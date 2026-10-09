import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  ClientAssertionCredential,
  ClientSecretCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type { TokenCredential } from '@azure/identity';
import {
  createCredential,
  createTokenProvider,
  MANAGED_IDENTITY_SIGN_IN_TIMEOUT_MS,
  SIGN_IN_TIMEOUT_MS,
  signInTimeoutMs,
} from '../src/auth.ts';
import type { AuthInputs } from '../src/auth.ts';
import { CLOUD_NAMES, findCloud } from '../src/cloud.ts';

const ZERO = '00000000-0000-0000-0000-000000000000';

function inputs(overrides: Partial<AuthInputs> = {}): AuthInputs {
  return {
    mode: 'client-secret',
    clientId: ZERO,
    clientSecret: 'not-a-real-secret',
    tenantId: ZERO,
    authorityHost: 'https://login.microsoftonline.com/',
    ...overrides,
  };
}

// Answers every request with a valid token response and records the URLs, so
// the tests see which login host a real credential talks to.
function recordingHttpClient(urls: string[]): AuthInputs['httpClient'] {
  return {
    sendRequest: (request: { url: string }) => {
      urls.push(request.url);
      const origin = new URL(request.url).origin;
      const body = request.url.includes('/discovery/instance')
        ? { tenant_discovery_endpoint: `${origin}/${ZERO}/v2.0/.well-known/openid-configuration` }
        : request.url.includes('openid-configuration')
          ? {
              token_endpoint: `${origin}/${ZERO}/oauth2/v2.0/token`,
              authorization_endpoint: `${origin}/${ZERO}/oauth2/v2.0/authorize`,
              issuer: `${origin}/${ZERO}/v2.0`,
            }
          : { access_token: 'token-value', token_type: 'Bearer', expires_in: 3600 };
      return Promise.resolve({
        request,
        status: 200,
        headers: {
          get: () => 'application/json',
          has: () => true,
          set: () => undefined,
          delete: () => undefined,
          toJSON: () => ({}),
          [Symbol.iterator]: function* () {
            // no headers
          },
        },
        bodyAsText: JSON.stringify(body),
      });
    },
  } as unknown as AuthInputs['httpClient'];
}

// core.setSecret writes an add-mask command to stdout; ES module namespaces
// cannot be stubbed, so the command is what the tests observe.
async function maskedDuring(action: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await action();
  } finally {
    process.stdout.write = original;
  }
  return written
    .filter((line) => line.startsWith('::add-mask::'))
    .map((line) => line.slice('::add-mask::'.length).trim());
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('Expected the promise to reject');
}

describe('credential choice', () => {
  it('uses a client secret credential for client-secret', () => {
    assert.ok(createCredential(inputs()) instanceof ClientSecretCredential);
  });

  it('uses a managed identity credential for managed-identity', () => {
    assert.ok(
      createCredential(inputs({ mode: 'managed-identity' })) instanceof ManagedIdentityCredential,
    );
  });

  it('passes the client ID to a user-assigned managed identity', () => {
    const credential = createCredential(
      inputs({ mode: 'managed-identity', clientId: 'user-assigned-client-id' }),
    );
    assert.equal(
      (credential as unknown as { clientId?: string }).clientId,
      'user-assigned-client-id',
    );
  });

  it('leaves the client ID unset for the system-assigned managed identity', () => {
    const credential = createCredential(inputs({ mode: 'managed-identity', clientId: '' }));
    assert.ok(!(credential as unknown as { clientId?: string }).clientId);
  });

  it('uses a client assertion credential for oidc', () => {
    assert.ok(createCredential(inputs({ mode: 'oidc' })) instanceof ClientAssertionCredential);
  });

  it('selects by mode alone, whatever else is set', () => {
    assert.ok(
      createCredential(inputs({ mode: 'oidc', clientSecret: 'not-a-real-secret' })) instanceof
        ClientAssertionCredential,
    );
  });

  it('names the missing inputs for a client secret', () => {
    assert.throws(
      () => createCredential(inputs({ clientSecret: '' })),
      /client-secret.*clientSecret/,
    );
  });

  it('names the missing inputs for oidc', () => {
    assert.throws(() => createCredential(inputs({ mode: 'oidc', tenantId: '' })), /oidc.*tenantId/);
  });
});

