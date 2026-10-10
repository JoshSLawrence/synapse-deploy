import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { HttpClient, HttpClientResponse } from '@actions/http-client';
import {
  createHttp,
  createHttpClient,
  DATA_PLANE_SOCKET_TIMEOUT_MS,
  ensureSuccess,
  HttpError,
  isPermanentConnectionError,
  MAX_RETRY_WAIT_MS,
  permissionHint,
  readBody,
  responseError,
  retryWaitMs,
  serviceMessageOf,
} from '../src/http.ts';
import type { Response } from '../src/http.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function listen(handler: Handler): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function close(server: http.Server | https.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof Error);
    return err;
  }
  assert.fail('Expected the promise to reject');
}

function fakeTokens() {
  const scopes: string[] = [];
  return {
    scopes,
    tokens: {
      getToken: (scope: string) => {
        scopes.push(scope);
        return Promise.resolve(`token-${scopes.length}`);
      },
    },
  };
}

// An instant sleep that records what it was asked to wait.
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

const FIXED_NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

describe('shared HTTP client', () => {
  it('keeps TLS certificate verification on', () => {
    const client = createHttpClient(DATA_PLANE_SOCKET_TIMEOUT_MS) as unknown as {
      _ignoreSslError?: boolean;
    };
    assert.ok(!client._ignoreSslError);
  });

  it('rejects a server whose certificate is self-signed', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
        ],
        { stdio: 'ignore' },
      );
    } catch {
      t.skip('openssl is not available');
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    const server = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (_req, res) => res.end('{}'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const err = await rejection(
        createHttpClient(DATA_PLANE_SOCKET_TIMEOUT_MS).get(`https://localhost:${port}/`),
      );
      assert.match(err.message, /self[- ]signed|certificate|SELF_SIGNED/i);
    } finally {
      await close(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets a socket timeout and disables redirects', () => {
    const client = createHttpClient(DATA_PLANE_SOCKET_TIMEOUT_MS) as unknown as {
      _socketTimeout: number;
      _allowRedirects: boolean;
    };
    assert.equal(client._socketTimeout, DATA_PLANE_SOCKET_TIMEOUT_MS);
    assert.equal(client._allowRedirects, false);
  });

  it('rejects a request to a server that never answers instead of hanging', async () => {
    const { server, port } = await listen(() => {
      /* never respond */
    });
    try {
      const err = await rejection(createHttpClient(200).get(`http://127.0.0.1:${port}/`));
      assert.match(err.message, /timeout/i);
    } finally {
      await close(server);
    }
  });

  it('does not follow a redirect to another host, so the bearer token is not forwarded', async () => {
    let leakedAuthorization: string | undefined;
    let targetHit = false;
    const target = await listen((req, res) => {
      targetHit = true;
      leakedAuthorization = req.headers.authorization;
      res.end('{}');
    });
    const origin = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://localhost:${target.port}/` });
      res.end();
    });
    try {
      const res = await createHttpClient(DATA_PLANE_SOCKET_TIMEOUT_MS).get(
        `http://127.0.0.1:${origin.port}/`,
        { Authorization: 'Bearer secret' },
      );
      await readBody(res);
      assert.equal(res.message.statusCode, 302);
      assert.equal(targetHit, false);
      assert.equal(leakedAuthorization, undefined);
    } finally {
      await close(origin.server);
      await close(target.server);
    }
  });
});

describe('readBody', () => {
  const client = createHttpClient(DATA_PLANE_SOCKET_TIMEOUT_MS);

  it('returns the whole body', async () => {
    const { server, port } = await listen((_req, res) => res.end('hello'));
    try {
      assert.equal(await readBody(await client.get(`http://127.0.0.1:${port}/`)), 'hello');
    } finally {
      await close(server);
    }
  });

  it('rejects when the connection is destroyed after a partial body', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    try {
      const res = await client.get(`http://127.0.0.1:${port}/`);
      const err = await rejection(readBody(res));
      assert.match(
        err.message,
        /closed before the response from 127\.0\.0\.1 was complete; re-run the job/,
      );
    } finally {
      await close(server);
    }
  });

  it('rejects when the peer closes a stalled body', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.end(), 50);
    });
    try {
      const res = await client.get(`http://127.0.0.1:${port}/`);
      const err = await rejection(readBody(res));
      assert.match(err.message, /re-run the job/);
    } finally {
      await close(server);
    }
  });

  it('rejects a body that stalls past the idle timeout', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
    });
    try {
      const res = await client.get(`http://127.0.0.1:${port}/`);
      const err = await rejection(readBody(res, 100));
      assert.match(err.message, /No data from 127\.0\.0\.1/);
    } finally {
      await close(server);
    }
  });

  it('settles for a stream-backed response too', async () => {
    const message = Object.assign(Readable.from(['abc']), {
      complete: true,
      setTimeout: () => undefined,
    });
    assert.equal(await readBody({ message } as unknown as HttpClientResponse), 'abc');
  });
});

