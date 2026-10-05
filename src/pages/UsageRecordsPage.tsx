import { HeavySessionBanner } from '../components/HeavySessionBanner';
import { ArchiveBanner } from '../components/ArchiveBanner';
import { ProviderStatusBanner } from '../components/ProviderStatusBanner';
import { UsageCollectorBanner } from '../components/UsageCollectorBanner';
import { ProxyChecksBanner } from '../components/ProxyChecksBanner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, CircleCheck, Clock3, Search, X } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { createRefreshScheduler } from '../services/refreshScheduler';
import { usageViewScopeKey } from '../services/usageViewScope';
import { formatCount } from '../lib/format';
import { type SessionPullRequestFilter, type UsageSessionSort } from '../services/usageSessions';
import { ArchiveMachineCrumb, FleetMachineCrumb, MachineCrumb } from '../components/layout/MachineCrumb';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { cn } from '../lib/utils';
import { UsageFleet } from './UsageFleet';
import { CapacityView } from './UsageCapacityView';
import { UsageDigestView } from './UsageDigestView';
import { useLongLimitWindowsKey } from '../services/capacityReport';
import { MachineHealthPanel } from './MachineHealthPanel';
import { MachinePage } from './MachinePage';
import { UsageLifetimeView } from './UsageLifetimeView';
import { MachinePill, ModelName, ProviderPill } from '../components/identity/Identity';
import { SessionDetailPage } from './SessionDetailPage';
import { SessionsCheckoutsPage } from './SessionsCheckouts';
import { FilterBar, FilterField } from '../components/FilterBar';
import {
  chippedUsageFilters,
  clearAllUsageFilters,
  clearUsageFilter,
  hasFailedToggle,
  isUsageFilterSet,
  offeredUsageFilters,
  USAGE_FILTER_LABELS,
  usageFilterChange,
  usageFilterChips,
  usageFilterHasMenu,
  usageFilterValueText,
  type UsageFilterId,
  type UsageFilters,
  type UsageResultFilter,
} from '../services/usageFilters';
import { SessionProjectsView, type OpenSessions } from './SessionProjectsView';
import { RequestsView } from './UsageRequestsGrid';
import { loadRequestOrder, saveRequestOrder } from '../services/usageRequestsGrid';
import { FleetBoard, LiveMachineCrumb } from '../components/FleetBoard';
import { loadFleetSources } from '../services/fleetBoard';
import {
  hasMachineScope,
  isSessionsTab,
  isUsageTab,
  machineRequestsView,
  machinesView,
  savedUsageView,
  sessionsView,
  usageView,
  type AppView,
  type MachinesParams,
  type SavedUsageView,
  type SessionsParams,
  type SessionsTabId,
  type UsageParams,
  type UsageTabId,
} from '../navigation';
import { leafLabel } from '../services/sidebarTree';
import { projectsLensAction } from '../components/ProjectsLens';
import type { ViewChange } from '../services/viewHistory';
import { useShortcut } from '../hooks/useShortcuts';
import { WithShortcut } from '../components/ShortcutKbd';
import type {
  CapacityReport,
  FacetCount,
  MachineAssignment,
  MachineSessions,
  SessionProjectsReport,
  UsageAnalysis,
  UsageCategory,
  UsageEventPage,
  UsageOverview,
  UsagePricing,
  UsageQuery,
  UsageRequestOrder,
  UsageSessionPage,
} from '../native/types';
import { useShownIdentity, type ShownIdentity } from '../services/emailPrivacy';
import { machineName } from '../services/machineNames';
import { addAccount } from '../services/addAccount';
import { UsageEmpty } from './UsageEmpty';
import { PricingView } from './UsagePricingView';
import { SessionsView } from './UsageSessionsView';
import { OverviewView, BreakdownSection, FailureGlance } from './UsageOverviewView';

/** A usage view: Usage's own, Sessions', Usage › Prices (`pricing`), or Accounts' Value (`capacity`). */
type UsageTab = UsageTabId | SessionsTabId | 'pricing' | 'capacity';
type UsageRange = '4h' | '24h' | 'today' | '7d' | '30d' | 'all' | 'custom';

const TAB_KEY = 'arbor.usage-records-tab.v1';
/** The Sessions page's own view: the live board, its list, or its projects. */
const SESSIONS_TAB_KEY = 'arbor.sessions-tab.v1';
/** Search waits for this long a pause in typing. */
const SEARCH_DELAY_MS = 250;
const RANGE_KEY = 'arbor.usage-records-range.v1';
const emptyAnalysis: UsageAnalysis = { models: [], providers: [], sources: [], accounts: [], apiKeys: [] };
const OPTIONS_KEPT_MS = 60_000;
/** How soon Projects reads again while GitHub is being asked about its pull requests. */
const GITHUB_RECHECK_MS = 3_000;

const loadTab = (): SavedUsageView => {
  try {
    return savedUsageView(localStorage.getItem(TAB_KEY));
  } catch {
    return { tab: 'overview' };
  }
};

const loadSessionsTab = (): SessionsTabId => {
  try {
    const saved = localStorage.getItem(SESSIONS_TAB_KEY) ?? undefined;
    return isSessionsTab(saved) ? saved : 'sessions';
  } catch {
    return 'sessions';
  }
};

const loadRange = (): UsageRange => {
  try {
    const saved = localStorage.getItem(RANGE_KEY) as UsageRange | null;
    // A custom range's dates aren't kept, so it isn't either: it would come back empty, reading as all time.
    return ['4h', '24h', 'today', '7d', '30d', 'all'].includes(saved ?? '')
      ? (saved as UsageRange)
      : '24h';
  } catch {
    return '24h';
  }
};

const rangeQuery = (range: UsageRange, customStart: string, customEnd: string): Pick<UsageQuery, 'start' | 'end'> => {
  const now = new Date();
  if (range === 'all') return {};
  if (range === 'custom') {
    const start = customStart ? new Date(customStart) : null;
    const end = customEnd ? new Date(customEnd) : null;
    return {
      start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : undefined,
      end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : undefined,
    };
  }
  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start: start.toISOString(), end: now.toISOString() };
  }
  const hours = range === '4h' ? 4 : range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  return {
    start: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString(),
    end: now.toISOString(),
  };
};

