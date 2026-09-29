import { useSyncExternalStore } from 'react';

/**
 * Incidents from the providers' public status pages: each status maps to a
 * ranked severity, and the last good status is kept when a check fails. Only
 * the parts of each page Arbor's traffic goes through count, and the incidents
 * behind them are named.
 */
export type StatusProvider = 'claude' | 'codex';
export type StatusIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown';
export type StatusComponent = { id: string; name: string; indicator: StatusIndicator };
export type StatusIncident = { id: string; name: string; status: string; indicator: StatusIndicator; updatedAt?: string; url: string };
export type ProviderStatus = {
  indicator: StatusIndicator;
  /** The components Arbor's traffic depends on, in page order. */
  components: StatusComponent[];
  /** Open incidents and maintenance touching those components. */
  incidents: StatusIncident[];
  /** When the status was last read successfully. */
  checkedAt: number;
  /** Why the latest check failed; everything else is from the last one that worked. */
  error?: string;
};

export const STATUS_POLL_INTERVAL_MS = 5 * 60_000;
/** Older than this, a status is dropped rather than shown, so an outage can't linger once the checks stop working. */
export const STATUS_STALE_AFTER_MS = 30 * 60_000;
const STATUS_TIMEOUT_MS = 10_000;

export const statusPageUrl: Record<StatusProvider, string> = {
  claude: 'https://status.claude.com/',
  codex: 'https://status.openai.com/',
};
const feedUrl: Record<StatusProvider, string> = {
  claude: 'https://status.claude.com/api/v2/summary.json',
  // incident.io's own feed. It is the only one that groups OpenAI's components (APIs, ChatGPT, Codex).
  codex: 'https://status.openai.com/proxy/status.openai.com',
};

export const isStatusProvider = (value: unknown): value is StatusProvider => value === 'claude' || value === 'codex';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
const httpsUrl = (value: unknown) => (text(value).startsWith('https://') ? text(value) : undefined);

const rank: Record<StatusIndicator, number> = { none: 0, maintenance: 1, unknown: 1, minor: 2, major: 3, critical: 4 };
export const worstIndicator = (indicators: StatusIndicator[]): StatusIndicator =>
  indicators.reduce<StatusIndicator>((worst, indicator) => (rank[indicator] > rank[worst] ? indicator : worst), 'none');
export const isOutage = (indicator: StatusIndicator) => rank[indicator] >= rank.major;

/** A Statuspage or incident.io component status, as a severity. */
export function componentIndicator(status: string): StatusIndicator {
  switch (status) {
    case '':
    case 'operational': return 'none';
    case 'degraded_performance': return 'minor';
    case 'partial_outage': return 'major';
    case 'major_outage':
    case 'full_outage': return 'critical';
    case 'under_maintenance': return 'maintenance';
    default: return 'unknown';
  }
}

/** Statuspage rates an incident none/minor/major/critical; incident.io uses the component statuses. */
const impactIndicator = (impact: string): StatusIndicator => {
  switch (impact) {
    case 'minor':
    case 'degraded_performance': return 'minor';
    case 'major':
    case 'partial_outage': return 'major';
    case 'critical':
    case 'major_outage':
    case 'full_outage': return 'critical';
    case 'maintenance':
    case 'under_maintenance': return 'maintenance';
    default: return 'none';
  }
};

const CLOSED = new Set(['resolved', 'postmortem', 'completed', 'maintenance_complete']);
/** Still being worked on. An incident being monitored is listed, but its impact no longer counts. */
const ACTIVE = new Set(['investigating', 'identified', 'in_progress', 'maintenance_in_progress']);

const indicatorFor = (components: StatusComponent[], incidents: StatusIncident[]) => worstIndicator([
  ...components.map((component) => component.indicator),
  ...incidents.filter((incident) => ACTIVE.has(incident.status)).map((incident) => incident.indicator),
]);

/** The Claude components Arbor's traffic goes through. The page also covers claude.ai, the Console and other products. */
const CLAUDE_COMPONENTS = [/^claude api\b/i, /^claude code\b/i];

