import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Eye, EyeOff, FolderOpen, Globe, Import, KeyRound, Layers, LogIn, MoreHorizontal, Pencil, Play, Plus } from '../components/ui/icons';
import { setAppPreference, useAppPreferences } from '../appPreferences';
import { AccountAvatar } from '../components/AccountAvatar';
import { AccountProfileDialog, type ProfileTarget } from '../components/AccountProfileDialog';
import { AccountsEmpty } from '../components/AccountsEmpty';
import { AddAccountDialog, type AddAccountTarget } from '../components/AddAccountDialog';
import { AuthFileFix, AuthFileMenuItems, AuthFileStatus, authFileProviderKey, authFileProviderName, useAuthFileCommands, type AuthFileCommands } from '../components/AuthFileCommands';
import { ProviderMark } from '../components/identity/Identity';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuTrigger } from '../components/ui/menu';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { StatusPill } from '../components/ui/status-dot';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { clearFocusRequest, requestFocus, useFocusRequest } from '../focusRequests';
import { useI18n } from '../i18n';
import { formatRelative } from '../lib/format';
import { cn } from '../lib/utils';
import { invokeCommand } from '../native/commands';
import type { OAuthBrowserOption } from '../native/types';
import { accountLimitsView, type AppView } from '../navigation';
import { displayRows, useAccountLimitPrefs } from '../services/accountLimits';
import { sortByOrder, useAccountOrder } from '../services/accountOrder';
import { resumeAccount } from '../services/accountPause';
import { fileProfile, useAccountProfiles, type ResolvedProfile } from '../services/accountProfiles';
import { useAccountReserves, type PausedAccount } from '../services/accountReserves';
import { accountsGap, ensureAccountsLoaded, setAccountsError, useLiveAccounts } from '../services/accountsStore';
import { authFileAvailability, isAuthFileGoneFromDisk, isRuntimeOnlyAuthFile, parseAuthFilePriority, type AuthFileAvailability } from '../services/authFiles';
import { useShownIdentity } from '../services/emailPrivacy';
import { readBoolean, readString } from '../services/managementApi';
import { NO_AUTO_OPEN_BROWSER_ID, isOAuthProvider, loadOAuthBrowserPreference, saveOAuthBrowserPreference } from '../services/oauthCallback';
import { planLabel, planVariant } from '../services/planCosts';
import { useQuotaCache } from '../services/quotaCache';
import { fileName, idleQuota, providerForFile, quotaKey, type AuthFile, type QuotaRow, type QuotaState } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';

/**
 * Accounts › Sign-ins: every credential the core has, by provider, with the name and avatar it goes by, its email, its
 * priority and cap, and the one limit closest to running out. Each provider signs in or imports another from its own
 * header. The Limits view is where every window is read in full; this one is for looking after the sign-ins.
 */

/** Providers in the order the other Accounts views list them; any other provider follows, by name. */
const PROVIDER_ORDER = ['claude', 'codex', 'antigravity', 'xai', 'kimi'];

const percentText = (percent: number) =>
  percent <= 10 ? 'text-error-foreground' : percent <= 30 ? 'text-warning-foreground' : 'text-foreground';

/** A window's name without the "window" or "limit" every one of them ends in. */
const shortWindow = (label: string) => label.replace(/\s+(window|limit)$/i, '');

type SignIn = {
  file: AuthFile;
  key: string;
  quota: QuotaState;
  availability: AuthFileAvailability;
  off: boolean;
  paused?: PausedAccount;
};
type ProviderGroup = { provider: string; label: string; signIns: SignIn[] };