/** An ISO time as a datetime-local field takes it: this Mac's local date and time, to the minute. */
const localInputValue = (iso: string | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const filterOptions = (items: UsageCategory[]) => items.filter((item) => item.key && item.label);
/** Sources are the accounts' emails or file names, shown hidden while Hide email addresses is on. Keys stay as they are. */
const shownSources = (items: UsageCategory[], shownIdentity: ShownIdentity) =>
  items.map((item) => ({ ...item, label: shownIdentity(item.label, { fileName: item.label }) }));

/** The pages this is: Usage, Sessions, Machines, Usage › Prices, or Accounts' Value. */
export type UsageVariant = 'usage' | 'sessions' | 'machines' | 'pricing' | 'value';

/** What the page keeps in its view: the tab, the machine, session and project it's narrowed to, and Usage's result. */
type Shown = { tab: UsageTab; machine: string; session: string; project: string; openSession: string | null; result: UsageResultFilter };

export function UsageRecordsPage({ variant = 'usage', params, onNavigate, onViewChange }: {
  variant?: UsageVariant;
  /** What the Usage, Sessions or Machines view asks for. The rest of the filters are the page's own. */
  params?: UsageParams | SessionsParams | MachinesParams;
  onNavigate?: (view: AppView) => void;
  /** Keeps the view in step as the page changes what it shows. */
  onViewChange?: (view: AppView, how?: ViewChange) => void;
}) {
  const { t } = useI18n();
  const shownIdentity = useShownIdentity();
  // Usage and Sessions read these from their view, so Back and Forward bring them back. Machines and Pricing keep
  // their machine filter to themselves.
  const inView = variant === 'usage' || variant === 'sessions';
  // Prices keeps only the machine the breadcrumb picked in its view, so moving between Usage's views keeps it.
  const machineInView = inView || variant === 'pricing';
  const asked: { tab?: string; machine?: string; session?: string; project?: string; result?: UsageParams['result']; lens?: SessionsParams['lens'] } = params ?? {};
  // The machine whose own page Machines shows in place of the fleet: its leaf in the sidebar lights while it does.
  const selectedMachine = variant === 'machines' ? asked.machine || null : null;
  const [ownMachine, setOwnMachine] = useState('');
  // A machine's page reads the range's requests for that machine alone.
  const machine = machineInView ? asked.machine ?? '' : selectedMachine ?? ownMachine;
  // The session whose requests Usage lists, and the one Sessions has open in place of its list.
  const session = variant === 'usage' ? asked.session ?? '' : '';
  const openSessionId = variant === 'sessions' ? asked.session || null : null;
  const project = variant === 'sessions' ? asked.project ?? '' : '';
  // Where Usage was left, for a view that names neither a tab nor what it's narrowed to.
  const left = variant === 'usage' && !isUsageTab(asked.tab) && !machine && !session ? loadTab() : null;
  const activeTab: UsageTab =
    variant === 'pricing' ? 'pricing'
      : variant === 'value' ? 'capacity'
      : variant === 'machines' ? 'overview'
      // A view that doesn't name a tab gets the one last picked, or the list for a machine's or project's sessions
      // and the requests for a machine's or session's. The effect below writes it into the view.
      : variant === 'sessions' ? (isSessionsTab(asked.tab) ? asked.tab : machine || project ? 'sessions' : loadSessionsTab())
      : isUsageTab(asked.tab) ? asked.tab : left?.tab ?? 'events';
  // Projects' Checkouts, shown in place of the list as a session is, so the list keeps its search and filters for
  // Activity, the other way of looking at the projects, and Back.
  const checkouts = variant === 'sessions' && !openSessionId && activeTab === 'projects' && asked.lens === 'checkouts';
  // Usage's result is in its view, so Back returns to Requests with Failed on or off; the other pages keep their own.
  const [ownResult, setOwnResult] = useState<UsageResultFilter>('all');
  const result: UsageResultFilter = variant === 'usage' ? asked.result ?? left?.result ?? 'all' : ownResult;
  // Requests' All / Failed toggle, which shows Result's Failed pick in place of its chip. Failed on lists the failed
  // requests with what went wrong, where the request grid can't show that.
  const failedToggle = hasFailedToggle(variant, activeTab);
  const failedOnly = failedToggle && result === 'failed';
  const shown: Shown = { tab: activeTab, machine, session, project, openSession: openSessionId, result };
  /** Shows `change` by changing the view: in place unless `how` says otherwise. Other pages change their own state. */
  const show = (change: Partial<Shown>, how?: ViewChange) => {
    const next = { ...shown, ...change };
    if (variant === 'usage') {
      onViewChange?.(usageView({
        tab: isUsageTab(next.tab) ? next.tab : undefined,
        machine: next.machine,
        session: next.session,
        result: next.result === 'all' ? undefined : next.result,
      }), how);
    } else if (variant === 'sessions') {
      onViewChange?.(sessionsView({
        tab: isSessionsTab(next.tab) ? next.tab : undefined,
        session: next.openSession ?? undefined,
        machine: next.machine,
        project: next.project,
      }), how);
      if (change.result !== undefined) setOwnResult(change.result);
    } else if (variant === 'pricing') {
      if (change.machine !== undefined) onViewChange?.(usageView({ tab: 'prices', machine: next.machine || undefined }), how);
      if (change.result !== undefined) setOwnResult(change.result);
    } else {
      if (change.machine !== undefined) setOwnMachine(change.machine);
      if (change.result !== undefined) setOwnResult(change.result);
    }
  };
  // The view names the tab it opened on, so Back returns to that tab even after another is picked elsewhere.
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    if (inView && asked.tab !== activeTab) showRef.current({ tab: activeTab });
  }, [inView, asked.tab, activeTab]);
  // A session's requests, or a project's sessions, open over all time without changing the range kept for next time.
  const [range, setRange] = useState<UsageRange>(() => (session || project ? 'all' : loadRange()));
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [source, setSource] = useState('');
  const [apiKeyHash, setApiKeyHash] = useState('');
  // The Sessions page's own filters, on what each session is rather than on its requests.
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [branch, setBranch] = useState('');
  const [client, setClient] = useState('');
  const [pullRequests, setPullRequests] = useState<SessionPullRequestFilter>('');
  const [assignments, setAssignments] = useState<MachineAssignment[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  // The Machines page's sessions, machine by machine.
  const [sessionsByMachine, setSessionsByMachine] = useState<MachineSessions[] | null>(null);
  // The time range `overview` was loaded for; rolling ranges move on every refresh.
  const [overviewRange, setOverviewRange] = useState<Pick<UsageQuery, 'start' | 'end'>>({});
  const [analysis, setAnalysis] = useState<UsageAnalysis>(emptyAnalysis);
  const [optionsAnalysis, setOptionsAnalysis] = useState<UsageAnalysis>(emptyAnalysis);
  // The names in the filter menus, kept between quiet refreshes of the same range. A new model or key still turns up
  // within a minute, and a range that takes seconds to read isn't read a second time on every refresh.
  const optionsRef = useRef<{ key: string; loadedAt: number; value: UsageAnalysis } | null>(null);
  const [events, setEvents] = useState<UsageEventPage | null>(null);
  const [sessions, setSessions] = useState<UsageSessionPage | null>(null);
  const [sessionSort, setSessionSort] = useState<UsageSessionSort>('recent');
  // Requests' order, with Failed on or off; null is newest first.
  const [requestOrder, setRequestOrder] = useState<UsageRequestOrder | null>(() =>
    typeof localStorage === 'undefined' ? null : loadRequestOrder(localStorage),
  );
  const [projects, setProjects] = useState<SessionProjectsReport | null>(null);
  // Set to ask GitHub about pull requests with the next load of the Projects view, whenever it last did.
  const checkGithubRef = useRef(false);
  // The Weekly tab loads its own data; this tells it the refresh button was pressed.
  const [digestRefresh, setDigestRefresh] = useState(0);
  // The same for the All time tab.
  const [lifetimeRefresh, setLifetimeRefresh] = useState(0);
  const [pricing, setPricing] = useState<UsagePricing | null>(null);
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  // The long limit windows accounts report, for Value's limit history.
  const capacityWindows = useLongLimitWindowsKey();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The scope of the last successful load. Views only render data loaded for the current scope.
  const [loadedScopeKey, setLoadedScopeKey] = useState('');
  const requestIdRef = useRef(0);
  const schedulerRef = useRef<ReturnType<typeof createRefreshScheduler> | null>(null);
  if (!schedulerRef.current) schedulerRef.current = createRefreshScheduler(5_000);

  useEffect(() => {
    if (variant !== 'usage' && variant !== 'sessions') return;
    try {
      localStorage.setItem(variant === 'usage' ? TAB_KEY : SESSIONS_TAB_KEY, activeTab);
    } catch {
      /* Keep in-memory */
    }
  }, [activeTab, variant]);

  useEffect(() => {
    const next = searchDraft.trim();
    if (next === search) return;
    const timer = window.setTimeout(() => {
      setSearch(next);
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [searchDraft, search]);

  const changeRange = (next: UsageRange) => {
    // Custom starts on the span shown so far rather than on empty dates, which would read as all time.
    if (next === 'custom' && range !== 'custom' && !customStart && !customEnd) {
      const shown = rangeQuery(range, '', '');
      setCustomStart(localInputValue(shown.start));
      setCustomEnd(localInputValue(shown.end));
    }
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      /* Keep in-memory */
    }
  };

  const buildQueries = useCallback(() => {
    const nextTimeQuery = rangeQuery(range, customStart, customEnd);
    return {
      timeQuery: nextTimeQuery,
      query: {
        ...nextTimeQuery,
        machine: machine || undefined,
        model: model || undefined,
        provider: provider || undefined,
        source: source || undefined,
        api_key_hash: apiKeyHash || undefined,
        failed: result === 'failed' ? true : result === 'success' ? false : undefined,
        canceled: result === 'canceled' ? true : result === 'failed' ? false : undefined,
        session: session || undefined,
        search: search || undefined,
        project: project || undefined,
        branch: branch || undefined,
        client: client || undefined,
        pull_requests: pullRequests || undefined,
      } satisfies UsageQuery,
    };
  }, [apiKeyHash, branch, client, customEnd, customStart, model, project, provider, pullRequests, range, result, search, source, machine, session]);

  const scopeKey = useMemo(
    () =>
      usageViewScopeKey({
        tab: activeTab,
        range,
        customStart,
        customEnd,
        machine,
        model,
        provider,
        source,
        apiKeyHash,
        result,
        session,
        project,
        branch,
        client,
        pullRequests,
      }),
    [activeTab, apiKeyHash, branch, client, customEnd, customStart, machine, model, project, provider, pullRequests, range, result, source, session],
  );

  const executeLoadData = useCallback(
    async (quiet = false) => {
      const requestId = ++requestIdRef.current;
      // The live board is read by its own monitor, whatever the range and filters, and Weekly and All time load
      // their own numbers and have no filters to list.
      if (activeTab === 'live' || activeTab === 'digest' || activeTab === 'lifetime') {
        setLoadedScopeKey(scopeKey);
        setError('');
        setLoading(false);
        // Weekly's machine menu still lists the machines, which opening it straight away wouldn't have read yet.
        if (activeTab === 'digest') {
          const nextAssignments = await invokeCommand('get_usage_machine_assignments').catch(() => null);
          if (nextAssignments && requestId === requestIdRef.current) setAssignments(nextAssignments);
        }
        return;
      }
      const { timeQuery, query } = buildQueries();
      if (!quiet) setLoading(true);
      try {
        // Value has no filters, so it needs neither the machines to pick from nor the names in the filters' menus.
        const nextAssignments = variant === 'value' ? [] : await invokeCommand('get_usage_machine_assignments');
        if (requestId !== requestIdRef.current) return;
        setAssignments(nextAssignments);
        // The names in the request filters' menus. Machines has none of those menus, so it skips the query.
        const optionsKey = [variant, range, customStart, customEnd].join('|');
        const kept = optionsRef.current;
        // Usage's Overview shows these same numbers in its Breakdown when nothing is filtered, so it always reads them
        // afresh.
        const breakdown = variant === 'usage' && activeTab === 'overview';
        const keepOptions = quiet && !breakdown && kept?.key === optionsKey
          && Date.now() - kept.loadedAt < OPTIONS_KEPT_MS;
        const optionsRequest = variant === 'machines' || variant === 'value'
          ? Promise.resolve(emptyAnalysis)
          : keepOptions && kept
            ? Promise.resolve(kept.value)
            : invokeCommand('get_usage_analysis', { query: timeQuery }).then((value) => {
                optionsRef.current = { key: optionsKey, loadedAt: Date.now(), value };
                return value;
              });
        if (activeTab === 'overview') {
          // Usage's Breakdown is the names in the menus when nothing is filtered, and read with the filters when
          // something is.
          const filtered = Boolean(machine || model || provider || source || apiKeyHash || session || result !== 'all');
          const [nextOptions, nextOverview, nextSessionsByMachine, nextAnalysis] = await Promise.all([
            optionsRequest,
            invokeCommand('get_usage_overview', { query }),
            variant === 'machines' ? invokeCommand('get_machine_sessions', { query }) : null,
            !breakdown ? null : filtered ? invokeCommand('get_usage_analysis', { query }) : optionsRequest,
          ]);
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
          setOverview(nextOverview);
          setOverviewRange(timeQuery);
          setSessionsByMachine(nextSessionsByMachine);
          if (nextAnalysis) setAnalysis(nextAnalysis);
        } else if (activeTab === 'sessions') {
          const [nextOptions, nextSessions] = await Promise.all([
            optionsRequest,
            invokeCommand('get_usage_sessions', {
              query: { ...query, sort: sessionSort, page, page_size: pageSize, facets: true },
            }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
          setSessions(nextSessions);
        } else if (activeTab === 'projects') {
          const checkNow = checkGithubRef.current;
          checkGithubRef.current = false;
          const [nextOptions, nextProjects] = await Promise.all([
            optionsRequest,
            invokeCommand('get_session_projects', { query: { ...query, facets: true }, checkNow }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
          setProjects(nextProjects);
        } else if (activeTab === 'events') {
          // Failed requests come with how many failed of every request in the range, so that overview drops the result.
          const [nextOptions, nextEvents, nextOverview] = await Promise.all([
            optionsRequest,
            invokeCommand('get_usage_events', {
              // Failed on keeps newest first: its grid has no sort of its own, so All's would apply unseen.
              query: { ...query, page, page_size: pageSize, request_order: failedOnly ? undefined : requestOrder ?? undefined },
            }),
            failedOnly ? invokeCommand('get_usage_overview', { query: { ...query, failed: undefined, canceled: undefined } }) : null,
          ]);
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
          setEvents(nextEvents);
          if (nextOverview) {
            setOverview(nextOverview);
            setOverviewRange(timeQuery);
          }
        } else if (activeTab === 'capacity') {
          const [nextOptions, nextCapacity] = await Promise.all([
            optionsRequest,
            invokeCommand('get_capacity_report', {
              query: { ...timeQuery, windows: capacityWindows ? capacityWindows.split('\n') : [] },
            }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
          setCapacity(nextCapacity);
        } else if (activeTab === 'pricing') {
          const [nextOptions, nextPricing] = await Promise.all([
            optionsRequest,
            invokeCommand('get_usage_pricing', { query }),
          ]);
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
          setPricing(nextPricing);
        } else {
          const nextOptions = await optionsRequest;
          if (requestId !== requestIdRef.current) return;
          setOptionsAnalysis(nextOptions);
        }
        setLoadedScopeKey(scopeKey);
        setError('');
      } catch (requestError) {
        if (requestId === requestIdRef.current) setError(String(requestError));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [activeTab, buildQueries, capacityWindows, customEnd, customStart, failedOnly, page, pageSize, range, requestOrder, sessionSort, model, provider, source, apiKeyHash, result, machine, session, scopeKey, variant]
  );

  const loadData = useCallback(
    (quiet = false, immediate = false) => {
      // A background refresh waits its turn, unless it's one the user asked for.
      if (quiet) return schedulerRef.current!.schedule(() => executeLoadData(true), immediate);
      setLoading(true);
      // An earlier failure belongs to the view being left; clearing it lets the new one show its skeleton.
      setError('');
      // A load the user asked for starts now and drops any queued background refresh.
      return schedulerRef.current!.runForeground(() => executeLoadData(false));
    },
    [executeLoadData],
  );

  useEffect(() => {
    void loadData();
    return () => {
      // A counter, not a DOM ref: cleanup bumps its latest value so any load still in flight is ignored.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestIdRef.current;
      schedulerRef.current?.cancelPending();
    };
  }, [loadData]);

  // While a session or Checkouts is open in its place, that keeps itself fresh, and the list waits until it's back.
  const listAway = Boolean(openSessionId) || checkouts;
  const sessionOpenRef = useRef(false);
  sessionOpenRef.current = listAway;
  // Back to the list, by its breadcrumb, Activity or Back: it catches up at once.
  const listAwayRef = useRef(listAway);
  useEffect(() => {
    if (listAwayRef.current && !listAway) void loadData(true);
    listAwayRef.current = listAway;
  }, [listAway, loadData]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (!disposed && !document.hidden && !sessionOpenRef.current) void loadData(true);
    };
    listen('usage-records-updated', refresh)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    // New records announce themselves. The timer catches what doesn't: transcripts read, pull requests checked,
    // sessions going quiet and a rolling range moving on, none of which needs a read every few seconds.
    const timer = window.setInterval(refresh, 60_000);
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadData]);

  // A check with GitHub finishes without announcing itself, so while one runs Projects reads again every few seconds
  // rather than leaving "Checking…" up until the minute's refresh.
  const githubChecking = activeTab === 'projects' && Boolean(projects?.github.checking);
  useEffect(() => {
    if (!githubChecking) return undefined;
    const recheck = window.setTimeout(() => void loadData(true), GITHUB_RECHECK_MS);
    return () => window.clearTimeout(recheck);
  }, [githubChecking, projects, loadData]);

  const filters: UsageFilters = { machine, session, project, branch, client, pullRequests, model, provider, source, apiKeyHash, result };
  // The filters this page and tab have, in the Filters popover and as chips when they're set.
  // A machine's page is about the one machine, so it has only the range to pick.
  // A view the breadcrumb narrows to a machine picks it there, so the Filters popover doesn't offer it twice.
  const machineCrumb = variant === 'pricing' || ((variant === 'usage' || variant === 'sessions') && hasMachineScope(variant, activeTab));
  const offeredFilters = selectedMachine ? [] : offeredUsageFilters(variant, activeTab, filters).filter((id) => !(machineCrumb && id === 'machine'));
  /**
   * Changes filters and starts over at the first page. Machine, session, project and Usage's result change the view;
   * the rest are the page's.
   */
  const changeFilters = (change: Partial<UsageFilters>) => {
    const viewChange: Partial<Shown> = {};
    if (change.machine !== undefined) viewChange.machine = change.machine;
    if (change.session !== undefined) viewChange.session = change.session;
    if (change.project !== undefined) viewChange.project = change.project;
    if (change.result !== undefined) viewChange.result = change.result;
    if (Object.keys(viewChange).length) show(viewChange);
    if (change.branch !== undefined) setBranch(change.branch);
    if (change.client !== undefined) setClient(change.client);
    if (change.pullRequests !== undefined) setPullRequests(change.pullRequests);
    if (change.model !== undefined) setModel(change.model);
    if (change.provider !== undefined) setProvider(change.provider);
    if (change.source !== undefined) setSource(change.source);
    if (change.apiKeyHash !== undefined) setApiKeyHash(change.apiKeyHash);
    setPage(1);
  };

  const clearSearch = () => {
    setSearchDraft('');
    setSearch('');
    setPage(1);
  };

  const hasCurrentSnapshot = loadedScopeKey === scopeKey;
  // Until data for the current scope arrives, show the skeleton rather than another scope's numbers.
  // A failed load shows its error instead, and quiet refreshes keep the scope, so they never flash it.
  const showInitialLoading =
    !error &&
    activeTab !== 'digest' &&
    activeTab !== 'lifetime' &&
    activeTab !== 'live' &&
    (!hasCurrentSnapshot ||
      (loading &&
        ((activeTab === 'overview' && !overview) ||
          (activeTab === 'sessions' && !sessions) ||
          (activeTab === 'projects' && !projects) ||
          (activeTab === 'events' && !events) ||
          (activeTab === 'capacity' && !capacity) ||
          (activeTab === 'pricing' && !pricing))));

  const openRequestsForMachine = (nextMachine: string) => {
    if (variant === 'usage') {
      show({ machine: nextMachine, tab: 'events' });
      setPage(1);
      return;
    }
    onNavigate?.(machineRequestsView(nextMachine));
  };
  const openRequestsForSession = (id: string) => onNavigate?.(usageView({ tab: 'events', session: id }));
  // A session opened from the list is a step of its own, so Back returns to the list as it was.
  const openSession = (id: string) => {
    if (variant === 'sessions') show({ openSession: id }, 'push');
    else onNavigate?.(sessionsView({ session: id }));
  };
  const closeSession = () => show({ openSession: null }, 'return');
  const openProjectSessions: OpenSessions = ({ project: nextProject, branch: nextBranch = '', search: nextSearch = '' }) => {
    // A step of its own, so Back returns to Projects.
    show({ project: nextProject, tab: 'sessions' }, 'push');
    setBranch(nextBranch);
    setSearchDraft(nextSearch);
    setSearch(nextSearch);
    setPage(1);
  };
  const checkGithubNow = () => {
    checkGithubRef.current = true;
    void loadData(true, true);
  };
  // In the order their names read, as they're shown.
  const byShownName = (left: string, right: string) => machineName(left).localeCompare(machineName(right));
  const machineNames = [...new Set(assignments.map((item) => item.machine).filter(Boolean))].sort(byShownName);
  const rangeOptions: { value: UsageRange; label: string }[] = [
    { value: '4h', label: t('usage.range.4h') },
    { value: '24h', label: t('usage.range.24h') },
    { value: 'today', label: t('usage.range.today') },
    { value: '7d', label: t('usage.range.7d') },
    { value: '30d', label: t('usage.range.30d') },
    { value: 'all', label: t('usage.range.all') },
    { value: 'custom', label: t('usage.range.custom') },
  ];
  const facets = variant !== 'sessions' ? undefined : activeTab === 'projects' ? projects?.facets : sessions?.facets;
  /** A menu's choices with their sessions. One that's chosen stays listed once the other filters leave it none. */
  const facetItems = (counts: FacetCount[] | undefined, selected: string) => {
    const listed = counts ?? [];
    return (selected && !listed.some((item) => item.value === selected) ? [...listed, { value: selected, sessions: 0 }] : listed).map((item) => (
      <SelectItem key={item.value} value={item.value}>
        <FacetOption label={item.value} sessions={item.sessions} />
      </SelectItem>
    ));
  };
  // Sessions also sit on the machines their transcripts were found on.
  const machineChoices = facets
    ? [...new Set([...machineNames, ...facets.machines.map((item) => item.value)])].sort(byShownName)
    : machineNames;
  const machineSessions = new Map(facets?.machines.map((item) => [item.value, item.sessions]));

  // The section, then the view the tree has lit: `Usage / Requests`, `Sessions / Live`. The tree picks the view, so
  // there are no tabs under the bar to name it.
  const viewLabel = variant === 'usage' || variant === 'sessions' ? leafLabel(variant, activeTab) : undefined;
  // Then, on a view that can be, the machine it's narrowed to, with every machine to pick from: the ones with requests
  // or sessions, and on Live the ones on the board as well.
  const pickMachine = (next: string) => changeFilters({ machine: next });
  // The archive files nothing under no machine, so All time has no Unassigned and shows everything for it.
  const lifetimeMachine = machine === '__unassigned__' ? '' : machine;
  const crumbMachine = !machineCrumb ? []
    : activeTab === 'lifetime' ? [<ArchiveMachineCrumb key="machine" machine={lifetimeMachine} known={machineChoices} onChange={pickMachine} />]
    : activeTab === 'live' ? [<LiveMachineCrumb key="machine" machine={machine} machines={machineChoices} onChange={pickMachine} />]
    : [<MachineCrumb key="machine" machine={machine} machines={machineChoices} unassigned onChange={pickMachine} />];
  const breadcrumb =
    variant === 'machines'
      // The fleet, or one machine's page, picked the way the other views pick theirs.
      ? [t('app.nav.machines'), <FleetMachineCrumb key="machine" machine={selectedMachine ?? ''} known={machineNames} onChange={(next) => onNavigate?.(machinesView(next || undefined))} />]
      : variant === 'value'
      ? [t('app.nav.accounts'), t('tree.accounts.value')]
      : variant === 'sessions'
      ? [t('app.nav.sessions'), ...(viewLabel ? [t(viewLabel)] : []), ...crumbMachine]
      : variant === 'pricing'
      ? [t('app.nav.usageRecords'), t('usage.tab.prices'), ...crumbMachine]
      : [t('app.nav.usageRecords'), ...(viewLabel ? [t(viewLabel)] : []), ...crumbMachine];

  const filterNames = {
    model: optionsAnalysis.models,
    provider: optionsAnalysis.providers,
    source: shownSources(optionsAnalysis.sources, shownIdentity),
    apiKeyHash: optionsAnalysis.apiKeys,
  };
  // The machine filter's chip shows the machine's pill; Unassigned isn't a machine, so it stays words. The model's
  // shows it with its mark, as the menu does.
  const filterChips = usageFilterChips(filters, chippedUsageFilters(variant, activeTab, filters, offeredFilters), t, filterNames)
    .map((chip) => (chip.id === 'machine' && filters.machine && filters.machine !== '__unassigned__' ? { ...chip, machine: filters.machine }
      : chip.id === 'model' && filters.model ? { ...chip, model: filters.model } : chip));
  /** One filter's menu in the Filters popover, labeled with the filter's name. */
  const filterMenu = (id: UsageFilterId, display: ReactNode, items: ReactNode) => {
    const fieldId = `usage-filter-${id}`;
    return (
      <FilterField key={id} label={t(USAGE_FILTER_LABELS[id])} htmlFor={fieldId}>
        <Select value={filters[id]} onValueChange={(next) => changeFilters(usageFilterChange(id, next ?? ''))}>
          <SelectTrigger id={fieldId} size="sm" className={cn(isUsageFilterSet(filters, id) && 'border-primary/40')}>
            <SelectValue>{display}</SelectValue>
          </SelectTrigger>
          <SelectPopup>{items}</SelectPopup>
        </Select>
      </FilterField>
    );
  };
  /** A model or provider in its menu with its provider's mark, as the page shows it; a source or key as its name. */
  const requestName = (id: 'model' | 'provider' | 'source' | 'apiKeyHash', key: string, label: string) =>
    id === 'model' ? <ModelName model={label} className="font-normal text-current" />
      : id === 'provider' ? <ProviderPill provider={key} />
        : label;
  /** A menu of the model, provider, source or key names the time range has requests for. */
  const requestMenu = (id: 'model' | 'provider' | 'source' | 'apiKeyHash', everything: string) =>
    filterMenu(
      id,
      filters[id] ? requestName(id, filters[id], usageFilterValueText(filters, id, t, filterNames)) : everything,
      <>
        <SelectItem value="">{everything}</SelectItem>
        {filterOptions(filterNames[id]).map((item) => <SelectItem key={item.key} value={item.key}>{requestName(id, item.key, item.label)}</SelectItem>)}
      </>,
    );
  const filterMenuFor = (id: UsageFilterId): ReactNode => {
    switch (id) {
      case 'project':
        return filterMenu(id, project || t('usage.filter.allProjects'), (
          <>
            <SelectItem value="">{t('usage.filter.allProjects')}</SelectItem>
            {facetItems(facets?.projects, project)}
          </>
        ));
      case 'branch':
        return filterMenu(id, branch || t('usage.filter.allBranches'), (
          <>
            <SelectItem value="">{t('usage.filter.allBranches')}</SelectItem>
            {facetItems(facets?.branches, branch)}
          </>
        ));
      case 'machine':
        return filterMenu(id, machine && machine !== '__unassigned__' ? <MachinePill name={machine} /> : machine ? usageFilterValueText(filters, id, t) : t('usage.filter.allMachines'), (
          <>
            <SelectItem value="">{t('usage.filter.allMachines')}</SelectItem>
            <SelectItem value="__unassigned__">{t('usage.filter.unassigned')}</SelectItem>
            {machineChoices.map((name) => (
              <SelectItem key={name} value={name}>
                {facets ? <FacetOption label={<MachinePill name={name} />} sessions={machineSessions.get(name) ?? 0} /> : <MachinePill name={name} />}
              </SelectItem>
            ))}
          </>
        ));
      case 'client':
        return filterMenu(id, client || t('usage.filter.allClients'), (
          <>
            <SelectItem value="">{t('usage.filter.allClients')}</SelectItem>
            {facetItems(facets?.clients, client)}
          </>
        ));
      case 'pullRequests':
        return filterMenu(id, pullRequests ? usageFilterValueText(filters, id, t) : t('usage.filter.anyPullRequest'), (
          <>
            <SelectItem value="">{t('usage.filter.anyPullRequest')}</SelectItem>
            <SelectItem value="with">
              <FacetOption label={t('usage.filter.withPullRequest')} sessions={facets?.withPullRequests} />
            </SelectItem>
            <SelectItem value="without">
              <FacetOption label={t('usage.filter.withoutPullRequest')} sessions={facets?.withoutPullRequests} />
            </SelectItem>
          </>
        ));
      case 'model':
        return requestMenu(id, t('usage.filter.allModels'));
      case 'provider':
        return requestMenu(id, t('usage.filter.allProviders'));
      case 'source':
        return requestMenu(id, t('usage.filter.allSources'));
      case 'apiKeyHash':
        return requestMenu(id, t('usage.filter.allKeys'));
      case 'result':
        return filterMenu(id, result === 'all' ? t('usage.filter.allResults') : usageFilterValueText(filters, id, t), (
          <>
            <SelectItem value="all">{t('usage.filter.allResults')}</SelectItem>
            <SelectItem value="success">{t('usage.result.success')}</SelectItem>
            <SelectItem value="failed">{t('usage.result.failed')}</SelectItem>
            <SelectItem value="canceled">{t('usage.result.canceled')}</SelectItem>
          </>
        ));
      case 'session':
        return null;
    }
  };

  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const refreshPage = () => {
    if (activeTab === 'live') {
      setLiveRefreshing(true);
      void loadFleetSources().finally(() => setLiveRefreshing(false));
      return;
    }
    if (activeTab === 'digest') setDigestRefresh((count) => count + 1);
    if (activeTab === 'lifetime') setLifetimeRefresh((count) => count + 1);
    void loadData(false);
  };
  const refreshing = loading || liveRefreshing;
  // A session or Checkouts open in place of the list has a refresh of its own.
  useShortcut('page.refresh', () => {
    if (!refreshing) refreshPage();
  }, !listAway);

  if (variant === 'sessions' && openSessionId) {
    return <SessionDetailPage key={openSessionId} sessionId={openSessionId} onBack={closeSession} onViewRequests={openRequestsForSession} />;
  }
  if (checkouts) {
    return <SessionsCheckoutsPage params={{ tab: 'projects', machine: asked.machine, project: asked.project, lens: 'checkouts' }} onViewChange={onViewChange} />;
  }

  const showFilters = activeTab !== 'digest' && activeTab !== 'lifetime' && activeTab !== 'live';
  // Requests is the page's one table, All or Failed: edge to edge, its filters held above the rows and its pager below.
  const requestsPage = variant === 'usage' && activeTab === 'events';
  const filterBar = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('usage.filter.title')}>
        {failedToggle ? (
          <ToggleGroup
            value={result === 'failed' ? ['failed'] : result === 'all' ? ['all'] : []}
            onValueChange={(value) => changeFilters({ result: value[0] === 'failed' ? 'failed' : 'all' })}
            aria-label={t('usage.requests.show')}
          >
            <Toggle value="all">{t('usage.requests.all')}</Toggle>
            <Toggle value="failed">{t('usage.requests.failed')}</Toggle>
          </ToggleGroup>
        ) : null}
        {variant === 'sessions' ? (
          <Input
            type="search"
            data-page-search
            size="sm"
            wrapperClassName="w-64"
            startAddon={<Search />}
            endAddon={searchDraft ? (
              <Button variant="ghost-muted" size="icon-xs" onClick={clearSearch} aria-label={t('usage.filter.clearSearch')}>
                <X />
              </Button>
            ) : null}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !searchDraft) return;
              event.preventDefault();
              clearSearch();
            }}
            placeholder={t('usage.filter.searchPlaceholder')}
            aria-label={t('usage.filter.search')}
          />
        ) : null}
        <Select
          value={range}
          onValueChange={(value) => {
            if (!value) return;
            changeRange(value);
            setPage(1);
          }}
        >
          <SelectTrigger
            size="sm"
            className={cn('w-auto min-w-0 max-w-56 gap-1.5', range !== '24h' && 'border-primary/40')}
            aria-label={t('usage.filter.timeRange')}
          >
            <Clock3 className={cn('size-3.5', range !== '24h' ? 'text-primary' : 'text-icon-muted')} aria-hidden="true" />
            <SelectValue className="truncate">{rangeOptions.find((option) => option.value === range)?.label ?? range}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {rangeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectPopup>
        </Select>
        {offeredFilters.length ? (
          <FilterBar
            chips={filterChips}
            onRemove={(id) => changeFilters(clearUsageFilter(id))}
            onClearAll={() => changeFilters({ ...clearAllUsageFilters(failedOnly), ...(machineCrumb ? { machine } : {}) })}
          >
            {offeredFilters.filter(usageFilterHasMenu).map(filterMenuFor)}
          </FilterBar>
        ) : null}
      </div>
      {range === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Input
            type="datetime-local"
            size="sm"
            wrapperClassName="w-56"
            value={customStart}
            onChange={(event) => setCustomStart(event.currentTarget.value)}
            aria-label={t('usage.filter.startTime')}
          />
          <span>{t('usage.filter.to')}</span>
          <Input
            type="datetime-local"
            size="sm"
            wrapperClassName="w-56"
            value={customEnd}
            onChange={(event) => setCustomEnd(event.currentTarget.value)}
            aria-label={t('usage.filter.endTime')}
          />
        </div>
      ) : null}
    </div>
  );

  return (
    <Page width={requestsPage ? 'full' : 'main'}>
      <PageTopbar
        collapsible={variant === 'sessions' && activeTab === 'projects' ? [
          // Checkouts is its own step, so Back returns to Activity as it was.
          projectsLensAction(undefined, (lens) => onViewChange?.(sessionsView({ tab: 'projects', machine, project, lens }), 'push')),
        ] : undefined}
        actions={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  onClick={refreshPage}
                  disabled={refreshing}
                  focusableWhenDisabled
                  aria-label={t('usage.refresh')}
                />
              }
            >
              <RefreshIcon refreshing={refreshing} />
            </TooltipTrigger>
            <TooltipPopup><WithShortcut id="page.refresh">{t('usage.refresh')}</WithShortcut></TooltipPopup>
          </Tooltip>
        }
      >
        <PageBreadcrumb segments={breadcrumb} />
      </PageTopbar>

      <PageBody gap={requestsPage ? 'gap-4' : 'gap-6'} fill={requestsPage}>
        {/* A page that is its table keeps the gutter for what sits above it. */}
        <div className={cn('flex flex-col', requestsPage ? 'gap-3 px-5 empty:hidden' : 'contents')}>
          {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
          {variant !== 'pricing' ? <ProxyChecksBanner onNavigate={onNavigate} /> : null}
          {variant !== 'pricing' ? <UsageCollectorBanner onOpenData={onNavigate ? () => onNavigate({ kind: 'settings', page: 'data' }) : undefined} /> : null}
          {variant === 'usage' || variant === 'value' ? <ProviderStatusBanner /> : null}
          {variant === 'usage' || variant === 'sessions' ? <HeavySessionBanner machine={machineCrumb ? machine : ''} onOpenSession={openSession} /> : null}
          {variant === 'sessions' ? <ArchiveBanner onOpen={onNavigate ? () => onNavigate({ kind: 'settings', page: 'session-archive' }) : undefined} /> : null}
        </div>

        {showFilters && !requestsPage ? filterBar : null}

        {/* A machine's page holds each section's place itself, so nothing lands above its header and pushes it down. */}
        {showInitialLoading && !requestsPage && !selectedMachine ? (
          <div className="flex flex-col gap-6" aria-busy="true" aria-label={t('usage.loading')}>
            <StatsGrid columns={6}>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="space-y-2 px-4 py-3">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-6 w-20" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </StatsGrid>
            <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
              <Spinner />
              {t('usage.loading')}
            </div>
          </div>
        ) : null}

        {activeTab === 'overview' && variant === 'machines' && selectedMachine && onNavigate ? (
          <MachinePage
            key={selectedMachine}
            machine={selectedMachine}
            overview={hasCurrentSnapshot ? overview : null}
            sessions={hasCurrentSnapshot ? sessionsByMachine : null}
            onNavigate={onNavigate}
            onOpenSession={openSession}
            onOpenRequests={openRequestsForMachine}
          />
        ) : activeTab === 'overview' && variant === 'machines' ? (
          <MachinesView
            overview={hasCurrentSnapshot ? overview : null}
            onOpen={(next) => onNavigate?.(machinesView(next))}
            onInspect={openRequestsForMachine}
            onAssign={() => onNavigate?.({ kind: 'settings', page: 'machines' })}
          />
        ) : null}
        {activeTab === 'live' && variant === 'sessions' ? (
          <FleetBoard machine={machine} onOpenSession={openSession} />
        ) : null}
        {hasCurrentSnapshot && activeTab === 'overview' && overview && variant === 'usage' ? (
          <>
            <OverviewView overview={overview} range={overviewRange} />
            <BreakdownSection analysis={analysis} overview={overview} />
          </>
        ) : null}
        {activeTab === 'digest' && variant === 'usage' ? <UsageDigestView refreshKey={digestRefresh} machine={machine} onOpenSession={openSession} /> : null}
        {activeTab === 'lifetime' && variant === 'usage' ? (
          <UsageLifetimeView key={lifetimeMachine} refreshKey={lifetimeRefresh} machine={lifetimeMachine} onOpenArchive={onNavigate ? () => onNavigate({ kind: 'settings', page: 'session-archive' }) : undefined} />
        ) : null}
        {hasCurrentSnapshot && activeTab === 'sessions' && sessions ? (
          <SessionsView
            sessions={sessions}
            search={search}
            pageSize={pageSize}
            sort={sessionSort}
            onOpen={openSession}
            onPage={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            onSortChange={(sort) => {
              setSessionSort(sort);
              setPage(1);
            }}
          />
        ) : null}
        {hasCurrentSnapshot && activeTab === 'projects' && projects ? (
          <SessionProjectsView report={projects} onOpenSessions={openProjectSessions} onCheckGithub={checkGithubNow} />
        ) : null}
        {requestsPage ? (
          <RequestsView
            // Failed on has a column layout of its own, which the grid reads once.
            key={failedOnly ? 'failed' : 'all'}
            events={hasCurrentSnapshot ? events : null}
            filters={filterBar}
            summary={failedOnly && hasCurrentSnapshot && events ? <FailureGlance failures={events} overview={overview} /> : null}
            failedOnly={failedOnly}
            pageSize={pageSize}
            order={requestOrder}
            empty={failedOnly ? (
              <Empty size="sm">
                <EmptyMedia><CircleCheck /></EmptyMedia>
                <EmptyDescription>{t('usage.failures.empty')}</EmptyDescription>
              </Empty>
            ) : <UsageEmpty />}
            onPage={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            onOrderChange={(order) => {
              setRequestOrder(order);
              saveRequestOrder(localStorage, order);
              setPage(1);
            }}
          />
        ) : null}
        {hasCurrentSnapshot && activeTab === 'capacity' && capacity ? (
          <CapacityView data={capacity} onAddAccount={onNavigate ? () => addAccount(onNavigate) : undefined} onNavigate={onNavigate} />
        ) : null}
        {hasCurrentSnapshot && activeTab === 'pricing' && pricing ? (
          <PricingView pricing={pricing} query={buildQueries().query} onChanged={() => loadData(true)} />
        ) : null}
      </PageBody>
    </Page>
  );
}

/**
 * The fleet at a glance: its totals, each machine's health (a row that opens its page) and its requests. `overview` is
 * null while usage for a new scope loads. Machine health reads on its own and ignores the usage filters, so it stays
 * mounted through that; only the parts drawn from the usage data wait for the new data.
 */
function MachinesView({ overview, onOpen, onInspect, onAssign }: {
  overview: UsageOverview | null;
  /** Opens a machine's own page. */
  onOpen: (machine: string) => void;
  onInspect: (machine: string) => void;
  onAssign: () => void;
}) {
  const { t } = useI18n();
  const machines = overview?.machines ?? [];
  const machineNames = new Set(machines.map((item) => item.machine).filter(Boolean));
  const totalTokens = machines.reduce((sum, item) => sum + item.tokens, 0);
  const totalRequests = machines.reduce((sum, item) => sum + item.requests, 0);
  const unassignedTokens = machines.filter((item) => !item.machine).reduce((sum, item) => sum + item.tokens, 0);
  const unassignedShare = totalTokens ? (unassignedTokens * 100) / totalTokens : 0;
  return (
    <div className="flex flex-col gap-6">
      {overview ? (
        <StatsGrid columns={4}>
          <StatBlock label={t('machines.stat.machines')} value={formatCount(machineNames.size)} />
          <StatBlock label={t('machines.stat.requests')} value={formatCount(totalRequests)} />
          <StatBlock label={t('machines.stat.tokens')} value={formatCount(totalTokens)} />
          <StatBlock
            label={t('machines.stat.unassigned')}
            value={`${unassignedShare.toFixed(1)}%`}
            hint={t('machines.stat.unassignedHint')}
            tone={unassignedShare > 25 ? 'warning' : 'default'}
          />
        </StatsGrid>
      ) : null}
      <MachineHealthPanel onConfigure={onAssign} onOpen={onOpen} />
      {overview ? <UsageFleet items={overview.machines} live={overview.machineLive} onInspect={onInspect} onAssign={onAssign} /> : null}
    </div>
  );
}

/** A filter menu's choice, with how many sessions it would show. */
function FacetOption({ label, sessions }: { label: ReactNode; sessions?: number }) {
  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-4">
      <span className="truncate">{label}</span>
      {sessions === undefined ? null : <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{formatCount(sessions)}</span>}
    </span>
  );
}

