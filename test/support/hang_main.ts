// A stand-in for src/main.ts that a test spawns: the same runGuarded and run(),
// with sign-in that never settles (hang), a missing template (fail) or an
// empty set of resources (ok). Usage: hang_main.ts <mode> <template file>
import * as core from '@actions/core';
import { findCloud } from '../../src/cloud.ts';
import { runGuarded } from '../../src/exit_guard.ts';
import { run } from '../../src/run.ts';

const [mode, templateFile] = process.argv.slice(2);
const cloud = findCloud('AzureCloud');
if (cloud === undefined || templateFile === undefined) {
  throw new Error('usage: hang_main.ts <mode> <template file>');
}

await runGuarded(
  process,
  () =>
    run(
      {
        workspaceName: 'myworkspace',
        templateFile: mode === 'fail' ? `${templateFile}.missing` : templateFile,
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
        // A dry run of an `ok` template needs no server beyond a token.
        dryRun: mode === 'ok',
      },
      {
        // A promise that never settles and holds no handle: the event loop drains.
        tokens: {
          getToken: () => (mode === 'ok' ? Promise.resolve('t') : new Promise(() => undefined)),
        },
        endpoints: { dataPlane: 'http://127.0.0.1:1', arm: 'http://127.0.0.1:1' },
        http: { request: () => Promise.reject(new Error('no network in this stand-in')) },
        sleep: () => Promise.resolve(),
        now: Date.now,
      },
    ),
  (message) => {
    core.setFailed(message);
  },
);
