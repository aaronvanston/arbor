import { lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertCircle, ArrowUpDown, ArrowUpRight, Check, FolderOpen, GripVertical, History, Import, KeyRound, Layers, MoreHorizontal, PauseCircle, Pencil, Play, Plus, PowerOff, SlidersHorizontal, RotateCcw, TriangleAlert } from '../components/ui/icons';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useConfirmation } from '../components/ConfirmationDialog';
import { QuotaActionFeedback } from '../components/QuotaActionFeedback';
import { ProviderStatusBanner } from '../components/ProviderStatusBanner';
import { canResetQuota, resetClaudeQuotaWithConfirmation, resetCodexQuotaWithConfirmation, resetUnconfirmed } from '../services/quotaActions';
import { formatQuotaReset, useQuotaClock } from '../services/quotaTime';
import { formatRelative, formatWhen } from '../lib/format';
import {
  fileName,
  formatQuotaTimestamp,
  idleQuota,
  providerForFile,
  quotaKey,
  type AuthFile,
  type QuotaProvider,
  type QuotaRow,
  type QuotaState,
} from '../services/quotaService';
import { useQuotaCache } from '../services/quotaCache';
import { accountsGap, ensureAccountsLoaded, refreshAccountQuotas, setAccountsError, useLiveAccounts } from '../services/accountsStore';
import { authFileAvailability, isOAuthCredentialFile, type AuthFileAvailability } from '../services/authFiles';
import { AuthFileFix, AuthFileMenuItems, AuthFileStatus, useAuthFileCommands, type AuthFileCommands } from '../components/AuthFileCommands';
import { resolveAccountProfile, useAccountProfiles, type ResolvedProfile } from '../services/accountProfiles';
import { moveKey, setAccountOrder, sortByOrder, useAccountOrder } from '../services/accountOrder';
import { AccountAvatar } from '../components/AccountAvatar';
import { ProviderMark } from '../components/identity/Identity';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { LimitSparkline } from '../components/LimitSparkline';
import { useLimitsHistory } from '../services/limitsHistory';
import { formatResetCountdown } from '../services/providerLimits';
import { capForRow, capOf, useAccountReserves, useReserveFailures, type AccountCap, type PausedAccount, type ReserveState } from '../services/accountReserves';
import { resumeAccount } from '../services/accountPause';
import { useShortcut } from '../hooks/useShortcuts';
import { WithShortcut } from '../components/ShortcutKbd';
import { ReserveChip } from '../components/ReserveControl';
import { planLabel, planVariant } from '../services/planCosts';
import { AccountProfileDialog, type ProfileTarget } from '../components/AccountProfileDialog';
import { LimitUsageDialog, type LimitUsageTarget } from '../components/LimitUsageDialog';
import { limitScope, type LimitScope } from '../services/limitUsage';
import { evenPace } from '../services/limitPace';
import { normalizeAuthIndex, readBoolean } from '../services/managementApi';
import { clearFocusRequest, useFocusRequest } from '../focusRequests';
import { useI18n } from '../i18n';
import { accountsView, isAccountsTab, sessionsView, type AccountsParams, type AccountsTabId, type AppView } from '../navigation';
import { addAccount } from '../services/addAccount';
import type { ViewChange } from '../services/viewHistory';
import {
  buildHeadline,
  capWarnings,
  displayRows,
  headlinePace,
  isStaleQuota,
  partialHeadline,
  pooledPercent,
  resolveHeadlineWindow,
  rowWindowMs,
  setHeadlineWindow,
  staleLimits,
  staleNoteKey,
  toggleHiddenWindow,
  usagePace,
  windowGrid,
  useAccountLimitPrefs,
  windowDurationMs,
  windowLabels,
  type CapWarning,
  type Headline,
  type PaceTone,
} from '../services/accountLimits';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { AccountSignInsPage } from './AccountSignIns';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { AccountsEmpty } from '../components/AccountsEmpty';
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from '../components/ui/popover';
import { chipVariants } from '../components/ui/chip';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';

/**
 * Value, which was Usage's Capacity: the Usage page's range and capacity report, so it loads with that page's module
 * the first time it's opened.
 */
const UsageRecordsPage = lazy(() => import('./UsageRecordsPage').then((module) => ({ default: module.UsageRecordsPage })));

/** The view Accounts was last left on, for opening it without naming one. */
const VIEW_KEY = 'arbor.accounts.view.v1';
function savedView(): AccountsTabId {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return isAccountsTab(saved) ? saved : 'limits';
  } catch {
    return 'limits';
  }
}

/**
 * Accounts: each account's limits, or what each subscription is worth at API prices against what it costs. A view
 * that doesn't name one opens the one last open, which is written into the view so Back returns to it.
 */
export function AccountsPage({ params, onNavigate, onViewChange }: {
  params?: AccountsParams;
  onNavigate?: (view: AppView) => void;
  onViewChange?: (view: AppView, how?: ViewChange) => void;
}) {
  const tab = isAccountsTab(params?.tab) ? params.tab : savedView();
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    if (params?.tab !== tab) onViewChangeRef.current?.(accountsView({ tab }));
    try {
      localStorage.setItem(VIEW_KEY, tab);
    } catch {
      // Remembered where storage allows.
    }
  }, [params?.tab, tab]);
  if (tab === 'value') return <UsageRecordsPage key="value" variant="value" onNavigate={onNavigate} />;
  if (tab === 'sign-ins') return <AccountSignInsPage onNavigate={onNavigate} />;
  return <AccountLimitsPage onNavigate={onNavigate} />;
}

const providerMeta: Record<QuotaProvider, { label: string }> = {
  claude: { label: 'Claude' },
  codex: { label: 'Codex' },
  kimi: { label: 'Kimi' },
  xai: { label: 'xAI' },
  antigravity: { label: 'Antigravity' },
};
const providerOrder: QuotaProvider[] = ['claude', 'codex', 'antigravity', 'xai', 'kimi'];
/** Rows only move up and down within their provider list. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

type Account = { file: AuthFile; quota: QuotaState; key: string; fileName: string; name: string; profile: ResolvedProfile };
type Paused = { file: AuthFile; quota: QuotaState; key: string; name: string; profile: ResolvedProfile; paused: PausedAccount };
/** An account turned off by hand. */
type Off = Omit<Paused, 'paused'>;
const percentTone = (percent: number | null) =>
  percent === null ? 'bg-muted-foreground/30' : percent <= 10 ? 'bg-error' : percent <= 30 ? 'bg-warning' : 'bg-success';
const percentText = (percent: number | null) =>
  percent === null ? 'text-muted-foreground' : percent <= 10 ? 'text-error-foreground' : percent <= 30 ? 'text-warning-foreground' : 'text-foreground';