describe('retryWaitMs', () => {
  it('doubles from 2 s without Retry-After', () => {
    assert.deepEqual(
      [1, 2, 3, 4].map((attempt) => retryWaitMs({}, attempt, FIXED_NOW)),
      [2000, 4000, 8000, 16000],
    );
  });

  it('uses Retry-After seconds', () => {
    assert.equal(retryWaitMs({ 'retry-after': '3' }, 1, FIXED_NOW), 3000);
    assert.equal(retryWaitMs({ 'retry-after': '0' }, 1, FIXED_NOW), 0);
  });

  it('uses a Retry-After HTTP date', () => {
    const date = new Date(FIXED_NOW + 7000).toUTCString();
    assert.equal(retryWaitMs({ 'retry-after': date }, 1, FIXED_NOW), 7000);
  });

  it('treats a Retry-After date in the past as no wait', () => {
    const date = new Date(FIXED_NOW - 7000).toUTCString();
    assert.equal(retryWaitMs({ 'retry-after': date }, 1, FIXED_NOW), 0);
  });

  it('falls back to the doubling for an unreadable Retry-After', () => {
    assert.equal(retryWaitMs({ 'retry-after': 'soon' }, 2, FIXED_NOW), 4000);
  });

  it('does not read numbers that are not whole seconds as dates', () => {
    for (const value of ['1.5', '-1', '1e3', '0x10']) {
      assert.equal(retryWaitMs({ 'retry-after': value }, 1, FIXED_NOW), 2000, value);
    }
  });

  it('trims whitespace around seconds', () => {
    assert.equal(retryWaitMs({ 'retry-after': '2 ' }, 1, FIXED_NOW), 2000);
    assert.equal(retryWaitMs({ 'retry-after': ' 5 ' }, 1, FIXED_NOW), 5000);
  });

  it('reads RFC 850 and asctime dates', () => {
    const base = new Date(FIXED_NOW + 9000);
    const asctime = base
      .toUTCString()
      .replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4');
    assert.equal(retryWaitMs({ 'retry-after': asctime }, 1, FIXED_NOW), 9000);
  });

  it('caps every wait at 60 s', () => {
    assert.equal(retryWaitMs({ 'retry-after': '3600' }, 1, FIXED_NOW), MAX_RETRY_WAIT_MS);
    assert.equal(retryWaitMs({}, 10, FIXED_NOW), MAX_RETRY_WAIT_MS);
  });
});

describe('connection errors that retrying cannot fix', () => {
  function failingClient(code: string, calls: { count: number }) {
    return {
      request: () => {
        calls.count++;
        return Promise.reject(Object.assign(new Error(`connect failed: ${code}`), { code }));
      },
    } as unknown as HttpClient;
  }

  for (const code of [
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ENOTFOUND',
  ]) {
    it(`fails at once on ${code}`, async () => {
      const calls = { count: 0 };
      const { sleep, waits } = fakeSleep();
      const http = createHttp({
        tokens: fakeTokens().tokens,
        sleep,
        client: failingClient(code, calls),
      });
      const err = await rejection(http.request('GET', 'https://myworkspace.example/x', 's'));
      assert.equal(calls.count, 1);
      assert.deepEqual(waits, []);
      assert.match(err.message, new RegExp(code));
      assert.match(err.message, /Retrying cannot help/);
    });
  }

  for (const code of ['EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']) {
    it(`still retries ${code}`, async () => {
      const calls = { count: 0 };
      const { sleep } = fakeSleep();
      const http = createHttp({
        tokens: fakeTokens().tokens,
        sleep,
        client: failingClient(code, calls),
      });
      const err = await rejection(http.request('GET', 'https://myworkspace.example/x', 's'));
      assert.equal(calls.count, 5);
      assert.match(err.message, /after 5 attempts/);
    });
  }

  it('reads the code from the cause too', () => {
    const err = new Error('wrapped', {
      cause: Object.assign(new Error('inner'), { code: 'CERT_HAS_EXPIRED' }),
    });
    assert.equal(isPermanentConnectionError(err), true);
    assert.equal(isPermanentConnectionError(new Error('no code')), false);
  });
});

