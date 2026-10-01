import { getVersion } from '@tauri-apps/api/app';
import { useSyncExternalStore } from 'react';
import type { MessageKey } from '../i18n/resources';

/**
 * Which kind of build is running, read from its own version like the Dock badge (`build_channel.rs`): a nightly is
 * `X.Y.Z-nightly.YYYYMMDD.N`, a dev build a development build or a `-dev` prerelease, and the rest stable, which shows
 * no mark. The update channel setting isn't consulted: it says what Arbor updates to, not what's running.
 */
export type BuildChannel = 'stable' | 'nightly' | 'dev';

/**
 * Read as this module loads, before main.tsx installs the browser mock, so only a development build inside the real
 * shell counts; the mock picks its build with `?build=`.
 */
const DEV_SHELL = Boolean(import.meta.env?.DEV) && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function buildChannelOf(version: string, devBuild: boolean): BuildChannel {
  const pre = /^v?\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/.exec(version.trim())?.[1] ?? '';
  if (devBuild || pre === 'dev' || pre.startsWith('dev.')) return 'dev';
  if (pre === 'nightly' || pre.startsWith('nightly.')) return 'nightly';
  return 'stable';
}

/** The tag's words, or null for stable, which isn't marked. */
export function buildChannelLabel(channel: BuildChannel): MessageKey | null {
  if (channel === 'nightly') return 'app.build.nightly';
  if (channel === 'dev') return 'app.build.dev';
  return null;
}

let channel: BuildChannel = DEV_SHELL ? 'dev' : 'stable';
let asked = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!asked) {
    asked = true;
    // The version can't change while the app runs, so it's asked once; a failure leaves the build unmarked.
    void getVersion().then((version) => {
      const next = buildChannelOf(version, DEV_SHELL);
      if (next === channel) return;
      channel = next;
      listeners.forEach((notify) => notify());
    }).catch(() => undefined);
  }
  return () => { listeners.delete(listener); };
}

export function useBuildChannel(): BuildChannel {
  return useSyncExternalStore(subscribe, () => channel, () => channel);
}
