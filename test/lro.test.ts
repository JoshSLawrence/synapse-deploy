import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHttp } from '../src/http.ts';
import {
  awaitArmDeploy,
  awaitDataPlaneDeploy,
  awaitDelete,
  awaitEndpointDeploy,
  OPERATION_DEADLINE_MS,
  pollWaitMs,
  sameOriginUrl,
} from '../src/lro.ts';
import { startFakeSynapse } from './fake/synapse_server.ts';
import type { Http, Method, Response } from '../src/http.ts';
import type { LroContext } from '../src/lro.ts';

const ORIGIN = 'http://127.0.0.1:1';
const PUT_URL = `${ORIGIN}/pipelines/pl_load?api-version=2019-06-01-preview`;
const SCOPE = 'https://dev.azuresynapse.net/.default';
const target = { scope: SCOPE, label: 'pipelines/pl_load', name: 'pl_load' };

function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
  method: Method = 'PUT',
  url: string = PUT_URL,
): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers,
    text,
    json: () => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(
          `${method} ${url} answered with status ${status} and a body that is not JSON.`,
        );
      }
    },
    method,
    url,
    attempts: 1,
  };
}

interface Call {
  method: string;
  url: string;
  scope: string;
}

// A scripted Http: each request takes the next answer, so a test states the
// exact sequence a poll sees. Running out of answers is a test failure.
function scripted(answers: (Response | Error)[]): { http: Http; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...answers];
  return {
    calls,
    http: {
      request(method, url, scope) {
        calls.push({ method, url, scope });
        const next = queue.shift();
        if (next === undefined) {
          return Promise.reject(new Error(`Unexpected extra request: ${method} ${url}`));
        }
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  };
}

// A clock that only moves when the code sleeps.
function fakeClock() {
  let time = Date.UTC(2026, 9, 9, 12, 0, 0);
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: (ms: number) => {
      waits.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

function context(answers: (Response | Error)[], deadlineMs?: number) {
  const clock = fakeClock();
  const { http, calls } = scripted(answers);
  const ctx: LroContext = {
    http,
    sleep: clock.sleep,
    now: clock.now,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
  return { ctx, calls, waits: clock.waits };
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

const operation = (id: string) =>
  response(202, { operationId: id }, { location: `/operationResults/${id}?api-version=x` });
const poll = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  response(status, body, headers, 'GET', `${ORIGIN}/operationResults/op1?api-version=x`);

describe('same-origin rule', () => {
  it('resolves a relative Location against the request', () => {
    assert.equal(
      sameOriginUrl(PUT_URL, '/operationResults/a?x=1'),
      `${ORIGIN}/operationResults/a?x=1`,
    );
  });

  it('accepts an absolute URL with the same scheme, host and port', () => {
    assert.equal(sameOriginUrl(PUT_URL, `${ORIGIN}/op/1`), `${ORIGIN}/op/1`);
  });

  it('refuses another host, port or scheme and names the host', () => {
    for (const other of [
      'http://localhost:1/op',
      'http://127.0.0.1:2/op',
      'https://127.0.0.1:1/op',
    ]) {
      assert.throws(() => sameOriginUrl(PUT_URL, other), /Refusing to send the token to /);
    }
  });
});

describe('poll waits', () => {
  it('doubles from 2 s to a 30 s cap without Retry-After', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((n) => pollWaitMs({}, n, 0));
    assert.deepEqual(waits, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('honours Retry-After seconds and an HTTP date', () => {
    assert.equal(pollWaitMs({ 'retry-after': '7' }, 3, 0), 7000);
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    assert.equal(pollWaitMs({ 'retry-after': 'Fri, 09 Oct 2026 12:00:10 GMT' }, 1, now), 10_000);
  });
});

describe('data-plane deploy', () => {
  it('is done on a plain 200 or 201 and polls nothing', async () => {
    for (const status of [200, 201]) {
      const { ctx, calls } = context([]);
      await awaitDataPlaneDeploy(ctx, response(status, { name: 'pl_load' }), target);
      assert.equal(calls.length, 0);
    }
  });

  it('fails a 202 without an operation ID, quoting the body', async () => {
    const { ctx } = context([]);
    const err = await rejection(
      awaitDataPlaneDeploy(ctx, response(202, 'accepted for later'), target),
    );
    assert.match(err.message, /pipelines\/pl_load/);
    assert.match(err.message, /202 without an operation ID/);
    assert.match(err.message, /accepted for later/);
  });

  it('fails a non-2xx PUT with its status and the service message', async () => {
    const { ctx } = context([]);
    const err = await rejection(
      awaitDataPlaneDeploy(ctx, response(400, { error: { message: 'bad body' } }), target),
    );
    assert.match(err.message, /400/);
    assert.match(err.message, /bad body/);
  });

  it('polls the Location header, relative or absolute, with the scope', async () => {
    const { ctx, calls } = context([poll(200, { name: 'pl_load' })]);
    await awaitDataPlaneDeploy(ctx, operation('op1'), target);
    assert.deepEqual(calls, [
      { method: 'GET', url: `${ORIGIN}/operationResults/op1?api-version=x`, scope: SCOPE },
    ]);
  });

  it('falls back to /operationResults/<id> without a Location header', async () => {
    const { ctx, calls } = context([poll(200, { status: 'Succeeded' })]);
    await awaitDataPlaneDeploy(ctx, response(202, { operationId: 'a b' }), target);
    assert.equal(calls[0]?.url, `${ORIGIN}/operationResults/a%20b?api-version=2019-06-01-preview`);
  });

  it('treats 202 and a 200 or 201 with an empty body as in progress', async () => {
    const { ctx, calls, waits } = context([
      poll(202),
      poll(200),
      poll(201, ''),
      poll(200, { name: 'pl_load' }),
    ]);
    await awaitDataPlaneDeploy(ctx, operation('op1'), target);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [2000, 4000, 8000]);
  });

  it('treats InProgress, Accepted and Running as in progress', async () => {
    const { ctx, calls } = context([
      poll(200, { status: 'InProgress' }),
      poll(200, { status: 'Accepted' }),
      poll(201, { status: 'Running' }),
      poll(200, { status: 'Succeeded' }),
    ]);
    await awaitDataPlaneDeploy(ctx, operation('op1'), target);
    assert.equal(calls.length, 4);
  });

  it('fails on Failed or Canceled with the service message', async () => {
    for (const status of ['Failed', 'Canceled']) {
      const { ctx } = context([
        poll(200, { status, error: { message: 'linked service missing' } }),
      ]);
      const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
      assert.match(err.message, new RegExp(status.toLowerCase()));
      assert.match(err.message, /linked service missing/);
      assert.match(err.message, /pipelines\/pl_load/);
    }
  });

  it('is done when the name equals the artifact, ignoring case', async () => {
    const { ctx } = context([poll(200, { name: 'PL_LOAD' })]);
    await awaitDataPlaneDeploy(ctx, operation('op1'), target);
  });

  it('fails on an unknown status or a body that is neither', async () => {
    for (const body of [{ status: 'Strange' }, { name: 'other' }]) {
      const { ctx } = context([poll(200, body)]);
      const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
      assert.match(err.message, /not the artifact/);
    }
  });

  it('is done on a 204 poll', async () => {
    const { ctx } = context([poll(204)]);
    await awaitDataPlaneDeploy(ctx, operation('op1'), target);
  });

  it('fails when the operation disappears (404)', async () => {
    const { ctx } = context([poll(404, { error: { message: 'gone' } })]);
    const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
    assert.match(err.message, /disappeared/);
  });

  it('fails on any other status, including 400 and 5xx', async () => {
    for (const status of [400, 401, 403, 500]) {
      const { ctx } = context([poll(status, { error: { message: 'nope' } })]);
      const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
      assert.match(err.message, new RegExp(String(status)));
    }
  });

  it('retries a 429 that reaches it and honours Retry-After', async () => {
    const { ctx, waits } = context([
      poll(429, '', { 'retry-after': '9' }),
      poll(200, { name: 'pl_load' }),
    ]);
    await awaitDataPlaneDeploy(ctx, operation('op1'), target);
    assert.deepEqual(waits, [9000]);
  });

  it('refuses a Location on another host without sending a poll', async () => {
    const { ctx, calls } = context([]);
    const err = await rejection(
      awaitDataPlaneDeploy(
        ctx,
        response(202, { operationId: 'x' }, { location: 'http://localhost:1/operationResults/x' }),
        target,
      ),
    );
    assert.match(err.message, /Refusing to send the token to localhost:1/);
    assert.equal(calls.length, 0);
  });

  it('gives up after 20 minutes, naming the artifact and the last status', async () => {
    const { ctx, waits } = context(Array.from({ length: 200 }, () => poll(202)));
    const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
    assert.match(err.message, /pipelines\/pl_load did not finish within 20 minutes/);
    assert.match(err.message, /last status: HTTP 202/);
    const waited = waits.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waited >= OPERATION_DEADLINE_MS, `waited ${waited} ms`);
    assert.ok(waited < OPERATION_DEADLINE_MS + 30_000);
  });

  it('uses a shorter deadline when given one', async () => {
    const { ctx } = context(
      Array.from({ length: 50 }, () => poll(202)),
      60_000,
    );
    const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
    assert.match(err.message, /within 1 minutes/);
  });

  it('lake database entities: a bare 202 with Location is an operation, and an answer without status is done', async () => {
    const { ctx, calls } = context([poll(202), poll(200, {})]);
    await awaitDataPlaneDeploy(
      ctx,
      response(202, '', { location: '/operationResults/op1?api-version=x' }),
      { ...target, lenient: true },
    );
    assert.equal(calls.length, 2);
    // A plain 200 and a 204 are done too.
    await awaitDataPlaneDeploy(context([]).ctx, response(204), { ...target, lenient: true });
  });
});

describe('delete (R1)', () => {
  const del = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    response(status, body, headers, 'DELETE');
  const deleteTarget = { scope: SCOPE, label: 'pipelines/pl_old' };
  const withLocation = { location: '/operationResults/op1?api-version=x' };

  it('treats a 404 on the DELETE as already deleted', async () => {
    const { ctx, calls } = context([]);
    await awaitDelete(ctx, del(404, { error: { message: 'not found' } }), deleteTarget);
    assert.equal(calls.length, 0);
  });

  it('is done on a 200 or 204 without Location', async () => {
    for (const status of [200, 204]) {
      const { ctx, calls } = context([]);
      await awaitDelete(ctx, del(status), deleteTarget);
      assert.equal(calls.length, 0);
    }
  });

  it('throws on a DELETE that fails, 400 and 5xx included', async () => {
    for (const status of [400, 401, 403, 409, 500]) {
      const { ctx } = context([]);
      const err = await rejection(
        awaitDelete(ctx, del(status, { error: { message: 'no' } }), deleteTarget),
      );
      assert.match(err.message, new RegExp(String(status)));
    }
  });

  it('ends the wait on a 404 poll', async () => {
    const { ctx, calls } = context([poll(404)]);
    await awaitDelete(ctx, del(202, undefined, withLocation), deleteTarget);
    assert.equal(calls.length, 1);
  });

  it('waits on 202 and on InProgress, then is done on 200, 201 or 204', async () => {
    for (const final of [poll(200, {}), poll(201, { status: 'Succeeded' }), poll(204), poll(200)]) {
      const { ctx, calls, waits } = context([
        poll(202),
        poll(200, { status: 'InProgress' }),
        final,
      ]);
      await awaitDelete(ctx, del(202, undefined, withLocation), deleteTarget);
      assert.equal(calls.length, 3);
      assert.deepEqual(waits, [2000, 4000]);
    }
  });

  it('fails when the body says Failed', async () => {
    const { ctx } = context([
      poll(200, { status: 'Failed', error: { message: 'still referenced' } }),
    ]);
    const err = await rejection(awaitDelete(ctx, del(202, undefined, withLocation), deleteTarget));
    assert.match(err.message, /still referenced/);
  });

  it('retries a 429 honouring Retry-After', async () => {
    const { ctx, waits } = context([poll(429, '', { 'retry-after': '5' }), poll(200, {})]);
    await awaitDelete(ctx, del(202, undefined, withLocation), deleteTarget);
    assert.deepEqual(waits, [5000]);
  });

  it('throws on 400, 401, 403 and 5xx polls instead of ending the wait', async () => {
    for (const status of [400, 401, 403, 500, 503]) {
      const { ctx } = context([poll(status, { error: { message: 'denied' } })]);
      const err = await rejection(
        awaitDelete(ctx, del(202, undefined, withLocation), deleteTarget),
      );
      assert.match(err.message, new RegExp(String(status)));
      assert.match(err.message, /pipelines\/pl_old/);
    }
  });

  it('refuses a cross-origin Location', async () => {
    const { ctx, calls } = context([]);
    const err = await rejection(
      awaitDelete(ctx, del(202, undefined, { location: 'http://localhost:1/op' }), deleteTarget),
    );
    assert.match(err.message, /Refusing to send the token to localhost:1/);
    assert.equal(calls.length, 0);
  });

  it('has the same 20 minute deadline', async () => {
    const { ctx } = context(Array.from({ length: 200 }, () => poll(202)));
    const err = await rejection(awaitDelete(ctx, del(202, undefined, withLocation), deleteTarget));
    assert.match(err.message, /within 20 minutes/);
  });
});

describe('managed private endpoint deploy', () => {
  const endpointUrl = `${ORIGIN}/managedVirtualNetworks/default/managedPrivateEndpoints/pe_sql?api-version=2019-06-01-preview`;
  const put = (status = 200, body: unknown = { name: 'pe_sql' }, headers = {}) =>
    response(status, body, headers, 'PUT', endpointUrl);
  const get = (status: number, body?: unknown) => response(status, body, {}, 'GET', endpointUrl);
  const state = (provisioningState?: string) =>
    get(200, {
      name: 'pe_sql',
      properties: provisioningState === undefined ? {} : { provisioningState },
    });
  const endpointTarget = { scope: SCOPE, label: 'managedPrivateEndpoints/pe_sql', name: 'pe_sql' };

  it('waits through Provisioning, Updating and a missing state until Succeeded', async () => {
    const { ctx, calls } = context([
      state('Provisioning'),
      state('Updating'),
      state(),
      state('Succeeded'),
    ]);
    await awaitEndpointDeploy(ctx, put(), endpointTarget);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.method === 'GET' && call.url === endpointUrl));
  });

  it('fails on Failed', async () => {
    const { ctx } = context([
      get(200, {
        properties: { provisioningState: 'Failed', error: { message: 'target refused' } },
      }),
    ]);
    const err = await rejection(awaitEndpointDeploy(ctx, put(), endpointTarget));
    assert.match(err.message, /target refused/);
  });

  it('is not done after a first matching name while still provisioning', async () => {
    const { ctx, calls } = context([state('Provisioning'), state('Succeeded')]);
    await awaitEndpointDeploy(ctx, put(), endpointTarget);
    assert.equal(calls.length, 2);
  });

  it('polls an operation first when the PUT returns an operationId', async () => {
    const { ctx, calls } = context([poll(200, { name: 'pe_sql' }), state('Succeeded')]);
    await awaitEndpointDeploy(
      ctx,
      put(202, { operationId: 'op1' }, { location: '/operationResults/op1?api-version=x' }),
      endpointTarget,
    );
    assert.deepEqual(
      calls.map((call) => call.url),
      [`${ORIGIN}/operationResults/op1?api-version=x`, endpointUrl],
    );
  });

  it('fails when the endpoint cannot be read', async () => {
    const { ctx } = context([get(404, { error: { message: 'missing' } })]);
    const err = await rejection(awaitEndpointDeploy(ctx, put(), endpointTarget));
    assert.match(err.message, /404/);
  });

  it('fails a PUT that did not answer 2xx', async () => {
    const { ctx } = context([]);
    const err = await rejection(
      awaitEndpointDeploy(ctx, put(400, { error: { message: 'bad' } }), endpointTarget),
    );
    assert.match(err.message, /400/);
  });

  it('has the 20 minute deadline', async () => {
    const { ctx } = context(Array.from({ length: 200 }, () => state('Provisioning')));
    const err = await rejection(awaitEndpointDeploy(ctx, put(), endpointTarget));
    assert.match(err.message, /within 20 minutes \(last status: provisioningState Provisioning\)/);
  });
});

describe('ARM integration runtime deploy', () => {
  const ARM_SCOPE = 'https://management.azure.com/.default';
  const irUrl = `${ORIGIN}/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Synapse/workspaces/myworkspace/integrationRuntimes/ir_example?api-version=2019-06-01-preview`;
  const armTarget = {
    scope: ARM_SCOPE,
    label: 'integrationRuntimes/ir_example',
    name: 'ir_example',
  };
  const put = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    response(status, body, headers, 'PUT', irUrl);
  const get = (status: number, body?: unknown, url = irUrl) =>
    response(status, body, {}, 'GET', url);
  const asyncUrl = `${ORIGIN}/asyncOperations/a1`;
  const asyncOp = (body: unknown, status = 200) => get(status, body, asyncUrl);
  const withAsync = { 'azure-asyncoperation': asyncUrl };

  it('is done on a 200 or 201 with Succeeded or no provisioning state', async () => {
    for (const body of [
      { properties: { provisioningState: 'Succeeded' } },
      { properties: {} },
      undefined,
    ]) {
      for (const status of [200, 201]) {
        const { ctx, calls } = context([]);
        await awaitArmDeploy(ctx, put(status, body), armTarget);
        assert.equal(calls.length, 0);
      }
    }
  });

  it('polls the resource while provisioning is not Succeeded', async () => {
    const provisioning = (state: string) => get(200, { properties: { provisioningState: state } });
    const { ctx, calls } = context([provisioning('Provisioning'), provisioning('Succeeded')]);
    await awaitArmDeploy(
      ctx,
      put(200, { properties: { provisioningState: 'Provisioning' } }),
      armTarget,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.scope, ARM_SCOPE);
    assert.equal(calls[0]?.url, irUrl);
  });

  it('fails when the resource ends Failed', async () => {
    const { ctx } = context([get(200, { properties: { provisioningState: 'Failed' } })]);
    const err = await rejection(
      awaitArmDeploy(ctx, put(200, { properties: { provisioningState: 'Updating' } }), armTarget),
    );
    assert.match(err.message, /provisioning failed/);
  });

  it('polls Azure-AsyncOperation on a 201 until Succeeded', async () => {
    const { ctx, calls } = context([
      asyncOp({ status: 'InProgress' }),
      asyncOp({ status: 'Running' }),
      asyncOp({ status: 'Succeeded' }),
    ]);
    await awaitArmDeploy(
      ctx,
      put(201, { properties: { provisioningState: 'Provisioning' } }, withAsync),
      armTarget,
    );
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.url === asyncUrl && call.scope === ARM_SCOPE));
  });

  it('polls Azure-AsyncOperation even on a 200 with a Succeeded body', async () => {
    const { ctx, calls } = context([asyncOp({ status: 'Succeeded' })]);
    await awaitArmDeploy(
      ctx,
      put(200, { properties: { provisioningState: 'Succeeded' } }, withAsync),
      armTarget,
    );
    assert.equal(calls.length, 1);
  });

  it('fails on Failed or Canceled with error.message', async () => {
    for (const status of ['Failed', 'Canceled']) {
      const { ctx } = context([asyncOp({ status, error: { message: 'quota exceeded' } })]);
      const err = await rejection(awaitArmDeploy(ctx, put(201, {}, withAsync), armTarget));
      assert.match(err.message, /quota exceeded/);
    }
  });

  it('refuses a cross-origin Azure-AsyncOperation', async () => {
    const { ctx, calls } = context([]);
    const err = await rejection(
      awaitArmDeploy(
        ctx,
        put(201, {}, { 'azure-asyncoperation': 'http://localhost:1/asyncOperations/a1' }),
        armTarget,
      ),
    );
    assert.match(err.message, /Refusing to send the token to localhost:1/);
    assert.equal(calls.length, 0);
  });

  it('polls a Location-only 202 until 200, 201 or 204', async () => {
    for (const final of [200, 201, 204]) {
      const locationUrl = `${ORIGIN}/armOperations/l1`;
      const { ctx, calls } = context([
        get(202, '', locationUrl),
        get(final, undefined, locationUrl),
      ]);
      await awaitArmDeploy(ctx, put(202, undefined, { location: locationUrl }), armTarget);
      assert.equal(calls.length, 2);
    }
  });

  it('fails a Location poll with another status', async () => {
    const { ctx } = context([get(500, { error: { message: 'boom' } })]);
    const err = await rejection(
      awaitArmDeploy(ctx, put(202, undefined, { location: `${ORIGIN}/l` }), armTarget),
    );
    assert.match(err.message, /500/);
  });

  it('fails a 202 with neither header', async () => {
    const { ctx } = context([]);
    const err = await rejection(awaitArmDeploy(ctx, put(202), armTarget));
    assert.match(err.message, /neither Azure-AsyncOperation nor Location/);
  });

  it('follows a body with operationId like a data-plane operation', async () => {
    const { ctx, calls } = context([poll(200, { name: 'ir_example' })]);
    await awaitArmDeploy(
      ctx,
      put(202, { operationId: 'op1' }, { location: '/operationResults/op1?api-version=x' }),
      armTarget,
    );
    assert.equal(calls[0]?.scope, ARM_SCOPE);
  });

  it('fails a non-2xx PUT with the permission hint on 403', async () => {
    const { ctx } = context([]);
    const err = await rejection(
      awaitArmDeploy(ctx, put(403, { error: { message: 'forbidden' } }), armTarget),
    );
    assert.match(err.message, /403/);
    assert.match(err.message, /missing/);
  });

  it('has the 20 minute deadline', async () => {
    const { ctx } = context(Array.from({ length: 200 }, () => asyncOp({ status: 'InProgress' })));
    const err = await rejection(awaitArmDeploy(ctx, put(201, {}, withAsync), armTarget));
    assert.match(err.message, /within 20 minutes \(last status: status InProgress\)/);
  });
});

describe('429 during a poll, through request()', () => {
  // The server is returned before anything is sent, so a test can close it in
  // a finally block whatever fails after.
  async function setup(fault: { count: number }) {
    const server = await startFakeSynapse({ lroPolls: 0 });
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const http = createHttp({ tokens: server.tokens, sleep });
    const ctx: LroContext = { http, sleep, now: Date.now };
    server.addFault({
      method: 'GET',
      path: /operationResults/,
      count: fault.count,
      response: {
        status: 429,
        headers: { 'Retry-After': '3' },
        body: '{"error":{"message":"slow down"}}',
      },
    });
    const put = () =>
      http.request(
        'PUT',
        `${server.url}/pipelines/pl_load?api-version=2019-06-01-preview`,
        'https://dev.azuresynapse.net/.default',
        { name: 'pl_load', properties: {} },
      );
    return { server, ctx, put, waits };
  }

  it('waits out a 429 and finishes', async () => {
    const { server, ctx, put, waits } = await setup({ count: 2 });
    try {
      await awaitDataPlaneDeploy(ctx, await put(), target);
      assert.deepEqual(waits, [3000, 3000]);
      const polls = server.requests.filter((r) => r.path.startsWith('/operationResults'));
      assert.equal(polls.length, 3);
    } finally {
      await server.close();
    }
  });

  it('fails when request() gives up after 5 attempts, not at the 20 minute deadline', async () => {
    const { server, ctx, put, waits } = await setup({ count: Number.POSITIVE_INFINITY });
    try {
      const err = await rejection(awaitDataPlaneDeploy(ctx, await put(), target));
      assert.match(err.message, /429/);
      assert.match(err.message, /after 5 attempts/);
      assert.match(err.message, /slow down/);
      assert.equal(waits.length, 4);
    } finally {
      await server.close();
    }
  });
});

describe('delete poll vocabulary (B1)', () => {
  const del = response(
    202,
    undefined,
    { location: '/operationResults/op1?api-version=x' },
    'DELETE',
  );
  const deleteTarget = { scope: SCOPE, label: 'pipelines/pl_old' };

  it('fails on Failed, Canceled and Rejected with the service message', async () => {
    for (const status of ['Failed', 'Canceled', 'Rejected']) {
      const { ctx } = context([poll(200, { status, error: { message: 'because' } })]);
      const err = await rejection(awaitDelete(ctx, del, deleteTarget));
      assert.match(err.message, new RegExp(status.toLowerCase()));
      assert.match(err.message, /because/);
    }
  });

  it('waits on InProgress, Accepted and Running (on 200 and 201)', async () => {
    const { ctx, calls } = context([
      poll(200, { status: 'InProgress' }),
      poll(201, { status: 'Accepted' }),
      poll(200, { status: 'Running' }),
      poll(200, { status: 'Succeeded' }),
    ]);
    await awaitDelete(ctx, del, deleteTarget);
    assert.equal(calls.length, 4);
  });

  it('is done on Succeeded, Deleted or no status', async () => {
    for (const body of [{ status: 'Succeeded' }, { status: 'Deleted' }, {}, { name: 'x' }]) {
      const { ctx } = context([poll(200, body)]);
      await awaitDelete(ctx, del, deleteTarget);
    }
  });

  it('throws on a status it does not know', async () => {
    const { ctx } = context([poll(200, { status: 'Strange' })]);
    const err = await rejection(awaitDelete(ctx, del, deleteTarget));
    assert.match(err.message, /status Strange/);
  });

  it('throws on a 200 or 201 body that is not JSON, and ignores the body of a 204', async () => {
    for (const status of [200, 201]) {
      const { ctx } = context([poll(status, '<html>proxy error</html>')]);
      const err = await rejection(awaitDelete(ctx, del, deleteTarget));
      assert.match(err.message, /not JSON/);
    }
    const { ctx } = context([poll(204, '<html>ignored</html>')]);
    await awaitDelete(ctx, del, deleteTarget);
  });
});

describe('deploy poll bodies', () => {
  it('throws on a 200 body that is not JSON', async () => {
    const { ctx } = context([poll(200, 'gateway page')]);
    const err = await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
    assert.match(err.message, /not JSON/);
  });

  it('fails fast on Rejected and Deleted too', async () => {
    for (const status of ['Rejected', 'Deleted']) {
      const { ctx } = context([poll(200, { status })]);
      await rejection(awaitDataPlaneDeploy(ctx, operation('op1'), target));
    }
  });
});

describe('operationResults base without a Location (S1)', () => {
  it('uses the root for data-plane artifacts', async () => {
    const { ctx, calls } = context([poll(200, { status: 'Succeeded' })]);
    await awaitDataPlaneDeploy(ctx, response(202, { operationId: 'a1' }), target);
    assert.equal(calls[0]?.url, `${ORIGIN}/operationResults/a1?api-version=2019-06-01-preview`);
  });

  it('uses the given base for endpoints and for ARM', async () => {
    for (const base of ['/managedVirtualNetworks/default', '/subscriptions/s/providers/w']) {
      const { ctx, calls } = context([poll(200, { name: 'x' })]);
      await awaitDataPlaneDeploy(ctx, response(202, { operationId: 'a1' }), {
        ...target,
        name: 'x',
        operationBase: base,
      });
      assert.equal(
        calls[0]?.url,
        `${ORIGIN}${base}/operationResults/a1?api-version=2019-06-01-preview`,
      );
    }
  });
});

describe('Retry-After handling (nits)', () => {
  it('waits at least 1 s for a Retry-After of 0 or a date in the past', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    assert.equal(pollWaitMs({ 'retry-after': '0' }, 1, now), 1000);
    assert.equal(pollWaitMs({ 'retry-after': 'Fri, 09 Oct 2026 11:00:00 GMT' }, 1, now), 1000);
  });

  it("honours the initial answer's Retry-After before the first poll, and only then", async () => {
    const first = context([poll(200, { name: 'pl_load' })]);
    await awaitDataPlaneDeploy(
      first.ctx,
      response(
        202,
        { operationId: 'op1' },
        { location: '/operationResults/op1', 'retry-after': '6' },
      ),
      target,
    );
    assert.deepEqual(first.waits, [6000]);
    const second = context([poll(200, { name: 'pl_load' })]);
    await awaitDataPlaneDeploy(second.ctx, operation('op1'), target);
    assert.deepEqual(second.waits, []);
  });
});