export function AccountSignInsPage({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const { files, disabled, listing, listedAt, loading, loaded, error } = useLiveAccounts();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const order = useAccountOrder();
  const reserves = useAccountReserves();
  const { hidden: hiddenWindows } = useAccountLimitPrefs();
  const { hideEmails } = useAppPreferences();
  const commands = useAuthFileCommands(listing);
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null);
  const [addTarget, setAddTarget] = useState<AddAccountTarget | null>(null);
  const shown = useShownIdentity();

  // Add account from anywhere else in the app arrives as a request: a provider's sign-in, or the choice of provider.
  const signInRequest = useFocusRequest('sign-in');
  useEffect(() => {
    if (!signInRequest) return;
    clearFocusRequest('sign-in');
    setAddTarget({ provider: isOAuthProvider(signInRequest) ? signInRequest : null });
  }, [signInRequest]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, SignIn[]>();
    listing.forEach((file) => {
      if (isAuthFileGoneFromDisk(file)) return;
      const provider = authFileProviderKey(file) || 'other';
      const key = quotaKey(file);
      const off = readBoolean(file, 'disabled');
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), {
        file,
        key,
        quota: quotas[key] ?? idleQuota(),
        availability: authFileAvailability(file, listedAt.receivedAtMs, listedAt.observedAt),
        off,
        paused: off ? reserves.paused[key] : undefined,
      }]);
    });
    const rank = (provider: string) => {
      const index = PROVIDER_ORDER.indexOf(provider);
      return index === -1 ? PROVIDER_ORDER.length : index;
    };
    return [...byProvider.entries()]
      .map(([provider, signIns]): ProviderGroup => {
        const [first] = signIns;
        const quotaProvider = first ? providerForFile(first.file) : null;
        // Accounts with limits keep the order they have on Limits; the rest go by name.
        const sorted = quotaProvider
          ? sortByOrder(signIns, order[quotaProvider], (signIn) => signIn.key)
          : [...signIns].sort((a, b) => fileName(a.file).localeCompare(fileName(b.file)));
        return { provider, label: first ? authFileProviderName(first.file) : provider, signIns: sorted };
      })
      .sort((a, b) => rank(a.provider) - rank(b.provider) || a.label.localeCompare(b.label));
  }, [listing, listedAt, quotas, order, reserves.paused]);

  const gap = accountsGap({ loaded, error, files, disabled });
  const openLimits = (key: string) => {
    if (!onNavigate) return;
    requestFocus('account', key);
    onNavigate(accountLimitsView());
  };
  const editProfile = (file: AuthFile) => {
    const key = quotaKey(file);
    setProfileTarget({ key, fileName: fileName(file), email: readString(file, 'email'), profile: profiles[key] });
  };

  return (
    <Page width="main">
      <PageTopbar
        actions={
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-pressed={hideEmails}
                    aria-label={t(hideEmails ? 'signIns.showEmails' : 'signIns.hideEmails')}
                    onClick={() => setAppPreference('hideEmails', !hideEmails)}
                  />
                }
              >
                {hideEmails ? <EyeOff /> : <Eye />}
              </TooltipTrigger>
              <TooltipPopup>{t(hideEmails ? 'signIns.showEmails' : 'signIns.hideEmails')}</TooltipPopup>
            </Tooltip>
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="icon-sm" aria-label={t('accounts.moreActions')} />}>
                <MoreHorizontal />
              </MenuTrigger>
              <MenuPopup className="min-w-72">
                <MenuItem disabled={commands.busy} onClick={commands.importFiles}>
                  <Import />
                  {t('signIns.importAny')}
                </MenuItem>
                <MenuItem disabled={!commands.hasModelsProviders} onClick={commands.providerModels}>
                  <Layers />
                  {t('authFiles.models.globalButton')}
                </MenuItem>
                <MenuItem disabled={commands.busy} onClick={() => void commands.openFolder()}>
                  <FolderOpen />
                  {t('authFiles.openDirectory')}
                </MenuItem>
                <MenuSeparator />
                <SignInBrowserMenu />
              </MenuPopup>
            </Menu>
            <Button size="sm" onClick={() => setAddTarget({ provider: null })}>
              <Plus />
              {t('accounts.add')}
            </Button>
          </div>
        }
      >
        <PageBreadcrumb segments={[t('accounts.title'), t('tree.accounts.signIns')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {commands.dialogs}
        <AccountProfileDialog target={profileTarget} onClose={() => setProfileTarget(null)} />
        <AddAccountDialog
          target={addTarget}
          onClose={() => setAddTarget(null)}
          onImport={() => {
            setAddTarget(null);
            commands.importFiles();
          }}
          onEditProfile={(file) => {
            setAddTarget(null);
            editProfile(file);
          }}
        />
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        {gap === 'loading' ? (
          <SettingsSection title={t('tree.accounts.signIns')}>
            {Array.from({ length: 3 }, (_, index) => (
              <SettingsBlock key={index} className="flex items-center gap-3" aria-hidden="true">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-44" />
                  <Skeleton className="h-3 w-64" />
                </div>
              </SettingsBlock>
            ))}
          </SettingsSection>
        ) : groups.length === 0 && gap ? (
          <SettingsSection title={t('tree.accounts.signIns')}>
            <AccountsEmpty
              gap={gap}
              icon={<KeyRound />}
              description={t('accounts.empty.description')}
              retrying={loading}
              onRetry={() => void ensureAccountsLoaded()}
              onNavigate={onNavigate}
              onAddAccount={() => setAddTarget({ provider: null })}
              onImport={commands.importFiles}
            />
          </SettingsSection>
        ) : (
          groups.map((group) => {
            const off = group.signIns.filter((signIn) => signIn.off).length;
            const runtime = group.signIns.filter((signIn) => isRuntimeOnlyAuthFile(signIn.file)).length;
            const count = group.signIns.length;
            const { provider } = group;
            return (
              <SettingsSection
                key={group.provider}
                title={
                  <span className="inline-flex items-center gap-2">
                    <ProviderMark provider={group.provider} decorative className="size-4" />
                    {group.label}
                  </span>
                }
                summary={[
                  t(count === 1 ? 'accounts.accountsCount.one' : 'accounts.accountsCount.other', { count }),
                  off ? t('signIns.offCount', { count: off }) : '',
                ].filter(Boolean).join(' · ')}
                headerAction={
                  <div className="flex items-center gap-1">
                    {isOAuthProvider(provider) ? (
                      <Button variant="ghost-muted" size="sm" onClick={() => setAddTarget({ provider })}>
                        <LogIn />
                        {t('signIns.signIn')}
                      </Button>
                    ) : null}
                    <Button variant="ghost-muted" size="sm" onClick={commands.importFiles} disabled={commands.busy}>
                      <Import />
                      {t('authFiles.import')}
                    </Button>
                  </div>
                }
              >
                {group.signIns.map((signIn) => (
                  <SignInRow
                    key={`${signIn.key}`}
                    signIn={signIn}
                    profile={fileProfile(signIn.file, profiles)}
                    email={shown(readString(signIn.file, 'email', 'account', 'label'), { email: readString(signIn.file, 'email') })}
                    cap={reserves.caps[signIn.key]}
                    hidden={hiddenWindows[providerForFile(signIn.file) ?? ''] ?? []}
                    commands={commands}
                    onEdit={() => editProfile(signIn.file)}
                    onOpenLimits={onNavigate ? () => openLimits(signIn.key) : undefined}
                  />
                ))}
                {runtime ? (
                  <SettingsBlock className="bg-muted/40 py-2 text-xs text-muted-foreground dark:bg-input/10">
                    {t(runtime === 1 ? 'authFiles.runtimeFootnote.one' : 'authFiles.runtimeFootnote.other', { count: runtime })}
                  </SettingsBlock>
                ) : null}
              </SettingsSection>
            );
          })
        )}
      </PageBody>
    </Page>
  );
}

