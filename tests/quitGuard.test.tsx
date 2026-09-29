import { describe, expect, it } from 'bun:test';
import { QUIT_GUARD_WINDOW_MS, quitGuardSupported, quitWarningMs } from '../src/services/quitGuard';

describe('the ⌘Q guard', () => {
  it('shows the warning until just before a second press stops quitting, within reason', () => {
    expect(quitWarningMs({ windowMs: 3_000 })).toBe(2_700);
    expect(quitWarningMs({ windowMs: 60_000 })).toBe(9_700);
    // A window too short to take much off is halved instead.
    expect(quitWarningMs({ windowMs: 400 })).toBe(200);
    for (const payload of [undefined, null, 'soon', {}, { windowMs: 0 }, { windowMs: -5 }, { windowMs: Number.NaN }, { windowMs: '1500' }]) {
      expect(quitWarningMs(payload)).toBe(QUIT_GUARD_WINDOW_MS - 300);
    }
  });

  it('is only offered on macOS', () => {
    expect(quitGuardSupported('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(true);
    expect(quitGuardSupported('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe(false);
    expect(quitGuardSupported('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(false);
  });
});
