import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { AppliedCounts, AutoLine, AutoLineEvent, AutoMachine } from '../native/types';
import type { SystemNotification } from './notify';

/**
 * Machines brought in line by themselves, which Rust does (`setup_autoline.rs`): only what the repo moved on and Arbor
 * backs up, never an edit made on a machine, a removal, or a plugin or MCP server. The window shows each machine's
 * standing, pauses one with its own value of `autoLineUp`, and says what each run did.
 */

export const AUTOLINE_EVENT = 'setup-autoline';

export const getAutoLine = () => invokeCommand('get_setup_autoline');
export const setAutoLinePaused = (machine: string, paused: boolean) => invokeCommand('set_setup_autoline_paused', { machine, paused });

/** Each machine as runs by themselves see it, read again after each one. */
export function useAutoLine(): AutoLine | null {
  const [found, setFound] = useState<AutoLine | null>(null);
  useEffect(() => {
    let disposed = false;
    const read = () => { getAutoLine().then((next) => { if (!disposed) setFound(next); }).catch(() => undefined); };
    read();
    const stop = listen(AUTOLINE_EVENT, read);
    return () => {
      disposed = true;
      void stop.then((off) => off()).catch(() => undefined);
    };
  }, []);
  return found;
}

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

const PARTS: { kind: keyof AppliedCounts; one: MessageKey; other: MessageKey }[] = [
  { kind: 'files', one: 'sync.standing.count.files.one', other: 'sync.standing.count.files.other' },
  { kind: 'skills', one: 'sync.standing.count.skills.one', other: 'sync.standing.count.skills.other' },
  { kind: 'hooks', one: 'sync.standing.count.hooks.one', other: 'sync.standing.count.hooks.other' },
  { kind: 'mcp', one: 'sync.standing.count.mcp.one', other: 'sync.standing.count.mcp.other' },
];

/** "3 files, 1 skill". */
export const appliedText = (counts: AppliedCounts, t: Translate) =>
  PARTS.filter(({ kind }) => counts[kind] > 0).map(({ kind, one, other }) => t(counts[kind] === 1 ? one : other, { count: counts[kind] })).join(', ');

/**
 * The alert after a run, or when what waits on a machine changed: one per machine (its subject), folded on repeat. A
 * run that did something is a quiet note; one that failed says Arbor stopped there; changes waiting say how many. Rust
 * also says on this event when a machine has been behind for a day, and when its setup scan failed three times in a
 * row while it answers.
 */
export function autoLineNotification(event: AutoLineEvent, t: Translate): SystemNotification | null {
  const subject = { machine: event.machine };
  switch (event.kind) {
    case 'applied': {
      const what = appliedText(event.applied, t);
      return what ? { title: t('autoLine.alert.applied', { machine: event.machine, what }), body: t('autoLine.alert.appliedBody'), kind: 'setupAuto', subject } : null;
    }
    case 'failed':
      return { title: t('autoLine.alert.failed', { machine: event.machine }), body: t('autoLine.alert.failedBody', { error: event.error ?? '' }), kind: 'setupAutoFailed', subject };
    case 'waiting':
      return event.waiting
        ? { title: t(event.waiting === 1 ? 'autoLine.alert.waiting.one' : 'autoLine.alert.waiting.other', { count: event.waiting, machine: event.machine }), body: t('autoLine.alert.waitingBody'), kind: 'setupWaiting', subject }
        : null;
    case 'behindLong':
      return { title: t('autoLine.alert.behind', { machine: event.machine }), body: t(event.waiting === 1 ? 'autoLine.alert.behindBody.one' : 'autoLine.alert.behindBody.other', { count: event.waiting }), kind: 'setupBehind', subject };
    case 'scanFailing':
      return { title: t('autoLine.alert.scanFailing', { machine: event.machine }), body: t('autoLine.alert.scanFailingBody', { error: event.error ?? '' }), kind: 'setupScanFailing', subject };
  }
}

/** A machine's line on Overview and the Repo strip, or null when there's nothing to say. */
export function autoLineWords(line: AutoLine | null, machine: string, ago: (ms: number) => string, t: Translate): string | null {
  if (!line?.enabled) return null;
  const found: AutoMachine | undefined = line.machines.find((entry) => entry.machine === machine);
  if (found?.paused) return t('autoLine.paused');
  if (found?.stopped) return t('autoLine.stopped', { error: found.stopped });
  if (found?.running) return t('autoLine.running');
  if (found?.lastRunMs) return t('autoLine.lastRun', { time: ago(found.lastRunMs) });
  return t('autoLine.on');
}

export const isPaused = (line: AutoLine | null, machine: string) => Boolean(line?.machines.find((entry) => entry.machine === machine)?.paused);
