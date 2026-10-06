import { describe, expect, test } from 'bun:test';
import { appUpdateSteps } from '../src/services/appUpdateSteps';
import type { AppUpdateTask } from '../src/native/types';

const task = (overrides: Partial<AppUpdateTask>) => ({
  phase: 'checking' as const,
  fromThisMac: false,
  percent: null,
  downloadedBytes: 0,
  totalBytes: null,
  ...overrides,
});

describe('appUpdateSteps', () => {
  test('a download shows its percent on the download step only', () => {
    const steps = appUpdateSteps(task({ phase: 'downloading', percent: 40 }));
    expect(steps.map((step) => [step.id, step.state, step.percent])).toEqual([
      ['check', 'done', null],
      ['download', 'current', 40],
      ['verify', 'upcoming', null],
      ['unpack', 'upcoming', null],
      ['restart', 'upcoming', null],
    ]);
  });

  test('a dev build is copied, with no percent to show', () => {
    const steps = appUpdateSteps(task({ phase: 'downloading', fromThisMac: true, totalBytes: 100 }));
    expect(steps.map((step) => step.id)).toEqual(['check', 'copy', 'verify', 'unpack', 'restart']);
    expect(steps.every((step) => step.percent === null)).toBe(true);
  });

  test('the steps after the download move on without a stale percent', () => {
    const steps = appUpdateSteps(task({ phase: 'staging', percent: 100 }));
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
    expect(steps.every((step) => step.percent === null)).toBe(true);
  });

  test('a task that isn\'t running a step marks none of them', () => {
    expect(appUpdateSteps(task({ phase: 'failed' })).every((step) => step.state === 'upcoming')).toBe(true);
  });
});
