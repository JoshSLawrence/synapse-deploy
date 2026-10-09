import { KINDS } from './kinds.ts';
import type { Artifact } from './template.ts';

/** At most this many operations (a write plus its polling) run at once. */
export const MAX_PARALLEL = 8;

export interface GraphNode {
  key: string;
  /** Keys that must finish first. Keys that are not nodes count as finished. */
  dependsOn: string[];
}

const SKIPPED_KINDS: ReadonlySet<string> = new Set(
  KINDS.filter((kind) => kind.plane === 'skip').map((kind) => kind.id),
);

/**
 * The graph of the artifacts that will be deployed. A dependency on a
 * resource that is in the template but not deployed (a default, a pool, the
 * virtual network, an endpoint or runtime that is not being deployed), or on
 * a kind that is left to infrastructure as code, is satisfied. Anything else
 * that is absent is returned as a message in `unresolved`.
 */
export function resolveDependencies(
  all: readonly Artifact[],
  deployable: readonly Artifact[],
): { nodes: GraphNode[]; unresolved: string[] } {
  const deployed = new Set(deployable.map((artifact) => artifact.key));
  const known = new Set(all.map((artifact) => artifact.key));
  const unresolved: string[] = [];
  const nodes = deployable.map((artifact) => {
    const dependsOn: string[] = [];
    for (const dependency of artifact.dependsOn) {
      if (deployed.has(dependency)) {
        dependsOn.push(dependency);
      } else if (!known.has(dependency) && !SKIPPED_KINDS.has(dependency.split('/')[0] ?? '')) {
        unresolved.push(
          `${artifact.key} depends on ${dependency}, which is not in the template. ` +
            'Add it to the template or remove the dependency.',
        );
      }
    }
    return { key: artifact.key, dependsOn };
  });
  return { nodes, unresolved };
}

/** A cycle as a list of keys that ends where it starts, or undefined. */
export function findCycle(nodes: readonly GraphNode[]): string[] | undefined {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): string[] | undefined => {
    const seen = state.get(key);
    if (seen === 'done') {
      return undefined;
    }
    if (seen === 'visiting') {
      return [...stack.slice(stack.indexOf(key)), key];
    }
    state.set(key, 'visiting');
    stack.push(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(dependency)) {
        const cycle = visit(dependency);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    state.set(key, 'done');
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node.key);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

/** Phase-1 validation: every dependency resolves and there is no cycle. */
export function buildGraph(
  all: readonly Artifact[],
  deployable: readonly Artifact[] = all.filter((artifact) => artifact.skip === undefined),
): GraphNode[] {
  const { nodes, unresolved } = resolveDependencies(all, deployable);
  if (unresolved.length > 0) {
    throw new Error(`Unresolved dependencies:\n- ${unresolved.join('\n- ')}`);
  }
  const cycle = findCycle(nodes);
  if (cycle) {
    throw new Error(
      `Dependency cycle: ${cycle.join(' -> ')}. Remove one of the dependsOn entries in the cycle.`,
    );
  }
  return nodes;
}

/** The same graph with every edge reversed, for deleting in reverse-dependency order. */
export function reverseGraph(nodes: readonly GraphNode[]): GraphNode[] {
  const keys = new Set(nodes.map((node) => node.key));
  const reversed = new Map(nodes.map((node) => [node.key, [] as string[]]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (keys.has(dependency)) {
        reversed.get(dependency)?.push(node.key);
      }
    }
  }
  return nodes.map((node) => ({ key: node.key, dependsOn: reversed.get(node.key) ?? [] }));
}

export interface ScheduleResult {
  succeeded: string[];
  failed: { key: string; error: unknown }[];
  /** Nodes that never started, because a dependency or another node failed. */
  notStarted: string[];
}

/**
 * Runs the nodes in dependency order, at most `limit` at a time, ready nodes
 * in the order given. The first failure stops new starts; what is already
 * running finishes, so nothing is left pending when this returns.
 */
export async function schedule(
  nodes: readonly GraphNode[],
  run: (key: string) => Promise<void>,
  limit: number = MAX_PARALLEL,
): Promise<ScheduleResult> {
  const keys = new Set(nodes.map((node) => node.key));
  const succeeded = new Set<string>();
  const started = new Set<string>();
  const running = new Set<Promise<void>>();
  const result: ScheduleResult = { succeeded: [], failed: [], notStarted: [] };

  const start = (node: GraphNode): void => {
    started.add(node.key);
    const task: Promise<void> = (async () => {
      try {
        await run(node.key);
        succeeded.add(node.key);
        result.succeeded.push(node.key);
      } catch (error) {
        result.failed.push({ key: node.key, error });
      }
    })().then(() => {
      running.delete(task);
    });
    running.add(task);
  };

  for (;;) {
    if (result.failed.length === 0) {
      for (const node of nodes) {
        if (running.size >= limit) {
          break;
        }
        if (
          !started.has(node.key) &&
          node.dependsOn.every((dependency) => !keys.has(dependency) || succeeded.has(dependency))
        ) {
          start(node);
        }
      }
    }
    if (running.size === 0) {
      break;
    }
    await Promise.race(running);
  }

  result.notStarted = nodes.filter((node) => !started.has(node.key)).map((node) => node.key);
  return result;
}
