import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AuthFileStatus } from '../src/components/AuthFileCommands';
import { listingReloadDelay } from '../src/services/accountsStore';
import { authFileAvailability, type AuthFileAvailability } from '../src/services/authFiles';

const now = Date.parse('2026-09-16T07:20:00Z');
const render = (availability: AuthFileAvailability, removed = false) => renderToStaticMarkup(
  <I18nProvider><AuthFileStatus availability={availability} now={now} removed={removed} /></I18nProvider>,
);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('credential status on the Auth Files page', () => {
  it('never shows the core’s raw status words', () => {
    for (const file of [
      { status: 'active' },
      { status: 'error', status_message: 'quota exhausted', unavailable: false, cooldowns: [] },
      { status: 'error', status_message: 'token expired', unavailable: true, cooldowns: [] },
    ]) {
      const html = text(render(authFileAvailability(file, now)));
      expect(html).not.toMatch(/\b(?:active|error)\b/);
    }
  });

  // Time left reads in short units now ("in 3d"), as it does everywhere else.
  it('puts the next moment that matters beside the pill', () => {
    expect(text(render({ kind: 'limit', retryAtMs: now + 3 * 86_400_000 }))).toMatch(/^Limit reached Resets .+ · in 3d$/);
    expect(text(render({ kind: 'retrying', message: 'transient upstream error', reason: 'transient_error', retryAtMs: now + 120_000 })))
      .toMatch(/^Retrying Retries .+ · in 2m$/);
    expect(text(render({ kind: 'unavailable', message: 'request failed', retryAtMs: now + 600_000 }))).toMatch(/^Unavailable Retries .+ · in 10m$/);
  });

  it('summarizes resting models on a ready credential', () => {
    const cooldowns = [
      { model: 'claude-fable-5-1', reason: 'transient_error', httpStatus: 503, retryAtMs: now + 300_000 },
      { model: 'claude-opus-5', reason: 'quota', httpStatus: 429, retryAtMs: now + 10_800_000 },
    ];
    expect(text(render({ kind: 'ready', models: { count: 2, retryAtMs: now + 300_000, cooldowns } })))
      .toMatch(/^Ready 2 models limited until .+ · in 5m$/);
    expect(text(render({ kind: 'ready', models: { count: 1, retryAtMs: now + 300_000, cooldowns: cooldowns.slice(0, 1) } })))
      .toMatch(/^Ready 1 model limited until /);
  });

  it('drops times that have passed instead of asking for a manual refresh', () => {
    // The page reloads itself once a rest ends; until then no stale countdown shows.
    expect(text(render({ kind: 'retrying', message: '', retryAtMs: now - 1_000 }))).toBe('Retrying');
    expect(text(render({ kind: 'limit', retryAtMs: now }))).toBe('Limit reached');
    const cooldowns = [
      { model: 'claude-fable-5-1', reason: 'transient_error', retryAtMs: now - 1_000 },
      { model: 'claude-opus-5', reason: 'quota', retryAtMs: now + 10_800_000 },
    ];
    expect(text(render({ kind: 'ready', models: { count: 2, retryAtMs: now - 1_000, cooldowns } })))
      .toMatch(/^Ready 1 model limited until .+ · in 3h$/);
    expect(text(render({ kind: 'ready', models: { count: 1, retryAtMs: now - 1_000, cooldowns: cooldowns.slice(0, 1) } }))).toBe('Ready');
  });

  it('marks a file that left the disk instead of its last known state', () => {
    expect(text(render({ kind: 'signin', message: 'invalid_grant', reason: 'invalid_grant' }, true))).toBe('Removed');
  });

  it('lets keyboard users reach the explanation behind a pill', () => {
    expect(render({ kind: 'signin', message: 'invalid_grant', reason: 'invalid_grant' })).toContain('tabindex="0"');
    expect(render({ kind: 'ready' })).not.toContain('tabindex');
  });
});

describe('when the Auth Files page reloads by itself', () => {
  const base = { lingering: false, lingeringChecks: 0, failures: 0, receivedAtMs: now, nowMs: now };

  it('waits for the first rest to end, plus a second for the core’s rounding', () => {
    expect(listingReloadDelay(base)).toBeUndefined();
    expect(listingReloadDelay({ ...base, changesAtMs: now + 60_000 })).toBe(61_000);
    expect(listingReloadDelay({ ...base, changesAtMs: now - 5_000 })).toBe(1_000);
    expect(listingReloadDelay({ ...base, changesAtMs: now + 30 * 86_400_000 })).toBe(6 * 3_600_000);
  });

  it('checks again soon while a removed file lingers', () => {
    expect(listingReloadDelay({ ...base, lingering: true })).toBe(3_000);
    expect(listingReloadDelay({ ...base, lingering: true, changesAtMs: now + 500 })).toBe(1_500);
  });

  it('checks for a removed file less often each time it is still listed, without delaying a rest’s end', () => {
    const lingering = { ...base, lingering: true };
    expect(listingReloadDelay({ ...lingering, lingeringChecks: 1 })).toBe(3_000);
    expect(listingReloadDelay({ ...lingering, lingeringChecks: 2 })).toBe(5_000);
    expect(listingReloadDelay({ ...lingering, lingeringChecks: 3 })).toBe(9_000);
    expect(listingReloadDelay({ ...lingering, lingeringChecks: 20 })).toBe(301_000);
    expect(listingReloadDelay({ ...lingering, lingeringChecks: 20, changesAtMs: now + 60_000 })).toBe(61_000);
    // Counted from when the listing that still showed the file arrived.
    expect(listingReloadDelay({ ...lingering, lingeringChecks: 3, nowMs: now + 6_000 })).toBe(3_000);
  });

  it('pauses longer after each background reload that failed', () => {
    // A failed reload keeps the old listing, whose rest has already ended.
    const stale = { ...base, changesAtMs: now - 5_000 };
    expect(listingReloadDelay({ ...stale, failures: 1 })).toBe(3_000);
    expect(listingReloadDelay({ ...stale, failures: 3 })).toBe(9_000);
    expect(listingReloadDelay({ ...stale, failures: 20 })).toBe(301_000);
    expect(listingReloadDelay({ ...base, lingering: true, failures: 2 })).toBe(5_000);
    expect(listingReloadDelay({ ...base, changesAtMs: now + 60_000, failures: 2 })).toBe(61_000);
  });
});
