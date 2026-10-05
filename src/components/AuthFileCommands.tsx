import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, Layers, LogIn, Pencil, Power, PowerOff, Search, Settings2, Trash2 } from './ui/icons';
import { useConfirmation } from './ConfirmationDialog';
import { AuthFileModelsDialog } from './AuthFileModelsDialog';
import { AuthReauthDialog, type ReauthTarget } from './AuthReauthDialog';
import { ReserveDialog, ReserveMenuItem, type ReserveTarget } from './ReserveControl';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { MenuItem, MenuSeparator } from './ui/menu';
import { draftFromNumber, NumberField, numberFromDraft } from './ui/number-field';
import { RefreshIcon } from './ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { StatusPill, type StatusTone } from './ui/status-dot';
import { Textarea } from './ui/textarea';
import { toast } from './ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { translate, useI18n } from '../i18n';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { cn } from '../lib/utils';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import type { PausedAccount } from '../services/accountReserves';
import { loadAccountFiles, setAccountsError } from '../services/accountsStore';
import { authFileActions, type AuthFileAction } from '../services/authFileActions';
import { cooldownReasonKey, statusMessageReason } from '../services/authFileHealth';
import {
  authFileName,
  canonicalProvider,
  isOAuthCredentialFile,
  isRuntimeOnlyAuthFile,
  normalizeAuthFilePriorityInput,
  oauthModelProvidersFromAuthFiles,
  parseAuthFilePriority,
  setOAuthCredentialFileDisabled,
  type AuthFileAvailability,
  type AuthFileModelLimits,
} from '../services/authFiles';
import { reauthProviderForFile, type ReauthOutcome } from '../services/authReauth';
import { managementApi, readBoolean, readString } from '../services/managementApi';
import { modelMatchesRule, normalizeOAuthExcludedRules, openOAuthModelNames, setOAuthModelsExcluded, type OAuthModelDefinition } from '../services/oauthModels';
import { loadOAuthModelSettings, saveOAuthModelSettings, type OAuthModelSettings, type OAuthModelTarget } from '../services/oauthModelSettings';
import { fileName, providerForFile, quotaKey, type AuthFile } from '../services/quotaService';
import { formatQuotaReset } from '../services/quotaTime';

/**
 * What can be done to a credential in the core's listing, and how its state reads: turning it on and off, its
 * priority, its models, signing in again, deleting it, and importing more. The Accounts page lists every credential
 * and offers them there.
 */

export const authFileProviderKey = (file: AuthFile) => canonicalProvider(readString(file, 'provider', 'type', 'account_type'));

/** A credential's provider as it's written, xAI and all. */
export const authFileProviderName = (file: AuthFile) => {
  const value = authFileProviderKey(file);
  if (value === 'xai') return 'xAI';
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : translate('authFiles.unknownProvider');
};

const statusTone: Record<AuthFileAvailability['kind'], StatusTone> = {
  ready: 'success',
  disabled: 'muted',
  limit: 'warning',
  retrying: 'info',
  signin: 'error',
  access: 'error',
  unavailable: 'error',
};

// The core's raw `status` ("active", "error") is never shown; every state gets its own label.
const statusLabel: Record<AuthFileAvailability['kind'], MessageKey> = {
  ready: 'authFiles.status.ready',
  disabled: 'authFiles.status.disabled',
  limit: 'authFiles.status.limit',
  retrying: 'authFiles.status.retrying',
  signin: 'authFiles.status.signIn',
  access: 'authFiles.status.access',
  unavailable: 'authFiles.status.unavailable',
};

/** The core's status message when it says more than the reason label already does. */
const statusDetail = (message: string) => (message && !statusMessageReason(message) ? message : '');

// Hint triggers are plain text, so they take keyboard focus themselves.
const hintTriggerClass = 'inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

