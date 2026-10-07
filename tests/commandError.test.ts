import { describe, expect, it } from 'bun:test';
import { CommandFailure, readCommandError } from '../src/services/commandError';
import type { CommandError } from '../src/native/types';

describe('what a command said went wrong', () => {
  it('takes the fields a failure crossed with, and keeps only the kinds it knows', () => {
    const core: CommandError = { kind: 'core', status: 502, reason: 'request failed', message: 'Management API error (502): request failed' };
    expect(readCommandError(core)).toEqual(core);
    expect(readCommandError({ kind: 'canceled', message: 'Download canceled' })).toEqual({ kind: 'canceled', message: 'Download canceled' });
    expect(readCommandError({ kind: 'unarchived', message: '3 of 40 not archived' }).kind).toBe('unarchived');
    expect(readCommandError({ kind: 'changed', message: 'Changed since the look' }).kind).toBe('changed');
    expect(readCommandError({ kind: 'from-a-newer-build', message: 'Something new' })).toEqual({ kind: 'failed', message: 'Something new' });
  });

  it('reads a command that answers with only a sentence as a plain failure, whatever the sentence says', () => {
    // A core update refused to keep settings safe says "canceled", but nobody stopped it.
    const refused = 'The core’s settings couldn’t be carried over, so the update was canceled to avoid losing settings';
    expect(readCommandError(refused)).toEqual({ kind: 'failed', message: refused });
    expect(readCommandError(new Error('Download failed'))).toEqual({ kind: 'failed', message: 'Download failed' });
  });

  it('shows the same sentence as before when a failure is thrown on', () => {
    const failure = new CommandFailure({ kind: 'core', status: 404, message: 'Management API error (404)' });
    expect(String(failure)).toBe('Management API error (404)');
    expect(failure.message).toBe('Management API error (404)');
    expect(readCommandError(failure)).toBe(failure.failure);
  });
});
