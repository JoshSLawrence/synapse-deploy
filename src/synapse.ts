// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import * as core from '@actions/core';
import { HttpError, responseError } from './http.ts';
import { artifactPath } from './kinds.ts';
import { asRecord, awaitDataPlaneDeploy, awaitDelete, awaitEndpointDeploy } from './lro.ts';
import { deployLakeDatabase } from './lakedb.ts';
import type { Kind } from './kinds.ts';
import type { LroContext } from './lro.ts';

export interface SynapseContext extends LroContext {
  /** The development endpoint, such as https://myworkspace.dev.azuresynapse.net; no trailing slash. */
  dataPlane: string;
  /** Token scope of the development endpoint. */
  scope: string;
}

const TRIGGER_HINT = 'Stop the trigger first; the deployer does not start or stop triggers.';

const PRIVATE_LINK_SERVICE = '/providers/microsoft.network/privatelinkservices/';

const NO_MANAGED_VNET = 'does not have a managed virtual network associated';

function describe(kind: Kind, name: string): string {
  return `${kind.collection}/${name}`;
}

// Synapse refuses to update or delete a started trigger, and its message is
// the only hint; the fix (stop it) belongs to the caller of the deployer.
function withTriggerHint(kind: Kind, err: unknown): unknown {
  if (kind.id !== 'triggers' || !(err instanceof Error) || !/started/i.test(err.message)) {
    return err;
  }
  const message = `${err.message} ${TRIGGER_HINT}`;
  return err instanceof HttpError
    ? new HttpError(message, err.status, err.serviceMessage, err)
    : new Error(message, { cause: err });
}

/**
 * An endpoint to a private link service needs its FQDNs; for every other
 * target Synapse rejects them, so they are dropped. The input is not changed.
 */
export function prepareEndpointBody(body: unknown): unknown {
  const copy = structuredClone(body);
  const properties = asRecord(asRecord(copy)?.properties);
  if (properties === undefined) {
    return copy;
  }
  const target = properties.privateLinkResourceId;
  const isPrivateLinkService =
    typeof target === 'string' && target.toLowerCase().includes(PRIVATE_LINK_SERVICE);
  if (!isPrivateLinkService) {
    delete properties.fqdns;
  }
  return copy;
}

/**
 * Deploys one data-plane artifact: notebooks, pipelines and the other plain
 * kinds, managed private endpoints (awaited until provisioned) and lake
 * databases (one PUT per DDL entity). Integration runtimes go through arm.ts.
 */
export async function deployArtifact(
  ctx: SynapseContext,
  kind: Kind,
  name: string,
  body: unknown,
): Promise<void> {
  const label = describe(kind, name);
  try {
    switch (kind.plane) {
      case 'data': {
        const put = await ctx.http.request(
          'PUT',
          ctx.dataPlane + artifactPath(kind, name),
          ctx.scope,
          body,
        );
        await awaitDataPlaneDeploy(ctx, put, { scope: ctx.scope, label, name });
        return;
      }
      case 'endpoint': {
        const put = await ctx.http.request(
          'PUT',
          ctx.dataPlane + artifactPath(kind, name),
          ctx.scope,
          prepareEndpointBody(body),
        );
        await awaitEndpointDeploy(ctx, put, { scope: ctx.scope, label, name });
        return;
      }
      case 'lakedb':
        await deployLakeDatabase(ctx, name, body);
        return;
      case 'arm':
        throw new Error(
          `${label} is deployed through Azure Resource Manager; use deployIntegrationRuntime.`,
        );
      case 'skip':
        throw new Error(`${label} is left to infrastructure as code and is never deployed.`);
    }
  } catch (err) {
    throw withTriggerHint(kind, err);
  }
}

/** Deletes one artifact (rule R1 for the wait). Kinds that are never deleted throw. */
export async function deleteArtifact(ctx: SynapseContext, kind: Kind, name: string): Promise<void> {
  const label = describe(kind, name);
  if (kind.delete === 'never') {
    throw new Error(`${label} is never deleted by the deployer.`);
  }
  try {
    const del = await ctx.http.request(
      'DELETE',
      ctx.dataPlane + artifactPath(kind, name),
      ctx.scope,
    );
    await awaitDelete(ctx, del, { scope: ctx.scope, label });
  } catch (err) {
    throw withTriggerHint(kind, err);
  }
}

/**
 * Whether the workspace has a managed virtual network, from the endpoint list.
 * Only the "does not have a managed virtual network associated" answer means
 * no; any other failure is a real error, never "nothing to do".
 */
export async function hasManagedVirtualNetwork(ctx: SynapseContext): Promise<boolean> {
  const res = await ctx.http.request(
    'GET',
    `${ctx.dataPlane}/managedVirtualNetworks/default/managedPrivateEndpoints?api-version=2019-06-01-preview`,
    ctx.scope,
  );
  if (res.status >= 200 && res.status < 300) {
    return true;
  }
  if (res.text.toLowerCase().includes(NO_MANAGED_VNET)) {
    core.debug('The workspace has no managed virtual network');
    return false;
  }
  throw responseError(res);
}
