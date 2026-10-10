export const PENDING_REQUESTS_MESSAGE =
  'The action stopped with requests still pending; the deployment may be incomplete. Re-run the job.';

/**
 * Node exits 0 when the event loop drains, even if main() never settled. A
 * promise that never settles must never look like a green run.
 */
export function guardAgainstSilentExit(
  proc: {
    once(event: 'beforeExit', listener: () => void): unknown;
    exitCode?: number | string | null;
  },
  hasSettled: () => boolean,
  setFailed: (message: string) => void,
): void {
  // once: setFailed and the exit code are enough, and a second beforeExit
  // (the loop can drain again) must not report the failure twice.
  proc.once('beforeExit', () => {
    if (!hasSettled()) {
      setFailed(PENDING_REQUESTS_MESSAGE);
      proc.exitCode = 1;
    }
  });
}

/**
 * Runs the action's work under the guard: success exits 0, failure reports
 * the message and exits 1, and work that never settles is caught by the
 * guard when the event loop drains.
 */
export async function runGuarded(
  proc: {
    once(event: 'beforeExit', listener: () => void): unknown;
    exitCode?: number | string | null;
    exit(code: number): unknown;
  },
  work: () => Promise<unknown>,
  setFailed: (message: string) => void,
): Promise<void> {
  let settled = false;
  guardAgainstSilentExit(proc, () => settled, setFailed);
  try {
    await work();
    settled = true;
    proc.exit(0);
  } catch (err) {
    settled = true;
    setFailed(err instanceof Error ? err.message : String(err));
    proc.exit(1);
  }
}
