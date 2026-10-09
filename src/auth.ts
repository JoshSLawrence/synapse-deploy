import * as core from '@actions/core';
import {
  ClientAssertionCredential,
  ClientSecretCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { mask } from './mask.ts';
import type { ClientSecretCredentialOptions } from '@azure/identity';
import type { TokenCredential } from '@azure/identity';

export type AuthMode = 'oidc' | 'client-secret' | 'managed-identity';

export interface TokenProvider {
  getToken(scope: string): Promise<string>;
}

export interface AuthInputs {
  mode: AuthMode;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  // The cloud's login host. It must match the cloud of the target workspace,
  // otherwise Azure China and US Government sign-ins go to the public cloud.
  authorityHost: string;
  // Lets tests observe the sign-in requests without a network.
  httpClient?: ClientSecretCredentialOptions['httpClient'];
  // Lets tests supply the GitHub OIDC token without a runner; defaults to
  // core.getIDToken.
  getIdToken?: (audience: string) => Promise<string>;
}

export const SIGN_IN_TIMEOUT_MS = 60_000;

// ManagedIdentityCredential retries an IMDS 410 for about 93 s (5 tries from
// 3 s, doubling), so a shorter timeout would cut off a recovery that works.
export const MANAGED_IDENTITY_SIGN_IN_TIMEOUT_MS = 120_000;

const FEDERATED_AUDIENCE = 'api://AzureADTokenExchange';

export function signInTimeoutMs(mode: AuthMode): number {
  return mode === 'managed-identity' ? MANAGED_IDENTITY_SIGN_IN_TIMEOUT_MS : SIGN_IN_TIMEOUT_MS;
}

function requireInputs(mode: AuthMode, inputs: AuthInputs, names: (keyof AuthInputs)[]): void {
  const missing = names.filter((name) => !inputs[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required input(s) for ${mode} authentication: ${missing.join(', ')}. ` +
        `Set them on the action and retry.`,
    );
  }
}

/** Picks the credential for the configured auth mode. */
export function createCredential(inputs: AuthInputs): TokenCredential {
  switch (inputs.mode) {
    case 'managed-identity':
      // A client ID selects a user-assigned identity; without one the
      // system-assigned identity is used.
      return inputs.clientId
        ? new ManagedIdentityCredential({ clientId: inputs.clientId })
        : new ManagedIdentityCredential();

    case 'oidc':
      requireInputs('oidc', inputs, ['clientId', 'tenantId']);
      core.debug(
        `Authenticating with federated credentials: client ${inputs.clientId}, tenant ${inputs.tenantId}`,
      );
      return new ClientAssertionCredential(
        inputs.tenantId,
        inputs.clientId,
        async () => {
          try {
            return await (inputs.getIdToken ?? ((audience) => core.getIDToken(audience)))(
              FEDERATED_AUDIENCE,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
              'Failed to get the GitHub OIDC token. Ensure the job has `id-token: write` ' +
                `permission and the client-id and tenant-id inputs are set: ${message}`,
              { cause: err },
            );
          }
        },
        { authorityHost: inputs.authorityHost, httpClient: inputs.httpClient },
      );

    case 'client-secret':
      requireInputs('client-secret', inputs, ['clientId', 'clientSecret', 'tenantId']);
      core.debug(
        `Authenticating with a client secret: client ${inputs.clientId}, tenant ${inputs.tenantId}`,
      );
      return new ClientSecretCredential(inputs.tenantId, inputs.clientId, inputs.clientSecret, {
        authorityHost: inputs.authorityHost,
        httpClient: inputs.httpClient,
      });
  }
}

// A sign-in that never answers would otherwise hold the job until the runner
// kills it.
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a credential so that every token it returns is masked in the logs.
 * The credential caches tokens per scope until shortly before they expire,
 * so keeping one provider for the run avoids a sign-in per artifact.
 */
export function createTokenProvider(
  inputs: AuthInputs,
  credential: TokenCredential = createCredential(inputs),
  timeoutMs: number = signInTimeoutMs(inputs.mode),
): TokenProvider {
  const masked = new Set<string>();

  return {
    async getToken(scope: string): Promise<string> {
      let token: string;
      try {
        const accessToken = await withTimeout(
          credential.getToken(scope),
          timeoutMs,
          `Sign-in with ${inputs.mode} (${inputs.authorityHost}) timed out after ${Math.round(timeoutMs / 1000)} s; retry the job.`,
        );
        if (!accessToken) {
          throw new Error('the credential returned no token');
        }
        token = accessToken.token;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Azure authentication failed: ${message}`, { cause: err });
      }

      if (!masked.has(token)) {
        mask(token);
        masked.add(token);
      }
      return token;
    },
  };
}
