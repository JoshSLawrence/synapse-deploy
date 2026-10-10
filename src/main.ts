import * as core from '@actions/core';
import { runGuarded } from './exit_guard.ts';
import { readInputs } from './inputs.ts';
import { defaultDeps, run } from './run.ts';

// Stack traces then point at src/, not at the bundle.
process.setSourceMapsEnabled(true);

await runGuarded(
  process,
  async () => {
    const inputs = readInputs();
    await run(inputs, defaultDeps(inputs));
  },
  (message) => {
    core.setFailed(message);
  },
);
