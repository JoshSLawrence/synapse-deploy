import * as core from '@actions/core';

// Masking a one- or two-character value would blank those characters
// everywhere in the logs, and core.setSecret("") makes the runner warn.
export const MIN_MASK_LENGTH = 3;

/** Masks a secret in the logs. Returns false when the value is too short to mask. */
export function mask(value: string): boolean {
  if (value.length < MIN_MASK_LENGTH) {
    return false;
  }
  core.setSecret(value);
  return true;
}