const paceBar: Record<PaceTone, string> = { success: 'bg-success', warning: 'bg-warning', error: 'bg-error', muted: 'bg-muted-foreground/30' };
/** An account without a reading: hatched, so it reads as unknown rather than used. */
const unknownBar = 'bg-[repeating-linear-gradient(-45deg,var(--color-muted-foreground)_0_1px,transparent_1px_5px)] opacity-45';
/** A turned-off account's share: gray and densely hatched, so it reads as there but out of use. */
const offBar = 'bg-muted-foreground/30 bg-[repeating-linear-gradient(-45deg,var(--color-muted-foreground)_0_1.5px,transparent_1.5px_4px)] opacity-70';
/** Row actions stay hidden until the row is hovered or one of them has focus. */
const hoverReveal = 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';
const paceText: Record<PaceTone, string> = { success: 'text-foreground', warning: 'text-warning-foreground', error: 'text-error-foreground', muted: 'text-muted-foreground' };

function AccountLimitsPage({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const { files, disabled, listing, listedAt, loading, loaded, refreshing, error } = useLiveAccounts();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const order = useAccountOrder();
  const reserves = useAccountReserves();
  const reserveFailures = useReserveFailures();
  const { hidden: hiddenWindows, headline: headlineWindows } = useAccountLimitPrefs();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null);
  const [limitTarget, setLimitTarget] = useState<LimitUsageTarget | null>(null);
  const [reordering, setReordering] = useState<QuotaProvider | null>(null);
  const querying = Object.values(quotas).some((quota) => quota.status === 'loading');
  const setError = setAccountsError;
  // Turning accounts on and off, their priorities and models, signing in again, deleting and importing: what Settings'
  // Auth Files page did, now beside each account.
  const commands = useAuthFileCommands(listing);
  // Each credential's state as of the listing, which says when it was built.
  const availabilityOf = useCallback(
    (file: AuthFile) => authFileAvailability(file, listedAt.receivedAtMs, listedAt.observedAt),
    [listedAt],
  );

  const refreshFiles = refreshAccountQuotas;

  const resetCodexQuota = useCallback(async (file: AuthFile, quota: QuotaState) => {
    setError('');
    try {
      await resetCodexQuotaWithConfirmation(file, () => askConfirmation({
        title: t('quota.reset'),
        message: t('quota.confirm.title', { name: fileName(file) }),
        confirmText: t('quota.confirm.button'),
        details: [
          { label: t('quota.resetCredits'), value: String(quota.resetCredits ?? '—') },
          { label: t('quota.confirm.applicableLabel'), value: String(quota.resetCreditsApplicable ?? '—') },
          { label: t('quota.earliestExpiry'), value: formatQuotaTimestamp(quota.resetCreditsEarliestExpiry) },
        ],
        warning: t('quota.confirm.warning'),
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [askConfirmation, setError, t]);

  const resetClaudeQuota = useCallback(async (file: AuthFile, quota: QuotaState) => {
    setError('');
    const reset = quota.bankedReset;
    const early = reset?.earlyUse;
    try {
      await resetClaudeQuotaWithConfirmation(file, () => askConfirmation({
        title: t('quota.reset'),
        message: reset?.refills
          ? t('quota.bankedReset.confirm.messageRefills', { limits: reset.refills, name: fileName(file) })
          : t('quota.bankedReset.confirm.message', { name: fileName(file) }),
        confirmText: t('quota.confirm.button'),
        details: [
          { label: t('quota.bankedResets'), value: String(quota.resetCredits ?? '—') },
          { label: t('quota.useBy'), value: formatQuotaTimestamp(quota.resetCreditsEarliestExpiry) },
          ...(reset?.weeklyResetsAt
            ? [{ label: t('quota.bankedReset.confirm.weekly'), value: formatQuotaTimestamp(reset.weeklyResetsAt) }]
            : []),
        ],
        warning: [
          !early ? null : early.limit && early.percentLeft !== undefined
            ? t('quota.bankedReset.confirm.early', { limit: early.limit, percent: early.percentLeft })
            : t('quota.bankedReset.confirm.earlyNoNumber'),
          t('quota.bankedReset.confirm.warning'),
        ].filter(Boolean).join(' '),
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [askConfirmation, setError, t]);

  const grouped = useMemo(() => {
    const groups = new Map<QuotaProvider, Account[]>();
    files.forEach((file) => {
      const provider = providerForFile(file);
      if (!provider) return;
      const key = quotaKey(file);
      const rawName = fileName(file);
      const profile = resolveAccountProfile(key, rawName, profiles[key]);
      const items = groups.get(provider) ?? [];
      items.push({ file, quota: quotas[key] ?? idleQuota(), key, fileName: rawName, name: profile.name, profile });
      groups.set(provider, items);
    });
    // Accounts that are off: those Arbor paused at their cap, which come back by themselves, and those turned off by hand.
    const pausedGroups = new Map<QuotaProvider, Paused[]>();
    const offGroups = new Map<QuotaProvider, Off[]>();
    disabled.forEach((file) => {
      const key = quotaKey(file);
      const paused = reserves.paused[key];
      const provider = providerForFile(file);
      if (!provider) return;
      const profile = resolveAccountProfile(key, fileName(file), profiles[key]);
      const quota = quotas[key] ?? idleQuota();
      if (paused) pausedGroups.set(provider, [...(pausedGroups.get(provider) ?? []), { file, quota, key, name: profile.name, profile, paused }]);
      else offGroups.set(provider, [...(offGroups.get(provider) ?? []), { file, quota, key, name: profile.name, profile }]);
    });
    return providerOrder.flatMap((provider) => {
      const listed = groups.get(provider) ?? [];
      const paused = sortByOrder(pausedGroups.get(provider) ?? [], order[provider], (item) => item.key);
      const off = sortByOrder(offGroups.get(provider) ?? [], order[provider], (item) => item.key);
      if (!listed.length && !paused.length && !off.length) return [];
      const items = sortByOrder(listed, order[provider], (account) => account.key);
      // Turned-off accounts keep their windows' columns, and count toward the headline grayed out.
      const turnedOff = [...paused, ...off];
      const labels = windowLabels([...items, ...turnedOff]);
      const hidden = hiddenWindows[provider] ?? [];
      const headlineLabel = resolveHeadlineWindow(provider, labels.filter((label) => !hidden.includes(label)), headlineWindows[provider]);
      return [{
        provider,
        accounts: items,
        paused,
        off,
        labels,
        hidden,
        headline: buildHeadline(items, headlineLabel, turnedOff),
        warnings: capWarnings(items, headlineLabel, hidden),
      }];
    });
  }, [files, disabled, quotas, profiles, order, hiddenWindows, headlineWindows, reserves.paused]);

  // An account chosen in the search palette is scrolled to and marked for a moment.
  const focus = useFocusRequest('account');
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !loaded) return;
    clearFocusRequest('account');
    setFlash(focus);
    // After this render lays the row out.
    window.setTimeout(() => {
      document.querySelector(`[data-account-key="${window.CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
  }, [focus, loaded]);
  useEffect(() => {
    if (!flash) return;
    // As long as the row-highlight animation in styles.css.
    const timer = window.setTimeout(() => setFlash(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const jumpTo = useCallback((key: string) => {
    setFlash(key);
    document.querySelector(`[data-account-key="${window.CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const reorder = useCallback((provider: QuotaProvider, keys: string[], event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setAccountOrder(provider, moveKey(keys, String(active.id), String(over.id)));
  }, []);

  // Turned-off accounts too, whose limits show grayed out.
  const refreshAll = () => void refreshFiles([...files, ...disabled]);
  const refreshDisabled = loading || refreshing || querying || files.length + disabled.length === 0;
  useShortcut('page.refresh', () => {
    if (!refreshDisabled) refreshAll();
  });

  const gap = accountsGap({ loaded, error, files, disabled });

  return (
    <Page width="main">
      <PageTopbar
        actions={
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshDisabled} focusableWhenDisabled />}>
                <RefreshIcon refreshing={refreshing || querying} />
                {refreshing || querying ? t('accounts.refreshing') : t('accounts.refreshAll')}
              </TooltipTrigger>
              <TooltipPopup><WithShortcut id="page.refresh">{t('accounts.refreshAll')}</WithShortcut></TooltipPopup>
            </Tooltip>
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="icon-sm" aria-label={t('accounts.moreActions')} />}>
                <MoreHorizontal />
              </MenuTrigger>
              <MenuPopup className="min-w-56">
                <MenuItem disabled={!commands.hasModelsProviders} onClick={commands.providerModels}>
                  <Layers />
                  {t('authFiles.models.globalButton')}
                </MenuItem>
                <MenuItem disabled={commands.busy} onClick={() => void commands.openFolder()}>
                  <FolderOpen />
                  {t('authFiles.openDirectory')}
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Button variant="outline" size="sm" onClick={commands.importFiles} disabled={commands.busy}>
              <Import />
              {t('authFiles.import')}
            </Button>
            {onNavigate ? (
              <Button size="sm" onClick={() => addAccount(onNavigate)}>
                <Plus />
                {t('accounts.add')}
              </Button>
            ) : null}
          </div>
        }
      >
        <PageBreadcrumb segments={[t('accounts.title'), t('tree.accounts.limits')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {commands.dialogs}
        <AccountProfileDialog target={profileTarget} onClose={() => setProfileTarget(null)} />
        <LimitUsageDialog
          target={limitTarget}
          onClose={() => setLimitTarget(null)}
          onOpenSession={onNavigate ? (id) => onNavigate(sessionsView({ session: id })) : undefined}
        />
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        <ProviderStatusBanner />
        {gap === 'loading' ? (
          <SettingsSection title={t('accounts.title')} description={t('accounts.description')}>
            {Array.from({ length: 3 }, (_, index) => (
              <SettingsBlock key={index} className="flex items-center gap-3" aria-hidden="true">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-44" />
                  <Skeleton className="h-3 w-64" />
                </div>
              </SettingsBlock>
            ))}
          </SettingsSection>
        ) : grouped.length === 0 && gap ? (
          <SettingsSection title={t('accounts.title')}>
            {/* The list's own error is in the alert above. Accounts Arbor paused at a cap are listed, so only accounts
                turned off by hand leave it empty while there are some. */}
            <AccountsEmpty
              gap={gap}
              icon={<KeyRound />}
              description={t('accounts.empty.description')}
              retrying={loading}
              onRetry={() => void ensureAccountsLoaded()}
              onNavigate={onNavigate}
              onImport={commands.importFiles}
            />
          </SettingsSection>
        ) : (
          <>
            {grouped.map(({ provider, accounts, paused, off, labels, hidden, headline, warnings }) => (
              <SettingsSection
                key={provider}
                title={
                  <span className="inline-flex items-center gap-2" title={t('accounts.description')}>
                    <ProviderMark provider={provider} decorative className="size-4" />
                    {providerMeta[provider].label}
                  </span>
                }
                headerAction={
                  <div className="flex items-center gap-2">
                    {accounts.length ? (
                      <Badge variant="muted">{t(accounts.length === 1 ? 'accounts.accountsCount.one' : 'accounts.accountsCount.other', { count: accounts.length })}</Badge>
                    ) : null}
                    {paused.length ? (
                      <Badge variant="warning">{t(paused.length === 1 ? 'accounts.pausedCount.one' : 'accounts.pausedCount.other', { count: paused.length })}</Badge>
                    ) : null}
                    {accounts.length > 1 ? (
                      <Button
                        variant={reordering === provider ? 'default' : 'ghost-muted'}
                        size="sm"
                        aria-pressed={reordering === provider}
                        onClick={() => setReordering((current) => (current === provider ? null : provider))}
                      >
                        {reordering === provider ? <Check /> : <ArrowUpDown />}
                        {reordering === provider ? t('accounts.reorder.done') : t('accounts.reorder.button')}
                      </Button>
                    ) : null}
                    {labels.length > 0 && reordering !== provider ? (
                      <Menu>
                        <MenuTrigger render={<Button variant="ghost-muted" size="sm" aria-label={t('accounts.windows.aria', { provider: providerMeta[provider].label })} />}>
                          <SlidersHorizontal />
                          {t('accounts.windows.button')}
                        </MenuTrigger>
                        <MenuPopup className="min-w-64">
                          <MenuRadioGroup value={headline.label} onValueChange={(label: string) => setHeadlineWindow(provider, label)}>
                            <MenuGroupLabel>{t('accounts.windows.headline')}</MenuGroupLabel>
                            {labels.filter((label) => !hidden.includes(label)).map((label) => (
                              <MenuRadioItem key={label} value={label}>
                                <span className="min-w-0 flex-1 truncate">{label}</span>
                                <span className="text-xs tabular-nums text-muted-foreground">{formatPooled(pooledPercent([...accounts, ...paused, ...off], label))}</span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                          <MenuSeparator />
                          <MenuGroup>
                            <MenuGroupLabel>{t('accounts.windows.visible')}</MenuGroupLabel>
                            {labels.map((label) => {
                              const visible = !hidden.includes(label);
                              return (
                                <MenuCheckboxItem
                                  key={label}
                                  checked={visible}
                                  disabled={visible && headline.label === label}
                                  onCheckedChange={() => toggleHiddenWindow(provider, label)}
                                >
                                  <span className={cn('min-w-0 flex-1 truncate', !visible && 'text-muted-foreground')}>{label}</span>
                                </MenuCheckboxItem>
                              );
                            })}
                          </MenuGroup>
                        </MenuPopup>
                      </Menu>
                    ) : null}
                  </div>
                }
              >
                {accounts.length || headline.off ? (
                  <HeadlineBlock
                    provider={provider}
                    headline={headline}
                    warnings={warnings}
                    count={accounts.length + headline.off}
                    loading={accounts.some((account) => account.quota.status === 'loading')}
                    onJump={jumpTo}
                  />
                ) : null}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  modifiers={[verticalOnly]}
                  onDragEnd={(event) => reorder(provider, accounts.map((account) => account.key), event)}
                >
                  <SortableContext items={accounts.map((account) => account.key)} strategy={verticalListSortingStrategy}>
                    {accounts.map((account) => (
                      <AccountRow
                        key={account.key}
                        account={account}
                        columns={labels.filter((label) => !hidden.includes(label))}
                        warnings={warnings.filter((warning) => warning.account === account)}
                        headline={headline.label}
                        flash={flash === account.key}
                        cap={isOAuthCredentialFile(account.file) ? capOf(reserves, account.key) : undefined}
                        availability={availabilityOf(account.file)}
                        commands={commands}
                        reordering={reordering === provider}
                        onRefresh={() => void refreshFiles([account.file])}
                        onEdit={() => setProfileTarget({ key: account.key, fileName: account.fileName, profile: profiles[account.key] })}
                        onExplain={(row, scope) => setLimitTarget({
                          account: account.key,
                          authIndex: normalizeAuthIndex(account.file.auth_index ?? account.file.authIndex),
                          accountName: account.name,
                          profile: account.profile,
                          row,
                          scope,
                        })}
                        onReset={provider === 'codex'
                          ? () => void resetCodexQuota(account.file, account.quota)
                          : provider === 'claude' ? () => void resetClaudeQuota(account.file, account.quota) : undefined}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
                {paused.length && reordering !== provider ? (
                  <PausedBlock items={paused} columns={labels.filter((label) => !hidden.includes(label))} reserves={reserves} failures={reserveFailures} flash={flash} />
                ) : null}
                {off.length && reordering !== provider ? (
                  <OffBlock items={off} columns={labels.filter((label) => !hidden.includes(label))} availabilityOf={availabilityOf} commands={commands} flash={flash} />
                ) : null}
              </SettingsSection>
            ))}
          </>
        )}
      </PageBody>
    </Page>
  );
}

const formatPooled = (percent: number | null) => (percent === null ? '—' : `${Math.round(percent)}%`);

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);

/** Accounts Arbor turned off at their cap, when each comes back, a way to bring one back now, and their limits grayed out. */
function PausedBlock({ items, columns, reserves, failures, flash }: {
  items: Paused[];
  /** The provider's windows being shown, so the grayed-out limits line up with the accounts in use. */
  columns: string[];
  reserves: ReserveState;
  failures: Record<string, string>;
  flash: string | null;
}) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const [busy, setBusy] = useState<string | null>(null);
  const resume = async (item: Paused) => {
    setBusy(item.key);
    setAccountsError('');
    try {
      await resumeAccount(item.key, item.file);
    } catch (resumeError) {
      setAccountsError(t('reserves.paused.resumeFailed', { name: item.name, error: resumeError instanceof Error ? resumeError.message : String(resumeError) }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsBlock className="flex flex-col gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <PauseCircle className="size-3.5 text-warning-foreground" aria-hidden="true" />
          {t('reserves.paused.title')}
        </span>
        <span className="text-xs text-muted-foreground">{t('reserves.paused.description')}</span>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const window = lowerFirst(item.paused.window);
          const time = formatResetCountdown(item.paused.resumeAtMs, now);
          const failure = failures[item.key];
          return (
            <li key={item.key} className={cn('-mx-2 flex flex-col gap-2 rounded-md px-2 py-0.5', flash === item.key && 'row-highlight')} data-account-key={item.key}>
              <div className="flex items-center gap-3">
                <AccountAvatar profile={item.profile} size="sm" />
                <span className="min-w-0 flex-1 text-xs">
                  <span className="block truncate">
                    <strong className={cn('text-sm font-medium text-foreground', !item.profile.custom && 'font-mono')} title={fileName(item.file)}>{item.name}</strong>
                    <span className="text-muted-foreground">
                      {` · ${t('reserves.paused.used', { percent: item.paused.percentUsed, window })} · `}
                      {time ? t('reserves.paused.back', { time }) : t('reserves.paused.backSoon')}
                    </span>
                  </span>
                  {failure ? <span className="block truncate text-warning-foreground" title={failure}>{t('reserves.failed', { error: failure })}</span> : null}
                </span>
                <OffDetails file={item.file} quota={item.quota} now={now} />
                <ReserveChip accountKey={item.key} name={item.name} provider={item.paused.provider} paused={item.paused} always />
                <Button variant="outline" size="xs" disabled={busy !== null} focusableWhenDisabled onClick={() => void resume(item)} title={t('reserves.paused.resumeHint', { window })}>
                  {busy === item.key ? <Spinner className="size-3" /> : <Play />}
                  {t('reserves.paused.resume')}
                </Button>
              </div>
              <OffWindows quota={item.quota} columns={columns} cap={capOf(reserves, item.key)} now={now} />
            </li>
          );
        })}
      </ul>
    </SettingsBlock>
  );
}

/** Accounts turned off by hand: Enable up front, and the rest of what each takes in its ⋯ menu. */
function OffBlock({ items, columns, availabilityOf, commands, flash }: {
  items: Off[];
  /** The provider's windows being shown, so the grayed-out limits line up with the accounts in use. */
  columns: string[];
  availabilityOf: (file: AuthFile) => AuthFileAvailability;
  commands: AuthFileCommands;
  flash: string | null;
}) {
  const { t } = useI18n();
  const now = useQuotaClock();
  return (
    <SettingsBlock className="flex flex-col gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          <PowerOff className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {t('accounts.turnedOff.title')}
        </span>
        <span className="text-xs text-muted-foreground">{t('accounts.turnedOff.description')}</span>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const availability = availabilityOf(item.file);
          return (
            <li key={item.key} className={cn('-mx-2 flex flex-col gap-2 rounded-md px-2 py-0.5', flash === item.key && 'row-highlight')} data-account-key={item.key}>
              <div className="flex items-center gap-3">
                <AccountAvatar profile={item.profile} size="sm" />
                <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                  <strong className={cn('min-w-0 shrink truncate text-sm font-medium text-foreground', !item.profile.custom && 'font-mono')} title={fileName(item.file)}>{item.name}</strong>
                  <OffDetails file={item.file} quota={item.quota} now={now} />
                </span>
                <AuthFileFix file={item.file} availability={availability} commands={commands} />
                <Menu>
                  <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={t('accounts.actions', { name: item.name })} />}>
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuPopup className="w-64">
                    <AuthFileMenuItems file={item.file} availability={availability} commands={commands} />
                  </MenuPopup>
                </Menu>
              </div>
              <OffWindows quota={item.quota} columns={columns} cap={null} now={now} />
            </li>
          );
        })}
      </ul>
    </SettingsBlock>
  );
}

/**
 * What a turned-off account still has, the same as an account in use shows beside its name: its plan, its banked or
 * manual resets, and a refresh, since its limits keep running down and resetting while it's off.
 */
function OffDetails({ file, quota, now }: { file: AuthFile; quota: QuotaState; now: number }) {
  const { t } = useI18n();
  const loading = quota.status === 'loading';
  const readAtMs = quota.fetchedAt ?? quota.staleSinceMs;
  const checkedAt = readAtMs ? formatWhen(readAtMs, { now }) : '';
  return (
    <>
      {quota.plan ? <Badge variant={planVariant(quota.plan)}>{planLabel(quota.plan)}</Badge> : null}
      {/* No Reset here: the core won't spend a reset on a turned-off account, so the chip says to turn it on first. */}
      <ResetCreditsChip quota={quota} claude={providerForFile(file) === 'claude'} note={t('accounts.resets.turnOnFirst')} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              onClick={() => void refreshAccountQuotas([file])}
              disabled={loading}
              focusableWhenDisabled
              aria-label={t('quota.refresh')}
            />
          }
        >
          <RefreshIcon refreshing={loading} />
        </TooltipTrigger>
        <TooltipPopup>{quota.status === 'success' && checkedAt ? t('accounts.refresh.checked', { time: checkedAt }) : t('quota.refresh')}</TooltipPopup>
      </Tooltip>
    </>
  );
}

/**
 * Limits that will block requests before the headline one, as a chip in the headline row rather than a block that
 * pushes the accounts down. Its popover lists them; picking one goes to that account.
 */
function CapWarningsChip({ warnings, onJump }: { warnings: CapWarning[]; onJump: (key: string) => void }) {
  const { t } = useI18n();
  const now = useQuotaClock();
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} render={<button type="button" className={chipVariants({ tone: 'warning' })} />}>
        <TriangleAlert />
        {t(warnings.length === 1 ? 'accounts.capWarnings.chip.one' : 'accounts.capWarnings.chip.other', { count: warnings.length })}
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" align="start">
        <PopoverTitle className="px-1.5 pt-1 text-xs font-medium text-muted-foreground">{t('accounts.capWarnings.title')}</PopoverTitle>
        <ul className="mt-1.5 flex flex-col">
          {warnings.map((warning) => {
            const account = warning.account as Account;
            const { quota } = account;
            const readAtMs = isStaleQuota(quota) ? quota.fetchedAt ?? quota.staleSinceMs : undefined;
            const values = {
              name: account.name,
              window: warning.row.label,
              percent: Math.round(warning.row.remainingPercent ?? 0),
              headline: warning.headline,
            };
            return (
              <li key={`${account.key}-${warning.row.label}`}>
                <PopoverClose
                  render={
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                      onClick={() => onJump(account.key)}
                      title={readAtMs !== undefined && quota.error ? t('accounts.stale.failed', { error: quota.error }) : undefined}
                    />
                  }
                >
                  {readAtMs !== undefined
                    ? <History className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden="true" />
                    : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden="true" />}
                  <span className="min-w-0">
                    {readAtMs !== undefined
                      ? t('accounts.capWarningStale', { ...values, time: formatWhen(readAtMs, { now }) })
                      : t('accounts.capWarning', values)}
                  </span>
                </PopoverClose>
              </li>
            );
          })}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

function HeadlineBlock({ provider, headline, warnings, count, loading, onJump }: {
  provider: QuotaProvider;
  headline: Headline;
  warnings: CapWarning[];
  count: number;
  loading: boolean;
  onJump: (key: string) => void;
}) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const history = useLimitsHistory();
  const reset = formatQuotaReset(headline.nextResetMs, headline.nextResetFallback, now);
  const countdown = formatResetCountdown(headline.nextResetMs, now);
  const animatedPercent = useAnimatedNumber(headline.percent);
  const percent = animatedPercent === null ? null : Math.round(animatedPercent);
  const pace = headlinePace(headline, now);
  const duration = headline.label ? windowDurationMs(headline.label) : null;
  const stale = staleLimits(headline);
  const paceLabel = t(pace.tone === 'error' ? 'accounts.pace.critical' : pace.tone === 'warning' ? 'accounts.pace.ahead' : pace.tone === 'success' ? 'accounts.pace.onTrack' : 'accounts.pace.unknown');
  const ariaLabel = headline.segments
    .map((segment) => (segment.percent === null
      ? t('accounts.segment.unknown', { name: segment.account.name })
      : t('accounts.segment.aria', { name: segment.account.name, percent: Math.round(segment.percent) })))
    .join(', ');
  // Accounts without a reading keep their slice, gathered at the far end so the empty track between reads as used.
  // Turned-off accounts come after the ones in use, grayed out.
  const slice = headline.total ? 100 / headline.total : 0;
  const bar = [
    ...headline.segments.filter((segment) => segment.percent !== null && !segment.off),
    ...headline.segments.filter((segment) => segment.off),
    ...headline.segments.filter((segment) => segment.percent === null),
  ];
  if (!headline.label) {
    return (
      <SettingsBlock className="text-sm text-muted-foreground">
        {loading ? <span className="inline-flex items-center gap-2"><Spinner className="size-3.5" />{t('quota.querying')}</span> : t('accounts.headline.none')}
      </SettingsBlock>
    );
  }
  const pooled = t(count === 1 ? 'accounts.headline.pooled.one' : 'accounts.headline.pooled.other', { count });
  return (
    <SettingsBlock className="flex flex-col gap-2.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex items-baseline gap-1.5">
            <span className={cn('text-2xl font-semibold leading-none tabular-nums tracking-tight', paceText[pace.tone], stale && 'opacity-60')}>
              {percent === null ? '—' : `${percent}%`}
            </span>
            <span className="text-sm text-muted-foreground">{t('accounts.left')}</span>
          </span>
          {partialHeadline(headline) ? (
            <span className="whitespace-nowrap text-xs text-muted-foreground" title={t('accounts.headline.reportingHint')}>
              {t('accounts.headline.reporting', { reporting: headline.reporting, total: headline.total })}
            </span>
          ) : null}
          {headline.off ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title={t('accounts.headline.offHint')}>
              <PowerOff className="size-3.5" aria-hidden="true" />
              {t(headline.off === 1 ? 'accounts.headline.off.one' : 'accounts.headline.off.other', { count: headline.off })}
            </span>
          ) : null}
          {pace.tone === 'warning' || pace.tone === 'error' ? (
            <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs', paceText[pace.tone])}>
              <TriangleAlert className="size-3.5" aria-hidden="true" />
              {paceLabel}
            </span>
          ) : null}
          {stale ? (
            <span
              className="inline-flex max-w-full items-center gap-1 whitespace-nowrap text-xs text-warning-foreground"
              title={stale.error ? t('accounts.stale.failed', { error: stale.error }) : undefined}
            >
              <History className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t(staleNoteKey(stale), { count: stale.accounts, time: formatWhen(stale.asOfMs, { now }) })}</span>
            </span>
          ) : null}
          {warnings.length ? <CapWarningsChip warnings={warnings} onJump={onJump} /> : null}
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <LimitSparkline samples={history[provider] ?? []} now={now} tone={pace.tone} />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 cursor-default truncate text-xs" />}>
              <span className="font-medium text-foreground">{headline.label}</span>
              {countdown ? <span className="ms-1.5 tabular-nums text-muted-foreground">{t('accounts.resetsIn', { time: countdown })}</span> : null}
            </TooltipTrigger>
            <TooltipPopup>{reset ? `${pooled} · ${t('accounts.nextReset', { time: reset })}` : pooled}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-input/60 dark:bg-input" role="img" aria-label={ariaLabel}>
        {bar.map((segment, index) => {
          const segmentReset = segment.row ? formatQuotaReset(segment.row.resetAtMs, segment.row.reset, now) : '';
          const segmentPace = usagePace(segment.percent, segment.row?.resetAtMs, segment.row ? rowWindowMs(segment.row) : duration, now);
          const account = segment.account as Account;
          const segmentStale = isStaleQuota(account.quota);
          const unknown = segment.percent === null;
          return (
            <Tooltip key={account.key ?? account.name}>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      'block h-full shrink-0 cursor-default transition-[width,filter,opacity] duration-500 ease-out first:rounded-l-full last:rounded-r-full hover:brightness-110',
                      unknown ? unknownBar : segment.off ? offBar : paceBar[segmentPace.tone],
                      unknown && bar[index - 1]?.percent !== null && 'ms-auto',
                      !unknown && segmentStale && 'opacity-45',
                      !unknown && segment.width <= 0 && 'invisible',
                    )}
                    style={{ width: `${unknown ? slice : segment.width}%` }}
                  />
                }
              />
              <TooltipPopup>
                <span className="flex items-start gap-2">
                  {account.profile ? <AccountAvatar profile={account.profile} size="sm" /> : null}
                  {unknown ? (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{t('accounts.segment.unknown', { name: account.name })}</span>
                      <span className="text-muted-foreground">{t('accounts.segment.notCounted')}</span>
                    </span>
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{t('accounts.segment.aria', { name: account.name, percent: Math.round(segment.percent ?? 0) })}</span>
                      {segmentReset ? <span className="text-muted-foreground">{t('accounts.nextReset', { time: segmentReset })}</span> : null}
                      {segment.off ? (
                        <span className="text-muted-foreground">{t('paused' in account ? 'accounts.segment.paused' : 'accounts.segment.off')}</span>
                      ) : (
                        <span className={cn(paceText[segmentPace.tone])}>
                          {t(segmentPace.tone === 'error' ? 'accounts.pace.critical' : segmentPace.tone === 'warning' ? 'accounts.pace.ahead' : segmentPace.tone === 'success' ? 'accounts.pace.onTrack' : 'accounts.pace.unknown')}
                        </span>
                      )}
                      {segmentStale && account.quota.fetchedAt ? (
                        <span className="max-w-64 text-warning-foreground">
                          {t('accounts.stale.asOf', { time: formatWhen(account.quota.fetchedAt, { now }) })}
                          {account.quota.error ? ` · ${t('accounts.stale.failed', { error: account.quota.error })}` : ''}
                        </span>
                      ) : null}
                    </span>
                  )}
                </span>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </SettingsBlock>
  );
}

/**
 * An account's banked resets (Claude) or manual resets (Codex) as a counter beside its name. Hovering or focusing it
 * opens the details, with Reset Quota; the counter takes the accent while a reset can be used now.
 */
function ResetCreditsChip({ quota, claude, blocked, onReset, note }: {
  quota: QuotaState;
  claude: boolean;
  /** Why a reset can't be used now, if it can't. */
  blocked?: string;
  onReset?: () => void;
  /** Shown under the details while there are resets to use, for an account that can't use them from here. */
  note?: string;
}) {
  const { t } = useI18n();
  const count = quota.resetCredits;
  const error = quota.resetCreditsError;
  if (count === undefined && !error) return null;
  const title = count === undefined
    ? t(claude ? 'accounts.resets.banked.title' : 'accounts.resets.manual.title')
    : t(claude
      ? count === 1 ? 'accounts.resets.banked.one' : 'accounts.resets.banked.other'
      : count === 1 ? 'accounts.resets.manual.one' : 'accounts.resets.manual.other', { count });
  const usable = Boolean(onReset) && (count ?? 0) > 0 && !blocked;
  const facts: Array<[string, string]> = [];
  if (quota.resetCreditsEarliestExpiry) facts.push([t(claude ? 'quota.useBy' : 'quota.earliestExpiry'), formatQuotaTimestamp(quota.resetCreditsEarliestExpiry)]);
  if (quota.resetCreditsApplicable !== undefined) facts.push([t('accounts.resets.applicable'), String(quota.resetCreditsApplicable)]);
  if (quota.bankedReset?.refills) facts.push([t('accounts.resets.refills'), quota.bankedReset.refills]);
  if (quota.subscriptionActiveUntil) facts.push([t('accounts.resets.subscription'), formatQuotaTimestamp(quota.subscriptionActiveUntil)]);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            className={chipVariants({ tone: count === undefined ? 'warning' : usable ? 'primary' : count === 0 ? 'quiet' : 'default' })}
            aria-label={title}
          />
        }
      >
        {count === undefined ? <TriangleAlert /> : <RotateCcw />}
        {count ?? '?'}
      </PopoverTrigger>
      <PopoverPopup width="sm" padding="compact" align="start">
        <PopoverTitle className="text-sm font-medium">{title}</PopoverTitle>
        {facts.length ? (
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 text-foreground tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {quota.bankedReset?.blockedReason ? <p className="mt-2 text-xs text-muted-foreground">{quota.bankedReset.blockedReason}</p> : null}
        {note && (count ?? 0) > 0 ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
        {error ? <p className="mt-2 text-xs text-warning-foreground">{t(claude ? 'quota.bankedResetsWarning' : 'quota.resetCreditsWarning', { error })}</p> : null}
        {onReset && (count ?? 0) > 0 ? (
          <div className="mt-3 flex items-center justify-end gap-2">
            {blocked && blocked !== quota.bankedReset?.blockedReason ? <span className="min-w-0 flex-1 text-xs text-muted-foreground">{blocked}</span> : null}
            <PopoverClose render={<Button variant={usable ? 'default' : 'outline'} size="xs" disabled={!usable} onClick={onReset} />}>
              <RotateCcw />
              {t('quota.reset')}
            </PopoverClose>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function AccountRow({ account, columns, warnings, headline, flash = false, cap, availability, commands, reordering, onRefresh, onEdit, onReset, onExplain }: {
  account: Account;
  /** The provider's windows being shown, in order: each window keeps its column, so the accounts line up. */
  columns: string[];
  /** This account's limits that will block requests before the headline one. */
  warnings: CapWarning[];
  /** Marks the row for a moment after the search palette jumped to it. */
  flash?: boolean;
  headline: string | null;
  /** How much of each limit the proxy may use, null without a cap, or undefined when the account can't be paused. */
  cap?: AccountCap | null;
  /** How the core has the credential now: signed in and ready, resting, or needing a new sign-in. */
  availability: AuthFileAvailability;
  commands: AuthFileCommands;
  reordering: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onReset?: () => void;
  onExplain?: (row: QuotaRow, scope: LimitScope) => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.key, disabled: !reordering });
  const now = useQuotaClock() + (account.quota.serverTimeOffsetMs ?? 0);
  const { quota, name, profile } = account;
  const visibleRows = displayRows(quota);
  const rows = visibleRows.filter((row) => columns.includes(row.label));
  // Said in words only for the headline window; the other bars show it with their tick.
  const headlineRow = headline ? visibleRows.find((row) => row.label === headline) : undefined;
  const headlineEven = headlineRow ? evenPace(headlineRow.remainingPercent, headlineRow.resetAtMs, headlineRow.windowMs, now) : null;
  const refreshingWithData = quota.status === 'loading' && visibleRows.length > 0;
  const loading = quota.status === 'loading';
  const stale = isStaleQuota(quota);
  const readAtMs = quota.fetchedAt ?? quota.staleSinceMs;
  const checkedAt = readAtMs ? formatWhen(readAtMs, { now }) : '';
  const claude = providerForFile(account.file) === 'claude';
  const resetOffered = Boolean(onReset) && (quota.resetCredits ?? 0) > 0;
  // The first thing standing in the way of a reset, shown on the disabled button.
  const resetBlocked = canResetQuota(account.file, quota)
    ? undefined
    : loading
      ? t('quota.resetWait')
      : readBoolean(account.file, 'disabled')
        ? t('quota.fileDisabled')
        : quota.resetCreditsApplicable === 0
          ? t('quota.resetNotApplicable')
          : resetUnconfirmed(quota)
            ? t('quota.resetCheckFirst')
            : quota.bankedReset?.blockedReason ?? t('quota.resetRefreshFirst');
  // A fresh reading says nothing here: when it was taken is in the refresh button's tooltip.
  const status = quota.status === 'error'
    ? stale && checkedAt ? t('accounts.status.stale', { time: checkedAt }) : t('accounts.status.error')
    : loading
      ? t(quota.pendingAction === 'reset' ? 'quota.resetting' : refreshingWithData ? 'accounts.status.updating' : 'quota.querying')
      : quota.status === 'idle' ? t('accounts.status.idle') : '';
  const cellWarnings = new Map(warnings.map((warning) => [warning.row.label, warning.headline]));
  const grid = windowGrid(columns);
  const header = (
    <div className="flex min-h-6 items-center gap-2.5">
      {reordering ? <GripVertical className="-ms-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      <AccountAvatar profile={profile} size="sm" />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
        <strong className={cn('min-w-0 shrink truncate text-sm font-medium text-foreground', !profile.custom && 'font-mono')} title={account.fileName}>{name}</strong>
        {quota.plan ? <Badge variant={planVariant(quota.plan)}>{planLabel(quota.plan)}</Badge> : null}
        {!reordering ? <ResetCreditsChip quota={quota} claude={claude} blocked={resetBlocked} onReset={onReset} /> : null}
        {!reordering && cap !== undefined ? <ReserveChip accountKey={account.key} name={name} provider={providerForFile(account.file)} /> : null}
        {!reordering && status ? (
          <span className={cn('min-w-0 truncate', quota.status !== 'error' ? 'text-muted-foreground' : stale ? 'text-warning-foreground' : 'text-error-foreground')} title={stale ? quota.error : undefined}>
            {status}
          </span>
        ) : null}
        {/* What the core says when it's anything but ready, or which models are resting. */}
        {!reordering && (availability.kind !== 'ready' || availability.models) ? (
          <AuthFileStatus availability={availability} now={now} readyPill={false} />
        ) : null}
        {!reordering && headlineRow && headlineEven?.verdict === 'ahead' ? (
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={t('accounts.pace.aheadDetail', { window: headlineRow.label, percent: Math.round(headlineRow.remainingPercent ?? 0), even: Math.round(headlineEven.evenPercent) })}
          >
            {t('accounts.pace.aheadOfEven')}
          </span>
        ) : null}
      </div>
      {!reordering ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="me-1.5 empty:hidden">
            <AuthFileFix file={account.file} availability={availability} commands={commands} />
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  className={cn(!loading && hoverReveal)}
                  onClick={onRefresh}
                  disabled={loading}
                  focusableWhenDisabled
                  aria-label={t('quota.refresh')}
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>{quota.status === 'success' && checkedAt ? t('accounts.refresh.checked', { time: checkedAt }) : t('quota.refresh')}</TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" className={cn(hoverReveal, 'data-popup-open:opacity-100')} aria-label={t('accounts.actions', { name })} />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup className="w-64">
              {resetOffered ? (
                <MenuItem onClick={onReset} disabledReason={resetBlocked}>
                  <RotateCcw />
                  {t('quota.reset')}
                </MenuItem>
              ) : null}
              <MenuItem onClick={onEdit}>
                <Pencil />
                {t('accounts.profile.edit')}
              </MenuItem>
              <MenuSeparator />
              <AuthFileMenuItems file={account.file} availability={availability} commands={commands} />
            </MenuPopup>
          </Menu>
        </div>
      ) : null}
    </div>
  );
  if (reordering) {
    return (
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className={cn(
          'relative cursor-grab touch-none bg-card outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing',
          isDragging && 'z-10 shadow-md ring-1 ring-border',
        )}
        data-slot="account-row"
        aria-label={t('accounts.reorder', { name })}
        {...attributes}
        {...listeners}
      >
        <SettingsBlock className="py-2">{header}</SettingsBlock>
      </div>
    );
  }
  return (
    <div ref={setNodeRef} className="group relative" data-slot="account-row" data-account-key={account.key}>
      <SettingsBlock className={cn('@container flex flex-col gap-2.5', flash && 'row-highlight')}>
        {header}
        <QuotaActionFeedback quota={quota} />
        {rows.length ? (
          <div
            className={cn(
              'grid gap-x-6 gap-y-2.5 transition-opacity duration-300 @lg:grid-cols-(--window-columns)',
              stale ? 'opacity-55' : refreshingWithData && 'opacity-70',
            )}
            style={{ '--window-columns': `repeat(${grid.perLine}, minmax(0, 1fr))` } as CSSProperties}
          >
            {rows.map((row) => {
              const place = grid.place(row.label);
              return (
                <WindowRow
                  key={row.label}
                  row={row}
                  headline={headline}
                  warning={cellWarnings.get(row.label)}
                  cap={cap ?? null}
                  now={now}
                  onExplain={onExplain}
                  className="@lg:col-start-(--window-column) @lg:row-start-(--window-row)"
                  style={place ? { '--window-column': place.column, '--window-row': place.row } as CSSProperties : undefined}
                />
              );
            })}
          </div>
        ) : null}
        {quota.status === 'success' && quota.rows.length === 0 && !quota.resetCredits ? (
          <span className="text-xs text-muted-foreground">{t('quota.service.xaiPaidQuotaUnavailable')}</span>
        ) : null}
        {quota.status === 'error' && !stale && quota.error ? (
          <p className="flex min-w-0 items-start gap-1.5 text-xs text-error-foreground">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{quota.error}</span>
          </p>
        ) : null}
        {quota.status === 'idle' ? (
          <Button variant="outline" size="xs" className="w-fit" onClick={onRefresh}>
            <ArrowUpRight />
            {t('quota.fetch')}
          </Button>
        ) : null}
      </SettingsBlock>
    </div>
  );
}

/** A turned-off account's limits under its name, grayed out and lined up with the accounts in use. */
function OffWindows({ quota, columns, cap, now }: { quota: QuotaState; columns: string[]; cap: AccountCap | null; now: number }) {
  const { t } = useI18n();
  const rows = displayRows(quota).filter((row) => columns.includes(row.label));
  if (quota.status === 'error' && !rows.length) {
    return <span className="text-xs text-muted-foreground" title={quota.error}>{t('accounts.status.error')}</span>;
  }
  if (!rows.length) return null;
  const grid = windowGrid(columns);
  return (
    <div className="@container">
      <div
        className={cn('grid gap-x-6 gap-y-2.5 @lg:grid-cols-(--window-columns)', isStaleQuota(quota) && 'opacity-55')}
        style={{ '--window-columns': `repeat(${grid.perLine}, minmax(0, 1fr))` } as CSSProperties}
      >
        {rows.map((row) => {
          const place = grid.place(row.label);
          return (
            <WindowRow
              key={row.label}
              row={row}
              headline={null}
              cap={cap}
              now={now}
              muted
              className="@lg:col-start-(--window-column) @lg:row-start-(--window-row)"
              style={place ? { '--window-column': place.column, '--window-row': place.row } as CSSProperties : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * One limit window: its name, when it resets and how much is left on one line, the bar under it. The exact reset
 * time, the even pace and a warning are in its tooltip; opening it shows what used the window.
 */
function WindowRow({ row, headline, warning, cap, now, muted = false, className, style, onExplain }: {
  row: QuotaRow;
  headline: string | null;
  /** The headline window this one runs out before, when it will. */
  warning?: string;
  cap: AccountCap | null;
  now: number;
  /** A turned-off account's limit: grayed out, with no even-pace mark, since nothing is spending it through the proxy. */
  muted?: boolean;
  className?: string;
  style?: CSSProperties;
  onExplain?: (row: QuotaRow, scope: LimitScope) => void;
}) {
  const { t } = useI18n();
  // Where the account gets paused, in the bar's terms of what's left; an easing cap moves it left as the reset nears.
  const capped = cap !== null ? capForRow(row, cap, now) : null;
  const marker = capped ? 100 - capped.percent : null;
  // Where the fill would sit had the window been spent evenly so far.
  const pace = muted ? null : evenPace(row.remainingPercent, row.resetAtMs, row.windowMs, now);
  const reset = formatQuotaReset(row.resetAtMs, row.reset, now);
  const relative = row.resetAtMs !== undefined && Number.isFinite(row.resetAtMs)
    ? row.resetAtMs > now ? formatRelative(row.resetAtMs, now) : t('quota.resetPassed')
    : row.reset ?? '';
  const animated = useAnimatedNumber(row.remainingPercent);
  const percent = animated === null ? null : Math.round(animated);
  const scope = onExplain ? limitScope(row) : null;
  const hints = [
    warning ? t('accounts.window.warning', { headline: warning }) : '',
    reset ? t('accounts.window.resets', { time: reset }) : '',
    row.detail ?? '',
    pace ? t('accounts.pace.even', { percent: Math.round(pace.evenPercent) }) : '',
    marker !== null ? t(capped?.eased ? 'reserves.markerEased' : 'reserves.marker', { percent: Math.round(marker) }) : '',
  ].filter(Boolean);
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        {warning ? <TriangleAlert className="size-3.5 shrink-0 text-warning-foreground" aria-hidden="true" /> : null}
        <span className={cn('min-w-0 truncate', row.label === headline && !muted ? 'font-medium text-foreground' : 'text-muted-foreground')}>{row.label}</span>
        {relative ? <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">· {relative}</span> : null}
        <strong className={cn('ms-auto shrink-0 ps-2 font-semibold tabular-nums', muted ? 'text-muted-foreground' : percentText(row.remainingPercent))}>
          {percent === null ? '—' : t('accounts.window.left', { percent })}
        </strong>
      </span>
      <span className="relative block">
        <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-input/60 dark:bg-input">
          <span
            className={cn('block h-full rounded-full transition-[width] duration-500 ease-out', muted ? 'bg-muted-foreground/40' : percentTone(row.remainingPercent))}
            style={{ width: `${Math.max(0, Math.min(100, row.remainingPercent ?? 0))}%` }}
          />
          {marker !== null ? <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/60" style={{ left: `${marker}%` }} /> : null}
        </span>
        {/* A hairline taller than the bar, so it reads apart from the cap marker. */}
        {pace ? (
          <span aria-hidden="true" className="pointer-events-none absolute -inset-y-0.5 w-px -translate-x-1/2 bg-foreground/50" style={{ left: `${pace.evenPercent}%` }} />
        ) : null}
      </span>
    </>
  );
  const tooltip = (
    <TooltipPopup className="flex-col items-start gap-0.5">
      {hints.map((hint) => <span key={hint}>{hint}</span>)}
      {scope ? <span className="text-muted-foreground">{t('accounts.window.explain')}</span> : null}
    </TooltipPopup>
  );
  if (!onExplain || !scope) {
    return (
      <Tooltip>
        <TooltipTrigger render={<div className={cn('flex min-w-0 cursor-default flex-col gap-1.5', className)} style={style} />}>{content}</TooltipTrigger>
        {hints.length ? tooltip : null}
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              '-mx-2 -my-1 flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
            style={style}
            onClick={() => onExplain(row, scope)}
            aria-label={t('limitUsage.openWindow', { window: row.label })}
            aria-description={hints.join('. ')}
          />
        }
      >
        {content}
      </TooltipTrigger>
      {tooltip}
    </Tooltip>
  );
}
