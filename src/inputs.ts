import * as core from '@actions/core';
import type { AuthMode } from './auth.ts';
import { CLOUD_NAMES, findCloud } from './cloud.ts';
import type { Cloud } from './cloud.ts';
import { mask } from './mask.ts';

export interface ParameterOverride {
  name: string;
  value: string;
}

export interface Inputs {
  workspaceName: string;
  templateFile: string;
  parameterFiles: string[];
  parameters: ParameterOverride[];
  cloud: Cloud;
  auth: AuthMode;
  clientId: string;
  tenantId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
  deleteArtifacts: boolean;
  deployManagedPrivateEndpoints: boolean;
  dryRun: boolean;
}

/** Where inputs come from; tests pass a map, the action passes @actions/core. */
export interface InputSource {
  getInput(name: string): string;
  getBooleanInput(name: string): boolean;
}

export const coreInputSource: InputSource = {
  getInput: (name) => core.getInput(name),
  getBooleanInput: (name) => core.getBooleanInput(name),
};

const WORKSPACE_NAME = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;

const AUTH_MODES: readonly AuthMode[] = ['oidc', 'client-secret', 'managed-identity'];

function required(source: InputSource, name: string): string {
  const value = source.getInput(name).trim();
  if (!value) {
    throw new Error(`Input ${name} is required; set it with \`${name}: <value>\` on the action.`);
  }
  return value;
}

function bool(source: InputSource, name: string): boolean {
  // core.getBooleanInput rejects anything but YAML true/false, so a typo such
  // as `yes` fails instead of silently meaning false. An empty input (not
  // set) means the documented default, false.
  if (!source.getInput(name).trim()) {
    return false;
  }
  try {
    return source.getBooleanInput(name);
  } catch {
    throw new Error(`Input ${name} must be true or false; got "${source.getInput(name)}".`);
  }
}

/**
 * `name=value` lines. The first `=` splits, the name is trimmed, and a bad
 * line is reported by number only: its value may be a secret.
 */
export function parseParameterLines(text: string): ParameterOverride[] {
  const overrides: ParameterOverride[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    const at = line.indexOf('=');
    const name = at < 0 ? '' : line.slice(0, at).trim();
    if (!name) {
      throw new Error(
        `Input parameters, line ${index + 1}: expected name=value. ` +
          'Write one name=value per line (object and array values as JSON).',
      );
    }
    overrides.push({ name, value: line.slice(at + 1) });
  });
  return overrides;
}

function parseAuth(value: string): AuthMode {
  const wanted = value.trim().toLowerCase();
  const mode = AUTH_MODES.find((candidate) => candidate === wanted);
  if (!mode) {
    throw new Error(
      `Input auth must be one of ${AUTH_MODES.join(', ')}; got "${value}". ` +
        'Use oidc for GitHub OIDC (the default).',
    );
  }
  return mode;
}

function validateAuth(
  mode: AuthMode,
  values: { clientId: string; tenantId: string; clientSecret: string },
): void {
  const missing = (names: [string, string][]) =>
    names.filter(([, value]) => !value).map(([name]) => name);

  if (mode === 'oidc') {
    const absent = missing([
      ['client-id', values.clientId],
      ['tenant-id', values.tenantId],
    ]);
    if (absent.length > 0) {
      throw new Error(
        `auth: oidc requires the ${absent.join(' and ')} input(s); set them on the action.`,
      );
    }
    if (values.clientSecret) {
      throw new Error('client-secret is set, but auth is oidc; set auth: client-secret to use it.');
    }
  } else if (mode === 'client-secret') {
    const absent = missing([
      ['client-id', values.clientId],
      ['tenant-id', values.tenantId],
      ['client-secret', values.clientSecret],
    ]);
    if (absent.length > 0) {
      throw new Error(
        `auth: client-secret requires the ${absent.join(', ')} input(s); set them on the action.`,
      );
    }
  } else if (values.clientSecret) {
    throw new Error(
      'client-secret is set, but auth is managed-identity, which takes no secret; remove client-secret.',
    );
  }
}

/** Reads and validates every input once. Every failure names the input and the fix. */
export function readInputs(source: InputSource = coreInputSource): Inputs {
  // Mask before anything can be logged, including a validation failure below.
  const clientSecret = source.getInput('client-secret');
  mask(clientSecret);

  const workspaceName = required(source, 'workspace-name');
  // The name becomes part of a host name that receives the bearer token, so
  // anything that could change the host (a dot, slash or @) must be refused.
  if (!WORKSPACE_NAME.test(workspaceName)) {
    throw new Error(
      `Input workspace-name "${workspaceName}" is not a valid workspace name: ` +
        'use 1 to 50 lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
    );
  }
  const templateFile = required(source, 'template-file');

  const cloudInput = source.getInput('cloud').trim() || 'AzureCloud';
  const cloud = findCloud(cloudInput);
  if (!cloud) {
    throw new Error(
      `Input cloud must be one of ${CLOUD_NAMES.join(', ')} (case-insensitive); got "${cloudInput}".`,
    );
  }

  const auth = parseAuth(source.getInput('auth') || 'oidc');
  const clientId = source.getInput('client-id').trim();
  const tenantId = source.getInput('tenant-id').trim();
  validateAuth(auth, { clientId, tenantId, clientSecret });

  return {
    workspaceName,
    templateFile,
    parameterFiles: source
      .getInput('parameters-file')
      .split(/\s+/)
      .filter((file) => file !== ''),
    parameters: parseParameterLines(source.getInput('parameters')),
    cloud,
    auth,
    clientId,
    tenantId,
    clientSecret,
    subscriptionId: source.getInput('subscription-id').trim(),
    resourceGroup: source.getInput('resource-group').trim(),
    deleteArtifacts: bool(source, 'delete-artifacts'),
    deployManagedPrivateEndpoints: bool(source, 'deploy-managed-private-endpoints'),
    dryRun: bool(source, 'dry-run'),
  };
}