export function claudeStatusFrom(payload: unknown, checkedAt: number): ProviderStatus {
  if (!isRecord(payload) || !Array.isArray(payload.components)) throw new Error('Unexpected status page reply');
  const components = records(payload.components)
    .filter((component) => component.group !== true && CLAUDE_COMPONENTS.some((pattern) => pattern.test(text(component.name))))
    .map((component) => ({ id: text(component.id), name: text(component.name), indicator: componentIndicator(text(component.status)) }));
  if (!components.length) throw new Error('The status page no longer lists the Claude API or Claude Code');
  const ids = new Set(components.map((component) => component.id));
  // An incident that names no components counts only if it has an impact.
  const affects = (item: Record<string, unknown>) => {
    const listed = records(item.components).map((component) => text(component.id));
    return listed.length ? listed.some((id) => ids.has(id)) : impactIndicator(text(item.impact)) !== 'none';
  };
  const incident = (item: Record<string, unknown>, indicator: StatusIndicator): StatusIncident => ({
    id: text(item.id),
    name: text(item.name),
    status: text(item.status),
    indicator,
    updatedAt: text(item.updated_at) || undefined,
    url: httpsUrl(item.shortlink) ?? `${statusPageUrl.claude}incidents/${encodeURIComponent(text(item.id))}`,
  });
  const incidents = [
    ...records(payload.incidents).filter(affects).map((item) => incident(item, impactIndicator(text(item.impact)))),
    ...records(payload.scheduled_maintenances)
      .filter((item) => text(item.status) === 'in_progress' && affects(item))
      .map((item) => incident(item, 'maintenance')),
  ].filter((item) => item.name && !CLOSED.has(item.status));
  return { indicator: indicatorFor(components, incidents), components, incidents, checkedAt };
}

/**
 * OpenAI's page, limited to its Codex group. incident.io doesn't document this
 * feed's incidents, so they are read defensively; the component statuses alone
 * decide the indicator when an incident can't be read.
 */
export function codexStatusFrom(payload: unknown, checkedAt: number): ProviderStatus {
  const summary = isRecord(payload) && isRecord(payload.summary) ? payload.summary : null;
  const structure = summary && isRecord(summary.structure) ? summary.structure : null;
  if (!summary || !structure || !Array.isArray(structure.items)) throw new Error('Unexpected status page reply');
  const group = records(structure.items).map((item) => item.group).find(
    (candidate): candidate is Record<string, unknown> => isRecord(candidate) && text(candidate.name).toLowerCase() === 'codex',
  );
  if (!group) throw new Error('The status page no longer has a Codex group');
  const statuses = new Map(records(summary.affected_components).map((item) => [text(item.component_id), text(item.status)]));
  const components = records(group.components)
    .filter((component) => component.hidden !== true && text(component.component_id))
    .map((component) => {
      const id = text(component.component_id);
      return { id, name: text(component.name) || id, indicator: componentIndicator(statuses.get(id) ?? '') };
    });
  const ids = new Set(components.map((component) => component.id));
  const incident = (item: Record<string, unknown>, maintenance: boolean): StatusIncident | null => {
    const id = text(item.id);
    const name = text(item.name);
    const status = text(item.status).toLowerCase();
    if (!name || CLOSED.has(status)) return null;
    const affected = [item.affected_components, item.component_impacts, item.components].flatMap(records);
    const affectedIds = affected.map((component) => text(component.component_id) || text(component.id)).filter(Boolean);
    if (affectedIds.length ? !affectedIds.some((componentId) => ids.has(componentId)) : !/\bcodex\b/i.test(name)) return null;
    const impact = text(item.current_worst_impact) || text(item.worst_impact) || text(item.impact);
    return {
      id,
      name,
      status,
      indicator: maintenance ? 'maintenance' : impact ? impactIndicator(impact)
        : worstIndicator(affected.map((component) => impactIndicator(text(component.status) || text(component.impact)))),
      updatedAt: text(item.last_update_at) || text(item.updated_at) || text(item.published_at) || undefined,
      url: httpsUrl(item.url) ?? httpsUrl(item.permalink) ?? `${statusPageUrl.codex}incidents/${encodeURIComponent(id)}`,
    };
  };
  const incidents = [
    ...records(summary.ongoing_incidents).map((item) => incident(item, false)),
    ...records(summary.scheduled_maintenances)
      .filter((item) => ACTIVE.has(text(item.status).toLowerCase()))
      .map((item) => incident(item, true)),
  ].filter((item): item is StatusIncident => item !== null);
  return { indicator: indicatorFor(components, incidents), components, incidents, checkedAt };
}

