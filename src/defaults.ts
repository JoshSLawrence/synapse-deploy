// Portions derived from Azure/Synapse-workspace-deployment.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import type { Json } from './expression.ts';
import type { KindId } from './kinds.ts';

// Anchored on purpose: a user's `x-WorkspaceDefaultStorage-copy` is an
// ordinary linked service and must be deployed.
const DEFAULT_LINKED_SERVICE = /-workspacedefault(sqlserver|storage)$/i;
const DEFAULT_CREDENTIAL = /^workspacesystemidentity$/i;
const DEFAULT_ENDPOINT = /^synapse-ws-/i;
const REMAPPABLE_LINKED_SERVICE = /^(.+)-WorkspaceDefault(Storage|SqlServer)$/i;

/** Whether an artifact is one the workspace creates itself: never deployed, never deleted. */
export function isServiceDefault(kind: KindId, name: string): boolean {
  switch (kind) {
    case 'linkedServices':
      return DEFAULT_LINKED_SERVICE.test(name);
    case 'credentials':
      return DEFAULT_CREDENTIAL.test(name);
    case 'managedPrivateEndpoints':
      return DEFAULT_ENDPOINT.test(name);
    default:
      return false;
  }
}

/**
 * The source workspace's default linked service names become the target's:
 * `<source>-WorkspaceDefaultStorage` is `<target>-WorkspaceDefaultStorage`.
 */
export function remapDefaultName(name: string, workspaceName: string): string {
  const match = REMAPPABLE_LINKED_SERVICE.exec(name);
  if (!match || (match[1] ?? '').toLowerCase() === workspaceName.toLowerCase()) {
    return name;
  }
  const suffix = (match[2] ?? '').toLowerCase() === 'storage' ? 'Storage' : 'SqlServer';
  return `${workspaceName}-WorkspaceDefault${suffix}`;
}

function remapDependency(text: string, workspaceName: string): string {
  const slash = text.lastIndexOf('/');
  // Only a linked service can be a workspace default; a pipeline named like
  // one must keep its name.
  const collection = text.slice(0, slash).split('/').pop() ?? '';
  if (collection.toLowerCase() !== 'linkedservices') {
    return text;
  }
  return text.slice(0, slash + 1) + remapDefaultName(text.slice(slash + 1), workspaceName);
}

/**
 * Remaps every `referenceName` string, and the last segment of every string
 * in a `dependsOn` array, anywhere in an artifact body. Returns a new value.
 */
export function remapDefaultReferences(value: Json, workspaceName: string): Json {
  if (Array.isArray(value)) {
    return value.map((item) => remapDefaultReferences(item, workspaceName));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const out: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'referenceName' &&
      typeof child === 'string' &&
      value['type'] === 'LinkedServiceReference'
    ) {
      out[key] = remapDefaultName(child, workspaceName);
    } else if (key === 'dependsOn' && Array.isArray(child)) {
      out[key] = child.map((item) =>
        typeof item === 'string'
          ? remapDependency(item, workspaceName)
          : remapDefaultReferences(item, workspaceName),
      );
    } else {
      out[key] = remapDefaultReferences(child, workspaceName);
    }
  }
  return out;
}
