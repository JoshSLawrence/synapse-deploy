import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCloud } from '../../src/cloud.ts';
import { createHttp } from '../../src/http.ts';
import type { Inputs } from '../../src/inputs.ts';
import type { Deps } from '../../src/run.ts';
import type { FakeSynapse } from '../fake/synapse_server.ts';

export const WORKSPACE = 'myworkspace';

type Json = Record<string, unknown>;

const PREFIX = 'Microsoft.Synapse/workspaces/';

/** A template resource named `<workspace>/<name>`, depending on `<collection>/<name>` strings. */
export function resource(
  type: string,
  name: string,
  properties: Json = {},
  dependsOn: string[] = [],
): Json {
  const isEndpoint = type === 'managedVirtualNetworks/managedPrivateEndpoints';
  return {
    name: `[concat(parameters('workspaceName'), '/${isEndpoint ? 'default/' : ''}${name}')]`,
    type: PREFIX + type,
    apiVersion: '2019-06-01-preview',
    properties,
    dependsOn: dependsOn.map(
      (dependency) => `[concat(variables('workspaceId'), '/${dependency}')]`,
    ),
  };
}

export function template(resources: Json[]): string {
  return JSON.stringify({
    $schema: 'http://schema.management.azure.com/schemas/2015-01-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    parameters: { workspaceName: { type: 'string', metadata: 'Workspace name' } },
    variables: {
      workspaceId: "[concat('Microsoft.Synapse/workspaces/', parameters('workspaceName'))]",
    },
    resources,
  });
}

export function reference(name: string, type: string): Json {
  return { referenceName: name, type };
}

/** A temp directory holding template.json, and inputs that point at it. */
export function setup(resources: Json[], overrides: Partial<Inputs> = {}): Inputs {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-deploy-e2e-'));
  writeFileSync(join(dir, 'template.json'), template(resources));
  const cloud = findCloud('AzureCloud');
  if (cloud === undefined) {
    throw new Error('AzureCloud is missing from the cloud table');
  }
  return {
    workspaceName: WORKSPACE,
    templateFile: join(dir, 'template.json'),
    parameterFiles: [],
    parameters: [],
    cloud,
    auth: 'oidc',
    clientId: '',
    tenantId: '',
    clientSecret: '',
    subscriptionId: '',
    resourceGroup: '',
    deleteArtifacts: false,
    deployManagedPrivateEndpoints: false,
    dryRun: false,
    ...overrides,
  };
}

/**
 * Deps against the fake server. The clock moves only when the code sleeps, so
 * deadlines work and nothing waits in real time; the server's own latency is
 * what makes operations overlap.
 */
export function depsFor(fake: FakeSynapse): Deps {
  let time = Date.UTC(2026, 9, 9, 12, 0, 0);
  const now = () => time;
  const sleep = (ms: number) => {
    time += ms;
    return Promise.resolve();
  };
  return {
    tokens: fake.tokens,
    endpoints: fake.endpoints,
    http: createHttp({ tokens: fake.tokens, sleep, now }),
    sleep,
    now,
  };
}
