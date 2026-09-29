import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { invokeCommand } from '../native/commands';
import { ArrowLeft, Bot, ChevronRight, FolderGit2, Search, SlidersHorizontal, type AppIcon } from './ui/icons';
import { requestFocus } from '../focusRequests';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { accountLimitsView, machineSessionsView, machinesView, sessionsView, type AppView } from '../navigation';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import { useAccountReserves } from '../services/accountReserves';
import { useAccountsStore } from '../services/accountsStore';
import { leavesSubmenu, paletteMatches, palettePageId, paletteResults, parsePaletteQuery, readRecents, rememberRecent, type PaletteGroup } from '../services/commandPalette';
import { liveSessionName } from '../services/liveSessions';
import { fetchMachineHealth } from '../services/machineHealth';
import { providerLabel } from '../services/providerLimits';
import { fileName, providerForFile, quotaKey } from '../services/quotaService';
import { formatAgo } from '../lib/format';
import { matchesShortcut } from '../services/shortcuts';
import type { IndexedSetting, SettingEntry } from '../services/settingsIndex';
import { AccountAvatar } from './AccountAvatar';
import { MachineMark, ProviderMark } from './identity/Identity';
import { usePaletteActions } from './CommandPaletteActions';
import { IconBox, type PaletteItem, type PaletteSubmenu } from './paletteItem';
import { SessionLabel } from './SessionLabel';
import { ShortcutKbd } from './ShortcutKbd';
import { Dialog, DialogPopup } from './ui/dialog';
import { Kbd } from './ui/kbd';
import { StatusDot, type StatusTone } from './ui/status-dot';
import type { FacetCount, HealthStatus, UsageSession, UsageSessionPage } from '../native/types';
import { paletteKind, trackFeature } from '../services/productAnalytics';
import { machineName } from '../services/machineNames';

/**
 * A page the palette can open, as the sidebar lists it, or one of its views, which names its page in `parent` and is
 * listed once something's typed.
 */
export type PalettePage = { view: AppView; label: string; icon: AppIcon; locked: boolean; keywords?: string; parent?: string };
/** A setting the palette can open its page at, from the Settings index. */
export type PaletteSetting = { setting: IndexedSetting; locked: boolean };

const STATUS_TONE: Record<HealthStatus, StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'error',
  unreachable: 'error',
  pending: 'muted',
  unconfigured: 'muted',
};
const GROUP_LABEL: Record<PaletteGroup, MessageKey> = {
  recent: 'palette.group.recent',
  pages: 'palette.group.pages',
  actions: 'palette.group.actions',
  settings: 'palette.group.settings',
  projects: 'palette.group.projects',
  sessions: 'palette.group.sessions',
  machines: 'palette.group.machines',
  accounts: 'palette.group.accounts',
};
const SUBMENU_PLACEHOLDER: Record<PaletteSubmenu, MessageKey> = { pause: 'palette.submenu.pause', resume: 'palette.submenu.resume' };
/** Search waits for a pause in typing this long. */
const SEARCH_DELAY_MS = 150;
const RECENT_SESSIONS = 6;
/**
 * The recent sessions and the project and machine names, as the palette last read them. Reading them looks through
 * every session there's been, so an open shows these straight away and reads again only once they're a minute old.
 */
let recentRead: { atMs: number; page: UsageSessionPage } | null = null;
const RECENT_READ_FRESH_MS = 60_000;

const optionId = (index: number) => `palette-option-${index}`;
const sessionId = (id: string) => (id.startsWith('session:') ? id.slice('session:'.length) : null);

/**
 * Cmd-K (Ctrl-K elsewhere): find a page, project, session, machine or account by name and go straight to it, or run
 * an action (`>` lists only those). Sessions are found by the Sessions page's own search, so a title, branch, pull
 * request or id works too. Before anything is typed it offers the last few picks first.
 */
