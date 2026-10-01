import type { MessageKey, MessageVariables } from '../i18n/resources';
import { shortSessionId, type SessionPullRequestFilter } from './usageSessions';
import { machineName } from './machineNames';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** The pages that list usage: Usage, Sessions, Machines, Settings › Pricing and Accounts' Value. */
export type UsageFilterPage = 'usage' | 'sessions' | 'machines' | 'pricing' | 'value';

/** A request's outcome, as the Result filter picks it. */
export type UsageResultFilter = 'all' | 'success' | 'failed' | 'canceled';

/**
 * Every filter the usage pages have besides their time range and search. Machine, session and project live in the
 * Usage and Sessions views, so Back brings them back; the page keeps the rest itself.
 */
export type UsageFilters = {
  machine: string;
  /** A session and its subagents; Usage's Requests open on one from a session's page. */
  session: string;
  project: string;
  branch: string;
  client: string;
  pullRequests: SessionPullRequestFilter;
  model: string;
  provider: string;
  source: string;
  apiKeyHash: string;
  result: UsageResultFilter;
};

export type UsageFilterId = keyof UsageFilters;

export const noUsageFilters: UsageFilters = {
  machine: '',
  session: '',
  project: '',
  branch: '',
  client: '',
  pullRequests: '',
  model: '',
  provider: '',
  source: '',
  apiKeyHash: '',
  result: 'all',
};

/** A usage page's own tab, or Sessions' list and projects, or Pricing. */
type UsageFilterTab = string;

/** The request filters every page with requests has, in the order they're listed. */
const REQUEST_FILTERS: readonly UsageFilterId[] = ['model', 'provider', 'source', 'apiKeyHash'];

/**
 * The filters that apply to what a page shows on a tab, in the order the Filters popover lists them and their chips
 * line up. Accounts' Value follows only the time range, Weekly picks its own week and All time counts everything; the
 * Machines page is about machine health, where a request's model, provider, source, key or result has nothing to say.
 * A session narrows only Usage's requests, and a branch only means something within a project.
 */
export function offeredUsageFilters(page: UsageFilterPage, tab: UsageFilterTab, filters: Pick<UsageFilters, 'project'>): UsageFilterId[] {
  if (page === 'value' || tab === 'digest' || tab === 'lifetime') return [];
  // The breadcrumb picks the machine there: one opens its own page.
  if (page === 'machines') return [];
  if (page === 'sessions') {
    return ['project', ...(filters.project ? ['branch' as const] : []), 'machine', 'client', 'pullRequests', ...REQUEST_FILTERS, 'result'];
  }
  return [...REQUEST_FILTERS, 'machine', 'result', ...(page === 'usage' ? ['session' as const] : [])];
}

/**
 * Whether the page has the All / Failed toggle beside its filters: Usage's Requests. It's the Result filter's Failed
 * pick, so the two always agree.
 */
export const hasFailedToggle = (page: UsageFilterPage, tab: UsageFilterTab) => page === 'usage' && tab === 'events';

/**
 * The offered filters that get a chip: all that are set, except Result while the Failed toggle shows it's Failed, which
 * would say the same thing twice. Result's other picks still get one.
 */
export function chippedUsageFilters(page: UsageFilterPage, tab: UsageFilterTab, filters: Pick<UsageFilters, 'result'>, offered: readonly UsageFilterId[]): UsageFilterId[] {
  return hasFailedToggle(page, tab) && filters.result === 'failed' ? offered.filter((id) => id !== 'result') : [...offered];
}

/** Whether a filter picks something; `all` and empty are the same as no filter. */
export const isUsageFilterSet = (filters: UsageFilters, id: UsageFilterId) => filters[id] !== noUsageFilters[id];

/** The offered filters that are picking something, in the order they're offered. */
export const activeUsageFilters = (filters: UsageFilters, offered: readonly UsageFilterId[]): UsageFilterId[] =>
  offered.filter((id) => isUsageFilterSet(filters, id));

/**
 * Filters with a menu in the Filters popover. A session has none: it's picked by opening its requests, and its chip
 * is the only way to see or drop it.
 */
export const usageFilterHasMenu = (id: UsageFilterId) => id !== 'session';

/** What a filter is called, on its menu in the popover and on its chip. */
export const USAGE_FILTER_LABELS: Record<UsageFilterId, MessageKey> = {
  machine: 'usage.filter.machine',
  session: 'usage.filter.sessionLabel',
  project: 'usage.filter.project',
  branch: 'usage.filter.branch',
  client: 'usage.filter.client',
  pullRequests: 'usage.filter.pullRequests',
  model: 'usage.filter.model',
  provider: 'usage.column.provider',
  source: 'usage.filter.source',
  apiKeyHash: 'usage.filter.key',
  result: 'usage.filter.result',
};

/** The names a page has for what it filters by id: a model's label, or the key an API key hash stands for. */
export type UsageFilterNames = Partial<Record<'model' | 'provider' | 'source' | 'apiKeyHash', ReadonlyArray<{ key: string; label: string }>>>;

/** How a filter's pick reads on its chip. */
export function usageFilterValueText(filters: UsageFilters, id: UsageFilterId, t: Translate, names: UsageFilterNames = {}): string {
  switch (id) {
    case 'machine':
      return filters.machine === '__unassigned__' ? t('usage.filter.unassigned') : machineName(filters.machine);
    case 'session':
      return shortSessionId(filters.session);
    case 'pullRequests':
      return filters.pullRequests === 'with' ? t('usage.filter.withPullRequest') : t('usage.filter.withoutPullRequest');
    case 'result':
      return t(`usage.result.${filters.result}` as MessageKey);
    case 'model':
    case 'provider':
    case 'source':
    case 'apiKeyHash': {
      const value = filters[id];
      // A name the options don't have yet (they load with the page) still shows what's picked.
      return names[id]?.find((item) => item.key === value)?.label || value;
    }
    default:
      return filters[id];
  }
}

export type UsageFilterChip = { id: UsageFilterId; label: string; value: string };

/** A removable chip for each offered filter that's picking something. */
export const usageFilterChips = (
  filters: UsageFilters,
  offered: readonly UsageFilterId[],
  t: Translate,
  names: UsageFilterNames = {},
): UsageFilterChip[] =>
  activeUsageFilters(filters, offered).map((id) => ({
    id,
    label: t(USAGE_FILTER_LABELS[id]),
    value: usageFilterValueText(filters, id, t, names),
  }));

/** What picking `value` for a filter changes. Branches belong to a project, so a new project drops the branch. */
export function usageFilterChange(id: UsageFilterId, value: string): Partial<UsageFilters> {
  switch (id) {
    case 'project':
      return { project: value, branch: '' };
    case 'pullRequests':
      return { pullRequests: value === 'with' || value === 'without' ? value : '' };
    case 'result':
      return { result: value === 'success' || value === 'failed' || value === 'canceled' ? value : 'all' };
    default:
      return { [id]: value };
  }
}

/** What removing a filter's chip changes. */
export const clearUsageFilter = (id: UsageFilterId): Partial<UsageFilters> => usageFilterChange(id, '');

/**
 * What Clear all changes: every filter, including ones the current tab doesn't offer, so going back to a tab that
 * does never brings back a filter that was cleared out of sight. The Failed toggle isn't one of its chips, so with
 * `keepFailed` it stays on.
 */
export const clearAllUsageFilters = (keepFailed = false): UsageFilters => ({ ...noUsageFilters, result: keepFailed ? 'failed' : 'all' });