describe('request', () => {
  async function withServer(
    handler: Handler,
    body: (url: string, port: number) => Promise<void>,
  ): Promise<void> {
    const { server, port } = await listen(handler);
    try {
      await body(`http://127.0.0.1:${port}`, port);
    } finally {
      await close(server);
    }
  }

  it('sends the method, a bearer token for the scope and the JSON body', async () => {
    let seen: { method?: string; auth?: string; type?: string; body: string } | undefined;
    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen = {
            method: req.method,
            auth: req.headers.authorization,
            type: req.headers['content-type'],
            body: Buffer.concat(chunks).toString(),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      },
      async (url) => {
        const { tokens, scopes } = fakeTokens();
        const res = await createHttp({ tokens }).request(
          'PUT',
          `${url}/x?api-version=1`,
          'scope-a',
          {
            name: 'value',
          },
        );

        assert.equal(res.status, 200);
        assert.deepEqual(res.json(), { ok: true });
        assert.equal(res.attempts, 1);
        assert.deepEqual(scopes, ['scope-a']);
        assert.deepEqual(seen, {
          method: 'PUT',
          auth: 'Bearer token-1',
          type: 'application/json',
          body: '{"name":"value"}',
        });
      },
    );
  });

  it('returns a 4xx without retrying, and does not throw', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls++;
        res.writeHead(404);
        res.end('{"error":{"message":"gone"}}');
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        const res = await createHttp({ tokens: fakeTokens().tokens, sleep }).request(
          'GET',
          `${url}/x`,
          's',
        );
        assert.equal(res.status, 404);
        assert.equal(calls, 1);
        assert.deepEqual(waits, []);
      },
    );
  });

  it('waits Retry-After seconds on a 429 and then succeeds', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(429, { 'Retry-After': '3' });
          res.end();
        } else {
          res.end('{}');
        }
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        const res = await createHttp({
          tokens: fakeTokens().tokens,
          sleep,
          now: () => FIXED_NOW,
        }).request('GET', `${url}/x`, 's');
        assert.equal(res.status, 200);
        assert.equal(res.attempts, 2);
        assert.deepEqual(waits, [3000]);
      },
    );
  });

  it('waits until a Retry-After HTTP date on a 429', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(429, { 'Retry-After': new Date(FIXED_NOW + 7000).toUTCString() });
          res.end();
        } else {
          res.end('{}');
        }
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        await createHttp({ tokens: fakeTokens().tokens, sleep, now: () => FIXED_NOW }).request(
          'GET',
          `${url}/x`,
          's',
        );
        assert.deepEqual(waits, [7000]);
      },
    );
  });

  it('retries a 503 once with the 2 s backoff', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(503);
          res.end();
        } else {
          res.end('{}');
        }
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        const res = await createHttp({ tokens: fakeTokens().tokens, sleep }).request(
          'DELETE',
          `${url}/x`,
          's',
        );
        assert.equal(res.status, 200);
        assert.deepEqual(waits, [2000]);
      },
    );
  });

  it('retries a connection reset', async () => {
    let calls = 0;
    await withServer(
      (req, res) => {
        if (++calls === 1) {
          req.socket.destroy();
        } else {
          res.end('{}');
        }
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        const res = await createHttp({ tokens: fakeTokens().tokens, sleep }).request(
          'GET',
          `${url}/x`,
          's',
        );
        assert.equal(res.status, 200);
        assert.equal(res.attempts, 2);
        assert.deepEqual(waits, [2000]);
      },
    );
  });

  it('retries a body that is cut off', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(200, { 'Content-Length': '100' });
          res.write('partial');
          setTimeout(() => res.socket?.destroy(), 10);
        } else {
          res.end('{}');
        }
      },
      async (url) => {
        const { sleep } = fakeSleep();
        const res = await createHttp({ tokens: fakeTokens().tokens, sleep }).request(
          'GET',
          `${url}/x`,
          's',
        );
        assert.equal(res.attempts, 2);
      },
    );
  });

  it('gets a fresh token for every attempt', async () => {
    let calls = 0;
    await withServer(
      (req, res) => {
        calls++;
        if (calls < 3) {
          res.writeHead(500);
          res.end();
        } else {
          res.end(req.headers.authorization);
        }
      },
      async (url) => {
        const { tokens, scopes } = fakeTokens();
        const res = await createHttp({ tokens, sleep: fakeSleep().sleep }).request(
          'GET',
          `${url}/x`,
          's',
        );
        assert.equal(scopes.length, 3);
        assert.equal(res.text, 'Bearer token-3');
      },
    );
  });

  it('fails after five 503s in a row, reporting the status and attempt count', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls++;
        res.writeHead(503);
        res.end('{"error":{"message":"busy"}}');
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        const err = await rejection(
          createHttp({ tokens: fakeTokens().tokens, sleep }).request(
            'GET',
            `${url}/x?secret=1`,
            's',
          ),
        );
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 503);
        assert.equal(calls, 5);
        assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
        assert.match(err.message, /GET \/x failed with status 503 after 5 attempts: busy/);
        assert.doesNotMatch(err.message, /secret=1/);
      },
    );
  });

  it('fails after five connection errors in a row', async () => {
    let calls = 0;
    await withServer(
      (req) => {
        calls++;
        req.socket.destroy();
      },
      async (url) => {
        const err = await rejection(
          createHttp({ tokens: fakeTokens().tokens, sleep: fakeSleep().sleep }).request(
            'GET',
            `${url}/x`,
            's',
          ),
        );
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, undefined);
        assert.equal(calls, 5);
        assert.match(err.message, /GET \/x failed after 5 attempts/);
      },
    );
  });

  it('caps a Retry-After above 60 s', async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        if (++calls === 1) {
          res.writeHead(429, { 'Retry-After': '3600' });
          res.end();
        } else {
          res.end('{}');
        }
      },
      async (url) => {
        const { sleep, waits } = fakeSleep();
        await createHttp({ tokens: fakeTokens().tokens, sleep }).request('GET', `${url}/x`, 's');
        assert.deepEqual(waits, [60_000]);
      },
    );
  });

  it('does not retry a sign-in failure', async () => {
    const tokens = {
      getToken: () => Promise.reject(new Error('Azure authentication failed: nope')),
    };
    const { sleep, waits } = fakeSleep();
    const err = await rejection(
      createHttp({ tokens, sleep }).request('GET', 'http://127.0.0.1:9/x', 's'),
    );
    assert.match(err.message, /authentication failed/);
    assert.deepEqual(waits, []);
  });

  it('always throws on a redirect and never follows it', async () => {
    let targetHit = false;
    const target = await listen((_req, res) => {
      targetHit = true;
      res.end('{}');
    });
    await withServer(
      (_req, res) => {
        res.writeHead(302, { Location: `http://localhost:${target.port}/` });
        res.end();
      },
      async (url) => {
        const err = await rejection(
          createHttp({ tokens: fakeTokens().tokens, sleep: fakeSleep().sleep }).request(
            'GET',
            `${url}/x`,
            's',
          ),
        );
        assert.match(err.message, /Unexpected redirect to http:\/\/localhost:\d+\//);
        assert.equal(targetHit, false);
      },
    );
    await close(target.server);
  });

  it('reports a body that is not JSON readably', async () => {
    await withServer(
      (_req, res) => res.end('<html>'),
      async (url) => {
        const res = await createHttp({ tokens: fakeTokens().tokens }).request(
          'GET',
          `${url}/x`,
          's',
        );
        assert.throws(
          () => res.json(),
          /GET \/x answered with status 200 and a body that is not JSON/,
        );
      },
    );
  });
});

