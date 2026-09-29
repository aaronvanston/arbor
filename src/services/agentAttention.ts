import { invokeCommand } from '../native/commands';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { liveSessionName } from './liveSessions';
import type { SystemNotification } from './notify';
import { shortSessionId } from './usageSessions';
import type { AgentKind, AttentionItem } from '../native/types';

/**
 * Why a session is waiting on its user, as the live board's sources read it from the reporter's events: asking to use a
 * tool, asking something only the user can answer, or done with its turn.
 */
export type AttentionKind = 'permission' | 'question' | 'waiting';

/** Sets Arbor's reporter up on a machine, or takes it away. A plan only says what would change. */
export const setAgentReporter = (machine: string, enabled: boolean, plan = false) =>
  invokeCommand('set_agent_reporter', { machine, enabled, plan });

/** How long a wait lasts before it's worth an alert: long enough that someone at the keyboard would have answered. */
export const ATTENTION_ALERT_AFTER_MS: Record<AttentionKind, number> = { permission: 30_000, question: 30_000, waiting: 60_000 };
/** A wait first seen this long past its alert time is old news, as after Arbor was closed. */
const ALERT_LATE_MS = 10 * 60_000;
/** Waits already alerted are remembered this long. */
const ALERTED_KEPT_MS = 12 * 60 * 60_000;
/** More alerts than this at once go out as one. */
const SEPARATE_ALERTS = 3;

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const AGENT_NAME: Record<AgentKind, MessageKey> = { claude: 'machines.agents.name.claude', codex: 'machines.agents.name.codex' };
const ALERT_TITLE: Record<AttentionKind, MessageKey> = {
  permission: 'attention.alert.permission',
  question: 'attention.alert.question',
  waiting: 'attention.alert.waiting',
};

/** A waiting session's name where there's only room for a few words. */
export function attentionName(item: AttentionItem, t: Translate) {
  return item.session ? liveSessionName(item.session) : `${t(AGENT_NAME[item.agent])} ${shortSessionId(item.sessionId)}`;
}

/** Waits already alerted, by what identifies them, with when each began. */
export type AttentionAlertState = Record<string, number>;

const waitKey = (item: AttentionItem) => [item.machine, item.agent, item.sessionId, item.kind, item.sinceMs].join('\n');

/**
 * The waits that are due an alert now, once each: past their alert time, still going, and not first seen so late
 * that they're old news. `enabled` says which kinds the preferences want.
 */
export function nextAttentionAlerts(
  state: AttentionAlertState,
  items: AttentionItem[],
  now: number,
  enabled: { permission: boolean; waiting: boolean },
) {
  const next: AttentionAlertState = {};
  for (const [key, since] of Object.entries(state)) {
    if (now - since < ALERTED_KEPT_MS) next[key] = since;
  }
  const due: AttentionItem[] = [];
  for (const item of items) {
    const key = waitKey(item);
    const after = ATTENTION_ALERT_AFTER_MS[item.kind];
    if (key in next || now - item.sinceMs < after) continue;
    next[key] = item.sinceMs;
    if (now - item.sinceMs > after + ALERT_LATE_MS) continue;
    if (item.kind === 'waiting' ? enabled.waiting : enabled.permission) due.push(item);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  return { state: next, due, changed };
}

/** The notifications for waits due an alert: one each, or one for them all when there are many. */
export function attentionNotifications(due: AttentionItem[], t: Translate): SystemNotification[] {
  if (!due.length) return [];
  const pressing = due.some((item) => item.kind !== 'waiting');
  if (due.length > SEPARATE_ALERTS) {
    return [{
      title: t('attention.alert.many', { count: due.length }),
      body: due.map((item) => t('attention.alert.body', { name: attentionName(item, t), machine: item.machine })).join('\n'),
      kind: pressing ? 'agentPermission' : 'agentWaiting',
      urgent: pressing,
    }];
  }
  return due.map((item) => ({
    title: t(ALERT_TITLE[item.kind], { agent: t(AGENT_NAME[item.agent]) }),
    body: t('attention.alert.body', { name: attentionName(item, t), machine: item.machine }),
    kind: item.kind === 'waiting' ? 'agentWaiting' : 'agentPermission',
    urgent: item.kind !== 'waiting',
    // Only sessions whose requests came through Arbor open on the Sessions page.
    subject: item.session ? { session: item.sessionId, machine: item.machine } : { machine: item.machine },
  }));
}

