import { describe, expect, it } from 'bun:test';
import { devBuildLine, shortCommit } from '../src/services/devBuild';
import type { DevBuildStatus } from '../src/native/types';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const COMMIT = '7c41e2a9d03b5f68a1e4c2b7d9f0e3a6b5c8d1f2';
const NEXT = 'e93b07d4a1c6f2e85b0d7a3c9e1f4b6a8d2c5e70';

const status = (overrides: Partial<DevBuildStatus> = {}): DevBuildStatus => ({
  installed: true, repository: '/Users/casey/src/arbor', state: 'idle', commit: COMMIT, step: null, startedAt: null, finishedAt: null, error: null,
  hasLog: false, requested: false, settlesAt: null, builtVersion: '1.0.27-dev.4123', builtCommit: COMMIT, builtAt: '2026-10-02T11:48:00Z',
  ...overrides,
});

describe('devBuildLine', () => {
  it('says when this Mac has no builder, and nothing is under way', () => {
    expect(devBuildLine(status({ installed: false, state: 'building' }), NOW)).toMatchObject({ key: 'appUpdate.devBuild.notSetUp', active: false });
  });

  it('names the build of main ready to take', () => {
    expect(devBuildLine(status(), NOW)).toMatchObject({ key: 'appUpdate.devBuild.built', variables: { commit: '7c41e2a' }, tone: 'success', active: false });
    expect(devBuildLine(status({ builtCommit: null }), NOW)).toMatchObject({ key: 'appUpdate.devBuild.none', active: false });
  });

  it('follows a build of the newer commit through its steps', () => {
    const line = devBuildLine(status({ state: 'building', step: 'signing', commit: NEXT, startedAt: '2026-10-02T11:57:00Z' }), NOW);
    expect(line).toMatchObject({ key: 'appUpdate.devBuild.building', step: 'appUpdate.devBuild.step.signing', variables: { commit: 'e93b07d' }, active: true });
    expect(devBuildLine(status({ state: 'building', step: null }), NOW).step).toBe('appUpdate.devBuild.step.building');
  });

  it('keeps checking while main settles or a build is asked for', () => {
    expect(devBuildLine(status({ state: 'waiting', commit: NEXT }), NOW)).toMatchObject({ key: 'appUpdate.devBuild.waiting', active: true, busy: false });
    expect(devBuildLine(status({ requested: true }), NOW)).toMatchObject({ key: 'appUpdate.devBuild.requested', active: true, busy: true });
    // A failure isn't hidden by a request still waiting to be taken.
    expect(devBuildLine(status({ state: 'building', requested: true }), NOW).key).toBe('appUpdate.devBuild.building');
  });

  it('says when a wait for main to settle ends, and still lets a build be asked for', () => {
    const line = devBuildLine(status({ state: 'waiting', commit: NEXT, settlesAt: '2026-10-02T12:03:00Z' }), NOW);
    expect(line).toMatchObject({ key: 'appUpdate.devBuild.waitingUntil', variables: { commit: 'e93b07d' }, busy: false });
    expect(line.variables.time).toBeTruthy();
    // Past its time, the builder is about to start, so there's no time to show.
    expect(devBuildLine(status({ state: 'waiting', settlesAt: '2026-10-02T11:59:00Z' }), NOW).key).toBe('appUpdate.devBuild.waiting');
    expect(devBuildLine(status({ state: 'building' }), NOW).busy).toBe(true);
  });

  it('shows a failed build as an error, not the older build still on offer', () => {
    const line = devBuildLine(status({ state: 'failed', commit: NEXT, finishedAt: '2026-10-02T11:58:00Z', error: 'checks failed' }), NOW);
    expect(line).toMatchObject({ key: 'appUpdate.devBuild.failed', tone: 'error', active: false, variables: { commit: 'e93b07d' } });
  });

  it('shortens commits to seven characters', () => {
    expect(shortCommit(COMMIT)).toBe('7c41e2a');
    expect(shortCommit(null)).toBe('');
  });
});
