import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { MAX_PARALLEL } from '../src/graph.ts';
import { PENDING_REQUESTS_MESSAGE } from '../src/exit_guard.ts';
import { run } from '../src/run.ts';
import type { Counts } from '../src/report.ts';
import type { Inputs } from '../src/inputs.ts';
import type { Deps } from '../src/run.ts';
import { startFakeSynapse } from './fake/synapse_server.ts';
import type { FakeConfig, FakeSynapse, RecordedRequest } from './fake/synapse_server.ts';
import { depsFor, reference, resource, setup, template, WORKSPACE } from './support/e2e.ts';

const ENDPOINTS = 'managedVirtualNetworks/default/managedPrivateEndpoints';
const ZERO = '00000000-0000-0000-0000-000000000000';

let server: FakeSynapse | undefined;

async function start(config: Partial<FakeConfig> = {}): Promise<FakeSynapse> {
  server = await startFakeSynapse(config);
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Outcome {
  counts?: Counts;
  error?: Error;
  log: string;
  outputs: Record<string, string>;
  summary: string;
}

/**
 * Runs the action's run() with stdout captured (workflow commands such as
 * ::error:: would otherwise be acted on by the runner that runs these tests)
 * and the runner's output and summary files pointed at temp files.
 */
async function execute(inputs: Inputs, deps: Deps): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-deploy-run-'));
  const outputFile = join(dir, 'output');
  const summaryFile = join(dir, 'summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const saved = { ...process.env };
  process.env['GITHUB_OUTPUT'] = outputFile;
  process.env['GITHUB_STEP_SUMMARY'] = summaryFile;

  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // The test runner reports from this process through the same stream, as
  // bytes; the action's own output is always text.
  process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string') {
      written.push(chunk);
      return true;
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  const outcome: Outcome = { log: '', outputs: {}, summary: '' };
  try {
    outcome.counts = await run(inputs, deps);
  } catch (error) {
    outcome.error = error as Error;
  } finally {
    process.stdout.write = original;
    process.env['GITHUB_OUTPUT'] = saved['GITHUB_OUTPUT'];
    process.env['GITHUB_STEP_SUMMARY'] = saved['GITHUB_STEP_SUMMARY'];
    if (saved['GITHUB_OUTPUT'] === undefined) delete process.env['GITHUB_OUTPUT'];
    if (saved['GITHUB_STEP_SUMMARY'] === undefined) delete process.env['GITHUB_STEP_SUMMARY'];
  }
  outcome.log = written.join('');
  for (const match of readFileSync(outputFile, 'utf8').matchAll(
    /^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm,
  )) {
    outcome.outputs[match[1] ?? ''] = match[3] ?? '';
  }
  outcome.summary = readFileSync(summaryFile, 'utf8');
  return outcome;
}

function ok(outcome: Outcome): Counts {
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.ok(outcome.counts);
  return outcome.counts;
}

function failure(outcome: Outcome): string {
  assert.ok(outcome.error, 'expected the run to fail');
  return outcome.error.message;
}

const decoded = (r: RecordedRequest) => decodeURIComponent(r.path);
const puts = (fake: FakeSynapse) => fake.writes().filter((r) => r.method === 'PUT');
const deletes = (fake: FakeSynapse) => fake.writes().filter((r) => r.method === 'DELETE');

const database = (name: string, extra: Record<string, unknown>[] = []) =>
  resource('databases', name, {
    Ddls: [
      {
        ActionType: 'CREATE',
        OldEntity: null,
        NewEntity: {
          Name: name,
          EntityType: 'DATABASE',
          Origin: { Type: 'SPARK' },
          Properties: { IsSyMSCDMDatabase: true },
        },
      },
      ...extra,
    ],
  });
const table = (db: string, name: string) => ({
  ActionType: 'CREATE',
  OldEntity: null,
  NewEntity: { Name: name, EntityType: 'TABLE', Namespace: { DatabaseName: db }, Properties: {} },
});
const relationship = (db: string, name: string) => ({
  ActionType: 'CREATE',
  OldEntity: null,
  NewEntity: {
    Name: name,
    EntityType: 'RELATIONSHIP',
    Namespace: { DatabaseName: db },
    Properties: {},
  },
});

/** Every kind, written in reverse dependency order so that file order cannot hide a bug. */
function fullTemplate() {
  return [
    resource('triggers', 'tr_daily', { runtimeState: 'Stopped' }, ['pipelines/pl_main']),
    resource(
      'pipelines',
      'pl_main',
      {
        activities: [
          {
            name: 'a',
            type: 'Copy',
            typeProperties: { dataset: reference('ds_in', 'DatasetReference') },
          },
        ],
      },
      ['datasets/ds_in', 'notebooks/nb_a'],
    ),
    resource('dataflows', 'df_a', {}, ['datasets/ds_in']),
    resource('datasets', 'ds_in', {}, ['linkedServices/ls_blob']),
    resource('linkedServices', 'ls_blob', { type: 'AzureBlobFS' }),
    resource('notebooks', 'nb_a'),
    resource('sqlscripts', 'sql_a'),
    resource('kqlscripts', 'kql_a'),
    resource('sparkConfigurations', 'spk_cfg'),
    resource('sparkJobDefinitions', 'job_a', {
      jobProperties: { file: 'abfss://data@stexample.dfs.core.windows.net/main.py' },
    }),
    resource('credentials', 'cred_a'),
    database('lake_keep', [table('lake_keep', 'customers'), relationship('lake_keep', 'rel_keep')]),
    resource('managedVirtualNetworks/managedPrivateEndpoints', 'pe_storage', { groupId: 'dfs' }, [
      'managedVirtualNetworks/default',
    ]),
    resource('integrationRuntimes', 'ir_a', { type: 'Managed' }),
    resource('managedVirtualNetworks', 'default'),
    resource('bigDataPools', 'pool1'),
    resource('linkedServices', `${WORKSPACE}-WorkspaceDefaultStorage`),
    resource('managedVirtualNetworks/managedPrivateEndpoints', `synapse-ws-sql--${WORKSPACE}`, {}, [
      'managedVirtualNetworks/default',
    ]),
  ];
}

describe('run: a full deploy', () => {
  it('deploys every kind in dependency order, with the right bodies, tokens and outputs', async () => {
    const fake = await start({ latencyMs: 2 });
    const inputs = setup(fullTemplate(), {
      deployManagedPrivateEndpoints: true,
      subscriptionId: ZERO,
      resourceGroup: 'rg-example',
    });
    const outcome = await execute(inputs, depsFor(fake));

    assert.deepEqual(ok(outcome), { deployed: 14, skipped: 4, deleted: 0 });
    assert.deepEqual(outcome.outputs, { deployed: '14', skipped: '4', deleted: '0' });

    const order = puts(fake).map(decoded);
    const before = (first: string, second: string) =>
      assert.ok(
        order.findIndex((p) => p.startsWith(first)) < order.findIndex((p) => p.startsWith(second)),
        `${first} before ${second}: ${order.join(', ')}`,
      );
    before('/linkedServices/ls_blob', '/datasets/ds_in');
    before('/datasets/ds_in', '/pipelines/pl_main');
    before('/datasets/ds_in', '/dataflows/df_a');
    before('/notebooks/nb_a', '/pipelines/pl_main');
    before('/pipelines/pl_main', '/triggers/tr_daily');

    // The workspace's own defaults, pools and the network are never written.
    assert.ok(
      !order.some((p) =>
        /WorkspaceDefault|synapse-ws-|pool1|managedVirtualNetworks\/default\?/.test(p),
      ),
    );
    assert.equal(fake.get('pipelines', 'pl_main')?.['properties'] !== undefined, true);
    assert.deepEqual(fake.names('managedVirtualNetworks/default/managedPrivateEndpoints'), [
      'pe_storage',
    ]);
    assert.deepEqual(fake.databaseChildren('lake_keep', 'tables'), ['customers']);
    assert.deepEqual(fake.databaseChildren('lake_keep', 'relationships'), ['rel_keep']);

    const arm = puts(fake).find((r) => r.path.includes('/integrationRuntimes/ir_a'));
    assert.ok(arm, 'the integration runtime goes through ARM');
    assert.equal(arm.authorization, 'Bearer fake-arm-token');
    assert.ok(arm.path.startsWith(`/subscriptions/${ZERO}/resourceGroups/rg-example/`));
    assert.ok(
      puts(fake)
        .filter((r) => r !== arm)
        .every((r) => r.authorization === 'Bearer fake-data-token'),
    );

    assert.match(outcome.log, /^deployed pipelines\/pl_main \(\d+\.\d s\)$/m);
    assert.match(
      outcome.log,
      /^skipped linkedServices\/myworkspace-WorkspaceDefaultStorage \(service default\)$/m,
    );
    assert.match(outcome.log, /^::group::Deploy \(14\)$/m);
    assert.match(outcome.summary, /^## Synapse deploy$/m);
    assert.match(outcome.summary, /Deployed 14, skipped 4 and deleted 0\./);
    assert.match(outcome.summary, /\| pipelines\/pl_main \| deployed \| /);
    assert.match(
      outcome.summary,
      /\| bigDataPools\/pool1 \| skipped \| left to infrastructure as code \|/,
    );
  });

  it('redeploys idempotently', async () => {
    const fake = await start();
    const inputs = setup(fullTemplate(), {
      deployManagedPrivateEndpoints: true,
      subscriptionId: ZERO,
      resourceGroup: 'rg-example',
    });
    ok(await execute(inputs, depsFor(fake)));
    assert.deepEqual(ok(await execute(inputs, depsFor(fake))), {
      deployed: 14,
      skipped: 4,
      deleted: 0,
    });
  });

  it('leaves endpoints alone unless asked, and never calls the endpoint paths', async () => {
    const fake = await start();
    const inputs = setup(fullTemplate(), { subscriptionId: ZERO, resourceGroup: 'rg-example' });
    const counts = ok(await execute(inputs, depsFor(fake)));
    assert.deepEqual(counts, { deployed: 13, skipped: 5, deleted: 0 });
    assert.ok(!fake.requests.some((r) => r.path.startsWith('/managedVirtualNetworks')));
  });

  it('runs at most 8 operations at once', async () => {
    const fake = await start({ lroPolls: 2, latencyMs: 15 });
    const notebooks = Array.from({ length: 24 }, (_, i) => resource('notebooks', `nb_${i}`));
    ok(await execute(setup(notebooks), depsFor(fake)));
    assert.equal(fake.names('notebooks').length, 24);
    assert.equal(fake.maxConcurrentOperations, MAX_PARALLEL);
  });

  it('fails in phase 1 without any request when the template is wrong', async () => {
    const fake = await start();
    const bad = setup([resource('pipelines', 'pl_a', { v: "[concat('a', string(1))]" })]);
    assert.match(failure(await execute(bad, depsFor(fake))), /string\(1\)|unsupported|concat/);
    const cycle = setup([
      resource('pipelines', 'pl_a', {}, ['pipelines/pl_b']),
      resource('pipelines', 'pl_b', {}, ['pipelines/pl_a']),
    ]);
    assert.match(failure(await execute(cycle, depsFor(fake))), /Dependency cycle/);
    const runtime = setup([resource('integrationRuntimes', 'ir_a')]);
    assert.match(
      failure(await execute(runtime, depsFor(fake))),
      /subscription-id and resource-group/,
    );
    assert.equal(fake.requests.length, 0);
    assert.equal(fake.tokenScopes.length, 0);
  });
});

describe('run: failures', () => {
  it('stops on the first failure, drains what is in flight and skips deletion', async () => {
    const fake = await start({ lroPolls: 1, latencyMs: 10 });
    fake.failOperation('pl_bad', 'dataset missing');
    fake.seed('pipelines', [{ name: 'pl_extra', properties: {} }]);
    const resources = [
      resource('pipelines', 'pl_bad'),
      resource('pipelines', 'pl_after', {}, ['pipelines/pl_bad']),
      ...Array.from({ length: 14 }, (_, i) => resource('notebooks', `nb_${i}`)),
    ];
    const outcome = await execute(setup(resources, { deleteArtifacts: true }), depsFor(fake));

    const message = failure(outcome);
    assert.match(
      message,
      /^Deployed \d+ of 16; 1 failed \(pipelines\/pl_bad\); \d+ not started\. Deletion skipped because deployment failed\.$/,
    );
    assert.match(outcome.log, /^::error title=pipelines\/pl_bad::.*dataset missing/m);
    assert.match(outcome.log, /^failed pipelines\/pl_bad: .*dataset missing/m);
    assert.ok(!puts(fake).some((r) => r.path.includes('pl_after')), 'a dependent must not start');
    assert.equal(deletes(fake).length, 0);
    assert.ok(fake.get('pipelines', 'pl_extra'), 'nothing is deleted after a failure');

    // Everything started was followed to its end: each operation polled to its final answer.
    const polls = new Map<string, number>();
    for (const r of fake.requests.filter((q) => q.path.startsWith('/operationResults/'))) {
      polls.set(r.path, (polls.get(r.path) ?? 0) + 1);
    }
    assert.equal(polls.size, puts(fake).length);
    assert.ok(
      [...polls.values()].every((count) => count === 2),
      [...polls.values()].join(),
    );
    const settled = fake.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fake.requests.length, settled, 'no request is still in flight');

    assert.equal(outcome.outputs['deployed'], /^Deployed (\d+) of/.exec(message)?.[1]);
    assert.match(outcome.summary, /\| pipelines\/pl_bad \| failed \| .*dataset missing/);
    assert.match(outcome.summary, /\| pipelines\/pl_after \| not started \|/);
    assert.match(outcome.summary, /^\*\*Deployed \d+ of 16/m);
  });

  it('names a failed deletion and still counts the others', async () => {
    const fake = await start({ lroPolls: 0 });
    fake.seed('pipelines', [
      { name: 'pl_a', properties: {} },
      { name: 'pl_b', properties: {} },
    ]);
    fake.failOperation('pl_a', 'cannot delete');
    const outcome = await execute(
      setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(
      failure(outcome),
      /^Deletion failed: 1 of 2 failed \(pipelines\/pl_a\); \d+ not started\.$/,
    );
    assert.deepEqual(outcome.outputs, { deployed: '1', skipped: '0', deleted: '1' });
    assert.equal(fake.get('pipelines', 'pl_b'), undefined);
    assert.match(outcome.log, /^::error title=pipelines\/pl_a::/m);
  });
});

describe('run: deletion', () => {
  const live = (fake: FakeSynapse) => {
    fake.seed('pipelines', [
      {
        name: 'pl_old',
        properties: {
          activities: [{ typeProperties: { dataset: reference('ds_old', 'DatasetReference') } }],
        },
      },
      { name: 'PL_KEEP', properties: {} },
    ]);
    fake.seed('triggers', [
      {
        name: 'tr_old',
        properties: {
          pipelines: [{ pipelineReference: reference('pl_old', 'PipelineReference') }],
        },
      },
    ]);
    fake.seed('datasets', [
      {
        name: 'ds_old',
        properties: { linkedServiceName: reference('ls_old', 'LinkedServiceReference') },
      },
    ]);
    fake.seed('linkedServices', [
      { name: 'ls_old', properties: {} },
      { name: `${WORKSPACE}-WorkspaceDefaultStorage`, properties: {} },
      { name: `${WORKSPACE}-WorkspaceDefaultSqlServer`, properties: {} },
      { name: 'x-WorkspaceDefaultStorage-copy', properties: {} },
    ]);
    fake.seed('credentials', [
      { name: 'WorkspaceSystemIdentity', properties: {} },
      { name: 'cred_old', properties: {} },
    ]);
    fake.seed('notebooks', [{ name: 'nb_old', properties: {} }]);
    fake.seed('sqlScripts', [{ name: 'sql_old', properties: {} }]);
    fake.seed(ENDPOINTS, [
      { name: 'pe_old', properties: {} },
      { name: 'pe_keep', properties: {} },
      { name: `synapse-ws-sql--${WORKSPACE}`, properties: {} },
      { name: `synapse-ws-custstgacct--${WORKSPACE}-stexample`, properties: {} },
    ]);
    fake.seedDatabase('spark_made', { symscdm: false });
    fake.seedDatabase('other_origin', { origin: 'OTHER' });
    for (const name of ['lake_old', 'lake_a', 'lake_b']) {
      fake.seedDatabase(name);
    }
    fake.seedDatabase('lake_other', { tables: ['t1'], relationships: ['r1'] });
    fake.seedDatabase('lake_keep', {
      tables: ['CUSTOMERS', 'stale_table'],
      relationships: ['rel_old', 'rel_keep'],
    });
  };
  const keep = () => [
    resource('pipelines', 'pl_keep'),
    resource('managedVirtualNetworks/managedPrivateEndpoints', 'pe_keep', { groupId: 'dfs' }, [
      'managedVirtualNetworks/default',
    ]),
    resource('managedVirtualNetworks', 'default'),
    database('lake_keep', [table('lake_keep', 'Customers'), relationship('lake_keep', 'rel_keep')]),
  ];
  const common = [
    '/credentials/cred_old',
    '/databases/lake_a',
    '/databases/lake_b',
    '/databases/lake_keep/relationships/rel_old',
    '/databases/lake_keep/tables/stale_table',
    '/databases/lake_old',
    '/databases/lake_other',
    '/datasets/ds_old',
    '/linkedServices/ls_old',
    '/linkedServices/x-WorkspaceDefaultStorage-copy',
    '/notebooks/nb_old',
    '/pipelines/pl_old',
    '/sqlScripts/sql_old',
    '/triggers/tr_old',
  ];

  for (const withEndpoints of [false, true]) {
    it(`deletes exactly what the template no longer holds (endpoints deployed: ${withEndpoints})`, async () => {
      const fake = await start({ latencyMs: 2 });
      live(fake);
      const outcome = await execute(
        setup(keep(), { deleteArtifacts: true, deployManagedPrivateEndpoints: withEndpoints }),
        depsFor(fake),
      );
      const counts = ok(outcome);

      const expected = withEndpoints ? [...common, `/${ENDPOINTS}/pe_old`] : common;
      assert.deepEqual(deletes(fake).map(decoded).sort(), expected.sort());
      // Children are not artifacts; the count follows the artifacts only.
      assert.equal(counts.deleted, expected.length - 2);
      assert.ok(!deletes(fake).some((r) => r.path.startsWith('/databases/lake_other/')));
      assert.equal(outcome.outputs['deleted'], String(expected.length - 2));
      assert.match(outcome.summary, /\(and 2 lake database tables or relationships\)\./);

      const order = deletes(fake).map(decoded);
      const at = (path: string) => order.indexOf(path);
      assert.ok(at('/triggers/tr_old') < at('/pipelines/pl_old'), order.join());
      assert.ok(at('/pipelines/pl_old') < at('/datasets/ds_old'), order.join());
      assert.ok(at('/datasets/ds_old') < at('/linkedServices/ls_old'), order.join());
      assert.ok(
        at('/databases/lake_keep/relationships/rel_old') <
          at('/databases/lake_keep/tables/stale_table'),
      );

      // Never touched: defaults, the template's own, Spark-created databases.
      assert.ok(fake.get('pipelines', 'PL_KEEP'));
      assert.ok(fake.get('linkedServices', `${WORKSPACE}-WorkspaceDefaultStorage`));
      assert.ok(fake.get('linkedServices', `${WORKSPACE}-WorkspaceDefaultSqlServer`));
      assert.ok(fake.get('credentials', 'WorkspaceSystemIdentity'));
      assert.ok(fake.get(ENDPOINTS, `synapse-ws-sql--${WORKSPACE}`));
      assert.ok(fake.get(ENDPOINTS, 'pe_keep'));
      assert.ok(fake.get(ENDPOINTS, `synapse-ws-custstgacct--${WORKSPACE}-stexample`));
      assert.equal(fake.get(ENDPOINTS, 'pe_old') !== undefined, !withEndpoints);
      assert.deepEqual(
        fake.databaseChildren('lake_keep', 'tables').map((n) => n.toLowerCase()),
        ['customers'],
      );
      assert.deepEqual(fake.databaseChildren('lake_keep', 'relationships'), ['rel_keep']);
      assert.ok(
        !fake.requests.some((r) => /integrationRuntimes/.test(r.path) && r.method !== 'PUT'),
      );
      assert.ok(!fake.requests.some((r) => r.path === '/databases/spark_made'));
      assert.equal(
        fake.requests.some((r) => r.path.startsWith('/managedVirtualNetworks')),
        withEndpoints,
      );

      // Paging: nextLink for plain lists, continuationToken (URL-encoded) for databases.
      assert.ok(fake.requests.some((r) => r.query.includes('skiptoken=')));
      assert.ok(fake.requests.some((r) => r.query.includes('continuationToken=cursor%2B%2F')));
      assert.match(outcome.summary, /\| triggers\/tr_old \| deleted \|/);
      assert.match(outcome.summary, /\| databases\/lake_keep relationship rel_old \| deleted \|/);
    });
  }

  it('never deletes integration runtimes, pools or the network, and leaves defaults deployed names alone', async () => {
    const fake = await start();
    const counts = ok(
      await execute(
        setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
        depsFor(fake),
      ),
    );
    assert.deepEqual(counts, { deployed: 1, skipped: 0, deleted: 0 });
    const listed = fake.requests.filter((r) => r.method === 'GET').map((r) => r.path);
    assert.ok(!listed.some((p) => /integrationRuntimes|bigDataPools|sqlPools/.test(p)));
    assert.ok(!listed.some((p) => p.startsWith('/managedVirtualNetworks')));
  });

  it('refuses a nextLink that points at another host, before changing anything', async () => {
    const fake = await start();
    fake.addFault({
      method: 'GET',
      path: /^\/datasets$/,
      response: {
        status: 200,
        body: JSON.stringify({ value: [], nextLink: 'http://127.0.0.1:1/datasets?x=1' }),
      },
    });
    const outcome = await execute(
      setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(failure(outcome), /Refusing to send the token to 127\.0\.0\.1:1/);
    assert.equal(fake.writes().length, 0);
  });

  it('fails before deleting when the live artifacts refer to each other in a cycle', async () => {
    const fake = await start();
    fake.seed('pipelines', [
      { name: 'pl_a', properties: { x: reference('pl_b', 'PipelineReference') } },
      { name: 'pl_b', properties: { x: reference('pl_a', 'PipelineReference') } },
    ]);
    const outcome = await execute(
      setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(
      failure(outcome),
      /pipelines\/pl_a -> pipelines\/pl_b -> pipelines\/pl_a|refer to one another/,
    );
    assert.equal(fake.writes().length, 0);
  });
});

describe('run: a workspace without a managed virtual network', () => {
  const endpointTemplate = () => [
    resource('pipelines', 'pl_a'),
    resource('managedVirtualNetworks/managedPrivateEndpoints', 'pe_storage', { groupId: 'dfs' }, [
      'managedVirtualNetworks/default',
    ]),
    resource('managedVirtualNetworks', 'default'),
    resource('managedVirtualNetworks/managedPrivateEndpoints', `synapse-ws-sql--${WORKSPACE}`, {}, [
      'managedVirtualNetworks/default',
    ]),
  ];

  it('fails before any write when an endpoint is to be deployed', async () => {
    const fake = await start({ hasManagedVnet: false });
    for (const deleteArtifacts of [false, true]) {
      const outcome = await execute(
        setup(endpointTemplate(), { deployManagedPrivateEndpoints: true, deleteArtifacts }),
        depsFor(fake),
      );
      const message = failure(outcome);
      assert.match(
        message,
        /deploy-managed-private-endpoints is true, but workspace myworkspace has no managed virtual network/,
      );
      assert.match(message, /managedPrivateEndpoints\/pe_storage/);
      assert.doesNotMatch(message, /synapse-ws-sql/);
      assert.equal(fake.writes().length, 0);
    }
  });

  it('succeeds when the template has no endpoint to deploy, with or without delete-artifacts', async () => {
    const fake = await start({ hasManagedVnet: false });
    fake.seed('pipelines', [{ name: 'pl_old', properties: {} }]);
    const templateWithoutEndpoints = [resource('pipelines', 'pl_a')];
    for (const deleteArtifacts of [false, true]) {
      const outcome = await execute(
        setup(templateWithoutEndpoints, { deployManagedPrivateEndpoints: true, deleteArtifacts }),
        depsFor(fake),
      );
      ok(outcome);
      assert.match(outcome.log, /has no managed virtual network: no endpoints to deploy or delete/);
    }
    assert.deepEqual(deletes(fake).map(decoded), ['/pipelines/pl_old']);
    assert.ok(!deletes(fake).some((r) => r.path.includes('managedVirtualNetworks')));
  });

  it('is not probed at all when endpoints are not deployed', async () => {
    const fake = await start({ hasManagedVnet: false });
    const counts = ok(
      await execute(setup(endpointTemplate(), { deleteArtifacts: true }), depsFor(fake)),
    );
    assert.deepEqual(counts, { deployed: 1, skipped: 3, deleted: 0 });
    assert.ok(!fake.requests.some((r) => r.path.startsWith('/managedVirtualNetworks')));
  });

  it('does not read another failure of the endpoint list as "no virtual network"', async () => {
    const fake = await start();
    fake.addFault({
      method: 'GET',
      path: /^\/managedVirtualNetworks\//,
      response: { status: 403, body: '{"error":{"message":"forbidden"}}' },
    });
    const outcome = await execute(
      setup([resource('pipelines', 'pl_a')], {
        deployManagedPrivateEndpoints: true,
        deleteArtifacts: true,
      }),
      depsFor(fake),
    );
    assert.match(failure(outcome), /403/);
    assert.equal(fake.writes().length, 0);
  });
});

describe('run: dry run', () => {
  it('reports what would change and writes nothing', async () => {
    const fake = await start();
    fake.seed('pipelines', [{ name: 'pl_old', properties: {} }]);
    fake.seed(ENDPOINTS, [{ name: 'pe_old', properties: {} }]);
    fake.seedDatabase('lake_keep', { tables: ['stale_table'], relationships: ['rel_old'] });
    const inputs = setup(
      [...fullTemplate().filter((r) => !String(r['type']).endsWith('integrationRuntimes'))],
      { dryRun: true, deleteArtifacts: true, deployManagedPrivateEndpoints: true },
    );
    const outcome = await execute(inputs, depsFor(fake));

    assert.deepEqual(ok(outcome), { deployed: 13, skipped: 4, deleted: 2 });
    assert.deepEqual(outcome.outputs, { deployed: '13', skipped: '4', deleted: '2' });
    assert.equal(fake.writes().length, 0);
    assert.ok(fake.requests.length > 0, 'a dry run still reads the workspace');
    assert.ok(fake.get('pipelines', 'pl_old'));
    assert.match(outcome.log, /^would delete pipelines\/pl_old$/m);
    assert.match(outcome.log, /^would delete databases\/lake_keep table stale_table$/m);
    assert.match(outcome.summary, /^## Synapse deploy \(dry run\)$/m);
    assert.match(
      outcome.summary,
      /Would deploy 13, skip 4 and delete 2 \(and 2 lake database tables or relationships\)\./,
    );
    assert.match(outcome.summary, /\| pipelines\/pl_old \| would delete \|/);
  });

  it('signs in and still fails on a template error or a missing right', async () => {
    const fake = await start();
    fake.addFault({
      method: 'GET',
      path: /^\/pipelines$/,
      response: { status: 403, body: '{"error":{"message":"no access"}}' },
    });
    const outcome = await execute(
      setup([resource('notebooks', 'nb_a')], { dryRun: true, deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(failure(outcome), /403/);
    assert.equal(fake.writes().length, 0);
  });
});

describe('summary', () => {
  it('trims long tables and keeps artifact text from breaking the markdown', async () => {
    const fake = await start({ putMode: 'sync' });
    const notebooks = Array.from({ length: 1_005 }, (_, i) => resource('notebooks', `nb_${i}`));
    notebooks.push(resource('notebooks', 'a|b<c>'));
    const outcome = await execute(setup(notebooks), depsFor(fake));
    ok(outcome);
    assert.match(outcome.summary, /6 more row\(s\) are not shown/);
    assert.ok(!outcome.summary.includes('a|b<c>'));
    assert.equal(
      outcome.summary.split('\n').filter((l) => l.startsWith('| notebooks/')).length,
      1_000,
    );
  });
});

describe('the exit guard', () => {
  const child = join(import.meta.dirname, 'support', 'hang_main.ts');

  function runChild(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), 'synapse-deploy-hang-'));
    const file = join(dir, 'template.json');
    writeFileSync(file, template([resource('notebooks', 'nb_a')]));
    return spawnSync(process.execPath, [child, mode, file], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env['PATH'] ?? '' },
    });
  }

  it('never lets a run that stops settling look green', () => {
    const result = runChild('hang');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(PENDING_REQUESTS_MESSAGE), result.stdout + result.stderr);
  });

  it('reports a failed run and a clean one by their exit codes', () => {
    const failed = runChild('fail');
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /::error::.*Cannot read the template file/);
    const green = runChild('ok');
    assert.equal(green.status, 0, green.stdout + green.stderr);
  });
});

describe('run: deletion safety', () => {
  it('deletes lake children one at a time, relationships first, each after the last answered', async () => {
    const fake = await start({ latencyMs: 30 });
    fake.seedDatabase('lake_keep', {
      tables: ['stale_a', 'stale_b'],
      relationships: ['rel_a', 'rel_b'],
    });
    ok(await execute(setup([database('lake_keep')], { deleteArtifacts: true }), depsFor(fake)));
    const children = deletes(fake).filter((r) => r.path.startsWith('/databases/lake_keep/'));
    assert.equal(children.length, 4);
    assert.deepEqual(
      children.map((r) => r.path.split('/')[3]),
      ['relationships', 'relationships', 'tables', 'tables'],
    );
    for (let i = 1; i < children.length; i++) {
      const gap = (children[i]?.time ?? 0) - (children[i - 1]?.time ?? 0);
      assert.ok(gap >= 25, `delete ${i} arrived ${gap} ms after the previous one`);
    }
  });

  it('deletes no lake child after an artifact deletion failed', async () => {
    const fake = await start({ lroPolls: 0 });
    fake.seed('pipelines', [{ name: 'pl_a', properties: {} }]);
    fake.failOperation('pl_a', 'cannot delete');
    fake.seedDatabase('lake_keep', { tables: ['stale'], relationships: ['rel_old'] });
    const outcome = await execute(
      setup([database('lake_keep')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(
      failure(outcome),
      /^Deletion failed: 1 of 3 failed \(pipelines\/pl_a\); 2 not started\.$/,
    );
    assert.deepEqual(fake.databaseChildren('lake_keep', 'tables'), ['stale']);
    assert.deepEqual(fake.databaseChildren('lake_keep', 'relationships'), ['rel_old']);
  });

  const lists: [string, string, string][] = [
    ['a plain collection', '/pipelines', 'pipelines'],
    ['the lake databases', '/databases', 'databases'],
  ];
  for (const [what, path, collection] of lists) {
    for (const status of [403, 500]) {
      it(`fails with no write when page 2 of ${what} answers ${status}`, async () => {
        const fake = await start();
        if (collection === 'databases') {
          for (const name of ['lake_a', 'lake_b', 'lake_c']) fake.seedDatabase(name);
        } else {
          fake.seed('pipelines', [{ name: 'pl_a' }, { name: 'pl_b' }, { name: 'pl_c' }]);
        }
        fake.addFault({
          method: 'GET',
          path: new RegExp(`^${path}$`),
          nth: 2,
          count: Infinity,
          response: { status, body: '{"error":{"message":"page two failed"}}' },
        });
        const outcome = await execute(
          setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
          depsFor(fake),
        );
        assert.match(failure(outcome), new RegExp(String(status)));
        assert.equal(fake.writes().length, 0);
      });
    }
  }

  it('fails with no write when a nextLink repeats', async () => {
    const fake = await start();
    fake.addFault({
      method: 'GET',
      path: /^\/datasets$/,
      count: Infinity,
      response: {
        status: 200,
        body: JSON.stringify({
          value: [{ name: 'ds_a' }],
          nextLink: `${fake.url}/datasets?api-version=2019-06-01-preview&skiptoken=1`,
        }),
      },
    });
    const outcome = await execute(
      setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(failure(outcome), /keeps returning nextLink pages/);
    assert.equal(fake.writes().length, 0);
  });

  it('fails with no write when a continuationToken repeats', async () => {
    const fake = await start();
    fake.addFault({
      method: 'GET',
      path: /^\/databases$/,
      count: Infinity,
      response: { status: 200, body: JSON.stringify({ items: [], continuationToken: 'again' }) },
    });
    const outcome = await execute(
      setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    assert.match(failure(outcome), /keeps returning continuation tokens/);
    assert.equal(fake.writes().length, 0);
  });
});

describe('run: transient faults', () => {
  for (const [status, headers] of [
    [429, { 'Retry-After': '1' }],
    [503, {}],
  ] as const) {
    it(`retries a deploy that first answers ${status}`, async () => {
      const fake = await start();
      fake.addFault({
        method: 'PUT',
        path: /^\/pipelines\/pl_a$/,
        response: { status, headers, body: '{"error":{"message":"busy"}}' },
      });
      const counts = ok(await execute(setup([resource('pipelines', 'pl_a')]), depsFor(fake)));
      assert.deepEqual(counts, { deployed: 1, skipped: 0, deleted: 0 });
      assert.equal(puts(fake).length, 2);
      assert.ok(fake.get('pipelines', 'pl_a'));
    });
  }
});

describe('run: lake database listing shapes', () => {
  it('reads the real shape: nested properties, SPARK case-insensitive, SyMS boolean only', async () => {
    const fake = await start();
    fake.seedDatabase('lake_gone');
    fake.seedDatabase('lake_lower', { origin: 'spark' });
    fake.seedDatabase('lake_other', { origin: 'OTHER' });
    fake.seedDatabase('lake_notsyms', { symscdm: false });
    fake.seedDatabase('lake_keep', { tables: ['stale'], relationships: ['rel_old'] });
    const outcome = await execute(
      setup([database('lake_keep')], { deleteArtifacts: true }),
      depsFor(fake),
    );
    ok(outcome);
    assert.deepEqual(deletes(fake).map(decoded).sort(), [
      '/databases/lake_gone',
      '/databases/lake_keep/relationships/rel_old',
      '/databases/lake_keep/tables/stale',
      '/databases/lake_lower',
    ]);
  });

  it('deletes only databases whose flags are exactly SPARK and boolean true', async () => {
    const fake = await start();
    fake.seedDatabase('lake_genuine');
    fake.seedDatabase('lake_str_true', { symscdm: 'true' });
    fake.seedDatabase('lake_str_false', { symscdm: 'false' });
    fake.seedDatabase('lake_bool_false', { symscdm: false });
    fake.seedDatabase('lake_num_one', { symscdm: 1 });
    fake.seedDatabase('lake_no_props', { raw: { Origin: { Type: 'SPARK' } } });
    fake.seedDatabase('lake_no_origin', { raw: { Properties: { IsSyMSCDMDatabase: true } } });
    fake.seedDatabase('lake_origin_num', { origin: 1 });
    ok(
      await execute(
        setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
        depsFor(fake),
      ),
    );
    assert.deepEqual(deletes(fake).map(decoded), ['/databases/lake_genuine']);
  });

  it('still accepts the flat shape', async () => {
    const fake = await start();
    const flat = (name: string) => ({
      Name: name,
      Origin: { Type: 'SPARK' },
      Properties: { IsSyMSCDMDatabase: true },
    });
    fake.addFault({
      method: 'GET',
      path: /^\/databases$/,
      response: { status: 200, body: JSON.stringify({ items: [flat('lake_flat')] }) },
    });
    ok(
      await execute(
        setup([resource('notebooks', 'nb_a')], { deleteArtifacts: true }),
        depsFor(fake),
      ),
    );
    assert.ok(deletes(fake).some((r) => r.path === '/databases/lake_flat'));
  });
});
