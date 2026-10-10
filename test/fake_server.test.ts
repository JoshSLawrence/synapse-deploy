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
  const res = await fetch(path.startsWith('http') ? path : `${fake.url}${path}`, {
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

  it('lro answers like Azure: 202 with operationId and a same-host Location, in progress n times, then the resource', async () => {
    const fake = await start({ putMode: 'lro', lroPolls: 2 });
    const put = await call(fake, 'PUT', `/pipelines/pl${V}`, { body: { properties: {} } });
    assert.equal(put.status, 202);
    assert.deepEqual(Object.keys(put.json ?? {}).sort(), [
      'artifactId',
      'changed',
      'created',
      'id',
      'name',
      'operationId',
      'recordId',
      'state',
      'type',
    ]);
    assert.equal(put.headers.get('retry-after'), '10');
    const location = put.headers.get('location') ?? assert.fail('no Location');
    assert.match(
      location,
      new RegExp(`^${fake.url}/operationResults/op\\d+\\?api-version=2019-06-01-preview$`),
    );
    assert.equal(put.json?.operationId, location.split('/')[4]?.split('?')[0]);
    for (let i = 0; i < 2; i++) {
      const pending = await call(fake, 'GET', location);
      assert.equal(pending.status, 202);
      assert.deepEqual(pending.json, { status: 'InProgress' });
      assert.equal(pending.headers.get('location'), location);
      assert.equal(pending.headers.get('retry-after'), '10');
    }
    const done = await call(fake, 'GET', location);
    assert.equal(done.status, 200);
    assert.equal(done.json?.name, 'pl');
    assert.equal(done.json?.status, undefined);
    // Neither the per-kind collection nor the other kinds' roots serve it.
    const id = put.json?.operationId as string;
    assert.equal((await call(fake, 'GET', `/pipelines/operationResults/${id}${V}`)).status, 404);
  });

  it('serves notebook operations under /notebookOperationResults and refuses them at the root', async () => {
    const fake = await start({ lroPolls: 0 });
    const put = await call(fake, 'PUT', `/notebooks/nb${V}`, { body: { properties: {} } });
    const location = put.headers.get('location') ?? assert.fail('no Location');
    assert.match(location, /\/notebookOperationResults\/op\d+\?/);
    const id = put.json?.operationId as string;
    const root = await call(fake, 'GET', `/operationResults/${id}${V}`);
    assert.equal(root.status, 400);
    assert.equal((root.json?.error as Record<string, unknown>).code, 'UnsupportedOperation');
    const done = await call(fake, 'GET', location);
    assert.equal(done.status, 200);
    assert.equal(done.json?.name, 'nb');
  });

  it('lro-no-location omits the header but the operation can be read by ID', async () => {
    const fake = await start({ putMode: 'lro-no-location', lroPolls: 0 });
    const put = await call(fake, 'PUT', `/pipelines/pl${V}`, { body: {} });
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

  it('answers 404 with the kind-specific code once an artifact is gone', async () => {
    const fake = await start();
    const codes: [string, string][] = [
      ['pipelines', 'PipelineNotFound'],
      ['triggers', 'TriggerNotFound'],
      ['datasets', 'DatasetNotFound'],
      ['linkedServices', 'LinkedServiceNotFound'],
      ['dataflows', 'DataFlowNotFound'],
    ];
    for (const [collection, code] of codes) {
      const got = await call(fake, 'GET', `/${collection}/absent${V}`);
      assert.equal(got.status, 404, collection);
      assert.equal(got.json?.code, code, collection);
      assert.equal(typeof got.json?.message, 'string');
    }
    for (const collection of ['sqlScripts', 'notebooks']) {
      const got = await call(fake, 'GET', `/${collection}/absent${V}`);
      assert.deepEqual(Object.keys(got.json ?? {}).sort(), [
        'code',
        'details',
        'error',
        'message',
        'target',
      ]);
    }
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
    // The real shape: entity fields nested under `properties`.
    assert.deepEqual((list.json?.items as Record<string, unknown>[])[0], {
      id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-example/providers/microsoft.synapse/workspaces/myworkspace/databases/db1',
      name: 'db1',
      properties: { Origin: { Type: 'SPARK' }, Properties: { IsSyMSCDMDatabase: true } },
      type: 'DATABASE',
    });
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
      (tables.json?.items as { name: string }[]).map((t) => t.name),
      ['t1', 't2'],
    );
    const rels = await call(fake, 'GET', '/databases/db1/relationships?api-version=2021-04-01');
    assert.deepEqual(
      (rels.json?.items as { name: string }[]).map((t) => t.name),
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

  it('writes synchronously with the PascalCase acknowledgement and answers 404 with Code and Message', async () => {
    const L = '?api-version=2021-04-01';
    const fake = await start();
    const keys = [
      'DDLType',
      'EntityName',
      'EntityType',
      'ObjectId',
      'ObjectVersion',
      'OriginObjectId',
      'PublishStatus',
    ];
    fake.seedDatabase('db1');
    for (const path of [
      '/databases/db1/tables/t1',
      '/databases/db1/relationships/r1',
      '/databases/db1',
    ]) {
      const put = await call(fake, 'PUT', `${path}${L}`, { body: { properties: {} } });
      assert.equal(put.status, 200, path);
      assert.deepEqual(Object.keys(put.json ?? {}).sort(), keys, path);
      assert.equal(put.headers.get('location'), null);
      assert.equal((await call(fake, 'DELETE', `${path}${L}`)).status, 200, path);
      const gone = await call(fake, 'GET', `${path}${L}`);
      assert.equal(gone.status, 404, path);
      assert.deepEqual(Object.keys(gone.json ?? {}).sort(), ['Code', 'Message'], path);
    }
  });
});

describe('fake Synapse server: DELETE', () => {
  it('sync answers 200; lro answers 202 with Location, in progress, then 200 with an empty body (or 404)', async () => {
    const fake = await start({ deleteMode: 'sync' });
    fake.seed('datasets', [{ name: 'ds' }]);
    assert.equal((await call(fake, 'DELETE', `/datasets/ds${V}`)).status, 200);
    assert.equal((await call(fake, 'DELETE', `/datasets/ds${V}`)).status, 404);

    fake.config.deleteMode = 'lro';
    fake.config.lroPolls = 1;
    fake.seed('datasets', [{ name: 'ds' }]);
    const del = await call(fake, 'DELETE', `/datasets/ds${V}`);
    assert.equal(del.status, 202);
    assert.equal(del.headers.get('retry-after'), null);
    const location = del.headers.get('location') ?? assert.fail('no Location');
    const pending = await call(fake, 'GET', location);
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.json, { status: 'InProgress' });
    const done = await call(fake, 'GET', location);
    assert.equal(done.status, 200);
    assert.equal(done.text, '');

    fake.config.lroPolls = 0;
    fake.config.deleteCompletion = 'not-found';
    fake.seed('datasets', [{ name: 'ds' }]);
    const gone = await call(fake, 'DELETE', `/datasets/ds${V}`);
    assert.equal((await call(fake, 'GET', gone.headers.get('location') ?? '')).status, 404);
  });

  describe('a started trigger', () => {
    const seeded = async (config: Partial<FakeConfig>) => {
      const fake = await start({ lroPolls: 1, ...config });
      fake.seed('triggers', [{ name: 'tr', properties: { runtimeState: 'Started' } }]);
      return fake;
    };

    it('PUT is accepted, then the operation ends Failed with TriggerEnabledCannotUpdate', async () => {
      const fake = await seeded({});
      const put = await call(fake, 'PUT', `/triggers/tr${V}`, { body: { properties: {} } });
      assert.equal(put.status, 202);
      const location = put.headers.get('location') ?? assert.fail('no Location');
      assert.equal((await call(fake, 'GET', location)).status, 202);
      const done = await call(fake, 'GET', location);
      assert.equal(done.status, 200);
      assert.deepEqual(done.json, {
        status: 'Failed',
        error: {
          code: 'TriggerEnabledCannotUpdate',
          message: 'Cannot update enabled Trigger; the trigger needs to be disabled first. ',
        },
      });
      assert.deepEqual(fake.names('triggers'), ['tr']);
    });

    it('DELETE is accepted, then the operation ends Failed with DeleteDataFactoryResourceOrchestrationError', async () => {
      const fake = await seeded({});
      const del = await call(fake, 'DELETE', `/triggers/tr${V}`);
      assert.equal(del.status, 202);
      const location = del.headers.get('location') ?? assert.fail('no Location');
      await call(fake, 'GET', location);
      const done = await call(fake, 'GET', location);
      assert.equal(done.status, 200);
      assert.equal(done.json?.status, 'Failed');
      assert.equal(
        (done.json?.error as Record<string, unknown>).code,
        'DeleteDataFactoryResourceOrchestrationError',
      );
      assert.match(JSON.stringify(done.json), /disabled first/);
      assert.deepEqual(fake.names('triggers'), ['tr']);
    });

    it('can refuse synchronously instead: 400 on the PUT, 409 with a Message on the DELETE', async () => {
      const fake = await seeded({ triggerPutMode: 'sync-400', triggerDeleteMode: 'sync-409' });
      const put = await call(fake, 'PUT', `/triggers/tr${V}`, { body: { properties: {} } });
      assert.equal(put.status, 400);
      assert.equal((put.json?.error as Record<string, unknown>).code, 'TriggerEnabledCannotUpdate');
      const del = await call(fake, 'DELETE', `/triggers/tr${V}`);
      assert.equal(del.status, 409);
      assert.match(String(del.json?.Message), /disabled first/);
      assert.deepEqual(fake.names('triggers'), ['tr']);
    });
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

  it('answers an unchanged redeploy with 200 Succeeded at once', async () => {
    const fake = await start({ endpointPolls: 0 });
    await call(fake, 'PUT', `${path}/pe${V}`, { body: { properties: { groupId: 'sql' } } });
    await call(fake, 'GET', `${path}/pe${V}`);
    const again = await call(fake, 'PUT', `${path}/pe${V}`, {
      body: { properties: { groupId: 'sql' } },
    });
    assert.equal(again.status, 200);
    assert.equal(
      (again.json?.properties as Record<string, unknown>).provisioningState,
      'Succeeded',
    );
    const changed = await call(fake, 'PUT', `${path}/pe${V}`, {
      body: { properties: { groupId: 'blob' } },
    });
    assert.equal(
      (changed.json?.properties as Record<string, unknown>).provisioningState,
      'Provisioning',
    );
  });

  it('DELETE answers 202 with no Location and no body; the endpoint is served n more times, then 404', async () => {
    const fake = await start({ endpointDeletePolls: 2, endpointPolls: 0 });
    await call(fake, 'PUT', `${path}/pe${V}`, { body: { properties: {} } });
    const del = await call(fake, 'DELETE', `${path}/pe${V}`);
    assert.equal(del.status, 202);
    assert.equal(del.headers.get('location'), null);
    assert.equal(del.text, '');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await call(fake, 'GET', `${path}/pe${V}`)).status);
    }
    assert.deepEqual(statuses, [200, 200, 404, 404]);
    const gone = await call(fake, 'GET', `${path}/pe${V}`);
    const inner = gone.json?.error as Record<string, unknown>;
    assert.equal(inner.code, 'UnknownError');
    assert.match(String(inner.message), /PrivateEndpointNotFound/);
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

  it('workspace-location: 202 with operationId and a workspace-scoped Location, no Azure-AsyncOperation', async () => {
    const fake = await start({ armPolls: 1, lroPolls: 1 });
    const put = await call(fake, 'PUT', `${path}${V}`, { headers: ARM, body: { properties: {} } });
    assert.equal(put.status, 202);
    assert.equal(put.headers.get('azure-asyncoperation'), null);
    assert.equal(put.headers.get('retry-after'), '10');
    const location = put.headers.get('location') ?? assert.fail('no Location');
    assert.match(
      location,
      new RegExp(
        `^${fake.url}/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Synapse/workspaces/myworkspace/operationResults/op\\d+\\?`,
      ),
    );
    assert.equal(put.json?.operationId, location.split('/').pop()?.split('?')[0]);
    const pending = await call(fake, 'GET', location, { headers: ARM });
    assert.equal(pending.status, 202);
    assert.equal(pending.text, '');
    const done = await call(fake, 'GET', location, { headers: ARM });
    assert.equal(done.status, 200);
    assert.deepEqual(Object.keys(done.json ?? {}).sort(), [
      'etag',
      'id',
      'name',
      'properties',
      'type',
    ]);

    const del = await call(fake, 'DELETE', `${path}${V}`, { headers: ARM });
    assert.equal(del.status, 202);
    assert.equal(del.headers.get('retry-after'), null);
    const delLocation = del.headers.get('location') ?? assert.fail('no Location');
    assert.equal((await call(fake, 'GET', delLocation, { headers: ARM })).status, 202);
    const delDone = await call(fake, 'GET', delLocation, { headers: ARM });
    assert.equal(delDone.status, 200);
    assert.equal(delDone.text, '');
    const gone = await call(fake, 'GET', `${path}${V}`, { headers: ARM });
    assert.equal(gone.status, 404);
    assert.equal((gone.json?.error as Record<string, unknown>).code, 'NotFound');
  });

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