/**
 * Which browser a sign-in opens the provider's page in, kept for every sign-in after: the Mac's default, a browser it
 * found, or none, when the page's link is only shown to open or copy.
 */
function SignInBrowserMenu() {
  const { t } = useI18n();
  const [browsers, setBrowsers] = useState<OAuthBrowserOption[] | null>(null);
  const [chosen, setChosen] = useState(() => loadOAuthBrowserPreference() || 'default');
  useEffect(() => {
    let active = true;
    invokeCommand('list_oauth_browsers')
      .then((found) => { if (active) setBrowsers(found); })
      .catch(() => { if (active) setBrowsers([]); });
    return () => { active = false; };
  }, []);
  const others = (browsers ?? []).filter((browser) => browser.id !== 'default');
  const label = chosen === NO_AUTO_OPEN_BROWSER_ID
    ? t('oauth.browser.noAutoOpen')
    : others.find((browser) => browser.id === chosen)?.label ?? t('oauth.browser.systemDefault');
  const choose = (id: string) => {
    setChosen(id);
    saveOAuthBrowserPreference(id);
  };
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Globe />
        <span className="min-w-0 flex-1 truncate">{t('signIns.browser')}</span>
        <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">{browsers ? label : t('oauth.browser.detecting')}</span>
      </MenuSubTrigger>
      <MenuPopup className="w-64" side="inline-end" align="start" sideOffset={6}>
        <MenuRadioGroup value={chosen} onValueChange={(id: string) => choose(id)}>
          <MenuGroupLabel>{t('signIns.browser.title')}</MenuGroupLabel>
          <MenuRadioItem value="default" closeOnClick>{t('oauth.browser.systemDefault')}</MenuRadioItem>
          {others.map((browser) => (
            <MenuRadioItem key={browser.id} value={browser.id} closeOnClick>{browser.label}</MenuRadioItem>
          ))}
          <MenuSeparator />
          <MenuRadioItem value={NO_AUTO_OPEN_BROWSER_ID} closeOnClick>{t('oauth.browser.noAutoOpen')}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </MenuSub>
  );
}

