import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mask, MIN_MASK_LENGTH } from '../src/mask.ts';

function masked(action: () => void): string[] {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  };
  try {
    action();
  } finally {
    process.stdout.write = original;
  }
  return written
    .filter((line) => line.startsWith('::add-mask::'))
    .map((line) => line.slice('::add-mask::'.length).trim());
}

describe('mask', () => {
  it('masks values of three or more characters', () => {
    assert.equal(MIN_MASK_LENGTH, 3);
    assert.deepEqual(
      masked(() => {
        assert.equal(mask('abc'), true);
        assert.equal(mask('a longer secret'), true);
      }),
      ['abc', 'a longer secret'],
    );
  });

  it('skips empty, one- and two-character values', () => {
    assert.deepEqual(
      masked(() => {
        assert.equal(mask(''), false);
        assert.equal(mask('a'), false);
        assert.equal(mask('ab'), false);
      }),
      [],
    );
  });

  it('also masks each line of a multi-line value of three or more characters', () => {
    const pem = '-----BEGIN KEY-----\r\nabcdef\nxy\n\n-----END KEY-----';
    assert.deepEqual(
      masked(() => {
        assert.equal(mask(pem), true);
      }),
      // The runner's workflow command escapes newlines, so compare unescaped.
      [
        pem.replace(/\r/g, '%0D').replace(/\n/g, '%0A'),
        '-----BEGIN KEY-----',
        'abcdef',
        '-----END KEY-----',
      ],
    );
  });
});