describe('oidc', () => {
  it('exchanges the GitHub OIDC token for the Azure AD audience', async () => {
    const getIdToken = mock.fn(() => Promise.resolve('github-oidc-token'));
    const provider = createTokenProvider(
      inputs({ mode: 'oidc', getIdToken, httpClient: recordingHttpClient([]) }),
    );

    await maskedDuring(async () => {
      assert.equal(await provider.getToken('https://management.azure.com/.default'), 'token-value');
    });
    assert.deepEqual(getIdToken.mock.calls[0]?.arguments, ['api://AzureADTokenExchange']);
  });

  it('hints at the id-token permission when no OIDC token is available', async () => {
    const getIdToken = () =>
      Promise.reject(new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable'));
    const provider = createTokenProvider(
      inputs({ mode: 'oidc', getIdToken, httpClient: recordingHttpClient([]) }),
    );

    const message = await messageOf(provider.getToken('https://management.azure.com/.default'));
    assert.match(message, /id-token: write/);
    assert.match(message, /Azure authentication failed/);
  });
});

describe('authority host per cloud', () => {
  // MSAL rewrites the legacy China host to its canonical alias, which is the
  // same cloud, so that alias is what the requests show.
  const hosts: Record<string, string> = {
    AzureCloud: 'login.microsoftonline.com',
    AzureChinaCloud: 'login.partner.microsoftonline.cn',
    AzureUSGovernment: 'login.microsoftonline.us',
  };

  for (const name of CLOUD_NAMES) {
    for (const mode of ['client-secret', 'oidc'] as const) {
      it(`${name} signs in at ${hosts[name]} with ${mode}`, async () => {
        const cloud = findCloud(name);
        assert.ok(cloud);
        const urls: string[] = [];
        const provider = createTokenProvider(
          inputs({
            mode,
            authorityHost: cloud.login,
            httpClient: recordingHttpClient(urls),
            getIdToken: () => Promise.resolve('github-oidc-token'),
          }),
        );
        await maskedDuring(async () => {
          await provider.getToken('https://management.azure.com/.default');
        });

        assert.ok(urls.length > 0);
        for (const url of urls) {
          assert.equal(new URL(url).host, hosts[name]);
        }
      });
    }
  }
});

describe('token masking', () => {
  it('masks each distinct token once', async () => {
    const tokens = ['first', 'first', 'second'];
    const credential: TokenCredential = {
      getToken: () => Promise.resolve({ token: tokens.shift() ?? '', expiresOnTimestamp: 0 }),
    };
    const provider = createTokenProvider(inputs(), credential);

    const masked = await maskedDuring(async () => {
      await provider.getToken('scope');
      await provider.getToken('scope');
      await provider.getToken('scope');
    });

    assert.deepEqual(masked, ['first', 'second']);
  });

  it('wraps credential failures with an actionable message', async () => {
    const credential: TokenCredential = { getToken: () => Promise.reject(new Error('boom')) };
    const provider = createTokenProvider(inputs(), credential);
    assert.equal(await messageOf(provider.getToken('scope')), 'Azure authentication failed: boom');
  });

  it('fails when the credential returns no token', async () => {
    const credential: TokenCredential = { getToken: () => Promise.resolve(null) };
    const provider = createTokenProvider(inputs(), credential);
    assert.match(await messageOf(provider.getToken('scope')), /returned no token/);
  });
});

describe('caching', () => {
  it('makes one token request for two getToken calls on the same scope', async () => {
    const urls: string[] = [];
    const provider = createTokenProvider(inputs({ httpClient: recordingHttpClient(urls) }));
    const tokenRequests = () => urls.filter((url) => url.includes('/oauth2/v2.0/token')).length;

    await maskedDuring(async () => {
      await provider.getToken('https://management.azure.com/.default');
      assert.equal(tokenRequests(), 1);
      await provider.getToken('https://management.azure.com/.default');
      assert.equal(tokenRequests(), 1);
    });
  });
});

describe('sign-in timeout', () => {
  it('is 60 s for oidc and client secret, 120 s for managed identity', () => {
    assert.equal(SIGN_IN_TIMEOUT_MS, 60_000);
    assert.equal(MANAGED_IDENTITY_SIGN_IN_TIMEOUT_MS, 120_000);
    assert.equal(signInTimeoutMs('oidc'), 60_000);
    assert.equal(signInTimeoutMs('client-secret'), 60_000);
    assert.equal(signInTimeoutMs('managed-identity'), 120_000);
  });

  it('fails with the mode and authority host when sign-in never answers', async () => {
    const credential: TokenCredential = {
      getToken: () => new Promise<never>(() => undefined),
    };
    const provider = createTokenProvider(
      inputs({ authorityHost: 'https://login.example.test/' }),
      credential,
      20,
    );

    const message = await messageOf(provider.getToken('scope'));
    assert.match(
      message,
      /Sign-in with client-secret \(https:\/\/login\.example\.test\/\) timed out/,
    );
    assert.match(message, /retry the job/);
  });

  it('gives a managed identity 120 s by default', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const credential: TokenCredential = {
      getToken: () => new Promise<never>(() => undefined),
    };
    const provider = createTokenProvider(inputs({ mode: 'managed-identity' }), credential);

    let settled = false;
    const outcome = provider.getToken('scope').then(
      () => 'resolved',
      (err: unknown) => {
        settled = true;
        return err instanceof Error ? err.message : String(err);
      },
    );

    t.mock.timers.tick(119_999);
    await Promise.resolve();
    assert.equal(settled, false);

    t.mock.timers.tick(1);
    const message = await outcome;
    assert.match(message, /managed-identity.*timed out after 120 s/);
  });

  it('gives oidc 60 s by default', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const credential: TokenCredential = {
      getToken: () => new Promise<never>(() => undefined),
    };
    const provider = createTokenProvider(inputs({ mode: 'oidc' }), credential);

    const outcome = provider.getToken('scope').then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    t.mock.timers.tick(60_000);
    assert.match(await outcome, /oidc.*timed out after 60 s/);
  });
});
