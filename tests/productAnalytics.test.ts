import { describe, expect, test } from 'bun:test';
import { admitException, appId, isBenignWindowError, EXCEPTIONS_MAX, newExceptionGate, pageViewEvent, paletteKind, REPEAT_WINDOW_MS, usageDataNoticeDue } from '../src/services/productAnalytics';

describe('page views', () => {
  test('carry page and view ids only, never the params that name things', () => {
    expect(pageViewEvent({ kind: 'main', page: 'usage', params: { tab: 'digest', machine: 'cedar' } })).toEqual({ event: 'page.viewed', page: 'usage', tab: 'digest' });
    expect(pageViewEvent({ kind: 'main', page: 'machines', params: { machine: 'cedar' } })).toEqual({ event: 'page.viewed', page: 'machines', tab: null });
    expect(pageViewEvent({ kind: 'main', page: 'home' })).toEqual({ event: 'page.viewed', page: 'home', tab: null });
    expect(pageViewEvent({ kind: 'settings', page: 'software' })).toEqual({ event: 'page.viewed', page: 'settings:software', tab: null });
  });
});

describe('exceptions', () => {
  test('leave out the browser\'s ResizeObserver loop notes, which aren\'t the app failing', () => {
    expect(isBenignWindowError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignWindowError('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isBenignWindowError('TypeError: x is undefined')).toBe(false);
    expect(isBenignWindowError(undefined)).toBe(false);
  });

  test('the same one is sent once a minute', () => {
    const gate = newExceptionGate();
    expect(admitException(gate, 'a', 0)).toBe(true);
    expect(admitException(gate, 'a', REPEAT_WINDOW_MS - 1)).toBe(false);
    expect(admitException(gate, 'b', 1)).toBe(true);
    expect(admitException(gate, 'a', REPEAT_WINDOW_MS)).toBe(true);
  });

  test('a window that keeps failing stops sending', () => {
    const gate = newExceptionGate();
    for (let index = 0; index < EXCEPTIONS_MAX; index += 1) expect(admitException(gate, `e${index}`, 0)).toBe(true);
    expect(admitException(gate, 'one more', 0)).toBe(false);
  });
});


describe('feature details', () => {
  test('become app ids, and anything else is dropped', () => {
    expect(appId('limitWarning')).toBe('limit-warning');
    expect(appId('gemini-cli')).toBe('gemini-cli');
    expect(appId('claude')).toBe('claude');
    expect(appId('my laptop')).toBeNull();
    expect(appId('/Users/x')).toBeNull();
    expect(appId('')).toBeNull();
    expect(appId(null)).toBeNull();
  });

  test('a palette pick is its kind, never what was picked', () => {
    expect(paletteKind('machine:cedar-02')).toBe('machine');
    expect(paletteKind('session:abc123')).toBe('session');
    expect(paletteKind('action:start-core')).toBe('action');
  });
});

describe('the first-launch note', () => {
  const settings = { usage: true, crashReports: true, noticeShown: false, blockedByEnv: false, available: true };
  test('shows once, from a build that sends, while something is sent', () => {
    expect(usageDataNoticeDue(settings)).toBe(true);
    expect(usageDataNoticeDue({ ...settings, usage: false })).toBe(true);
    expect(usageDataNoticeDue({ ...settings, noticeShown: true })).toBe(false);
    expect(usageDataNoticeDue({ ...settings, usage: false, crashReports: false })).toBe(false);
    expect(usageDataNoticeDue({ ...settings, blockedByEnv: true })).toBe(false);
    expect(usageDataNoticeDue({ ...settings, available: false })).toBe(false);
  });
});
