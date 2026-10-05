import { afterEach, describe, expect, it, jest } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AfterLaunch } from '../src/components/AfterLaunch';
import { afterLaunch, LAUNCH_SETTLE_MS, resetLaunchSettle } from '../src/services/launchSettle';

afterEach(() => {
  jest.useRealTimers();
  resetLaunchSettle(true);
});

describe('waiting for launch to settle', () => {
  it('lets what Home doesn’t need start a moment after the first render, and at once after that', async () => {
    jest.useFakeTimers();
    resetLaunchSettle();
    let started = 0;
    void afterLaunch().then(() => { started += 1; });
    void afterLaunch().then(() => { started += 1; });
    jest.advanceTimersByTime(LAUNCH_SETTLE_MS - 1);
    await Promise.resolve();
    expect(started).toBe(0);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(started).toBe(2);
    await afterLaunch();
  });

  it('mounts the deferred monitors only once launch has settled', () => {
    resetLaunchSettle();
    expect(renderToStaticMarkup(<AfterLaunch><span>monitor</span></AfterLaunch>)).toBe('');
    resetLaunchSettle(true);
    expect(renderToStaticMarkup(<AfterLaunch><span>monitor</span></AfterLaunch>)).toBe('<span>monitor</span>');
  });
});