const parsers: Record<StatusProvider, (payload: unknown, checkedAt: number) => ProviderStatus> = {
  claude: claudeStatusFrom,
  codex: codexStatusFrom,
};

type StatusMap = Partial<Record<StatusProvider, ProviderStatus>>;
type DismissedMap = Partial<Record<StatusProvider, string>>;
let statuses: StatusMap = {};
/** Banners the user closed, by what they showed. Kept in memory only, and forgotten once the provider recovers. */
let dismissed: DismissedMap = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const commit = (next: StatusMap) => {
  statuses = next;
  const kept = Object.fromEntries(Object.entries(dismissed).filter(([provider]) => {
    const status = next[provider as StatusProvider];
    return status && status.indicator !== 'none';
  })) as DismissedMap;
  if (Object.keys(kept).length !== Object.keys(dismissed).length) dismissed = kept;
  notify();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => statuses;
const getDismissed = () => dismissed;

export const useProviderStatuses = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
export const getProviderStatuses = getSnapshot;
export const useDismissedStatuses = () => useSyncExternalStore(subscribe, getDismissed, getDismissed);
export const getDismissedStatuses = getDismissed;

/** What a banner shows, so closing it lasts until the problem changes or gets worse. */
export const statusSignature = (status: ProviderStatus) => [
  status.indicator,
  ...affectedComponents(status).map((component) => `${component.id}:${component.indicator}`),
  ...status.incidents.map((incident) => incident.id).sort(),
].join('|');

export function dismissProviderStatus(provider: StatusProvider, status: ProviderStatus) {
  dismissed = { ...dismissed, [provider]: statusSignature(status) };
  notify();
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Re-reads each provider's status page. A failed read keeps the provider's last status, marked with the error. */
export async function refreshProviderStatuses(
  providers: StatusProvider[],
  fetcher: Fetcher = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): Promise<void> {
  await Promise.all(providers.map(async (provider) => {
    try {
      const response = await fetcher(feedUrl[provider], { cache: 'no-store', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = parsers[provider](await response.json(), now());
      commit({ ...statuses, [provider]: status });
    } catch (error) {
      const previous = statuses[provider];
      const message = error instanceof Error ? error.message : String(error);
      if (previous) commit({ ...statuses, [provider]: { ...previous, error: message } });
      else console.warn(`Failed to check the ${provider} status page`, error);
    }
  }));
}

/** Forgets providers that no longer need checking, such as when checks are turned off or the last account goes. */
export function retainProviderStatuses(providers: StatusProvider[]) {
  const next = Object.fromEntries(Object.entries(statuses).filter(([provider]) => providers.includes(provider as StatusProvider))) as StatusMap;
  if (Object.keys(next).length !== Object.keys(statuses).length) commit(next);
}

/** A status worth showing: something is wrong, and the last good check is recent enough to trust. */
export function activeStatus(status: ProviderStatus | undefined, nowMs: number): ProviderStatus | null {
  if (!status || status.indicator === 'none' || nowMs - status.checkedAt > STATUS_STALE_AFTER_MS) return null;
  return status;
}

/** The components that aren't operational, worst first. */
export const affectedComponents = (status: ProviderStatus) => status.components
  .filter((component) => component.indicator !== 'none')
  .sort((left, right) => rank[right.indicator] - rank[left.indicator]);

/** The incidents behind a status, the ones still being worked on first. */
export const statusIncidents = (status: ProviderStatus) => [...status.incidents]
  .sort((left, right) => Number(ACTIVE.has(right.status)) - Number(ACTIVE.has(left.status)) || rank[right.indicator] - rank[left.indicator]);
