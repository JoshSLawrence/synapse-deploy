// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { LAKE_DATABASE_API_VERSION } from './kinds.ts';
import { asRecord, awaitDataPlaneDeploy } from './lro.ts';
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