function AuthFileModelLimitsSummary({ models, now }: { models: AuthFileModelLimits; now: number }) {
  const { t } = useI18n();
  const time = (ms: number) => formatQuotaReset(ms, undefined, now);
  // Rests that ended since the listing arrived are gone until the next one confirms it.
  const cooldowns = models.cooldowns.filter((cooldown) => cooldown.retryAtMs > now);
  const [first] = cooldowns;
  if (!first) return null;
  const count = new Set(cooldowns.map((cooldown) => cooldown.model)).size;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={cn(hintTriggerClass, 'cursor-default text-xs text-muted-foreground')} />}>
        {t(count === 1 ? 'authFiles.status.modelsLimited.one' : 'authFiles.status.modelsLimited.other', { count, time: time(first.retryAtMs) })}
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm">
        <span className="flex flex-col gap-1.5">
          <span>{t('authFiles.status.modelsHint')}</span>
          {cooldowns.map((cooldown) => (
            <span className="flex flex-col" key={cooldown.model}>
              <span className="font-mono">{cooldown.model}</span>
              <span className="text-muted-foreground">
                {[
                  t(cooldownReasonKey(cooldown.reason)),
                  cooldown.httpStatus ? t('authFiles.health.http', { status: cooldown.httpStatus }) : '',
                  t('authFiles.health.until', { time: time(cooldown.retryAtMs) }),
                ].filter(Boolean).join(' · ')}
              </span>
            </span>
          ))}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A status pill whose tooltip explains it. */
function HintedStatusPill({ tone, label, details }: { tone: StatusTone; label: string; details: string[] }) {
  const pill = <StatusPill tone={tone} className={details.length ? 'cursor-default' : undefined}>{label}</StatusPill>;
  if (details.length === 0) return pill;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={hintTriggerClass} />}>{pill}</TooltipTrigger>
      <TooltipPopup className="max-w-xs">
        <span className="flex flex-col gap-1">
          {/* The core's message can be a whole upstream error body. */}
          {details.map((line) => <span className="line-clamp-4 break-words" key={line}>{line}</span>)}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * A credential's status pill plus the one fact that matters next to it: when a
 * limit resets, when the core retries, or which models are resting. A file
 * that left the disk shows only that: the core is about to drop it.
 */
export function AuthFileStatus({ availability, now, removed = false, paused, readyPill = true }: {
  availability: AuthFileAvailability;
  now: number;
  removed?: boolean;
  /** Set when Arbor turned the account off at its cap. */
  paused?: PausedAccount;
  /** Off where a row already reads as ready, so only which models are resting is said. */
  readyPill?: boolean;
}) {
  const { t } = useI18n();
  if (removed) {
    return <HintedStatusPill tone="muted" label={t('authFiles.status.removed')} details={[t('authFiles.status.removedHint')]} />;
  }
  const reasonLabel = (reason?: string) => (reason ? t(cooldownReasonKey(reason)) : '');
  // A time that has passed means the page is about to reload; the listing says what happened.
  const upcoming = (ms?: number) => (ms !== undefined && ms > now ? formatQuotaReset(ms, undefined, now) : '');
  let details: string[] = [];
  let aside: ReactNode = null;
  switch (availability.kind) {
    case 'limit': {
      details = [t('authFiles.status.limitHint')];
      const time = upcoming(availability.retryAtMs);
      if (time) aside = t('authFiles.status.resets', { time });
      break;
    }
    case 'retrying': {
      // The core keeps retrying a failed token refresh, but a revoked sign-in never recovers on its own.
      const hint = availability.reason === 'token_expired' ? 'authFiles.status.tokenExpiredHint' : 'authFiles.status.retryingHint';
      details = [reasonLabel(availability.reason), statusDetail(availability.message), t(hint)];
      const time = upcoming(availability.retryAtMs);
      if (time) aside = t('authFiles.status.retries', { time });
      break;
    }
    case 'signin':
      details = [reasonLabel(availability.reason), statusDetail(availability.message), t('authFiles.status.signInHint')];
      break;
    case 'access':
      details = [reasonLabel(availability.reason), statusDetail(availability.message), t('authFiles.status.accessHint')];
      break;
    case 'unavailable': {
      details = [availability.message];
      const time = upcoming(availability.retryAtMs);
      if (time) aside = t('authFiles.status.retries', { time });
      break;
    }
    case 'ready':
      if (availability.models) aside = <AuthFileModelLimitsSummary models={availability.models} now={now} />;
      if (!readyPill) return aside;
      break;
    case 'disabled': {
      if (!paused) break;
      const window = paused.window.charAt(0).toLowerCase() + paused.window.slice(1);
      details = [paused.easedCap !== undefined
        ? t('reserves.authFiles.hintEased', { cap: paused.cap, eased: paused.easedCap, window })
        : t('reserves.authFiles.hint', { cap: paused.cap, window })];
      const time = upcoming(paused.resumeAtMs);
      aside = time ? t('reserves.authFiles.back', { time }) : null;
      break;
    }
  }
  return (
    <>
      <HintedStatusPill tone={statusTone[availability.kind]} label={t(statusLabel[availability.kind])} details={[...new Set(details.filter(Boolean))]} />
      {typeof aside === 'string' ? <span className="text-xs text-muted-foreground">{aside}</span> : aside}
    </>
  );
}

