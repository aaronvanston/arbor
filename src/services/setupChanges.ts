import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { SystemNotification } from './notify';
import type { SetupItem } from '../native/types';

/**
 * Change alerts (see `watched_changes` in setup.rs): a hook, MCP server, plugin marketplace or plugin that came, went or
 * changed on a machine between two of Setup's scans, when Arbor didn't do it. Each can run code there. Scans compare
 * within one run of Arbor, since their fingerprints are salted afresh each time it starts.
 */

export type WatchedKind = Extract<SetupItem['kind'], 'hook' | 'mcp' | 'marketplace' | 'plugin'>;
export type ChangeKind = 'added' | 'removed' | 'changed';

/** Mirrors `setup::SetupChange`. */
export type SetupChange = { home: string; kind: WatchedKind; name: string; change: ChangeKind };
/** Mirrors `setup::SetupChanged`, the `setup-changed` event's payload. */
export type SetupChanged = { machine: string; changes: SetupChange[] };

export const SETUP_CHANGED_EVENT = 'setup-changed';
/** How often Setup is read in the background to notice changes; a scan this recent is fresh enough to skip. */
export const SETUP_WATCH_INTERVAL_MS = 30 * 60_000;
/** Changes named in the Mac's notification before the rest are counted. */
const CHANGES_NAMED = 3;

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const CHANGE_TEXT: Record<WatchedKind, Record<ChangeKind, MessageKey>> = {
  hook: { added: 'setupChange.hook.added', removed: 'setupChange.hook.removed', changed: 'setupChange.hook.changed' },
  mcp: { added: 'setupChange.mcp.added', removed: 'setupChange.mcp.removed', changed: 'setupChange.mcp.changed' },
  marketplace: { added: 'setupChange.marketplace.added', removed: 'setupChange.marketplace.removed', changed: 'setupChange.marketplace.changed' },
  plugin: { added: 'setupChange.plugin.added', removed: 'setupChange.plugin.removed', changed: 'setupChange.plugin.changed' },
};
const KIND_NAME: Record<WatchedKind, MessageKey> = {
  hook: 'setupChange.kind.hook',
  mcp: 'setupChange.kind.mcp',
  marketplace: 'setupChange.kind.marketplace',
  plugin: 'setupChange.kind.plugin',
};
const KIND_ORDER: WatchedKind[] = ['hook', 'mcp', 'plugin', 'marketplace'];

export const changeText = (change: SetupChange, t: Translate) => t(CHANGE_TEXT[change.kind][change.change], { name: change.name, home: change.home });

/**
 * The alert for one scan's changes. The Mac's names what changed; the phone's, which goes through someone else's
 * service, only counts it by kind.
 */
export function setupChangeNotification({ machine, changes }: SetupChanged, t: Translate): SystemNotification | null {
  if (!changes.length) return null;
  const named = changes.slice(0, CHANGES_NAMED).map((change) => changeText(change, t));
  const more = changes.length - named.length;
  const kinds = KIND_ORDER.filter((kind) => changes.some((change) => change.kind === kind)).map((kind) => t(KIND_NAME[kind]));
  return {
    title: t('setupChange.title', { machine }),
    body: more ? t('setupChange.bodyMore', { changes: named.join('; '), count: more }) : t('setupChange.body', { changes: named.join('; ') }),
    phoneBody: t(changes.length === 1 ? 'setupChange.phone.one' : 'setupChange.phone.other', { count: changes.length, kinds: kinds.join(', '), machine }),
    kind: 'setupChanged',
    subject: { machine },
  };
}
