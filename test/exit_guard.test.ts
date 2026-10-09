import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { guardAgainstSilentExit, PENDING_REQUESTS_MESSAGE } from '../src/exit_guard.ts';

function fakeProcess() {
  const handlers: (() => void)[] = [];
  const registered: string[] = [];
  return {
    handlers,
    registered,
    exitCode: undefined as number | string | null | undefined,
    once(event: 'beforeExit', handler: () => void) {
      registered.push(event);
      handlers.push(handler);
      return this;
    },
  };
}

describe('guardAgainstSilentExit', () => {
  it('fails the run when main never settled', () => {
    const proc = fakeProcess();
    const setFailed = mock.fn((_message: string) => undefined);
    guardAgainstSilentExit(proc, () => false, setFailed);

    proc.handlers[0]?.();

    assert.deepEqual(
      setFailed.mock.calls.map((call) => call.arguments),
      [[PENDING_REQUESTS_MESSAGE]],
    );
    assert.equal(proc.exitCode, 1);
  });

  it('leaves a settled run alone', () => {
    const proc = fakeProcess();
    const setFailed = mock.fn((_message: string) => undefined);
    guardAgainstSilentExit(proc, () => true, setFailed);

    proc.handlers[0]?.();

    assert.equal(setFailed.mock.callCount(), 0);
    assert.equal(proc.exitCode, undefined);
  });

  it('registers once, so a second beforeExit cannot report twice', () => {
    const proc = fakeProcess();
    guardAgainstSilentExit(
      proc,
      () => true,
      () => undefined,
    );
    assert.deepEqual(proc.registered, ['beforeExit']);
  });
});
