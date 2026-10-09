import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { armScope, dataPlaneScope, findCloud } from '../src/cloud.ts';
import { startFakeSynapse } from './fake/synapse_server.ts';
import type { FakeConfig, FakeSynapse } from './fake/synapse_server.ts';

let server: FakeSynapse | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(config: Partial<FakeConfig> = {}): Promise<FakeSynapse> {
  server = await startFakeSynapse(config);
  return server;
}

const DATA = { Authorization: 'Bearer fake-data-token', 'Content-Type': 'application/json' };
const ARM = { Authorization: 'Bearer fake-arm-token', 'Content-Type': 'application/json' };
const V = '?api-version=2019-06-01-preview';

async function call(
  fake: FakeSynapse,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
) {
  const res = await fetch(`${fake.url}${path}`, {
    method,
    headers: options.headers ?? DATA,
    body: options.body === undefined ? null : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: (text === '' ? undefined : JSON.parse(text)) as Record<string, unknown> | undefined,
  };
}

describe('fake Synapse server: auth', () => {
  it('issues one token per scope and refuses an unknown scope', async () => {
    const fake = await start();
    const cloud = findCloud('AzureCloud') ?? assert.fail('no cloud');
    assert.equal(await fake.tokens.getToken(dataPlaneScope(cloud)), 'fake-data-token');
    assert.equal(await fake.tokens.getToken(armScope(cloud)), 'fake-arm-token');
    await assert.rejects(
      fake.tokens.getToken('https://elsewhere.example/.default'),
      /no token for scope/,
    );
    assert.equal(fake.tokenScopes.length, 3);
  });

  it('answers 401 for a missing token, the ARM token on the data plane and the reverse', async () => {
    const fake = await start();
    assert.equal((await call(fake, 'GET', `/pipelines${V}`, { headers: {} })).status, 401);
    assert.equal((await call(fake, 'GET', `/pipelines${V}`, { headers: ARM })).status, 401);
    const arm =
      '/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w/integrationRuntimes/ir';
    assert.equal((await call(fake, 'GET', `${arm}${V}`, { headers: DATA })).status, 401);
    assert.equal((await call(fake, 'GET', `${arm}${V}`, { headers: ARM })).status, 404);
  });
});

describe('fake Synapse server: PUT modes', () => {
  it('sync answers 200 with the resource', async () => {
    const fake = await start({ putMode: 'sync' });
    const res = await call(fake, 'PUT', `/pipelines/pl_a${V}`, { body: { properties: { x: 1 } } });
    assert.equal(res.status, 200);
    assert.equal(res.json?.name, 'pl_a');
    assert.deepEqual(fake.get('pipelines', 'PL_A'), { properties: { x: 1 } });
  });

  it('lro answers 202 with operationId and Location, in progress n times, then the resource', async () => {
    const fake = await start({ putMode: 'lro', lroPolls: 2 });
    const put = await call(fake, 'PUT', `/notebooks/nb${V}`, { body: { properties: {} } });
    assert.equal(put.status, 202);
    const location = put.headers.get('location') ?? assert.fail('no Location');
    assert.match(location, /^\/operationResults\/op\d+\?api-version=2019-06-01-preview$/);
    assert.equal(put.json?.operationId, location.split('/')[2]?.split('?')[0]);
    assert.equal((await call(fake, 'GET', location)).status, 202);
    assert.equal((await call(fake, 'GET', location)).status, 202);
    const done = await call(fake, 'GET', location);
    assert.equal(done.status, 200);
    assert.equal(done.json?.name, 'nb');
  });

  it('lro-no-location omits the header but the operation can be read by ID', async () => {
    const fake = await start({ putMode: 'lro-no-location', lroPolls: 0 });
    const put = await call(fake, 'PUT', `/notebooks/nb${V}`, { body: {} });
    assert.equal(put.headers.get('location'), null);
    const id = put.json?.operationId as string;
    assert.equal((await call(fake, 'GET', `/operationResults/${id}${V}`)).status, 200);
  });

  it('failOperation makes the operation finish as Failed', async () => {
    const fake = await start({ lroPolls: 0 });
    fake.failOperation('Pl_X', 'dataset missing');
    const put = await call(fake, 'PUT', `/pipelines/pl_x${V}`, { body: {} });
    const done = await call(fake, 'GET', put.headers.get('location') ?? '');
    assert.equal(done.json?.status, 'Failed');
    assert.deepEqual(done.json?.error, { code: 'Failed', message: 'dataset missing' });
  });

  it('answers 404 for an unknown collection or operation', async () => {
    const fake = await start();
    assert.equal((await call(fake, 'GET', `/nothing${V}`)).status, 404);
    assert.equal((await call(fake, 'GET', `/operationResults/zzz${V}`)).status, 404);
  });
});

describe('fake Synapse server: lists and paging', () => {
  it('pages value/nextLink with the configured size', async () => {
    const fake = await start({ pageSize: 2 });
    fake.seed(
      'pipelines',
      ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })),
    );
    const seen: string[] = [];
    let next: string | undefined = `/pipelines${V}`;
    let pages = 0;
    while (next !== undefined) {
      const page = await call(fake, 'GET', next.replace(fake.url, ''));
      seen.push(...(page.json?.value as { name: string }[]).map((item) => item.name));
      next = page.json?.nextLink as string | undefined;
      pages++;
    }
    assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(pages, 3);
  });

  it('nextLink is an absolute URL on the same host', async () => {
    const fake = await start({ pageSize: 1 });
    fake.seed('pipelines', [{ name: 'a' }, { name: 'b' }]);
    const page = await call(fake, 'GET', `/pipelines${V}`);
    assert.ok((page.json?.nextLink as string).startsWith(`${fake.url}/pipelines?`));
  });

  it('pages databases and children with items/continuationToken, which needs URL encoding', async () => {
    const fake = await start({ pageSize: 2 });
    fake.seedDatabase('db1', { tables: ['t1', 't2', 't3'], relationships: ['r1'] });
    fake.seedDatabase('db2', { origin: 'OTHER', symscdm: false });
    fake.seedDatabase('db3');
    const list = await call(fake, 'GET', '/databases?api-version=2021-04-01');
    assert.equal((list.json?.items as unknown[]).length, 2);
    const token = list.json?.continuationToken as string;
    assert.match(token, /\+/);
    const raw = await call(
      fake,
      'GET',
      `/databases?api-version=2021-04-01&continuationToken=${token}`,
    );
    assert.equal(raw.status, 400, 'an unencoded + is read as a space');
    const second = await call(
      fake,
      'GET',
      `/databases?api-version=2021-04-01&continuationToken=${encodeURIComponent(token)}`,
    );
    assert.equal((second.json?.items as unknown[]).length, 1);
    assert.equal(second.json?.continuationToken, undefined);
    assert.equal((await call(fake, 'GET', '/databases?continuationToken=bogus')).status, 400);

    const tables = await call(fake, 'GET', '/databases/db1/tables?api-version=2021-04-01');
    assert.deepEqual(
      (tables.json?.items as { Name: string }[]).map((t) => t.Name),
      ['t1', 't2'],
    );
    const rels = await call(fake, 'GET', '/databases/db1/relationships?api-version=2021-04-01');
    assert.deepEqual(
      (rels.json?.items as { Name: string }[]).map((t) => t.Name),
      ['r1'],
    );
  });

  it('stores and deletes database children, and 404s for the absent', async () => {
    const fake = await start();
    const L = '?api-version=2021-04-01';
    fake.seedDatabase('db1');
    assert.equal(
      (await call(fake, 'PUT', `/databases/db1/tables/t1${L}`, { body: { properties: {} } }))
        .status,
      200,
    );
    assert.deepEqual(fake.databaseChildren('db1', 'tables'), ['t1']);
    assert.equal((await call(fake, 'DELETE', `/databases/db1/tables/t1${L}`)).status, 200);
    assert.equal((await call(fake, 'DELETE', `/databases/db1/tables/t1${L}`)).status, 404);
    assert.equal((await call(fake, 'GET', `/databases/absent${L}`)).status, 404);
  });
});