function SignInRow({ signIn, profile, email, cap, hidden, commands, onEdit, onOpenLimits }: {
  signIn: SignIn;
  profile: ResolvedProfile;
  /** The account's email as it's shown: hidden while the setting is on. */
  email: string;
  cap: number | undefined;
  /** The provider's windows hidden on Limits, which are left out here too. */
  hidden: readonly string[];
  commands: AuthFileCommands;
  onEdit: () => void;
  onOpenLimits?: () => void;
}) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const { file, quota, availability, off, paused } = signIn;
  const [resuming, setResuming] = useState(false);
  const priority = parseAuthFilePriority(file.priority) ?? 0;
  const runtime = isRuntimeOnlyAuthFile(file);
  const rows = displayRows(quota).filter((row): row is QuotaRow & { remainingPercent: number } =>
    row.remainingPercent !== null && !row.extra && !hidden.includes(row.label));
  const resets = quota.resetCredits;
  const claude = providerForFile(file) === 'claude';
  const facts = [
    email,
    priority ? t('accounts.routing.priority', { priority }) : '',
    cap ? t('reserves.cap', { percent: cap }) : '',
    resets ? t(claude
      ? resets === 1 ? 'accounts.resets.banked.one' : 'accounts.resets.banked.other'
      : resets === 1 ? 'accounts.resets.manual.one' : 'accounts.resets.manual.other', { count: resets }) : '',
  ].filter(Boolean);
  const resume = async () => {
    setResuming(true);
    setAccountsError('');
    try {
      await resumeAccount(signIn.key, file);
    } catch (resumeError) {
      setAccountsError(t('reserves.paused.resumeFailed', { name: profile.name, error: resumeError instanceof Error ? resumeError.message : String(resumeError) }));
    } finally {
      setResuming(false);
    }
  };
  const back = paused && paused.resumeAtMs > now ? formatRelative(paused.resumeAtMs, now) : '';
  return (
    <div data-account-key={signIn.key}>
    <SettingsBlock className="flex items-center gap-3 py-3">
      <button
        type="button"
        className="shrink-0 cursor-pointer rounded-[10px] outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onEdit}
        aria-label={t('signIns.editProfile', { name: profile.name })}
        title={t('signIns.editProfile', { name: profile.name })}
      >
        <AccountAvatar profile={profile} size="md" className={cn(off && 'opacity-50')} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <strong className={cn('min-w-0 truncate text-sm font-medium', off ? 'text-muted-foreground' : 'text-foreground', !profile.custom && 'font-mono')}>
            {profile.name}
          </strong>
          {quota.plan ? <Badge variant={planVariant(quota.plan)}>{planLabel(quota.plan)}</Badge> : null}
          {runtime ? <Badge variant="info">{t('authFiles.runtime')}</Badge> : null}
          {paused ? (
            <>
              <StatusPill tone="warning">{t('signIns.paused')}</StatusPill>
              <span className="text-xs text-muted-foreground">{back ? t('reserves.paused.back', { time: back }) : t('reserves.paused.backSoon')}</span>
            </>
          ) : off ? (
            <StatusPill tone="muted">{t('accounts.turnedOff.title')}</StatusPill>
          ) : availability.kind !== 'ready' || availability.models ? (
            <AuthFileStatus availability={availability} now={now} readyPill={false} />
          ) : null}
        </div>
        {facts.length ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{facts.join(' · ')}</div> : null}
      </div>
      {/* The fix goes before the limit, so every row's limit lines up at the right. */}
      <div className="flex shrink-0 items-center empty:hidden">
        {paused ? (
          <Button variant="outline" size="xs" disabled={resuming} onClick={() => void resume()} title={t('reserves.paused.resumeHint', { window: paused.window.charAt(0).toLowerCase() + paused.window.slice(1) })}>
            {resuming ? <Spinner className="size-3" /> : <Play />}
            {t('reserves.paused.resume')}
          </Button>
        ) : (
          <AuthFileFix file={file} availability={availability} commands={commands} />
        )}
      </div>
      <TightestLimit quota={off ? idleQuota() : quota} rows={off ? [] : rows} now={now} onOpen={onOpenLimits} />
      <div className="flex shrink-0 items-center">
        <Menu>
          <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={t('accounts.actions', { name: profile.name })} />}>
            <MoreHorizontal />
          </MenuTrigger>
          <MenuPopup className="w-64">
            <MenuItem onClick={onEdit}>
              <Pencil />
              {t('signIns.menu.editProfile')}
            </MenuItem>
            <MenuSeparator />
            <AuthFileMenuItems file={file} availability={availability} commands={commands} paused={paused} />
          </MenuPopup>
        </Menu>
      </div>
    </SettingsBlock>
    </div>
  );
}