describe('lake database entity answers (S3)', () => {
  const lenient = { ...target, lenient: true };

  it('accepts 200, 201 and 204, polls a 202 with Location, fails a 202 without one', async () => {
    for (const status of [200, 201, 204]) {
      await awaitDataPlaneDeploy(context([]).ctx, response(status), lenient);
    }
    const { ctx, calls } = context([poll(200, {})]);
    await awaitDataPlaneDeploy(
      ctx,
      response(202, undefined, { location: '/operationResults/op1?api-version=x' }),
      lenient,
    );
    assert.equal(calls.length, 1);
    const err = await rejection(awaitDataPlaneDeploy(context([]).ctx, response(202), lenient));
    assert.match(err.message, /202 without an operation ID or Location/);
  });

  it('fails a PUT that is not 2xx', async () => {
    const err = await rejection(
      awaitDataPlaneDeploy(
        context([]).ctx,
        response(409, { error: { message: 'conflict' } }),
        lenient,
      ),
    );
    assert.match(err.message, /409/);
  });
});

describe('clearly terminal states fail fast; unknown ones keep waiting', () => {
  const endpointUrl = `${ORIGIN}/managedVirtualNetworks/default/managedPrivateEndpoints/pe?api-version=2019-06-01-preview`;
  const endpointTarget = { scope: SCOPE, label: 'managedPrivateEndpoints/pe', name: 'pe' };
  const put = response(200, { name: 'pe' }, {}, 'PUT', endpointUrl);
  const state = (provisioningState: string) =>
    response(200, { properties: { provisioningState } }, {}, 'GET', endpointUrl);

  it('endpoint provisioning: Canceled, Rejected and Deleted fail; Strange waits', async () => {
    for (const bad of ['Canceled', 'Rejected', 'Deleted']) {
      const { ctx } = context([state(bad)]);
      const err = await rejection(awaitEndpointDeploy(ctx, put, endpointTarget));
      assert.match(err.message, /provisioning /);
    }
    const { ctx, calls } = context([state('Strange'), state('Succeeded')]);
    await awaitEndpointDeploy(ctx, put, endpointTarget);
    assert.equal(calls.length, 2);
  });

  it('ARM async operation: Rejected fails, an unknown status waits', async () => {
    const armPut = response(201, {}, { 'azure-asyncoperation': `${ORIGIN}/asyncOperations/a1` });
    const asyncOp = (body: unknown) =>
      response(200, body, {}, 'GET', `${ORIGIN}/asyncOperations/a1`);
    const { ctx } = context([asyncOp({ status: 'Rejected', error: { message: 'no' } })]);
    await rejection(awaitArmDeploy(ctx, armPut, { scope: SCOPE, label: 'ir', name: 'ir' }));
    const waiting = context([asyncOp({ status: 'Strange' }), asyncOp({ status: 'Succeeded' })]);
    await awaitArmDeploy(waiting.ctx, armPut, { scope: SCOPE, label: 'ir', name: 'ir' });
    assert.equal(waiting.calls.length, 2);
  });
});

describe('fallback poll details', () => {
  it('uses the given api-version for the fallback poll', async () => {
    const { ctx, calls } = context([poll(200, { name: 'x' })]);
    await awaitDataPlaneDeploy(ctx, response(202, { operationId: 'a1' }), {
      ...target,
      name: 'x',
      operationApiVersion: '2030-01-01',
    });
    assert.match(calls[0]?.url ?? '', /api-version=2030-01-01$/);
  });

  it('fails a lake database target with an operationId and no Location', async () => {
    const { ctx, calls } = context([]);
    const err = await rejection(
      awaitDataPlaneDeploy(ctx, response(202, { operationId: 'a1' }), { ...target, lenient: true }),
    );
    assert.match(err.message, /no Location/);
    assert.equal(calls.length, 0);
  });
});