describe('fake Synapse server: DELETE', () => {
  it('sync answers 200, lro answers 202 with Location that ends in 200 or 404, absent is 404', async () => {
    const fake = await start({ deleteMode: 'sync' });
    fake.seed('datasets', [{ name: 'ds' }]);
    assert.equal((await call(fake, 'DELETE', `/datasets/ds${V}`)).status, 200);
    assert.equal((await call(fake, 'DELETE', `/datasets/ds${V}`)).status, 404);

    fake.config.deleteMode = 'lro';
    fake.config.lroPolls = 0;
    for (const completion of ['ok', 'not-found'] as const) {
      fake.config.deleteCompletion = completion;
      fake.seed('datasets', [{ name: 'ds' }]);
      const del = await call(fake, 'DELETE', `/datasets/ds${V}`);
      assert.equal(del.status, 202);
      const done = await call(fake, 'GET', del.headers.get('location') ?? '');
      assert.equal(done.status, completion === 'ok' ? 200 : 404);
    }
  });

  it('refuses to update or delete an enabled trigger with the code and message Synapse uses', async () => {
    const fake = await start();
    fake.seed('triggers', [{ name: 'tr', properties: { runtimeState: 'Started' } }]);
    const del = await call(fake, 'DELETE', `/triggers/tr${V}`);
    assert.equal(del.status, 400);
    assert.match(JSON.stringify(del.json), /disabled first/);
    const put = await call(fake, 'PUT', `/triggers/tr${V}`, { body: { properties: {} } });
    assert.equal(put.status, 400);
    assert.deepEqual(put.json?.error, {
      code: 'TriggerEnabledCannotUpdate',
      message: 'Cannot update enabled Trigger; the trigger needs to be disabled first.',
    });
    assert.deepEqual(fake.names('triggers'), ['tr']);
  });
});