export function CommandPalette({ open, initialQuery = '', onOpenChange, finalFocus, pages, settings, lockedHint, coreReady, onNavigate, onOpenSetting }: {
  open: boolean;
  /** Already typed as it opens: what was typed into the sidebar's search row. */
  initialQuery?: string;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes as it closes, when that's not simply back where it was. */
  finalFocus?: ComponentProps<typeof DialogPopup>['finalFocus'];
  pages: PalettePage[];
  settings: PaletteSetting[];
  /** Why a locked page can't open yet. */
  lockedHint: string;
  coreReady: boolean;
  onNavigate: (view: AppView) => void;
  /** Opens a setting's page at its row. */
  onOpenSetting: (entry: SettingEntry) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  // Null until the arrows or the mouse pick a row: then the first row that can run is the one Enter runs.
  const [active, setActive] = useState<number | null>(null);
  const [submenu, setSubmenu] = useState<PaletteSubmenu | null>(null);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  const [recent, setRecent] = useState<UsageSession[]>([]);
  // Sessions picked lately that aren't among the most recent, looked up by id so they can still be listed.
  const [pickedSessions, setPickedSessions] = useState<UsageSession[]>([]);
  const [found, setFound] = useState<{ query: string; sessions: UsageSession[] } | null>(null);
  const [projects, setProjects] = useState<FacetCount[]>([]);
  const [sessionMachines, setSessionMachines] = useState<FacetCount[]>([]);
  const [machines, setMachines] = useState<{ machine: string; status: HealthStatus }[]>([]);
  const { files, disabled } = useAccountsStore();
  const profiles = useAccountProfiles();
  const reserves = useAccountReserves();
  const { actions, submenus } = usePaletteActions({ onNavigate });
  const listRef = useRef<HTMLDivElement>(null);
  // The dialog puts the focus in the field as it opens (initialFocus), once it has noted what had it, so closing hands
  // it back there. The field's own autoFocus would take it first and leave the dialog only the field to go back to.
  const fieldRef = useRef<HTMLInputElement>(null);
  // Entering or leaving a list of accounts remounts the field, which then takes the focus back itself.
  const fieldFor = useRef(submenu);
  useLayoutEffect(() => {
    if (fieldFor.current === submenu) return;
    fieldFor.current = submenu;
    if (open) fieldRef.current?.focus();
  }, [open, submenu]);
  // Read as it opens, not a reason to open again.
  const initialQueryRef = useRef(initialQuery);
  initialQueryRef.current = initialQuery;
  // What's worth listing before anything is typed, and the names to match against.
  useEffect(() => {
    if (!open) return undefined;
    let stale = false;
    setQuery(initialQueryRef.current);
    setActive(null);
    setFound(null);
    setSubmenu(null);
    const picks = readRecents();
    setRecents(picks);
    const show = async (page: UsageSessionPage) => {
      if (stale) return;
      const latest = page.items.slice(0, RECENT_SESSIONS);
      setRecent(latest);
      setProjects((page.facets?.projects ?? []).filter((item) => item.value));
      setSessionMachines((page.facets?.machines ?? []).filter((item) => item.value));
      const missing = picks.flatMap((id) => {
        const session = sessionId(id);
        return session && !latest.some((item) => item.id === session) ? [session] : [];
      });
      const looked = await Promise.all(missing.map((id) =>
        invokeCommand('get_usage_sessions', { query: { search: id, sort: 'recent', page: 1, page_size: 1 } })
          .then((result) => result.items.find((item) => item.id === id) ?? null)
          .catch(() => null)));
      if (!stale) setPickedSessions(looked.filter((item): item is UsageSession => item !== null));
    };
    const kept = recentRead;
    if (kept) void show(kept.page);
    if (!kept || Date.now() - kept.atMs >= RECENT_READ_FRESH_MS) {
      invokeCommand('get_usage_sessions', { query: { sort: 'recent', page: 1, page_size: RECENT_SESSIONS, facets: true } })
        .then((page) => {
          recentRead = { atMs: Date.now(), page };
          return show(page);
        })
        .catch((error) => console.warn('Failed to load sessions for search', error));
    }
    fetchMachineHealth(Date.now(), 60_000, true)
      .then((snapshot) => {
        if (!stale) setMachines(snapshot.machines.map((item) => ({ machine: item.machine, status: item.status })));
      })
      .catch((error) => console.warn('Failed to load machines for search', error));
    return () => {
      stale = true;
    };
  }, [open]);

  const { actionsOnly, text } = parsePaletteQuery(query);
  const sessionSearch = open && !submenu && !actionsOnly ? text : '';
  useEffect(() => {
    if (!sessionSearch) return undefined;
    let stale = false;
    const timer = window.setTimeout(() => {
      invokeCommand('get_usage_sessions', { query: { search: sessionSearch, sort: 'recent', page: 1, page_size: 8 } })
        .then((page) => {
          if (!stale) setFound({ query: sessionSearch, sessions: page.items });
        })
        .catch(() => {
          if (!stale) setFound({ query: sessionSearch, sessions: [] });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [sessionSearch]);

  // Built only while it's open: closed, the accounts and settings it lists still change, with nothing to show them.
  const entries = useMemo((): PaletteItem[] => {
    if (!open) return [];
    const now = Date.now();
    const pageItems: PaletteItem[] = pages.map((page) => {
      const Icon = page.icon;
      const settings = page.view.kind === 'settings';
      const tab = page.view.kind === 'main' && page.view.params && 'tab' in page.view.params ? page.view.params.tab : undefined;
      // Settings' pages and each page's views sit under what they belong to, which finds them too.
      const parent = settings ? t('settings.title') : page.parent;
      return {
        id: palettePageId(page.view),
        group: 'pages',
        label: page.label,
        keywords: [parent, page.keywords].filter(Boolean).join(' '),
        shown: parent ? 'typed' : undefined,
        icon: <IconBox><Icon /></IconBox>,
        content: parent
          ? <span className="block truncate"><span className="text-muted-foreground">{`${parent} › `}</span>{page.label}</span>
          : undefined,
        shortcut: page.view.kind === 'main' && !tab ? `go.${page.view.page}` : undefined,
        // Listed grayed out rather than hidden, so it's clear why it won't open.
        disabledReason: page.locked ? lockedHint : undefined,
        run: () => onNavigate(page.view),
      };
    });
    // Found by title first, then by section, page and the other words Settings search knows them by.
    const settingItems: PaletteItem[] = settings.map(({ setting, locked }) => ({
      id: `setting:${setting.entry.id}`,
      group: 'settings',
      label: setting.title,
      keywords: [setting.section, setting.page, setting.aliases].join(' '),
      shown: 'typed',
      icon: <IconBox><SlidersHorizontal /></IconBox>,
      content: <span className="block truncate"><span className="text-muted-foreground">{`${setting.page} › `}</span>{setting.title}</span>,
      disabledReason: locked ? lockedHint : undefined,
      run: () => onOpenSetting(setting.entry),
    }));
    const sessionItem = (session: UsageSession, shown: PaletteItem['shown']): PaletteItem => ({
      id: `session:${session.id}`,
      group: 'sessions',
      label: liveSessionName(session),
      searched: shown === 'typed',
      shown,
      icon: <IconBox><ProviderMark provider={session.provider} decorative className="size-full object-contain" fallback={<Bot />} /></IconBox>,
      content: <SessionLabel session={session} machine extra={formatAgo(session.lastActiveAtMs, now)} className="text-sm" />,
      run: () => onNavigate(sessionsView({ session: session.id })),
    });
    const sessionItems = [
      ...recent.map((session) => sessionItem(session, 'idle')),
      ...(text && found?.query === text ? found.sessions : []).map((session) => sessionItem(session, 'typed')),
      ...pickedSessions.map((session) => sessionItem(session, 'recentOnly')),
    ];
    const countLabel = (label: string, sessions: number) => (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(sessions === 1 ? 'palette.sessions.one' : 'palette.sessions.other', { count: sessions })}
        </span>
      </span>
    );
    const projectItems: PaletteItem[] = projects.map((project) => ({
      id: `project:${project.value}`,
      group: 'projects',
      label: project.value,
      shown: 'typed',
      icon: <IconBox><FolderGit2 /></IconBox>,
      content: countLabel(project.value, project.sessions),
      run: () => onNavigate(sessionsView({ tab: 'sessions', project: project.value })),
    }));
    const listed = new Set(machines.map((item) => item.machine));
    const machineItems: PaletteItem[] = [
      ...machines.map((item): PaletteItem => ({
        id: `machine:${item.machine}`,
        group: 'machines',
        // Found by the name it's shown by, and by its own.
        label: machineName(item.machine),
        keywords: item.machine,
        shown: 'typed',
        icon: (
          <IconBox>
            <MachineMark name={item.machine} />
            <StatusDot tone={STATUS_TONE[item.status]} className="absolute -top-0.5 -right-0.5 ring-2 ring-popover" />
          </IconBox>
        ),
        run: () => {
          requestFocus('machine', item.machine);
          onNavigate(machinesView(item.machine));
        },
      })),
      // Machines known only from their sessions open those sessions.
      ...sessionMachines.filter((item) => !listed.has(item.value)).map((item): PaletteItem => ({
        id: `machine-sessions:${item.value}`,
        group: 'machines',
        label: machineName(item.value),
        keywords: item.value,
        shown: 'typed',
        icon: <IconBox><MachineMark name={item.value} /></IconBox>,
        content: countLabel(machineName(item.value), item.sessions),
        run: () => onNavigate(machineSessionsView(item.value)),
      })),
    ];
    const accountFiles = coreReady ? [...files, ...disabled.filter((file) => reserves.paused[quotaKey(file)])] : [];
    const accountItems: PaletteItem[] = accountFiles.map((file) => {
      const key = quotaKey(file);
      const profile = resolveAccountProfile(key, fileName(file), profiles[key]);
      const provider = providerForFile(file);
      const email = typeof file.email === 'string' ? file.email : '';
      const detail = [provider ? providerLabel[provider] : '', reserves.paused[key] ? t('palette.paused') : ''].filter(Boolean).join(' · ');
      return {
        id: `account:${key}`,
        group: 'accounts',
        label: profile.name,
        keywords: [email, fileName(file), provider ? providerLabel[provider] : ''].join(' '),
        shown: 'typed',
        // As big as the other rows' icon tiles (IconBox), so every row's words start in line.
        icon: <AccountAvatar profile={profile} size="sm" className="size-7" />,
        content: (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn('truncate', !profile.custom && 'font-mono text-xs')}>{profile.name}</span>
            {detail ? <span className="shrink-0 text-xs text-muted-foreground">{detail}</span> : null}
          </span>
        ),
        run: () => {
          requestFocus('account', key);
          onNavigate(accountLimitsView());
        },
      };
    });
    return [...pageItems, ...actions, ...settingItems, ...projectItems, ...sessionItems, ...machineItems, ...accountItems];
  }, [open, pages, settings, onOpenSetting, lockedHint, actions, text, found, recent, pickedSessions, projects, machines, sessionMachines, files, disabled, reserves.paused, profiles, coreReady, onNavigate, t]);

  const items = useMemo(
    () => (submenu ? paletteMatches(submenus[submenu], query) : paletteResults(entries, query, recents)),
    [submenu, submenus, entries, query, recents],
  );

  useEffect(() => setActive(null), [query, submenu]);
  // -1 when nothing listed can run: no row lights up as if Enter would do something.
  const current = active !== null && items[active] ? active : items.findIndex((item) => !item.disabledReason);
  useEffect(() => {
    if (current >= 0) listRef.current?.querySelector(`#${optionId(current)}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  // Back to the palette's own list as it was before, with what was typed for the accounts gone.
  const leaveSubmenu = () => {
    setSubmenu(null);
    setQuery('');
  };

  const pick = (item: PaletteItem | undefined) => {
    if (!item || item.disabledReason) return;
    // A pick inside a list of accounts is remembered as the action that opened the list.
    if (!submenu) setRecents(rememberRecent(item.id));
    if (item.submenu) {
      setSubmenu(item.submenu);
      setQuery('');
      return;
    }
    const run = item.run;
    if (!run) return;
    trackFeature('palette-used', { kind: paletteKind(item.id) });
    // Closed first: the action says how it went in a toast. Run in the same key press or click, which a copy needs.
    onOpenChange(false);
    void run();
  };

  // The app's shortcuts stand aside inside a dialog, so the palette closes itself on ⌘K from anywhere in it.
  const onPopupKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!matchesShortcut(event.nativeEvent, 'palette.toggle')) return;
    event.preventDefault();
    onOpenChange(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Rows that can't run are passed over; they say why where they're listed.
      const from = current >= 0 ? current : step > 0 ? -1 : items.length;
      for (let offset = 1; offset <= items.length; offset += 1) {
        const next = (from + step * offset + items.length * offset) % items.length;
        if (!items[next]?.disabledReason) {
          setActive(next);
          break;
        }
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(items[current]);
    } else if (event.key !== 'Escape' && leavesSubmenu(event.key, query, submenu !== null)) {
      // Escape is left to the dialog, which asks the same before it closes, wherever the focus is in it.
      event.preventDefault();
      leaveSubmenu();
    }
  };

  const searching = Boolean(sessionSearch) && found?.query !== sessionSearch;
  const emptyText = searching
    ? t('palette.searching')
    : submenu
      ? t(query ? 'palette.empty' : 'palette.emptyAccounts', { query })
      : text ? t('palette.empty', { query: text }) : t('palette.emptyStart');
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next, details) => {
          // Esc in a list of accounts goes back to the palette's own list; from there it closes the palette.
          if (!next && details.reason === 'escape-key' && leavesSubmenu('Escape', query, submenu !== null)) {
            details.cancel();
            leaveSubmenu();
            return;
          }
          onOpenChange(next);
        }}
      >
        {/* Held near the top rather than centered, so the field stays put as the list grows and shrinks. */}
        <DialogPopup
          showCloseButton={false}
          initialFocus={fieldRef}
          finalFocus={finalFocus}
          className="row-span-3 row-start-1 mt-[calc(10vh-1rem)] max-w-xl gap-0 self-start overflow-hidden p-0"
          aria-label={t('palette.title')}
          onKeyDown={onPopupKeyDown}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3">
            {submenu ? (
              <button
                type="button"
                className="-ms-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none ring-ring hover:bg-accent hover:text-foreground focus-visible:ring-2"
                onClick={leaveSubmenu}
                aria-label={t('palette.submenu.back')}
                title={t('palette.submenu.back')}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </button>
            ) : <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <input
              // Remounted on entering or leaving a list of accounts, so the field takes the focus back (fieldFor).
              key={submenu ?? 'top'}
              ref={fieldRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t(submenu ? SUBMENU_PLACEHOLDER[submenu] : 'palette.placeholder')}
              aria-label={t('palette.title')}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={current >= 0 ? optionId(current) : undefined}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            {/* In a list of accounts, Esc goes back instead; the footer says so. */}
            {submenu ? null : <Kbd>{t('palette.key.close')}</Kbd>}
          </div>
          <div ref={listRef} id="palette-list" role="listbox" aria-label={t('palette.title')} className="max-h-[min(26rem,60vh)] overflow-y-auto p-1.5">
            {items.length ? items.map((item, index) => {
              const heading = !submenu && (index === 0 || items[index - 1]?.group !== item.group) ? (
                <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground" role="presentation">
                  {t(GROUP_LABEL[item.group])}
                </div>
              ) : null;
              const unavailable = Boolean(item.disabledReason);
              return (
                <div key={item.id} role="presentation">
                  {heading}
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === current}
                    aria-disabled={unavailable || undefined}
                    className={cn(
                      'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground',
                      index === current && 'bg-accent text-accent-foreground',
                      unavailable && 'cursor-default',
                    )}
                    onMouseMove={() => {
                      if (index !== current && !unavailable) setActive(index);
                    }}
                    onClick={() => pick(item)}
                  >
                    <span className={cn('flex min-w-0 flex-1 items-center gap-2.5', unavailable && 'opacity-50')}>
                      {item.icon}
                      <span className="min-w-0 flex-1">{item.content ?? <span className="block truncate">{item.label}</span>}</span>
                    </span>
                    {item.disabledReason || item.detail ? (
                      <span className="shrink-0 truncate text-xs text-muted-foreground">{item.disabledReason ?? item.detail}</span>
                    ) : null}
                    {item.shortcut && !unavailable ? <ShortcutKbd id={item.shortcut} /> : null}
                    {item.submenu && !unavailable ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                  </div>
                </div>
              );
            }) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
            )}
          </div>
          <div className="flex min-h-9 items-center gap-3 border-t border-border/60 px-3 py-2 text-2xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Kbd>{t('palette.key.move')}</Kbd>{t('palette.hint.move')}</span>
            <span className="inline-flex items-center gap-1"><Kbd>{t('palette.key.open')}</Kbd>{t('palette.hint.open')}</span>
            {submenu
              ? <span className="inline-flex items-center gap-1"><Kbd>{t('palette.key.back')}</Kbd>{t('palette.hint.back')}</span>
              : actionsOnly ? null : <span className="inline-flex items-center gap-1"><Kbd>{t('palette.key.actions')}</Kbd>{t('palette.hint.actions')}</span>}
            {searching ? <span className="ms-auto">{t('palette.searching')}</span> : null}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