type PriorityEditor = { fileName: string; originalPriority: number; value: string; error: string };
type ModelsProvider = { provider: string; label: string };

export type AuthFileCommands = ReturnType<typeof useAuthFileCommands>;

/**
 * The changes a credential takes, each followed by reading the listing again, with the dialogs and file picker they
 * open. A change that worked says so in a toast; one that failed says why above the list. Render `dialogs` once.
 */
export function useAuthFileCommands(listing: AuthFile[]) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const { copy } = useCopyToClipboard();
  const [busy, setBusy] = useState(false);
  const [refreshingName, setRefreshingName] = useState('');
  const [priorityEditor, setPriorityEditor] = useState<PriorityEditor | null>(null);
  const [reauthTarget, setReauthTarget] = useState<ReauthTarget | null>(null);
  const [modelViewName, setModelViewName] = useState<string | null>(null);
  const [modelsTarget, setModelsTarget] = useState<OAuthModelTarget | null>(null);
  const [capTarget, setCapTarget] = useState<ReserveTarget | null>(null);
  const profiles = useAccountProfiles();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Provider-wide exclusions only apply to OAuth credential files, so runtime entries and API keys add no provider.
  const modelsProviders: ModelsProvider[] = useMemo(() => oauthModelProvidersFromAuthFiles(listing)
    .map((provider) => ({ provider, label: authFileProviderName({ provider }) }))
    .sort((a, b) => a.label.localeCompare(b.label)), [listing]);
  const succeeded = (key: MessageKey, variables?: MessageVariables) => toast({ kind: 'success', title: t(key, variables) });

  /**
   * Runs one change: busy while it runs, the listing read again after, and why it failed above the list. The
   * failure is set after the reload, which clears the list's error as it starts. Says whether the change went through.
   */
  const change = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setAccountsError('');
    let failure = '';
    try {
      await work();
    } catch (requestError) {
      failure = String(requestError);
    } finally {
      setBusy(false);
    }
    await loadAccountFiles();
    if (failure) setAccountsError(failure);
    return !failure;
  };

  // Turning an account off or on is undone as easily as it's done, so it happens straight away with Undo.
  const toggle = async (file: AuthFile) => {
    const disabled = !readBoolean(file, 'disabled');
    if (!await change(() => setOAuthCredentialFileDisabled(file, disabled))) return;
    toast({
      title: t(disabled ? 'authFiles.turnedOff' : 'authFiles.turnedOn', { name: authFileName(file) }),
      action: { label: t('common.undo'), onClick: () => { void change(() => setOAuthCredentialFileDisabled(file, !disabled)); } },
    });
  };

  const remove = async (file: AuthFile) => {
    const name = authFileName(file);
    if (isRuntimeOnlyAuthFile(file)) {
      setAccountsError(t('authFiles.runtimeDeleteError'));
      return;
    }
    if (!await askConfirmation({ title: t('common.delete'), message: t('authFiles.deleteConfirm', { name }), confirmText: t('common.delete'), variant: 'danger' })) return;
    await change(async () => {
      await managementApi.delete('/auth-files', { query: { name } });
      succeeded('authFiles.deleted');
    });
  };

  const editPriority = (file: AuthFile) => {
    const priority = parseAuthFilePriority(file.priority);
    setPriorityEditor({
      fileName: authFileName(file),
      originalPriority: priority ?? 0,
      value: priority === undefined || priority === 0 ? '' : String(priority),
      error: '',
    });
  };

  const savePriority = async () => {
    if (!priorityEditor || busy) return;
    const priority = normalizeAuthFilePriorityInput(priorityEditor.value);
    if (priority === null) {
      setPriorityEditor((current) => (current ? { ...current, error: t('authFiles.priority.invalid') } : current));
      return;
    }
    if (priority === priorityEditor.originalPriority) {
      setPriorityEditor(null);
      return;
    }
    const name = priorityEditor.fileName;
    setBusy(true);
    try {
      await managementApi.patch('/auth-files/fields', { name, priority });
      setPriorityEditor(null);
      succeeded('authFiles.priority.updated', { name });
      await loadAccountFiles();
    } catch (requestError) {
      setPriorityEditor((current) => (current ? { ...current, error: String(requestError) } : current));
    } finally {
      setBusy(false);
    }
  };

  const reauth = (file: AuthFile) => {
    const provider = reauthProviderForFile(file);
    if (!provider || isRuntimeOnlyAuthFile(file)) return;
    setReauthTarget({ file, provider });
  };

  const reauthCompleted = (outcome: ReauthOutcome) => {
    if (outcome.kind === 'in-place') succeeded('authFiles.reauth.done', { name: outcome.name });
    else if (outcome.kind === 'transplanted' || outcome.kind === 'renamed') {
      succeeded(outcome.kind === 'transplanted' ? 'authFiles.reauth.doneTransplanted' : 'authFiles.reauth.doneRenamed', { name: outcome.name, from: outcome.from });
    }
    void loadAccountFiles();
  };

  /** Asks the core to refresh a credential it is waiting to retry, then shows what it reports now. */
  const refreshCredential = async (file: AuthFile) => {
    const name = readString(file, 'name');
    if (!name || !isOAuthCredentialFile(file)) return;
    setRefreshingName(name);
    await change(async () => {
      try {
        await managementApi.post('/auth-files/refresh', { name });
        succeeded('authFiles.refresh.done', { name });
      } catch (requestError) {
        throw new Error(t('authFiles.refresh.failed', { name, error: String(requestError) }));
      }
    });
    setRefreshingName('');
  };

  const importFiles = () => fileInputRef.current?.click();

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (selected.length === 0) return;
    let uploaded = 0;
    const failures: string[] = [];
    await change(async () => {
      for (const file of selected) {
        try {
          await managementApi.uploadAuthFile(file);
          uploaded += 1;
        } catch (requestError) {
          failures.push(`${file.name}: ${String(requestError)}`);
        }
      }
      if (uploaded > 0) succeeded('authFiles.uploaded', { count: uploaded });
      if (failures.length > 0) throw new Error(t('authFiles.uploadFailed', { count: failures.length, errors: failures.join('; ') }));
    });
  };

  const openFolder = () => change(async () => {
    await managementApi.openAuthFilesDirectory();
  });

  const viewModels = (file: AuthFile) => setModelViewName(authFileName(file));

  const excludeModels = (file: AuthFile) => {
    const name = readString(file, 'name');
    const provider = authFileProviderKey(file);
    if (!name || !provider || isRuntimeOnlyAuthFile(file) || !isOAuthCredentialFile(file)) return;
    setModelsTarget({ scope: 'credential', name, provider, label: authFileProviderName(file) });
  };

  /** Models turned off for every account of a provider, starting at the first provider that has any. */
  const providerModels = () => {
    const [first] = modelsProviders;
    if (first) setModelsTarget({ ...first, scope: 'provider' });
  };

  const copyName = (file: AuthFile) => void copy(authFileName(file), { label: t('authFiles.nameCopied') });

  /** Opens an account's cap, with what paused it when Arbor has it paused. */
  const editCap = (file: AuthFile, paused?: PausedAccount) => {
    const key = quotaKey(file);
    setCapTarget({ key, name: resolveAccountProfile(key, fileName(file), profiles[key]).name, provider: providerForFile(file), paused });
  };

  const dialogs = (
    <>
      <input ref={fileInputRef} type="file" accept=".json,application/json" multiple hidden onChange={(event) => void upload(event)} />
      <PriorityDialog
        editor={priorityEditor}
        busy={busy}
        onChange={(value) => setPriorityEditor((current) => (current ? { ...current, value, error: '' } : current))}
        onSave={() => void savePriority()}
        onClose={() => {
          if (!busy) setPriorityEditor(null);
        }}
      />
      {modelViewName ? <AuthFileModelsDialog name={modelViewName} onClose={() => setModelViewName(null)} /> : null}
      <AuthReauthDialog target={reauthTarget} onClose={() => setReauthTarget(null)} onCompleted={reauthCompleted} />
      <ExcludedModelsDialog target={modelsTarget} providers={modelsProviders} onTarget={setModelsTarget} onClose={() => setModelsTarget(null)} />
      <ReserveDialog target={capTarget} onClose={() => setCapTarget(null)} />
    </>
  );

  return {
    busy,
    refreshingName,
    hasModelsProviders: modelsProviders.length > 0,
    toggle,
    remove,
    editPriority,
    reauth,
    refreshCredential,
    importFiles,
    openFolder,
    viewModels,
    excludeModels,
    providerModels,
    copyName,
    editCap,
    dialogs,
  };
}

