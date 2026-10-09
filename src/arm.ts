// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { awaitArmDeploy } from './lro.ts';
import { DEFAULT_API_VERSION, KINDS } from './kinds.ts';
import type { LroContext } from './lro.ts';

export interface ArmContext extends LroContext {
  /** The Azure Resource Manager endpoint; a trailing slash is fine. */
  arm: string;
  /** Token scope of Azure Resource Manager. */
  scope: string;
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
}

const kind = KINDS.find((candidate) => candidate.id === 'integrationRuntimes');

/** The integration runtime's resource URL under the workspace. */
export function integrationRuntimeUrl(ctx: ArmContext, name: string): string {
  const apiVersion = kind?.apiVersion ?? DEFAULT_API_VERSION;
  return (
    `${ctx.arm.replace(/\/+$/, '')}/subscriptions/${encodeURIComponent(ctx.subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(ctx.resourceGroup)}` +
    `/providers/Microsoft.Synapse/workspaces/${encodeURIComponent(ctx.workspace)}` +
    `/integrationRuntimes/${encodeURIComponent(name)}?api-version=${apiVersion}`
  );
}

/** PUTs the integration runtime through ARM and waits by ARM's operation rules. */
export async function deployIntegrationRuntime(
  ctx: ArmContext,
  name: string,
  body: unknown,
): Promise<void> {
  const put = await ctx.http.request('PUT', integrationRuntimeUrl(ctx, name), ctx.scope, body);
  await awaitArmDeploy(ctx, put, {
    scope: ctx.scope,
    label: `integrationRuntimes/${name}`,
    name,
    operationApiVersion: kind?.apiVersion ?? DEFAULT_API_VERSION,
    operationBase:
      `/subscriptions/${encodeURIComponent(ctx.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(ctx.resourceGroup)}` +
      `/providers/Microsoft.Synapse/workspaces/${encodeURIComponent(ctx.workspace)}`,
  });
}
