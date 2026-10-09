import * as core from '@actions/core';

// Masking a one- or two-character value would blank those characters
// everywhere in the logs, and core.setSecret("") makes the runner warn.
export const MIN_MASK_LENGTH = 3;

/**
 * Masks a secret in the logs. Returns false when the value is too short to
 * mask. The runner masks line by line, so each line of a multi-line value
 * (a PEM key, say) is masked too.
 */
export function mask(value: string): boolean {
  if (value.length < MIN_MASK_LENGTH) {
    return false;
  }
  core.setSecret(value);
  if (/[\r\n]/.test(value)) {
    for (const line of value.split(/\r?\n/)) {
      if (line.length >= MIN_MASK_LENGTH && line !== value) {
        core.setSecret(line);
      }
    }
  }
  return true;
}