/** A credential's ⋯ menu items, from what its state allows, in groups with the destructive ones last. */
export function AuthFileMenuItems({ file, availability, commands, paused }: {
  file: AuthFile;
  availability: AuthFileAvailability;
  commands: AuthFileCommands;
  paused?: PausedAccount;
}) {
  const { t } = useI18n();
  const { menu } = authFileActions(file, availability);
  const priority = parseAuthFilePriority(file.priority) ?? 0;
  // The row's own refresh button reads an account's limits.
  const groups = menu.map((group) => group.filter((item) => item.id !== 'check-limits')).filter((group) => group.length > 0);
  const item = (action: AuthFileAction) => {
    const reason = action.unavailable ? t(action.unavailable) : undefined;
    switch (action.id) {
      case 'check-limits':
        return null;
      case 'priority':
        return (
          <MenuItem key={action.id} disabledReason={reason} onClick={() => commands.editPriority(file)}>
            <Pencil />
            <span className="min-w-0 flex-1 truncate">{t('authFiles.menu.priority')}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{priority}</span>
          </MenuItem>
        );
      case 'cap':
        return <ReserveMenuItem key={action.id} accountKey={quotaKey(file)} onOpen={() => commands.editCap(file, paused)} />;
      case 'models':
        return (
          <MenuItem key={action.id} disabledReason={reason} onClick={() => commands.viewModels(file)}>
            <Layers />
            {t('authFiles.models.viewTitle')}
          </MenuItem>
        );
      case 'exclude-models':
        return (
          <MenuItem key={action.id} disabledReason={reason} onClick={() => commands.excludeModels(file)}>
            <Settings2 />
            {t('authFiles.models.excludeButton')}
          </MenuItem>
        );
      case 'copy-name':
        // A toast, as the menu closes before a tick on the item could show.
        return (
          <MenuItem key={action.id} onClick={() => commands.copyName(file)}>
            <Copy />
            {t('authFiles.copyName')}
          </MenuItem>
        );
      case 'reauth':
        return (
          <MenuItem key={action.id} onClick={() => commands.reauth(file)}>
            <LogIn />
            {t('authFiles.reauth.button')}
          </MenuItem>
        );
      case 'refresh-credential':
        return (
          <MenuItem key={action.id} onClick={() => void commands.refreshCredential(file)}>
            <RefreshIcon />
            {t('authFiles.refreshNow')}
          </MenuItem>
        );
      case 'enable':
      case 'disable':
        return (
          <MenuItem key={action.id} disabledReason={reason} onClick={() => void commands.toggle(file)}>
            {action.id === 'enable' ? <Power /> : <PowerOff />}
            {t(action.id === 'enable' ? 'common.enable' : 'common.disable')}
          </MenuItem>
        );
      case 'delete':
        // remove asks first.
        return (
          <MenuItem key={action.id} variant="destructive" disabledReason={reason} onClick={() => void commands.remove(file)}>
            <Trash2 />
            {t('common.delete')}
          </MenuItem>
        );
    }
  };
  return groups.map((group, index) => (
    <Fragment key={group[0]?.id ?? index}>
      {index > 0 ? <MenuSeparator /> : null}
      {group.map(item)}
    </Fragment>
  ));
}

