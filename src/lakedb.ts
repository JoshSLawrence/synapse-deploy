// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { ensureSuccess } from './http.ts';
import { LAKE_DATABASE_API_VERSION } from './kinds.ts';
import { asRecord, awaitDataPlaneDeploy, awaitDelete } from './lro.ts';
import type { SynapseContext } from './synapse.ts';

function requireString(value: unknown, what: string, database: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `Lake database ${database}: ${what} is missing or not a string in a Ddls entry; ` +
        're-export the workspace template.',
    );
  }
  return value;
}

/**
 * Deploys a lake database from its template resource: one PUT per entry of
 * properties.Ddls, in order, each of the entry's NewEntity (Name and
 * EntityType become the request's name and type). A relationship without a
 * RelationshipType gets 0, as the service requires one.
 */
export async function deployLakeDatabase(
  ctx: SynapseContext,
  database: string,
  resource: unknown,
): Promise<void> {
  const ddls = asRecord(asRecord(resource)?.properties)?.Ddls;
  if (!Array.isArray(ddls)) {
    throw new Error(
      `Lake database ${database}: properties.Ddls is missing; re-export the workspace template.`,
    );
  }

  for (const ddl of ddls as unknown[]) {
    const entity = asRecord(asRecord(ddl)?.NewEntity);
    if (entity === undefined) {
      throw new Error(
        `Lake database ${database}: a Ddls entry has no NewEntity; re-export the workspace template.`,
      );
    }
    const { Name, EntityType, ...properties } = entity;
    const name = requireString(Name, 'Name', database);
    const type = requireString(EntityType, 'EntityType', database);
    const lowerType = type.toLowerCase();

    let path: string;
    if (lowerType === 'database') {
      path = `/databases/${encodeURIComponent(name)}`;
    } else {
      const owner = requireString(
        asRecord(properties.Namespace)?.DatabaseName,
        'Namespace.DatabaseName',
        database,
      );
      path = `/databases/${encodeURIComponent(owner)}/${lowerType}s/${encodeURIComponent(name)}`;
    }
    if (lowerType === 'relationship' && !('RelationshipType' in properties)) {
      properties.RelationshipType = 0;
    }

    const put = await ctx.http.request(
      'PUT',
      `${ctx.dataPlane}${path}?api-version=${LAKE_DATABASE_API_VERSION}`,
      ctx.scope,
      { name, type, properties },
    );
    await awaitDataPlaneDeploy(ctx, put, {
      scope: ctx.scope,
      label: `databases/${database} ${lowerType} ${name}`,
      name,
      lenient: true,
    });
  }
}

/** A table or relationship of a lake database. */
export type LakeChildType = 'tables' | 'relationships';

export interface LakeChild {
  database: string;
  type: LakeChildType;
  name: string;
}

// A listing that keeps handing out tokens is broken; stop instead of looping.
const MAX_PAGES = 1_000;

function nameOf(item: Record<string, unknown>): string | undefined {
  const name = item.Name ?? item.name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * Every item of a `{items, continuationToken}` listing. The next page is the
 * same URL plus the URL-encoded token: the token is not a URL, and it may
 * hold characters such as `+` that a query string would otherwise change.
 */
async function listItems(ctx: SynapseContext, path: string): Promise<Record<string, unknown>[]> {
  const base = `${ctx.dataPlane}${path}?api-version=${LAKE_DATABASE_API_VERSION}`;
  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let url = base;
  for (let page = 1; ; page++) {
    const res = ensureSuccess(await ctx.http.request('GET', url, ctx.scope));
    const body = asRecord(res.json());
    if (!Array.isArray(body?.items)) {
      throw new Error(
        `Listing ${path} answered without an "items" array; check that the identity can read lake ` +
          'databases and re-run the job.',
      );
    }
    for (const item of body.items as unknown[]) {
      const record = asRecord(item);
      if (record !== undefined) {
        items.push(record);
      }
    }
    const token = body.continuationToken;
    if (typeof token !== 'string' || token === '') {
      return items;
    }
    if (seen.has(token) || page >= MAX_PAGES) {
      throw new Error(
        `Listing ${path} keeps returning continuation tokens (page ${page}); re-run the job, and ` +
          'report it if it persists.',
      );
    }
    seen.add(token);
    url = `${base}&continuationToken=${encodeURIComponent(token)}`;
  }
}

/**
 * The names of the workspace's lake databases: Spark origin and a Synapse
 * Metadata Service (SyMS) database. Other databases, such as those a Spark
 * job created, are never touched.
 */
export async function listLakeDatabases(ctx: SynapseContext): Promise<string[]> {
  const names: string[] = [];
  for (const item of await listItems(ctx, '/databases')) {
    const origin = asRecord(item.Origin)?.Type;
    const symscdm = asRecord(item.Properties)?.IsSyMSCDMDatabase;
    const name = nameOf(item);
    if (
      name !== undefined &&
      typeof origin === 'string' &&
      origin.toUpperCase() === 'SPARK' &&
      symscdm === true
    ) {
      names.push(name);
    }
  }
  return names;
}

/** The tables or relationships of a lake database. */
export async function listLakeChildren(
  ctx: SynapseContext,
  database: string,
  type: LakeChildType,
): Promise<LakeChild[]> {
  const items = await listItems(ctx, `/databases/${encodeURIComponent(database)}/${type}`);
  return items.flatMap((item) => {
    const name = nameOf(item);
    return name === undefined ? [] : [{ database, type, name }];
  });
}

/**
 * The names a template database defines: the NewEntity.Name of every Ddls
 * entry. Compared case-insensitively, so a table re-cased in Git is not
 * deleted after it was deployed under the new case.
 */
export function templateEntityNames(resource: unknown): Set<string> {
  const ddls = asRecord(asRecord(resource)?.properties)?.Ddls;
  const names = new Set<string>();
  for (const ddl of Array.isArray(ddls) ? (ddls as unknown[]) : []) {
    const name = asRecord(asRecord(ddl)?.NewEntity)?.Name;
    if (typeof name === 'string') {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

/** Deletes one table or relationship of a lake database (rule R1 for the wait). */
export async function deleteLakeChild(ctx: SynapseContext, child: LakeChild): Promise<void> {
  const res = await ctx.http.request(
    'DELETE',
    `${ctx.dataPlane}/databases/${encodeURIComponent(child.database)}/${child.type}/` +
      `${encodeURIComponent(child.name)}?api-version=${LAKE_DATABASE_API_VERSION}`,
    ctx.scope,
  );
  await awaitDelete(ctx, res, { scope: ctx.scope, label: describeLakeChild(child) });
}

export function describeLakeChild(child: LakeChild): string {
  return `databases/${child.database} ${child.type === 'tables' ? 'table' : 'relationship'} ${child.name}`;
}
