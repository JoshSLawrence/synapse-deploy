// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { isServiceDefault } from './defaults.ts';
import { findCycle } from './graph.ts';
import { ensureSuccess } from './http.ts';
import { kindForReferenceType, KINDS } from './kinds.ts';
import { listLakeChildren, listLakeDatabases, templateEntityNames } from './lakedb.ts';
import { asRecord, sameOriginUrl } from './lro.ts';
import { artifactKey } from './template.ts';
import type { GraphNode } from './graph.ts';
import type { Kind } from './kinds.ts';
import type { LakeChild } from './lakedb.ts';
import type { Response } from './http.ts';
import type { SynapseContext } from './synapse.ts';
import type { Artifact } from './template.ts';

/** An artifact that exists in the workspace. */
export interface LiveArtifact {
  /** The kind of the collection it was listed in, not its own `type` field. */
  kind: Kind;
  name: string;
  /** `<kind id>/<lowercased name>`, as template artifacts are keyed. */
  key: string;
  /** Keys of the artifacts its JSON refers to. */
  references: string[];
}

// A listing that never ends is a broken server; stop instead of looping.
const MAX_PAGES = 1_000;

/** Every `{referenceName, type}` object in the value that points at a known kind. */
function referencesOf(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      referencesOf(item, found);
    }
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const { referenceName, type } = record;
    if (typeof referenceName === 'string' && typeof type === 'string') {
      const kind = kindForReferenceType(type);
      if (kind !== undefined) {
        found.add(artifactKey(kind.id, referenceName));
      }
    }
    for (const child of Object.values(record)) {
      referencesOf(child, found);
    }
  }
  return found;
}

/**
 * Every item of a `{value, nextLink}` listing. `first` is a first page that
 * was already fetched (the endpoint probe's), so it is not asked for twice.
 */
async function listCollection(
  ctx: SynapseContext,
  kind: Kind,
  first?: Response,
): Promise<Record<string, unknown>[]> {
  const start = `${ctx.dataPlane}/${kind.collection}?api-version=${kind.apiVersion}`;
  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>([start]);
  let res = first ?? (await ctx.http.request('GET', start, ctx.scope));
  for (let page = 1; ; page++) {
    ensureSuccess(res);
    const body = asRecord(res.json());
    if (!Array.isArray(body?.value)) {
      throw new Error(
        `Listing ${kind.collection} answered without a "value" array; check that the identity ` +
          'can read the workspace and re-run the job.',
      );
    }
    for (const item of body.value as unknown[]) {
      const record = asRecord(item);
      if (record !== undefined) {
        items.push(record);
      }
    }
    const next = body.nextLink;
    if (typeof next !== 'string' || next === '') {
      return items;
    }
    // The next page is fetched with the bearer token, so it must stay on the
    // host that was asked.
    const url = sameOriginUrl(res.url, next);
    if (seen.has(url) || page >= MAX_PAGES) {
      throw new Error(
        `Listing ${kind.collection} keeps returning nextLink pages (page ${page}); re-run the job, ` +
          'and report it if it persists.',
      );
    }
    seen.add(url);
    res = await ctx.http.request('GET', url, ctx.scope);
  }
}

function liveFrom(kind: Kind, item: Record<string, unknown>): LiveArtifact {
  const name = item.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `Listing ${kind.collection} returned an item without a name; re-run the job, and report it ` +
        'if it persists.',
    );
  }
  return {
    kind,
    name,
    key: artifactKey(kind.id, name),
    references: [...referencesOf(item)],
  };
}

/**
 * Lists what delete-artifacts may delete (design 3.8, rules 1 to 3): every
 * deletable collection, the lake databases, and the managed private
 * endpoints only when `endpoints` is given (the caller's probe of the
 * managed virtual network, whose first page is reused). Integration runtimes
 * are never listed.
 */
export async function listLiveArtifacts(
  ctx: SynapseContext,
  endpoints: { exists: boolean; response: Response } | undefined,
): Promise<LiveArtifact[]> {
  const live: LiveArtifact[] = [];
  for (const kind of KINDS) {
    if (kind.delete === 'collection') {
      for (const item of await listCollection(ctx, kind)) {
        live.push(liveFrom(kind, item));
      }
    } else if (kind.delete === 'endpoint' && endpoints?.exists === true) {
      for (const item of await listCollection(ctx, kind, endpoints.response)) {
        live.push(liveFrom(kind, item));
      }
    } else if (kind.delete === 'lakedb') {
      for (const name of await listLakeDatabases(ctx)) {
        live.push({ kind, name, key: artifactKey(kind.id, name), references: [] });
      }
    }
  }
  return live;
}

/**
 * Rules 4 and 5: the candidates are the live artifacts that are not service
 * defaults and are not in the template at all (deployed or skipped), ordered
 * so that an artifact goes after every candidate that refers to it. Throws on
 * a reference cycle, before anything is deleted.
 */
export function planDeletions(
  live: readonly LiveArtifact[],
  template: readonly Artifact[],
): { artifacts: LiveArtifact[]; nodes: GraphNode[] } {
  const inTemplate = new Set(template.map((artifact) => artifact.key));
  const artifacts = live.filter(
    (artifact) =>
      !isServiceDefault(artifact.kind.id, artifact.name) && !inTemplate.has(artifact.key),
  );
  const referrers = new Map(artifacts.map((artifact) => [artifact.key, [] as string[]]));
  for (const artifact of artifacts) {
    for (const reference of artifact.references) {
      // Naming itself is not an ordering constraint.
      if (reference !== artifact.key) {
        referrers.get(reference)?.push(artifact.key);
      }
    }
  }
  const nodes = artifacts.map((artifact) => ({
    key: artifact.key,
    dependsOn: referrers.get(artifact.key) ?? [],
  }));
  const cycle = findCycle(nodes);
  if (cycle !== undefined) {
    throw new Error(
      `Cannot order the deletions: ${cycle.join(' -> ')} refer to one another. Delete one of them ` +
        'in Synapse Studio first, or put it back in the template.',
    );
  }
  return { artifacts, nodes };
}

/**
 * Rule 6: for each live lake database that is also in the template, the
 * relationships and tables the template no longer defines, relationships first.
 */
export async function planLakeChildren(
  ctx: SynapseContext,
  live: readonly LiveArtifact[],
  template: readonly Artifact[],
): Promise<LakeChild[]> {
  const definitions = new Map(
    template
      .filter((artifact) => artifact.kind.id === 'databases' && artifact.skip === undefined)
      .map((artifact) => [artifact.key, artifact]),
  );
  const relationships: LakeChild[] = [];
  const tables: LakeChild[] = [];
  for (const database of live) {
    const definition = definitions.get(database.key);
    if (database.kind.id !== 'databases' || definition === undefined) {
      continue;
    }
    const wanted = templateEntityNames(definition.body);
    for (const [type, target] of [
      ['relationships', relationships],
      ['tables', tables],
    ] as const) {
      for (const child of await listLakeChildren(ctx, database.name, type)) {
        if (!wanted.has(child.name.toLowerCase())) {
          target.push(child);
        }
      }
    }
  }
  return [...relationships, ...tables];
}