/**
 * The one fix a credential's state calls for, up front: Sign in again when the provider rejected its token, Refresh
 * now while the core waits to retry, Enable when it's turned off. Nothing otherwise.
 */
export function AuthFileFix({ file, availability, commands }: { file: AuthFile; availability: AuthFileAvailability; commands: AuthFileCommands }) {
  const { t } = useI18n();
  const { primary } = authFileActions(file, availability);
  if (primary?.id === 'reauth') {
    return (
      <Tooltip>
        <TooltipTrigger render={<Button variant="default" size="xs" onClick={() => commands.reauth(file)} disabled={commands.busy} focusableWhenDisabled />}>
          <LogIn />
          {t('authFiles.reauth.button')}
        </TooltipTrigger>
        <TooltipPopup>{t('authFiles.reauth.hint')}</TooltipPopup>
      </Tooltip>
    );
  }
  if (primary?.id === 'refresh-credential') {
    return (
      <Tooltip>
        <TooltipTrigger render={<Button variant="default" size="xs" onClick={() => void commands.refreshCredential(file)} disabled={commands.busy} focusableWhenDisabled />}>
          <RefreshIcon refreshing={commands.refreshingName === readString(file, 'name')} />
          {t('authFiles.refreshNow')}
        </TooltipTrigger>
        <TooltipPopup>{t('authFiles.refreshNowHint')}</TooltipPopup>
      </Tooltip>
    );
  }
  if (primary?.id === 'enable') {
    return (
      <Button variant="outline" size="xs" onClick={() => void commands.toggle(file)} disabled={commands.busy} focusableWhenDisabled>
        <Power />
        {t('common.enable')}
      </Button>
    );
  }
  return null;
}