function response(status: number, text: string): Response {
  return {
    status,
    headers: {},
    text,
    json: () => JSON.parse(text) as unknown,
    method: 'PUT',
    url: 'https://myworkspace.dev.azuresynapse.net/pipelines/pl?api-version=2019-06-01-preview',
    attempts: 1,
  };
}

describe('errors', () => {
  it('reads error.message, then message, then the raw text', () => {
    assert.equal(serviceMessageOf('{"error":{"message":"a"}}'), 'a');
    assert.equal(serviceMessageOf('{"message":"b"}'), 'b');
    assert.equal(serviceMessageOf('{"Code":"X","Message":"capitalised"}'), 'capitalised');
    assert.equal(serviceMessageOf('plain'), 'plain');
    assert.equal(serviceMessageOf('{"error":"c"}'), '{"error":"c"}');
  });

  it('truncates the service message at 2,000 characters', () => {
    const message = serviceMessageOf(JSON.stringify({ message: 'x'.repeat(5000) }));
    assert.equal(message.length, 2003);
    assert.ok(message.endsWith('...'));
  });

  it('carries the method, path without query, status and message', () => {
    const err = responseError(response(400, '{"error":{"message":"bad name"}}'));
    assert.equal(err.message, 'PUT /pipelines/pl failed with status 400: bad name.');
  });

  it('adds a role hint for 401 and 403 only', () => {
    assert.match(responseError(response(403, '{}')).message, /likely missing a role for this call/);
    assert.match(responseError(response(401, '{}')).message, /likely missing/);
    assert.doesNotMatch(responseError(response(400, '{}')).message, /likely missing/);
    assert.equal(permissionHint(404, 'x'), '');
  });

  it('accepts any 2xx and throws on the rest', () => {
    for (const status of [200, 201, 202, 204]) {
      assert.equal(ensureSuccess(response(status, '')).status, status);
    }
    assert.throws(() => ensureSuccess(response(404, '')), /status 404/);
  });
});
