import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGraph,
  findCycle,
  MAX_PARALLEL,
  resolveDependencies,
  reverseGraph,
  schedule,
} from '../src/graph.ts';
import type { GraphNode } from '../src/graph.ts';
import { KINDS } from '../src/kinds.ts';
import type { Artifact } from '../src/template.ts';

function artifact(key: string, dependsOn: string[] = [], skip?: string): Artifact {
  const [kindId = '', name = ''] = key.split('/');
  const kind = KINDS.find((candidate) => candidate.id === kindId);
  assert.ok(kind, key);
  const type = `Microsoft.Synapse/workspaces/${kind.templateTail}`;
  const out: Artifact = { key, kind, name, type, body: {}, dependsOn };
  if (skip !== undefined) out.skip = skip;
  return out;
}

const node = (key: string, ...dependsOn: string[]): GraphNode => ({ key, dependsOn });

describe('graph: dependencies', () => {
  it('orders by dependsOn', () => {
    const nodes = buildGraph([
      artifact('pipelines/c', ['datasets/b']),
      artifact('datasets/b', ['linkedServices/a']),
      artifact('linkedServices/a'),
    ]);
    assert.deepEqual(nodes, [
      node('pipelines/c', 'datasets/b'),
      node('datasets/b', 'linkedServices/a'),
      node('linkedServices/a'),
    ]);
  });

  it('treats dependencies on skipped resources and skipped kinds as satisfied', () => {
    const all = [
      artifact('linkedServices/ws-workspacedefaultstorage', [], 'service default'),
      artifact('pipelines/p', [
        'linkedServices/ws-workspacedefaultstorage',
        'managedVirtualNetworks/default',
        'bigDataPools/pool',
        'managedPrivateEndpoints/pe',
      ]),
      artifact('managedPrivateEndpoints/pe'),
    ];
    const deployable = all.filter((a) => a.key === 'pipelines/p');
    const { nodes, unresolved } = resolveDependencies(all, deployable);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(nodes, [node('pipelines/p')]);
  });

  it('lists every unresolved dependency', () => {
    assert.throws(
      () =>
        buildGraph([
          artifact('pipelines/a', ['datasets/missing']),
          artifact('pipelines/b', ['linkedServices/gone', 'notebooks/also']),
        ]),
      (error: Error) =>
        error.message.includes('pipelines/a depends on datasets/missing') &&
        error.message.includes('pipelines/b depends on linkedServices/gone') &&
        error.message.includes('pipelines/b depends on notebooks/also') &&
        error.message.includes('Add it to the template'),
    );
  });

  it('reports a cycle', () => {
    assert.throws(
      () =>
        buildGraph([
          artifact('pipelines/a', ['pipelines/b']),
          artifact('pipelines/b', ['pipelines/a']),
        ]),
      /Dependency cycle: pipelines\/a -> pipelines\/b -> pipelines\/a/,
    );
    assert.throws(
      () => buildGraph([artifact('pipelines/a', ['pipelines/a'])]),
      /cycle: pipelines\/a -> pipelines\/a/,
    );
  });

  it('finds no cycle in a diamond', () => {
    assert.equal(
      findCycle([node('d', 'b', 'c'), node('b', 'a'), node('c', 'a'), node('a')]),
      undefined,
    );
  });

  it('reverses every edge', () => {
    assert.deepEqual(reverseGraph([node('b', 'a'), node('a')]), [node('b'), node('a', 'b')]);
  });
});

function tracker() {
  let running = 0;
  let max = 0;
  const started: string[] = [];
  const finished: string[] = [];
  return {
    started,
    finished,
    get max() {
      return max;
    },
    get running() {
      return running;
    },
    async run(key: string, ticks = 3, fail = false): Promise<void> {
      started.push(key);
      running += 1;
      max = Math.max(max, running);
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      running -= 1;
      finished.push(key);
      if (fail) throw new Error(`boom ${key}`);
    },
  };
}

describe('graph: scheduler', () => {
  it('starts a node only after its dependencies finished', async () => {
    const t = tracker();
    const result = await schedule([node('c', 'b'), node('b', 'a'), node('a')], (key) => t.run(key));
    assert.deepEqual(t.started, ['a', 'b', 'c']);
    assert.deepEqual(result.succeeded, ['a', 'b', 'c']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.notStarted, []);
  });

  it('never runs more than the limit at once, and starts ready nodes in order', async () => {
    const t = tracker();
    const nodes = Array.from({ length: 25 }, (_, i) => node(`n${i}`));
    const result = await schedule(nodes, (key) => t.run(key, 5));
    assert.equal(MAX_PARALLEL, 8);
    assert.equal(t.max, 8);
    assert.deepEqual(
      t.started.slice(0, 8),
      nodes.slice(0, 8).map((n) => n.key),
    );
    assert.equal(result.succeeded.length, 25);
    assert.equal(t.running, 0);
  });

  it('honours a smaller limit', async () => {
    const t = tracker();
    await schedule(
      Array.from({ length: 6 }, (_, i) => node(`n${i}`)),
      (key) => t.run(key),
      2,
    );
    assert.equal(t.max, 2);
  });

  it('stops starting after a failure, lets running nodes finish and leaves nothing pending', async () => {
    const t = tracker();
    const nodes = [node('a'), node('b'), node('c', 'a'), node('d', 'b'), node('e', 'c')];
    const result = await schedule(nodes, (key) => t.run(key, key === 'b' ? 6 : 2, key === 'a'));
    assert.deepEqual(
      result.failed.map((f) => f.key),
      ['a'],
    );
    assert.deepEqual(result.succeeded, ['b']);
    assert.deepEqual(result.notStarted, ['c', 'd', 'e']);
    assert.equal(t.running, 0);
    assert.deepEqual(t.finished.sort(), ['a', 'b']);
  });

  it('does not start a dependent of a failed node', async () => {
    const t = tracker();
    const result = await schedule([node('a'), node('b', 'a')], (key) => t.run(key, 1, true));
    assert.deepEqual(result.notStarted, ['b']);
    assert.ok((result.failed[0]?.error as Error).message.includes('boom a'));
  });

  it('treats a dependency that is not a node as finished', async () => {
    const t = tracker();
    const result = await schedule([node('a', 'elsewhere')], (key) => t.run(key));
    assert.deepEqual(result.succeeded, ['a']);
  });
});