function PriorityDialog({ editor, busy, onChange, onSave, onClose }: {
  editor: PriorityEditor | null;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={editor !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup className="max-w-sm" showCloseButton={!busy}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('authFiles.priority.title')}</DialogTitle>
            <DialogDescription className="truncate font-mono text-sm" title={editor?.fileName}>{editor?.fileName}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-file-priority-input">{t('authFiles.priority.label')}</Label>
              <NumberField
                id="auth-file-priority-input"
                autoFocus
                value={numberFromDraft(editor?.value ?? '')}
                placeholder={t('authFiles.priority.placeholder')}
                disabled={busy}
                aria-invalid={Boolean(editor?.error) || undefined}
                font="mono"
                onValueChange={(next) => onChange(draftFromNumber(next))}
              />
              <p className="text-xs text-muted-foreground">{t('authFiles.priority.hint')}</p>
            </div>
            {editor?.error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{editor.error}</AlertDescription></Alert> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : <Check />}
              {busy ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The models turned off for one credential, or for every account of a provider: tick them, or write rules with `*`,
 * against the catalog the core reports.
 */
function ExcludedModelsDialog({ target, providers, onTarget, onClose }: {
  target: OAuthModelTarget | null;
  providers: ModelsProvider[];
  onTarget: (target: OAuthModelTarget) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<OAuthModelSettings | null>(null);
  const [rulesText, setRulesText] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const savingRef = useRef(false);
  const models = useMemo(() => settings?.models ?? [], [settings]);
  const rules = normalizeOAuthExcludedRules(rulesText.split(/\r?\n/));
  const excludedCount = models.length - openOAuthModelNames(models, rules).size;
  const dialogBusy = loading || saving;
  const providerLabel = providers.find((item) => item.provider === target?.provider)?.label ?? target?.label ?? '';

  useEffect(() => {
    const request = ++requestRef.current;
    setSettings(null);
    setRulesText('');
    setSearch('');
    setError('');
    if (!target) return;
    setLoading(true);
    loadOAuthModelSettings(target)
      .then((loaded) => {
        if (requestRef.current !== request) return;
        setSettings(loaded);
        setRulesText(loaded.excludedRules.join('\n'));
      })
      .catch((requestError: unknown) => {
        if (requestRef.current === request) setError(String(requestError));
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false);
      });
  }, [target]);

  const close = () => {
    if (savingRef.current) return;
    requestRef.current += 1;
    onClose();
  };

  const save = async () => {
    if (!settings || loading || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await saveOAuthModelSettings(settings, rules);
      toast({
        kind: 'success',
        title: settings.target.scope === 'credential'
          ? t('authFiles.models.credentialUpdated', { name: settings.target.name })
          : t('authFiles.models.updated', { provider: settings.target.label }),
      });
      savingRef.current = false;
      close();
      if (settings.target.scope === 'credential') void loadAccountFiles();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => `${model.id} ${model.displayName ?? ''}`.toLowerCase().includes(query));
  }, [search, models]);

  const setExcluded = (chosen: OAuthModelDefinition[], excluded: boolean) => {
    if (savingRef.current) return;
    setRulesText((current) => setOAuthModelsExcluded(current.split(/\r?\n/), chosen, excluded).join('\n'));
  };

  return (
    <Dialog open={target !== null} onOpenChange={(next) => { if (!next && !saving) close(); }}>
      <DialogPopup className="max-w-xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{t(target?.scope === 'credential' ? 'authFiles.models.title' : 'authFiles.models.globalButton')}</DialogTitle>
          <DialogDescription>{target ? t(target.scope === 'credential' ? 'authFiles.models.description' : 'authFiles.models.globalDescription', { provider: target.label }) : ''}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {target?.scope === 'credential' ? (
            <code className="block truncate rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 font-mono text-sm dark:bg-input/24" title={target.name}>{target.name}</code>
          ) : target ? (
            <div className="flex items-center justify-between gap-4">
              <Label>{t('authFiles.models.provider')}</Label>
              <Select
                value={target.provider}
                disabled={saving}
                onValueChange={(value) => {
                  const provider = providers.find((item) => item.provider === value);
                  if (provider) onTarget({ ...provider, scope: 'provider' });
                }}
              >
                <SelectTrigger size="sm" className="w-48" aria-label={t('authFiles.models.provider')}>
                  <SelectValue>{providerLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {providers.map((provider) => <SelectItem key={provider.provider} value={provider.provider}>{provider.label}</SelectItem>)}
                </SelectPopup>
              </Select>
            </div>
          ) : null}

          <Input
            size="sm"
            type="search"
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t('authFiles.models.search')}
            aria-label={t('authFiles.models.search')}
            startAddon={<Search />}
          />

          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t('authFiles.models.summary', { total: models.length, excluded: excludedCount })}</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost-muted" size="xs" onClick={() => setExcluded(models, true)} disabled={dialogBusy || models.length === 0} focusableWhenDisabled title={t('authFiles.models.excludeAllHint')}>{t('authFiles.models.excludeAll')}</Button>
              <Button variant="ghost-muted" size="xs" onClick={() => setExcluded(models, false)} disabled={dialogBusy || models.length === 0} focusableWhenDisabled title={t('authFiles.models.clearHint')}>{t('authFiles.models.clearSelected')}</Button>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Spinner />{t('authFiles.models.loading')}</div>
            ) : error && !settings ? (
              <div className="p-3">
                <Alert variant="error" icon={<AlertCircle />}>
                  <div className="font-medium">{t('authFiles.models.loadFailed')}</div>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            ) : (
              <>
                {error ? <div className="border-b border-border/50 p-2"><Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert></div> : null}
                {settings?.catalogError ? <div className="border-b border-border/50 p-2"><Alert variant="warning" icon={<AlertCircle />} role="status"><AlertDescription>{t('authFiles.models.catalogUnavailable')}</AlertDescription></Alert></div> : null}
                {visible.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">{models.length ? t('authFiles.models.noMatch') : t('authFiles.models.empty')}</div>
                ) : (
                  <ul className="[&>li+li]:border-t [&>li+li]:border-border/50">
                    {visible.map((model) => {
                      const wildcardRule = rules.find((rule) => rule.includes('*') && modelMatchesRule(model.id, rule));
                      const checked = rules.some((rule) => modelMatchesRule(model.id, rule));
                      return (
                        <li key={model.id}>
                          <label className={cn('flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-accent/50', checked && 'bg-foreground/[0.03]', wildcardRule && 'cursor-not-allowed opacity-70')}>
                            <Checkbox checked={checked} disabled={saving || Boolean(wildcardRule)} onCheckedChange={(next) => setExcluded([model], next)} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-2">
                                <strong className="truncate font-mono text-sm font-medium" title={model.id}>{model.id}</strong>
                                {model.displayName ? <small className="truncate text-xs text-muted-foreground" title={model.displayName}>{model.displayName}</small> : null}
                              </span>
                              {wildcardRule ? <small className="block text-xs text-warning-foreground">{t('authFiles.models.wildcardBlocked', { rule: wildcardRule })}</small> : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oauth-model-rules">{t('authFiles.models.rulesLabel')}</Label>
            <Textarea id="oauth-model-rules" rows={3} spellCheck={false} value={rulesText} disabled={dialogBusy || !settings} onChange={(event) => setRulesText(event.currentTarget.value)} placeholder={t('authFiles.models.rulesPlaceholder')} aria-describedby="oauth-model-rules-hint" className="min-h-16 font-mono text-sm" />
            <p id="oauth-model-rules-hint" className="text-xs text-muted-foreground">{t('authFiles.models.rulesHint')}</p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={dialogBusy || !settings}>
            {saving ? <Spinner /> : <Check />}
            {saving ? t('common.saving') : t('authFiles.models.save', { count: rules.length })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
