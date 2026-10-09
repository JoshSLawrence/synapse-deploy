import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caseNames, compareCase, readCase, REASONS } from './support/parity.ts';

const key = (d: { artifact: string; path: string; legacy?: unknown; current?: unknown }) =>
  JSON.stringify([d.artifact, d.path, d.legacy ?? null, d.current ?? null]);

describe('parity with the predecessor (legacy.json)', () => {
  it('has fixture cases to compare', () => {
    assert.ok(caseNames().length >= 14);
  });

  for (const name of caseNames()) {
    it(`${name}: equal to legacy.json except the listed differences`, () => {
      const { legacy, current, differences } = readCase(name);
      const actual = compareCase(legacy, current, differences);

      for (const difference of differences) {
        assert.ok(
          (REASONS as readonly string[]).includes(difference.reason),
          `${name}: ${difference.artifact} ${difference.path}: unknown reason "${difference.reason}"`,
        );
      }

      const listed = new Set(differences.map(key));
      assert.equal(
        listed.size,
        differences.length,
        `${name}: duplicate entries in differences.json`,
      );
      const unexplained = actual.filter((d) => !listed.has(key(d)));
      assert.deepEqual(unexplained, [], `${name}: differences not in differences.json`);

      const occurring = new Set(actual.map(key));
      const stale = differences.filter((d) => !occurring.has(key(d)));
      assert.deepEqual(stale, [], `${name}: listed differences that no longer occur`);
    });
  }
});
