import * as core from '@actions/core';
import { guardAgainstSilentExit } from './exit_guard.ts';
import { readInputs } from './inputs.ts';
import { defaultDeps, run } from './run.ts';

// Stack traces then point at src/, not at the bundle.
process.setSourceMapsEnabled(true);

let settled = false;
guardAgainstSilentExit(
  process,
  () => settled,
  (message) => {
    core.setFailed(message);
  },
);

try {
  const inputs = readInputs();
  await run(inputs, defaultDeps(inputs));
  settled = true;
  process.exit(0);
} catch (err) {
  settled = true;
  core.setFailed(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
