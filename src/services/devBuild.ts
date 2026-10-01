import type { MessageKey } from '../i18n/resources';
import type { DevBuildStatus } from '../native/types';
import { formatAgo } from '../lib/format';

/** How Settings › Updates words the dev builder's state: a key and its values, and how it looks. */
export type DevBuildLine = {
  key: MessageKey;
  variables: Record<string, string>;
  tone: 'info' | 'success' | 'error' | 'muted';
  /** The step a running build is on, worded by the caller into `{step}`. */
  step?: MessageKey;
  /** A build is under way or asked for, so the page keeps checking on it. */
  active: boolean;
};

export const shortCommit = (commit: string | null) => (commit ?? '').slice(0, 7);

export function devBuildLine(status: DevBuildStatus, nowMs = Date.now()): DevBuildLine {
  const commit = shortCommit(status.commit);
  if (!status.installed) return { key: 'appUpdate.devBuild.notSetUp', variables: {}, tone: 'muted', active: false };
  if (status.state === 'building') {
    return {
      key: 'appUpdate.devBuild.building',
      variables: { commit, since: status.startedAt ? formatAgo(status.startedAt, nowMs) : '' },
      step: `appUpdate.devBuild.step.${status.step ?? 'building'}`,
      tone: 'info',
      active: true,
    };
  }
  if (status.requested) return { key: 'appUpdate.devBuild.requested', variables: {}, tone: 'info', active: true };
  if (status.state === 'waiting') return { key: 'appUpdate.devBuild.waiting', variables: { commit }, tone: 'info', active: true };
  if (status.state === 'failed') {
    return {
      key: 'appUpdate.devBuild.failed',
      variables: { commit, when: status.finishedAt ? formatAgo(status.finishedAt, nowMs) : '' },
      tone: 'error',
      active: false,
    };
  }
  if (status.builtCommit) {
    return {
      key: 'appUpdate.devBuild.built',
      variables: { commit: shortCommit(status.builtCommit), when: status.builtAt ? formatAgo(status.builtAt, nowMs) : '' },
      tone: 'success',
      active: false,
    };
  }
  return { key: 'appUpdate.devBuild.none', variables: {}, tone: 'muted', active: false };
}