/**
 * The account's limit closest to running out, with its window and when it resets. Every window is in its tooltip, and
 * clicking it opens the account on Limits.
 */
function TightestLimit({ quota, rows, now, onOpen }: {
  quota: QuotaState;
  rows: Array<QuotaRow & { remainingPercent: number }>;
  now: number;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const box = 'flex w-40 shrink-0 flex-col items-end text-right';
  if (!rows.length) {
    if (quota.status === 'loading') return <span className={cn(box, 'text-xs text-muted-foreground')}><Spinner className="size-3.5" /></span>;
    if (quota.status === 'error') return <span className={cn(box, 'text-xs text-muted-foreground')}>{t('signIns.limitsUnread')}</span>;
    return <span className={box} />;
  }
  const tightest = rows.reduce((low, row) => (
    row.remainingPercent < low.remainingPercent
    || (row.remainingPercent === low.remainingPercent && (row.resetAtMs ?? Infinity) < (low.resetAtMs ?? Infinity))
      ? row : low));
  const when = (row: QuotaRow) => (row.resetAtMs !== undefined && row.resetAtMs > now ? formatRelative(row.resetAtMs, now) : '');
  const percent = Math.round(tightest.remainingPercent);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(box, '-my-1 cursor-pointer rounded-md px-2 py-1 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent')}
            disabled={!onOpen}
            onClick={onOpen}
          />
        }
      >
        <span className={cn('text-sm font-semibold tabular-nums', percentText(percent))}>{t('accounts.window.left', { percent })}</span>
        <span className="max-w-full truncate text-xs text-muted-foreground">
          {[shortWindow(tightest.label), when(tightest)].filter(Boolean).join(' · ')}
        </span>
      </TooltipTrigger>
      <TooltipPopup className="flex-col items-stretch gap-1">
        <span className="grid grid-cols-[auto_auto_auto] gap-x-3 gap-y-0.5 tabular-nums">
          {rows.map((row) => (
            <span key={row.label} className="contents">
              <span className={cn(row === tightest ? 'font-medium' : 'text-muted-foreground')}>{shortWindow(row.label)}</span>
              <span className="text-right">{t('accounts.window.left', { percent: Math.round(row.remainingPercent) })}</span>
              <span className="text-muted-foreground">{when(row)}</span>
            </span>
          ))}
        </span>
        {onOpen ? <span className="text-muted-foreground">{t('signIns.openLimits')}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
