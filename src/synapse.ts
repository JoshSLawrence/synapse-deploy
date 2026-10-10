// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import * as core from '@actions/core';
import { HttpError, responseError } from './http.ts';
import { artifactPath, DEFAULT_API_VERSION } from './kinds.ts';
import {
  asRecord,
  awaitDataPlaneDeploy,
  awaitDelete,
  awaitEndpointDelete,
  awaitEndpointDeploy,
} from './lro.ts';
import { deployLakeDatabase } from './lakedb.ts';
import type { Kind } from './kinds.ts';
import type { Response } from './http.ts';
import type { LroContext } from './lro.ts';

export interface SynapseContext extends LroContext {
  /** The development endpoint, such as https://myworkspace.dev.azuresynapse.net; no trailing slash. */
  dataPlane: string;
  /** Token scope of the development endpoint. */
  scope: string;
}

// Where the service reports operations that have no Location header.
const ENDPOINT_OPERATION_BASE = '/managedVirtualNetworks/default';

// Synapse says "Cannot update enabled Trigger; the trigger needs to be
// disabled first." (code TriggerEnabledCannotUpdate). Only the service's text
// is matched: the artifact's own name may contain "started".
const TRIGGER_ENABLED = /TriggerEnabledCannotUpdate|enabled trigger|disabled first|started/i;

const TRIGGER_HINT = 'Stop the trigger first; the deployer does not start or stop triggers.';

const PRIVATE_LINK_SERVICE = '/providers/microsoft.network/privatelinkservices/';

const NO_MANAGED_VNET = 'does not have a managed virtual network associated';

function describe(kind: Kind, name: string): string {
  return `${kind.collection}/${name}`;
}

// Synapse refuses to update or delete a started trigger, and its message is
// the only hint; the fix (stop it) belongs to the caller of the deployer.
function withTriggerHint(kind: Kind, err: unknown): unknown {
  if (
    kind.id !== 'triggers' ||
    !(err instanceof HttpError) ||
    !TRIGGER_ENABLED.test(err.serviceMessage)
  ) {
    return err;
  }
  const message = `${err.message} ${TRIGGER_HINT}`;
  return new HttpError(message, err.status, err.serviceMessage, err);
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
        await awaitEndpointDeploy(ctx, put, {
          scope: ctx.scope,
          label,
          name,
          operationBase: ENDPOINT_OPERATION_BASE,
        });
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
    const wait = kind.plane === 'endpoint' ? awaitEndpointDelete : awaitDelete;
    await wait(ctx, del, { scope: ctx.scope, label });
  } catch (err) {
    throw withTriggerHint(kind, err);
  }
}

/**
 * Whether the workspace has a managed virtual network, from the endpoint list.
 * Only the "does not have a managed virtual network associated" answer means
 * no; any other failure is a real error, never "nothing to do". The first
 * response is returned too, so the deletion listing can reuse its first page.
 */
export async function hasManagedVirtualNetwork(
  ctx: SynapseContext,
): Promise<{ exists: boolean; response: Response }> {
  const response = await ctx.http.request(
    'GET',
    `${ctx.dataPlane}/managedVirtualNetworks/default/managedPrivateEndpoints?api-version=${DEFAULT_API_VERSION}`,
    ctx.scope,
  );
  if (response.status >= 200 && response.status < 300) {
    return { exists: true, response };
  }
  if (response.text.toLowerCase().includes(NO_MANAGED_VNET)) {
    core.debug('The workspace has no managed virtual network');
    return { exists: false, response };
  }
  throw responseError(response);
}
