import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { deployIntegrationRuntime } from '../src/arm.ts';
import { armScope, dataPlaneScope, findCloud } from '../src/cloud.ts';
import { createHttp } from '../src/http.ts';
import { KINDS, kindForTemplateType } from '../src/kinds.ts';
import {
  deleteArtifact,
  deployArtifact,
  hasManagedVirtualNetwork,
  prepareEndpointBody,
} from '../src/synapse.ts';
import { startFakeSynapse } from './fake/synapse_server.ts';
import type { FakeConfig, FakeSynapse } from './fake/synapse_server.ts';
import type { Kind } from '../src/kinds.ts';
import type { ArmContext } from '../src/arm.ts';
import type { SynapseContext } from '../src/synapse.ts';

const cloud = findCloud('AzureCloud') ?? assert.fail('AzureCloud is not in the cloud table');

let server: FakeSynapse | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(config: Partial<FakeConfig> = {}) {
  const started = await startFakeSynapse(config);
  server = started;
  // A clock that moves only when the code sleeps: deadlines work, nothing
  // waits in real time.
  const waits: number[] = [];
  let time = Date.UTC(2026, 9, 9, 12, 0, 0);
  const now = () => time;
  const sleep = (ms: number) => {
    waits.push(ms);
    time += ms;
    return Promise.resolve();
  };
  const http = createHttp({ tokens: started.tokens, sleep, now });
  const ctx: SynapseContext = {
    http,
    sleep,
    now,
    dataPlane: started.endpoints.dataPlane,
    scope: dataPlaneScope(cloud),
  };
  const arm: ArmContext = {
    http,
    sleep,
    now,
    arm: `${started.endpoints.arm}/`,
    scope: armScope(cloud),
    subscriptionId: '00000000-0000-0000-0000-000000000000',
    resourceGroup: 'rg-example',
    workspace: 'myworkspace',
  };
  return { server: started, ctx, arm, waits };
}