describe('fake Synapse server: endpoints', () => {
  const path = `/managedVirtualNetworks/default/managedPrivateEndpoints`;

  it('PUT answers Provisioning and GET reports Succeeded after n polls', async () => {
    const fake = await start({ endpointPolls: 2 });
    const put = await call(fake, 'PUT', `${path}/pe${V}`, {
      body: { properties: { groupId: 'sql' } },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json?.properties, { groupId: 'sql', provisioningState: 'Provisioning' });
    const states: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const got = await call(fake, 'GET', `${path}/pe${V}`);
      states.push((got.json?.properties as Record<string, unknown>).provisioningState);
    }
    assert.deepEqual(states, ['Provisioning', 'Provisioning', 'Succeeded', 'Succeeded']);
  });

  it('can end Failed', async () => {
    const fake = await start({ endpointPolls: 0, endpointFinalState: 'Failed' });
    await call(fake, 'PUT', `${path}/pe${V}`, { body: {} });
    const got = await call(fake, 'GET', `${path}/pe${V}`);
    assert.equal((got.json?.properties as Record<string, unknown>).provisioningState, 'Failed');
  });

  it('without a managed virtual network every endpoint call answers 400 with the known message', async () => {
    const fake = await start({ hasManagedVnet: false });
    for (const [method, p] of [
      ['GET', path],
      ['PUT', `${path}/pe`],
      ['DELETE', `${path}/pe`],
    ] as const) {
      const res = await call(fake, method, `${p}${V}`, { body: method === 'PUT' ? {} : undefined });
      assert.equal(res.status, 400);
      assert.match(res.text, /does not have a managed virtual network associated/);
    }
  });
});

