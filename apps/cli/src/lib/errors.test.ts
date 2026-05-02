import { describe, expect, it } from 'vitest';
import { CliError, type ERROR_CODES, exitCodeFor } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';

describe('CliError', () => {
  it('carries code + message + optional details', () => {
    const err = new CliError('NOTE_NOT_FOUND', 'note abc not found', { id: 'abc' });
    expect(err.name).toBe('CliError');
    expect(err.code).toBe('NOTE_NOT_FOUND');
    expect(err.message).toBe('note abc not found');
    expect(err.details).toEqual({ id: 'abc' });
    expect(err).toBeInstanceOf(Error);
  });

  it('omits details when not provided', () => {
    const err = new CliError('DB_BUSY', 'retries exhausted');
    expect(err.details).toBeUndefined();
  });
});

describe('exitCodeFor', () => {
  const cases: [keyof typeof ERROR_CODES, number][] = [
    ['NOTE_NOT_FOUND', EXIT_CODES.FAILURE],
    ['DB_BUSY', EXIT_CODES.FAILURE],
    ['HTTP_ERROR', EXIT_CODES.FAILURE],
    ['UNKNOWN', EXIT_CODES.FAILURE],
    ['ALREADY_TRASHED', EXIT_CODES.FAILURE],
    ['USAGE_ERROR', EXIT_CODES.USAGE],
    ['INVALID_JSON_INPUT', EXIT_CODES.USAGE],
    ['INVALID_TAG', EXIT_CODES.USAGE],
    ['CONFIG_NOT_FOUND', EXIT_CODES.ENV],
    ['DATA_DIR_MISSING', EXIT_CODES.ENV],
    ['ENV_UNSUPPORTED', EXIT_CODES.ENV],
    ['DAEMON_UNAVAILABLE', EXIT_CODES.DAEMON_UNAVAILABLE],
    ['DAEMON_RUNNING_BLOCKED', EXIT_CODES.CONFLICT],
    ['VERSION_MISMATCH', EXIT_CODES.CONFLICT],
    ['MIGRATION_REQUIRED', EXIT_CODES.CONFLICT],
    ['INCOMPATIBLE_DB', EXIT_CODES.CONFLICT],
    ['MIGRATION_BUSY', EXIT_CODES.CONFLICT],
    ['USER_CANCELLED', EXIT_CODES.CANCELLED],
  ];
  for (const [code, expected] of cases) {
    it(`maps ${code} → ${expected}`, () => {
      expect(exitCodeFor(code)).toBe(expected);
    });
  }

  it('falls back to FAILURE for unknown codes', () => {
    // @ts-expect-error — intentional: runtime surface can receive unmapped strings
    expect(exitCodeFor('SOMETHING_WEIRD')).toBe(EXIT_CODES.FAILURE);
  });
});