function kind(type: string): Kind {
  const found = kindForTemplateType(`Microsoft.Synapse/workspaces/${type}`);
  assert.ok(found, type);
  return found;
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

const dataKinds = KINDS.filter((candidate) => candidate.plane === 'data');
const body = (name: string) => ({ name, type: 'x', properties: { description: `about ${name}` } });

describe('deploy and delete, every plain kind, against the fake server', () => {
  for (const mode of ['sync', 'lro', 'lro-no-location'] as const) {
    it(`deploys every kind in ${mode} mode and polls only when told`, async () => {
      const { server: fake, ctx } = await start({ putMode: mode });
      // The root operationResults collection refuses notebooks, so without a
      // Location they have no place to poll.
      const deployed = dataKinds.filter(
        (candidate) => mode !== 'lro-no-location' || candidate.collection !== 'notebooks',
      );
      for (const candidate of deployed) {
        await deployArtifact(ctx, candidate, 'my artifact', body('my artifact'));
        const stored = fake.get(candidate.collection, 'my artifact');
        assert.deepEqual(stored, body('my artifact'), candidate.id);
      }
      const puts = fake.requests.filter((r) => r.method === 'PUT');
      assert.deepEqual(
        puts.map((r) => r.path),
        deployed.map((candidate) => `/${candidate.collection}/my%20artifact`),
      );
      assert.ok(puts.every((r) => r.query === '?api-version=2019-06-01-preview'));
      assert.ok(puts.every((r) => r.authorization === 'Bearer fake-data-token'));
      const polls = fake.requests.filter((r) => r.path.startsWith('/operationResults/'));
      assert.equal(polls.length > 0, mode !== 'sync');
      if (mode === 'lro-no-location') {
        assert.ok(polls.every((r) => r.query === '?api-version=2019-06-01-preview'));
      }
    });
  }

  for (const [deleteMode, deleteCompletion] of [
    ['sync', 'ok'],
    ['lro', 'ok'],
    ['lro', 'not-found'],
  ] as const) {
    it(`deletes every kind (${deleteMode}, completion ${deleteCompletion})`, async () => {
      const { server: fake, ctx } = await start({ deleteMode, deleteCompletion });
      for (const candidate of dataKinds) {
        fake.seed(candidate.collection, [{ name: 'a_b', properties: {} }]);
        await deleteArtifact(ctx, candidate, 'a_b');
        assert.deepEqual(fake.names(candidate.collection), [], candidate.id);
      }
    });
  }

  it('treats deleting something already gone as done', async () => {
    const { ctx } = await start();
    await deleteArtifact(ctx, kind('pipelines'), 'absent');
  });

  it('refuses to delete a kind that is never deleted, and to deploy skipped or ARM kinds', async () => {
    const { ctx } = await start();
    assert.match(
      (await rejection(deleteArtifact(ctx, kind('integrationRuntimes'), 'ir'))).message,
      /never deleted/,
    );
    assert.match(
      (await rejection(deployArtifact(ctx, kind('bigDataPools'), 'p', {}))).message,
      /infrastructure as code/,
    );
    assert.match(
      (await rejection(deployArtifact(ctx, kind('integrationRuntimes'), 'ir', {}))).message,
      /Azure Resource Manager/,
    );
  });

  it('fails the deploy when the operation fails, naming the artifact and the reason', async () => {
    const { server: fake, ctx } = await start();
    fake.failOperation('pl_bad', 'a referenced dataset does not exist');
    const err = await rejection(deployArtifact(ctx, kind('pipelines'), 'pl_bad', body('pl_bad')));
    assert.match(err.message, /pipelines\/pl_bad/);
    assert.match(err.message, /a referenced dataset does not exist/);
  });

  const HINT = /Stop the trigger first; the deployer does not start or stop triggers\./;

  it('adds the trigger hint when the PUT of an enabled trigger ends Failed', async () => {
    const { server: fake, ctx } = await start();
    fake.seed('triggers', [{ name: 'tr_hourly', properties: { runtimeState: 'Started' } }]);
    const put = await rejection(
      deployArtifact(ctx, kind('triggers'), 'tr_hourly', body('tr_hourly')),
    );
    assert.match(put.message, /TriggerEnabledCannotUpdate|disabled first/);
    assert.match(put.message, HINT);
  });

  it('adds the trigger hint when the DELETE of an enabled trigger ends Failed', async () => {
    const { server: fake, ctx } = await start();
    fake.seed('triggers', [{ name: 'tr_hourly', properties: { runtimeState: 'Started' } }]);
    const del = await rejection(deleteArtifact(ctx, kind('triggers'), 'tr_hourly'));
    assert.match(del.message, /disabled first/);
    assert.match(del.message, HINT);
    assert.deepEqual(fake.names('triggers'), ['tr_hourly']);
  });

  it('adds the trigger hint when the service refuses synchronously: 400 on the PUT, 409 on the DELETE', async () => {
    const { server: fake, ctx } = await start({
      triggerPutMode: 'sync-400',
      triggerDeleteMode: 'sync-409',
    });
    fake.seed('triggers', [{ name: 'tr_hourly', properties: { runtimeState: 'Started' } }]);
    const put = await rejection(
      deployArtifact(ctx, kind('triggers'), 'tr_hourly', body('tr_hourly')),
    );
    assert.match(put.message, /disabled first/);
    assert.match(put.message, HINT);
    const del = await rejection(deleteArtifact(ctx, kind('triggers'), 'tr_hourly'));
    assert.match(del.message, /status 409: Cannot update enabled Trigger/);
    assert.match(del.message, HINT);
  });

  it('adds no hint when only the trigger name says "started", or the artifact is not a trigger', async () => {
    const { server: fake, ctx } = await start();
    fake.addFault({
      path: /triggers/,
      response: { status: 400, body: '{"error":{"message":"The recurrence is invalid."}}' },
    });
    const err = await rejection(
      deployArtifact(ctx, kind('triggers'), 'tr_started_daily', body('tr_started_daily')),
    );
    assert.match(err.message, /tr_started_daily/);
    assert.match(err.message, /recurrence is invalid/);
    assert.doesNotMatch(err.message, /Stop the trigger/);

    fake.addFault({
      path: /pipelines/,
      response: { status: 400, body: '{"error":{"message":"disabled first"}}' },
    });
    const other = await rejection(deployArtifact(ctx, kind('pipelines'), 'x', body('x')));
    assert.doesNotMatch(other.message, /Stop the trigger/);
  });

  it('sends the token for the right scope and a wrong one is refused', async () => {
    const { server: fake, ctx } = await start();
    await deployArtifact(ctx, kind('notebooks'), 'nb', body('nb'));
    assert.deepEqual([...new Set(fake.tokenScopes)], [dataPlaneScope(cloud)]);
    const wrong = await rejection(
      deployArtifact({ ...ctx, scope: armScope(cloud) }, kind('notebooks'), 'nb', body('nb')),
    );
    assert.match(wrong.message, /401/);
  });
});

describe('managed private endpoints', () => {
  const endpoint = (extra: Record<string, unknown> = {}) => ({
    name: 'pe_sql',
    properties: {
      privateLinkResourceId:
        '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Sql/servers/sqlexample',
      groupId: 'sqlServer',
      fqdns: ['sqlexample.sql.example.com'],
      ...extra,
    },
  });

  it('drops fqdns unless the target is a private link service, without changing the input', () => {
    const input = endpoint();
    const prepared = prepareEndpointBody(input) as { properties: Record<string, unknown> };
    assert.equal('fqdns' in prepared.properties, false);
    assert.ok('fqdns' in input.properties);

    const service = endpoint({
      privateLinkResourceId:
        '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/microsoft.network/PrivateLinkServices/plsexample',
    });
    const kept = prepareEndpointBody(service) as { properties: Record<string, unknown> };
    assert.deepEqual(kept.properties.fqdns, ['sqlexample.sql.example.com']);
    assert.deepEqual(prepareEndpointBody({ name: 'x' }), { name: 'x' });
  });

  it('is not done until the endpoint is provisioned', async () => {
    const { server: fake, ctx } = await start({ endpointPolls: 3 });
    const pe = kind('managedVirtualNetworks/managedPrivateEndpoints');
    await deployArtifact(ctx, pe, 'pe_sql', endpoint());
    const gets = fake.requests.filter((r) => r.method === 'GET');
    assert.equal(gets.length, 4);
    assert.deepEqual(
      (fake.get(pe.collection, 'pe_sql') as { properties: { provisioningState: string } })
        .properties.provisioningState,
      'Succeeded',
    );
    const stored = fake.get(pe.collection, 'pe_sql') as { properties: Record<string, unknown> };
    assert.equal('fqdns' in stored.properties, false);
  });

  it('works with an operation in front, and fails when provisioning fails', async () => {
    const { ctx } = await start({
      endpointPutMode: 'lro',
      endpointFinalState: 'Failed',
      endpointPolls: 0,
    });
    const err = await rejection(
      deployArtifact(
        ctx,
        kind('managedVirtualNetworks/managedPrivateEndpoints'),
        'pe_sql',
        endpoint(),
      ),
    );
    assert.match(err.message, /provisioning failed/);
  });

  it('polls the endpoint operation under the virtual network base when there is no Location', async () => {
    const { server: fake, ctx } = await start({ endpointPutMode: 'lro-no-location' });
    const pe = kind('managedVirtualNetworks/managedPrivateEndpoints');
    await deployArtifact(ctx, pe, 'pe_sql', endpoint());
    const poll = fake.requests.find((r) => r.path.includes('operationResults'));
    assert.match(poll?.path ?? '', /^\/managedVirtualNetworks\/default\/operationResults\/op\d+$/);
  });

  it('deletes an endpoint at the virtual network path', async () => {
    const { server: fake, ctx } = await start();
    const pe = kind('managedVirtualNetworks/managedPrivateEndpoints');
    fake.seed(pe.collection, [{ name: 'pe_sql', properties: {} }]);
    await deleteArtifact(ctx, pe, 'pe_sql');
    assert.equal(
      fake.writes()[0]?.path,
      '/managedVirtualNetworks/default/managedPrivateEndpoints/pe_sql',
    );
  });

  it('reports whether the workspace has a managed virtual network', async () => {
    const withVnet = await start();
    const found = await hasManagedVirtualNetwork(withVnet.ctx);
    assert.equal(found.exists, true);
    assert.equal(found.response.status, 200);
    assert.deepEqual(found.response.json(), { value: [] });
    await server?.close();
    const without = await start({ hasManagedVnet: false });
    const missing = await hasManagedVirtualNetwork(without.ctx);
    assert.equal(missing.exists, false);
    assert.equal(missing.response.status, 400);
    const pe = kind('managedVirtualNetworks/managedPrivateEndpoints');
    const err = await rejection(deployArtifact(without.ctx, pe, 'pe_sql', endpoint()));
    assert.match(err.message, /400/);
  });

  it('does not read any other failure as "no managed virtual network"', async () => {
    const { server: fake, ctx } = await start();
    fake.addFault({
      path: /managedPrivateEndpoints/,
      response: { status: 400, body: '{"error":{"message":"Something else is wrong."}}' },
    });
    const err = await rejection(hasManagedVirtualNetwork(ctx));
    assert.match(err.message, /Something else is wrong/);
  });
});

describe('lake databases (deploy half)', () => {
  const entity = (extra: Record<string, unknown>) => ({
    ActionType: 'CREATE',
    OldEntity: null,
    NewEntity: extra,
    Source: { Type: 'SPARK' },
  });
  const resource = {
    name: 'myworkspace/lakedb_example',
    properties: {
      Ddls: [
        entity({
          Name: 'lakedb_example',
          EntityType: 'DATABASE',
          Origin: { Type: 'SPARK' },
          Properties: { IsSyMSCDMDatabase: true },
        }),
        entity({
          Name: 'customers',
          EntityType: 'TABLE',
          Namespace: { DatabaseName: 'lakedb_example' },
        }),
        entity({
          Name: 'orders',
          EntityType: 'TABLE',
          Namespace: { DatabaseName: 'lakedb_example' },
        }),
        entity({
          Name: 'orders_customers',
          EntityType: 'RELATIONSHIP',
          Namespace: { DatabaseName: 'lakedb_example' },
          FromTableName: 'orders',
          ToTableName: 'customers',
        }),
      ],
    },
  };

  it('PUTs the database, then each table and relationship, at api-version 2021-04-01', async () => {
    const { server: fake, ctx } = await start();
    await deployArtifact(ctx, kind('databases'), 'lakedb_example', resource);
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    assert.deepEqual(
      puts.map((r) => `${r.path}${r.query}`),
      [
        '/databases/lakedb_example?api-version=2021-04-01',
        '/databases/lakedb_example/tables/customers?api-version=2021-04-01',
        '/databases/lakedb_example/tables/orders?api-version=2021-04-01',
        '/databases/lakedb_example/relationships/orders_customers?api-version=2021-04-01',
      ],
    );
    assert.deepEqual(puts[1]?.body, {
      name: 'customers',
      type: 'TABLE',
      properties: { Namespace: { DatabaseName: 'lakedb_example' } },
    });
    const relationship = puts[3]?.body as { properties: Record<string, unknown> };
    assert.equal(relationship.properties.RelationshipType, 0);
    assert.deepEqual(fake.databaseChildren('lakedb_example', 'tables'), ['customers', 'orders']);
    assert.deepEqual(fake.databaseChildren('lakedb_example', 'relationships'), [
      'orders_customers',
    ]);
  });

  it('keeps a RelationshipType that is already set', async () => {
    const { server: fake, ctx } = await start();
    const withType = {
      properties: {
        Ddls: [
          entity({
            Name: 'r',
            EntityType: 'RELATIONSHIP',
            Namespace: { DatabaseName: 'd' },
            RelationshipType: 2,
          }),
        ],
      },
    };
    fake.seedDatabase('d');
    await deployArtifact(ctx, kind('databases'), 'd', withType);
    const sent = fake.requests.find((r) => r.method === 'PUT')?.body as {
      properties: Record<string, unknown>;
    };
    assert.equal(sent.properties.RelationshipType, 2);
  });

  it('polls a 202 with Location, and fails on malformed DDLs with a fix', async () => {
    const { server: fake, ctx } = await start();
    fake.addFault({
      method: 'PUT',
      path: /^\/databases\/lakedb_example$/,
      response: { status: 202, headers: { Location: '/operationResults/op1' } },
    });
    fake.addFault({ method: 'GET', path: /operationResults/, response: { status: 202 } });
    fake.addFault({
      method: 'GET',
      path: /operationResults/,
      nth: 2,
      response: { status: 200, body: '{}' },
    });
    await deployArtifact(ctx, kind('databases'), 'lakedb_example', {
      properties: { Ddls: [entity({ Name: 'lakedb_example', EntityType: 'DATABASE' })] },
    });
    assert.equal(fake.requests.filter((r) => r.path === '/operationResults/op1').length, 2);

    for (const bad of [
      {},
      { properties: {} },
      { properties: { Ddls: [{}] } },
      { properties: { Ddls: [entity({ EntityType: 'TABLE' })] } },
      { properties: { Ddls: [entity({ Name: 't', EntityType: 'TABLE' })] } },
    ]) {
      const err = await rejection(deployArtifact(ctx, kind('databases'), 'd', bad));
      assert.match(err.message, /Lake database d/);
      assert.match(err.message, /re-export/);
    }
  });

  it('fails a 202 without Location and any PUT that is not 2xx', async () => {
    const { server: fake, ctx } = await start();
    const one = { properties: { Ddls: [entity({ Name: 'd', EntityType: 'DATABASE' })] } };
    fake.addFault({ method: 'PUT', path: /databases/, response: { status: 202 } });
    const accepted = await rejection(deployArtifact(ctx, kind('databases'), 'd', one));
    assert.match(accepted.message, /202 without an operation ID or Location/);

    fake.addFault({
      method: 'PUT',
      path: /databases/,
      response: { status: 409, body: '{"error":{"message":"conflict"}}' },
    });
    const conflict = await rejection(deployArtifact(ctx, kind('databases'), 'd', one));
    assert.match(conflict.message, /409/);
    assert.match(conflict.message, /conflict/);
  });

  it('accepts 200, 201 and 204 for a lake database entity', async () => {
    for (const status of [200, 201, 204]) {
      const { server: fake, ctx } = await start();
      fake.addFault({
        method: 'PUT',
        path: /databases/,
        response: { status, body: status === 204 ? '' : '{}' },
      });
      await deployArtifact(ctx, kind('databases'), 'd', {
        properties: { Ddls: [entity({ Name: 'd', EntityType: 'DATABASE' })] },
      });
      await server?.close();
    }
  });

  it('deletes a lake database', async () => {
    const { server: fake, ctx } = await start();
    fake.seedDatabase('lakedb_example');
    await deleteArtifact(ctx, kind('databases'), 'lakedb_example');
    assert.equal(fake.writes()[0]?.query, '?api-version=2021-04-01');
  });
});

describe('integration runtimes through ARM', () => {
  const ir = { name: 'x', properties: { type: 'Managed', typeProperties: {} } };
  const path =
    '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Synapse/workspaces/myworkspace/integrationRuntimes/ir_example';

  for (const armMode of [
    'workspace-location',
    'async-operation',
    'location-only',
    'provisioning-body',
    'sync',
  ] as const) {
    it(`deploys in ${armMode} mode with the ARM token`, async () => {
      const { server: fake, arm } = await start({ armMode });
      await deployIntegrationRuntime(arm, 'ir_example', ir);
      const put = fake.requests.find((r) => r.method === 'PUT');
      assert.equal(put?.path, path);
      assert.equal(put?.query, '?api-version=2019-06-01-preview');
      assert.equal(put?.authorization, 'Bearer fake-arm-token');
      assert.deepEqual(put?.body, ir);
      assert.equal(fake.requests.length > 1, armMode !== 'sync');
      assert.deepEqual([...new Set(fake.tokenScopes)], [armScope(cloud)]);
    });
  }

  it('polls an operationId without Location under the workspace path', async () => {
    const { server: fake, arm } = await start({ armMode: 'operation-id' });
    await deployIntegrationRuntime(arm, 'ir_example', ir);
    const poll = fake.requests.find((r) => r.path.includes('operationResults'));
    assert.equal(
      poll?.path.replace(/op\d+$/, 'OP'),
      '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example/providers/Microsoft.Synapse/workspaces/myworkspace/operationResults/OP',
    );
  });

  it('fails when the ARM operation fails', async () => {
    const { server: fake, arm } = await start();
    fake.failOperation('ir_example', 'the runtime could not be created');
    const err = await rejection(deployIntegrationRuntime(arm, 'ir_example', ir));
    assert.match(err.message, /could not be created/);
  });

  it('refuses an Azure-AsyncOperation on another host', async () => {
    const { server: fake, arm } = await start();
    fake.addFault({
      method: 'PUT',
      path: /integrationRuntimes/,
      response: {
        status: 201,
        headers: { 'Azure-AsyncOperation': 'http://localhost:1/asyncOperations/a' },
        body: '{}',
      },
    });
    const err = await rejection(deployIntegrationRuntime(arm, 'ir_example', ir));
    assert.match(err.message, /Refusing to send the token to localhost:1/);
  });
});

describe('faults surface through the clients', () => {
  it('recovers from a 503 and fails after five in a row', async () => {
    const { server: fake, ctx, waits } = await start({ putMode: 'sync' });
    fake.addFault({ method: 'PUT', path: /pipelines/, response: { status: 503, body: 'busy' } });
    await deployArtifact(ctx, kind('pipelines'), 'pl', body('pl'));
    assert.equal(waits.length, 1);

    fake.clearFaults();
    fake.addFault({
      method: 'PUT',
      path: /pipelines/,
      count: Number.POSITIVE_INFINITY,
      response: { status: 503, body: 'busy' },
    });
    const err = await rejection(deployArtifact(ctx, kind('pipelines'), 'pl', body('pl')));
    assert.match(err.message, /after 5 attempts/);
  });

  it('fails on a redirect', async () => {
    const { server: fake, ctx } = await start();
    fake.addFault({
      path: /pipelines/,
      response: { status: 302, headers: { Location: 'http://localhost:1/x' } },
    });
    const err = await rejection(deployArtifact(ctx, kind('pipelines'), 'pl', body('pl')));
    assert.match(err.message, /redirect/i);
  });

  it('refuses a Location on another host', async () => {
    const { server: fake, ctx } = await start();
    fake.addFault({
      method: 'PUT',
      path: /pipelines/,
      response: {
        status: 202,
        headers: { Location: 'http://localhost:1/operationResults/x' },
        body: '{"operationId":"x"}',
      },
    });
    const err = await rejection(deployArtifact(ctx, kind('pipelines'), 'pl', body('pl')));
    assert.match(err.message, /Refusing to send the token to localhost:1/);
  });

  it('fails, rather than hangs, on a reset, a body that stops and a closed connection', async () => {
    const { server: fake, waits } = await start();
    const http = createHttp({
      tokens: fake.tokens,
      sleep: () => Promise.resolve(),
      maxAttempts: 2,
      bodyIdleTimeoutMs: 100,
    });
    const url = `${fake.url}/pipelines/pl?api-version=2019-06-01-preview`;
    for (const response of [{ reset: true }, { stallBody: true }, { closeEarly: true }] as const) {
      fake.clearFaults();
      fake.addFault({ path: /pipelines/, count: Number.POSITIVE_INFINITY, response });
      const err = await rejection(http.request('GET', url, dataPlaneScope(cloud)));
      assert.match(err.message, /after 2 attempts/);
    }
    assert.deepEqual(waits, []);
  });
});

describe('concurrency is observable', () => {
  it('records the most operations in flight at once', async () => {
    const { server: fake, ctx } = await start({ latencyMs: 20 });
    await Promise.all(
      ['a', 'b', 'c'].map((name) => deployArtifact(ctx, kind('pipelines'), name, body(name))),
    );
    assert.ok(fake.maxConcurrentOperations >= 2, String(fake.maxConcurrentOperations));
    assert.ok(fake.maxConcurrentOperations <= 3);
  });
});