describe('fake Synapse server: ARM integration runtimes', () => {
  const path =
    '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Synapse/workspaces/myworkspace/integrationRuntimes/ir';

  it('async-operation: 201 with Azure-AsyncOperation that reports InProgress, then Succeeded', async () => {
    const fake = await start({ armMode: 'async-operation', armPolls: 1 });
    const put = await call(fake, 'PUT', `${path}${V}`, { headers: ARM, body: { properties: {} } });
    assert.equal(put.status, 201);
    const op = (put.headers.get('azure-asyncoperation') ?? assert.fail('no header')).replace(
      fake.url,
      '',
    );
    assert.match(op, /^\/asyncOperations\//);
    assert.equal((await call(fake, 'GET', op, { headers: ARM })).json?.status, 'InProgress');
    assert.equal((await call(fake, 'GET', op, { headers: ARM })).json?.status, 'Succeeded');
  });

  it('location-only: 202 with Location, 202 until finished, then 200', async () => {
    const fake = await start({ armMode: 'location-only', armPolls: 1, lroPolls: 1 });
    const put = await call(fake, 'PUT', `${path}${V}`, { headers: ARM, body: {} });
    assert.equal(put.status, 202);
    const location = put.headers.get('location') ?? assert.fail('no Location');
    assert.equal((await call(fake, 'GET', location, { headers: ARM })).status, 202);
    assert.equal((await call(fake, 'GET', location, { headers: ARM })).status, 200);
  });

  it('provisioning-body: 200 Provisioning, the resource GET reports Succeeded after n polls', async () => {
    const fake = await start({ armMode: 'provisioning-body', armPolls: 1 });
    const put = await call(fake, 'PUT', `${path}${V}`, { headers: ARM, body: {} });
    assert.equal(
      (put.json?.properties as Record<string, unknown>).provisioningState,
      'Provisioning',
    );
    const first = await call(fake, 'GET', `${path}${V}`, { headers: ARM });
    const second = await call(fake, 'GET', `${path}${V}`, { headers: ARM });
    assert.equal(
      (first.json?.properties as Record<string, unknown>).provisioningState,
      'Provisioning',
    );
    assert.equal(
      (second.json?.properties as Record<string, unknown>).provisioningState,
      'Succeeded',
    );
  });

  it('sync: 200 Succeeded', async () => {
    const fake = await start({ armMode: 'sync' });
    const put = await call(fake, 'PUT', `${path}${V}`, { headers: ARM, body: {} });
    assert.equal(put.status, 200);
    assert.equal((put.json?.properties as Record<string, unknown>).provisioningState, 'Succeeded');
  });
});

describe('fake Synapse server: faults', () => {
  it('fires a status fault on the nth match for count matches, with headers and body', async () => {
    const fake = await start({ putMode: 'sync' });
    fake.addFault({
      method: 'PUT',
      path: /pipelines/,
      nth: 2,
      count: 2,
      response: {
        status: 429,
        headers: { 'Retry-After': '7' },
        body: '{"error":{"message":"slow"}}',
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call(fake, 'PUT', `/pipelines/p${V}`, { body: {} });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(res.headers.get('retry-after'), '7');
        assert.match(res.text, /slow/);
      }
    }
    assert.deepEqual(statuses, [200, 429, 429, 200, 200]);
  });

  it('counts matches for every fault, whichever one answers', async () => {
    const fake = await start();
    fake.addFault({ path: /pipelines/, response: { status: 503 } });
    fake.addFault({ path: /pipelines/, nth: 2, response: { status: 500 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(fake, 'GET', `/pipelines${V}`)).status);
    }
    assert.deepEqual(statuses, [503, 500, 200]);
    fake.clearFaults();
    assert.equal((await call(fake, 'GET', `/pipelines${V}`)).status, 200);
  });

  it('a redirect fault carries its Location', async () => {
    const fake = await start();
    fake.addFault({
      path: /pipelines/,
      response: { status: 302, headers: { Location: 'http://localhost:1/x' } },
    });
    const res = await call(fake, 'GET', `/pipelines${V}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://localhost:1/x');
  });

  it('reset destroys the socket', async () => {
    const fake = await start();
    fake.addFault({ path: /pipelines/, response: { reset: true } });
    await assert.rejects(call(fake, 'GET', `/pipelines${V}`));
  });

  it('stall-body sends part of the body and then nothing', async () => {
    const fake = await start();
    fake.addFault({ path: /pipelines/, response: { stallBody: true } });
    const controller = new AbortController();
    const res = await fetch(`${fake.url}/pipelines${V}`, {
      headers: DATA,
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(res.text());
  });

  it('close-early cuts the body short', async () => {
    const fake = await start();
    fake.addFault({ path: /pipelines/, response: { closeEarly: true } });
    const res = await fetch(`${fake.url}/pipelines${V}`, { headers: DATA });
    await assert.rejects(res.text());
  });
});

describe('fake Synapse server: recording and helpers', () => {
  it('records requests, separates writes and parses JSON bodies', async () => {
    const fake = await start({ putMode: 'sync', deleteMode: 'sync' });
    await call(fake, 'PUT', `/pipelines/a${V}`, { body: { properties: { k: 'v' } } });
    await call(fake, 'GET', `/pipelines/a${V}`);
    await call(fake, 'DELETE', `/pipelines/a${V}`);
    assert.deepEqual(
      fake.requests.map((r) => `${r.method} ${r.path}`),
      ['PUT /pipelines/a', 'GET /pipelines/a', 'DELETE /pipelines/a'],
    );
    assert.deepEqual(fake.requests[0]?.body, { properties: { k: 'v' } });
    assert.equal(fake.requests[0]?.authorization, 'Bearer fake-data-token');
    assert.deepEqual(
      fake.writes().map((r) => r.method),
      ['PUT', 'DELETE'],
    );
  });

  it('does not alter the recorded body when it stores the resource', async () => {
    const fake = await start();
    await call(fake, 'PUT', `${'/managedVirtualNetworks/default/managedPrivateEndpoints/pe'}${V}`, {
      body: { properties: {} },
    });
    assert.deepEqual(fake.requests[0]?.body, { properties: {} });
  });

  it('seed, get and names are case-insensitive, and an unknown collection throws', async () => {
    const fake = await start();
    fake.seed('linkedServices', [{ name: 'LS_One', properties: { type: 'AzureBlobFS' } }]);
    assert.deepEqual(fake.get('linkedservices', 'ls_one'), { properties: { type: 'AzureBlobFS' } });
    assert.deepEqual(fake.names('linkedServices'), ['LS_One']);
    assert.throws(() => fake.seed('nothing', [{ name: 'x' }]), /no collection/);
  });

  it('counts operations in flight, an LRO until it completes', async () => {
    const fake = await start({ putMode: 'lro', lroPolls: 0, latencyMs: 10 });
    const first = await call(fake, 'PUT', `/pipelines/a${V}`, { body: {} });
    const second = await call(fake, 'PUT', `/pipelines/b${V}`, { body: {} });
    assert.equal(fake.maxConcurrentOperations, 2);
    await call(fake, 'GET', first.headers.get('location') ?? '');
    await call(fake, 'GET', second.headers.get('location') ?? '');
    const third = await call(fake, 'PUT', `/pipelines/c${V}`, { body: {} });
    assert.equal(third.status, 202);
    assert.equal(fake.maxConcurrentOperations, 2, 'finished operations no longer count');
    assert.ok(fake.maxConcurrentRequests >= 1);
  });
});

describe('fake Synapse server: api-version, operation paths and metrics', () => {
  it('answers 400 unless the api-version fits the path', async () => {
    const fake = await start({ putMode: 'sync' });
    for (const path of [
      '/pipelines/p',
      '/pipelines/p?api-version=2021-04-01',
      '/pipelines/p?api-version=1',
    ]) {
      const res = await call(fake, 'PUT', path, { body: {} });
      assert.equal(res.status, 400, path);
      assert.match(res.text, /InvalidApiVersionParameter/);
    }
    assert.equal(
      (await call(fake, 'GET', '/databases?api-version=2019-06-01-preview')).status,
      400,
    );
    assert.equal((await call(fake, 'GET', '/databases?api-version=2021-04-01')).status, 200);
    const arm =
      '/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w/integrationRuntimes/ir';
    assert.equal(
      (await call(fake, 'GET', `${arm}?api-version=2021-04-01`, { headers: ARM })).status,
      400,
    );
    assert.equal((await call(fake, 'GET', `${arm}${V}`, { headers: ARM })).status, 404);
  });

  it('serves an endpoint operation only under its own operationResults base', async () => {
    const fake = await start({ endpointPutMode: 'lro-no-location', lroPolls: 0 });
    const put = await call(
      fake,
      'PUT',
      `/managedVirtualNetworks/default/managedPrivateEndpoints/pe${V}`,
      { body: {} },
    );
    const id = put.json?.operationId as string;
    assert.equal(put.headers.get('location'), null);
    assert.equal((await call(fake, 'GET', `/operationResults/${id}${V}`)).status, 404);
    const ok = await call(
      fake,
      'GET',
      `/managedVirtualNetworks/default/operationResults/${id}${V}`,
    );
    assert.equal(ok.status, 200);
  });

  it('operation-id ARM mode is served under the workspace path', async () => {
    const fake = await start({ armMode: 'operation-id', lroPolls: 0 });
    const ws = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w';
    const put = await call(fake, 'PUT', `${ws}/integrationRuntimes/ir${V}`, {
      headers: ARM,
      body: {},
    });
    assert.equal(put.status, 202);
    const id = put.json?.operationId as string;
    assert.equal((await call(fake, 'GET', `/operationResults/${id}${V}`)).status, 404);
    assert.equal(
      (await call(fake, 'GET', `${ws}/operationResults/${id}${V}`, { headers: ARM })).status,
      200,
    );
  });

  it('location-only uses armPolls', async () => {
    const fake = await start({ armMode: 'location-only', armPolls: 3, lroPolls: 0 });
    const put = await call(
      fake,
      'PUT',
      `/subscriptions/s/resourceGroups/r/providers/Microsoft.Synapse/workspaces/w/integrationRuntimes/ir${V}`,
      { headers: ARM, body: {} },
    );
    const location = put.headers.get('location') ?? '';
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await call(fake, 'GET', location, { headers: ARM })).status);
    }
    assert.deepEqual(statuses, [202, 202, 202, 200]);
  });

  it('keeps an endpoint write open until its provisioning ends, and resetMetrics closes the rest', async () => {
    const fake = await start({ endpointPutMode: 'sync', endpointPolls: 1 });
    const base = '/managedVirtualNetworks/default/managedPrivateEndpoints';
    await call(fake, 'PUT', `${base}/a${V}`, { body: {} });
    await call(fake, 'PUT', `${base}/b${V}`, { body: {} });
    assert.equal(fake.maxConcurrentOperations, 2);
    fake.resetMetrics();
    assert.equal(fake.maxConcurrentOperations, 0);
    await call(fake, 'PUT', `${base}/c${V}`, { body: {} });
    await call(fake, 'GET', `${base}/c${V}`);
    await call(fake, 'GET', `${base}/c${V}`);
    await call(fake, 'PUT', `${base}/d${V}`, { body: {} });
    assert.equal(fake.maxConcurrentOperations, 1, 'c finished provisioning before d started');
  });
});
