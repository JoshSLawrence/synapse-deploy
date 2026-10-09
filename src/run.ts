import { createTokenProvider } from './auth.ts';
import type { TokenProvider } from './auth.ts';
import { dataPlaneUrl } from './cloud.ts';
import { createHttp, defaultSleep } from './http.ts';
import type { Http } from './http.ts';
import type { Inputs } from './inputs.ts';

/**
 * Everything the run reaches outside the process through. Tests pass a fake
 * token provider, loopback endpoints and an instant sleep; no test-only input
 * or environment variable exists in shipped code.
 */
export interface Deps {
  tokens: TokenProvider;
  endpoints: { dataPlane: string; arm: string };
  http: Http;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function defaultDeps(inputs: Inputs): Deps {
  const tokens = createTokenProvider({
    mode: inputs.auth,
    clientId: inputs.clientId,
    clientSecret: inputs.clientSecret,
    tenantId: inputs.tenantId,
    authorityHost: inputs.cloud.login,
  });
  return {
    tokens,
    endpoints: {
      dataPlane: dataPlaneUrl(inputs.cloud, inputs.workspaceName),
      arm: inputs.cloud.arm.replace(/\/+$/, ''),
    },
    http: createHttp({ tokens }),
    sleep: defaultSleep,
    now: Date.now,
  };
}

export function run(inputs: Inputs, _deps: Deps): Promise<void> {
  return Promise.reject(
    new Error(
      `not implemented yet: the inputs for workspace ${inputs.workspaceName} are valid, ` +
        'but this rewrite cannot deploy anything until v1.0.0 is released. ' +
        'Do not use this version of the action yet.',
    ),
  );
}
