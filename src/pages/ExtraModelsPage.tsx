import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { Plus, Sparkles, Trash2 } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { ProviderMark } from '../components/identity/Identity';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { NumberField } from '../components/ui/number-field';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { toast } from '../components/ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useI18n } from '../i18n';
import { useUnsavedChanges } from '../services/unsavedChanges';
import { announceAccessChanges } from '../components/extraModelAccessToast';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import { loadAccountFiles, useAccountsStore } from '../services/accountsStore';
import {
  FIXED_RESERVE_MAX,
  FIXED_RESERVE_MIN,
  LEND_MODES,
  RESERVE_MODES,
  accessLine,
  accessSummary,
  clearDeclined,
  getReservePolicies,
  isPartial,
  lower,
  reapplyExclusions,
  recentUse,
  reserveLine,
  reservePolicyFor,
  runModelAccessCheck,
  providerReserves,
  setReservePolicy,
  undoAccessChanges,
  useModelAccess,
  useReservePolicies,
  type AccessSummary,
  type AccountReserve,
  type ExclusionChange,
  type LendMode,
  type ReserveMode,
  type ReservePolicy,
} from '../services/extraModelAccess';
import { freshQuotas } from '../services/accountLimits';
import { useQuotaCache } from '../services/quotaCache';
import { fileName as fileNameOf, quotaKey } from '../services/quotaService';
import {
  EXTRA_MODEL_STATUS_LABEL,
  LIVE_LIST_SOURCE,
  extraModelFrom,
  extraModelIdProblem,
  extraModelProviderLabel,
  extraModelStatus,
  hasLiveList,
  suggestExtraModels,
  usableAccounts,
  templateFor,
  type ExtraModelStatus,
  type LiveModel,
  type LiveModelsResult,
} from '../services/extraModels';
import type { ExtraModel, ExtraModelsProvider, ExtraModelsView } from '../native/types';

const STATUS_BADGE: Record<ExtraModelStatus, 'success' | 'info' | 'warning' | 'muted'> = {
  active: 'success',
  builtIn: 'info',
  notLoaded: 'warning',
  saved: 'muted',
};

export type Check = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: LiveModelsResult };

/** What a busy button is saving: a model of a provider's, since two providers could share an id. */
const busyKey = (provider: string, model: string) => `${provider}/${model}`;

/** The providers on the page that Arbor can ask for a live list. */
const checkable = (view: ExtraModelsView | null) =>
  (view?.providers ?? []).filter((entry) => hasLiveList(entry.provider));

/** Where an extra model stands across its provider's accounts, for its row. */
export type ModelAccessRow = {
  summary: AccessSummary;
  /** The accounts' names, by credential file name. */
  names: Record<string, string>;
  policy: ReservePolicy;
  /** Requests for it that worked this week. */
  recent: number;
  /** Someone undid keeping it from accounts without it, so it still goes to them. */
  declined: string[];
  /** The reserves the accounts with it keep, by credential file name. */
  reserves: [string, AccountReserve][];
};

const RESERVE_LABEL = {
  auto: 'extraModels.reserve.auto',
  fixed: 'extraModels.reserve.fixed',
  never: 'extraModels.reserve.never',
  only: 'extraModels.reserve.only',
} as const satisfies Record<ReserveMode, string>;
const RESERVE_HINT = {
  auto: 'extraModels.reserve.autoHint',
  fixed: 'extraModels.reserve.fixedHint',
  never: 'extraModels.reserve.neverHint',
  only: 'extraModels.reserve.onlyHint',
} as const satisfies Record<ReserveMode, string>;
const LEND_LABEL = {
  floor: 'extraModels.reserve.lend.floor',
  all: 'extraModels.reserve.lend.all',
  hold: 'extraModels.reserve.lend.hold',
} as const satisfies Record<LendMode, string>;
const LEND_HINT = {
  floor: 'extraModels.reserve.lend.floorHint',
  all: 'extraModels.reserve.lend.allHint',
  hold: 'extraModels.reserve.lend.holdHint',
} as const satisfies Record<LendMode, string>;

export function ExtraModelsPage() {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [view, setView] = useState<ExtraModelsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [addProvider, setAddProvider] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [basedOn, setBasedOn] = useState<string | null>(null);
  // npm's latest Codex, which ChatGPT's list is asked as: undefined until asked, null when npm couldn't say.
  const codexVersion = useRef<string | null | undefined>(undefined);
  useUnsavedChanges(newId.trim() !== '');

  const policies = useReservePolicies();
  const access = useModelAccess();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const { files } = useAccountsStore();

  // Asks every account of each provider which models it has: new models for suggestions, and which accounts each extra
  // model is on, which keeps it from the rest.
  const checkLive = useCallback(async (current: ExtraModelsView, providers?: string[]) => {
    const asked = providers ?? current.providers.map((entry) => entry.provider);
    const shown = checkable(current).map((entry) => entry.provider).filter((provider) => asked.includes(provider));
    setChecks((before) => ({ ...before, ...Object.fromEntries(shown.map((provider) => [provider, { state: 'checking' }])) }));
    if (asked.includes('codex') && codexVersion.current === undefined) {
      codexVersion.current = await invokeCommand('get_agent_latest_versions').then((latest) => latest.codex, () => null);
    }
    let result: Awaited<ReturnType<typeof runModelAccessCheck>> | null = null;
    try {
      result = await runModelAccessCheck(current, { codexVersion: codexVersion.current ?? undefined, only: providers });
    } catch (requestError) {
      const failed: LiveModelsResult = { ok: false, message: String(requestError) };
      setChecks((before) => ({ ...before, ...Object.fromEntries(shown.map((provider) => [provider, { state: 'done', result: failed }])) }));
      return;
    }
    const { live, changes, error: changeError } = result;
    setChecks((before) => ({
      ...before,
      ...Object.fromEntries(shown.map((provider): [string, Check] => [
        provider,
        { state: 'done', result: live[provider] ?? { ok: false, reason: 'extraModels.suggestions.noAccount' } },
      ])),
    }));
    if (changeError) setError(t('extraModels.access.failed', { error: changeError }));
    announceAccessChanges(changes, t);
  }, [t]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    void loadAccountFiles();
    try {
      const next = await invokeCommand('get_extra_models');
      setView(next);
      if (next.coreRunning) void checkLive(next);
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, [checkLive]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = useMemo(() => checkable(view), [view]);
  const checking = live.some((entry) => checks[entry.provider]?.state === 'checking');
  const providers = useMemo(() => view?.providers ?? [], [view]);
  const chosen = providers.find((entry) => entry.provider === addProvider) ?? providers[0] ?? null;
  const catalog = useMemo(() => chosen?.catalog ?? [], [chosen]);
  const trimmedId = newId.trim();
  const autoTemplate = useMemo(() => (trimmedId ? templateFor(trimmedId, catalog) : null), [trimmedId, catalog]);
  const template = catalog.find((model) => model.id === basedOn) ?? autoTemplate;
  const idProblem = chosen && trimmedId ? extraModelIdProblem(trimmedId, chosen) : null;

  const save = async (provider: ExtraModelsProvider, models: ExtraModel[], key: string) => {
    setBusy(key);
    setError('');
    try {
      const next = await invokeCommand('set_extra_models', { provider: provider.provider, expected: provider.models, models });
      setView(next);
      // A new model is checked on each account; one taken out has Arbor's rules for it taken back.
      if (next.coreRunning) void checkLive(next, [provider.provider]);
      return next;
    } catch (requestError) {
      setError(String(requestError));
      return null;
    } finally {
      setBusy('');
    }
  };

  const add = async (provider: ExtraModelsProvider, model: ExtraModel) => {
    const key = busyKey(provider.provider, model.id);
    const saved = await save(provider, [...provider.models, model], key);
    if (!saved) return;
    if (provider.provider === chosen?.provider && model.id === trimmedId) {
      setNewId('');
      setBasedOn(null);
    }
    toast({
      kind: 'success',
      title: t(saved.coreRunning ? 'extraModels.added' : 'extraModels.addedStopped', {
        model: model.id,
        provider: extraModelProviderLabel(provider.provider),
      }),
      action: {
        label: t('common.undo'),
        onClick: () => {
          const after = saved.providers.find((entry) => entry.provider === provider.provider);
          if (after) void save(after, after.models.filter((entry) => entry.id !== model.id), key);
        },
      },
    });
  };

  const addSuggestion = (provider: ExtraModelsProvider, suggestion: LiveModel) =>
    add(provider, extraModelFrom(suggestion.id, suggestion.displayName, templateFor(suggestion.id, provider.catalog), suggestion.details));

  const addById = () => {
    if (!chosen || !trimmedId || idProblem) return;
    void add(chosen, extraModelFrom(trimmedId, null, template));
  };

  const remove = async (provider: ExtraModelsProvider, model: ExtraModel) => {
    if (!view) return;
    const builtIn = extraModelStatus(model, provider, view) === 'builtIn';
    if (!await askConfirmation({
      title: t('extraModels.removeConfirm.title', { model: model.id }),
      message: t(builtIn ? 'extraModels.removeConfirm.builtIn' : 'extraModels.removeConfirm.message', { model: model.id }),
      confirmText: t('extraModels.removeConfirm.confirm'),
      variant: builtIn ? 'primary' : 'danger',
    })) return;
    if (await save(provider, provider.models.filter((entry) => entry.id !== model.id), busyKey(provider.provider, model.id))) {
      toast({ kind: 'success', title: t('extraModels.removed', { model: model.id }) });
    }
  };

  const reapply = async (current: ExtraModelsView): Promise<ExclusionChange[]> => {
    try {
      const { changes, error: changeError } = await reapplyExclusions(current);
      if (changeError) setError(t('extraModels.access.failed', { error: changeError }));
      if (changes.length > 0) void loadAccountFiles();
      return changes;
    } catch (requestError) {
      setError(t('extraModels.access.failed', { error: String(requestError) }));
      return [];
    }
  };

  // A reserve at or below the account's limit is fenced by the limits monitor, which picks a change up at once; only
  // "Serve only this model" is applied here, as it doesn't wait on the limits.
  const changePolicy = async (provider: ExtraModelsProvider, model: ExtraModel, change: Partial<ReservePolicy>) => {
    if (!view) return;
    const before = reservePolicyFor(getReservePolicies(), provider.provider, model.id);
    const next = { ...before, ...change };
    if (next.mode === before.mode && next.percent === before.percent && next.lend === before.lend) return;
    setReservePolicy(provider.provider, model.id, change);
    const changes = next.mode === 'only' || before.mode === 'only' ? await reapply(view) : [];
    // A share typed in is saved as it's typed, so it gets no toast of its own.
    if (change.percent !== undefined && change.mode === undefined && change.lend === undefined) return;
    toast({
      kind: 'success',
      title: t('extraModels.reserve.saved', { model: model.id, mode: t(change.lend ? LEND_LABEL[change.lend] : RESERVE_LABEL[next.mode]) }),
      action: {
        label: t('common.undo'),
        onClick: () => {
          setReservePolicy(provider.provider, model.id, before);
          if (changes.length > 0) void undoAccessChanges(changes, false).finally(() => void loadAccountFiles());
        },
      },
    });
  };

  const sendOnly = async (model: ExtraModel, accounts: string[]) => {
    if (!view) return;
    clearDeclined(model.id, accounts);
    announceAccessChanges(await reapply(view), t);
  };

  const reservesBy = useMemo(() => {
    const fresh = freshQuotas(quotas);
    return new Map(Object.keys(access.providers).map((provider) => [provider, providerReserves(files, fresh, access, policies, provider, Date.now())]));
  }, [files, quotas, access, policies]);

  const rowAccess = (provider: ExtraModelsProvider, model: ExtraModel): ModelAccessRow | null => {
    const usable = usableAccounts(files, provider.provider);
    if (usable.length === 0) return null;
    const names = Object.fromEntries(usable.map((file) => {
      const name = fileNameOf(file);
      return [name, resolveAccountProfile(quotaKey(file), name, profiles[quotaKey(file)]).name];
    }));
    const id = lower(model.id);
    return {
      summary: accessSummary(access, model.id, Object.keys(names)),
      names,
      policy: reservePolicyFor(policies, provider.provider, model.id),
      recent: recentUse(access, provider.provider, model.id),
      declined: Object.keys(names).filter((name) => (access.declined[name] ?? []).includes(id)),
      reserves: [...(reservesBy.get(provider.provider) ?? new Map<string, AccountReserve>())].filter(([, reserve]) => reserve.models.includes(id)),
    };
  };

  const unserved = view?.coreRunning ? providers.filter((entry) => entry.models.length > 0 && !entry.pluginLoaded) : [];
  const unservedLabels = unserved.map((entry) => extraModelProviderLabel(entry.provider)).join(', ');
  const modelCount = providers.reduce((count, entry) => count + entry.models.length, 0);

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('extraModels.page.title')]} />
      </PageTopbar>
      <PageBody>
        <div aria-live="polite" className="empty:hidden">
          {error ? (
            <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
          ) : unserved.length > 0 ? (
            <Alert variant="warning">
              <AlertDescription>
                {t(unserved.every((entry) => entry.pluginInstalled) ? 'extraModels.warning.notLoaded' : 'extraModels.warning.notInstalled', { provider: unservedLabels })}
              </AlertDescription>
            </Alert>
          ) : view && !view.coreRunning ? (
            <Alert variant="info"><AlertDescription>{t('extraModels.warning.coreStopped')}</AlertDescription></Alert>
          ) : null}
        </div>

        <SettingsSection
          settingId="extra-models.suggestions"
          title={t('extraModels.suggestions.title')}
          description={t('extraModels.suggestions.description')}
          headerAction={
            <Button
              size="sm"
              variant="outline"
              onClick={() => { if (view) void checkLive(view); }}
              disabled={loading || checking || !view?.coreRunning || live.length === 0}
              disabledReason={view && !view.coreRunning ? t('extraModels.suggestions.coreStopped') : undefined}
            >
              <RefreshIcon refreshing={checking} />
              {t('extraModels.suggestions.check')}
            </Button>
          }
        >
          {loading ? (
            <SuggestionRows provider={null} check={{ state: 'checking' }} suggestions={[]} busy={busy} onAdd={() => {}} />
          ) : !view?.coreRunning ? (
            <SettingsBlock className="py-3 text-sm text-muted-foreground">{t('extraModels.suggestions.coreStopped')}</SettingsBlock>
          ) : live.length === 0 ? (
            <SettingsBlock className="py-3 text-sm text-muted-foreground">{t('extraModels.suggestions.noSources')}</SettingsBlock>
          ) : live.map((provider) => {
            const check = checks[provider.provider] ?? { state: 'idle' };
            return (
              <SuggestionRows
                key={provider.provider}
                provider={provider}
                check={check}
                suggestions={check.state === 'done' && check.result.ok ? suggestExtraModels(check.result.models, provider, view.served) : []}
                busy={busy}
                onAdd={(suggestion) => void addSuggestion(provider, suggestion)}
              />
            );
          })}
        </SettingsSection>

        <SettingsSection
          settingId="extra-models.list"
          title={t('extraModels.list.title')}
          description={t('extraModels.list.description')}
          headerAction={<Badge variant="muted">{modelCount}</Badge>}
        >
          <ExtraModelRows
            view={loading ? null : view}
            busy={busy}
            onRemove={(provider, model) => void remove(provider, model)}
            accessFor={rowAccess}
            onPolicy={(provider, model, change) => void changePolicy(provider, model, change)}
            onSendOnly={(model, accounts) => void sendOnly(model, accounts)}
          />
        </SettingsSection>

        <SettingsSection settingId="extra-models.add" title={t('extraModels.add.title')} description={t('extraModels.add.description')}>
          {providers.length > 1 ? (
            <SettingsRow
              title={t('extraModels.add.provider.title')}
              description={t('extraModels.add.provider.description')}
              control={
                <Select
                  value={chosen?.provider ?? ''}
                  onValueChange={(value) => {
                    setAddProvider(value || null);
                    setBasedOn(null);
                  }}
                  disabled={loading || Boolean(busy)}
                >
                  <SelectTrigger className="w-80" aria-label={t('extraModels.add.provider.title')}>
                    <SelectValue>
                      {chosen ? <ProviderOption provider={chosen.provider} /> : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {providers.map((entry) => (
                      <SelectItem key={entry.provider} value={entry.provider}>
                        <ProviderOption provider={entry.provider} />
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
          <SettingsRow
            title={<label htmlFor="extra-model-id">{t('extraModels.add.id.title')}</label>}
            description={t('extraModels.add.id.description')}
            control={
              <Input
                id="extra-model-id"
                value={newId}
                onChange={(event) => setNewId(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addById();
                }}
                placeholder={t('extraModels.add.id.placeholder')}
                disabled={loading || Boolean(busy) || !chosen}
                wrapperClassName="w-80"
                font="mono"
                autoComplete="off"
                spellCheck={false}
              />
            }
          />
          <SettingsRow
            title={t('extraModels.add.basedOn.title')}
            description={t('extraModels.add.basedOn.description')}
            control={
              <Select value={template?.id ?? ''} onValueChange={(value) => setBasedOn(value || null)} disabled={loading || Boolean(busy) || catalog.length === 0}>
                <SelectTrigger className="w-80 font-mono" aria-label={t('extraModels.add.basedOn.title')}>
                  <SelectValue placeholder={t(catalog.length === 0 ? 'extraModels.add.basedOn.none' : 'extraModels.add.basedOn.hint')}>
                    {template?.id}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {catalog.map((model) => (
                    <SelectItem key={model.id} value={model.id} className="font-mono text-sm">
                      {model.id}
                      {model.displayName ? <span className="ms-2 font-sans text-xs text-muted-foreground">{model.displayName}</span> : null}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsBlock className="flex items-center justify-between gap-4 bg-muted/40 py-2.5 dark:bg-input/10">
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {!chosen && !loading
                ? t('extraModels.add.noProvider')
                : idProblem ? t(idProblem) : trimmedId && template ? t('extraModels.basedOn', { model: template.id }) : t('extraModels.add.hint')}
            </span>
            <Button size="sm" onClick={addById} disabled={loading || Boolean(busy) || !chosen || !trimmedId || Boolean(idProblem)}>
              {chosen && busy === busyKey(chosen.provider, trimmedId) ? <Spinner /> : <Plus />}
              {t('extraModels.add.submit')}
            </Button>
          </SettingsBlock>
        </SettingsSection>
        <p className="px-4 text-xs text-muted-foreground">{t('extraModels.note')}</p>
      </PageBody>
    </Page>
  );
}

function ProviderOption({ provider }: { provider: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProviderMark provider={provider} decorative />
      <span className="truncate">{extraModelProviderLabel(provider)}</span>
    </span>
  );
}

/** The provider's mark in the square a row starts with, or a sparkle for one Arbor has no mark for. */
function RowMark({ provider }: { provider: string | null }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground dark:bg-input/32">
      {provider ? <ProviderMark provider={provider} fallback={<Sparkles className="size-3.5" aria-hidden="true" />} /> : <Sparkles className="size-3.5" aria-hidden="true" />}
    </span>
  );
}

/** A provider's new models, each with Add; or why there are none to show. */
export function SuggestionRows({ provider, check, suggestions, busy, onAdd }: {
  provider: ExtraModelsProvider | null;
  check: Check;
  suggestions: LiveModel[];
  busy: string;
  onAdd: (suggestion: LiveModel) => void;
}) {
  const { t } = useI18n();
  const key = provider?.provider ?? '';
  const names = { provider: extraModelProviderLabel(key), source: LIVE_LIST_SOURCE[key] ?? extraModelProviderLabel(key) };
  const message = (text: string) => (
    <SettingsBlock className="flex min-h-12 items-center gap-3 py-2 text-sm text-muted-foreground">
      <RowMark provider={key} />
      <span className="min-w-0 flex-1">{text}</span>
    </SettingsBlock>
  );
  if (check.state === 'checking') {
    return (
      <SettingsBlock className="flex min-h-12 items-center gap-3 py-2" aria-hidden="true">
        {provider ? <RowMark provider={key} /> : null}
        <Skeleton className="h-3.5 w-44" />
        <Skeleton className="h-3 w-24" />
      </SettingsBlock>
    );
  }
  if (check.state === 'idle') return message(t('extraModels.suggestions.coreStopped'));
  if (!check.result.ok) {
    return message('reason' in check.result
      ? t(check.result.reason, names)
      : t('extraModels.suggestions.failed', { ...names, reason: check.result.message }));
  }
  if (suggestions.length === 0) return message(t('extraModels.suggestions.none', names));
  return (
    <>
      {suggestions.map((suggestion) => {
        // Details the live list gave come first, so it's named as their source over the template.
        const detailsFrom = suggestion.details ? names.source : provider ? templateFor(suggestion.id, provider.catalog)?.id : null;
        return (
          <SettingsBlock key={suggestion.id} className="flex min-h-12 items-center gap-3 py-2">
            <RowMark provider={key} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm text-foreground" title={suggestion.id}>{suggestion.id}</div>
              <div className="truncate text-xs text-muted-foreground">
                {suggestion.displayName ?? suggestion.id}
                {detailsFrom ? ` · ${t('extraModels.basedOn', { model: detailsFrom })}` : ''}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => onAdd(suggestion)}
              aria-label={t('extraModels.addModel', { model: suggestion.id })}
            >
              {busy === busyKey(key, suggestion.id) ? <Spinner /> : <Plus />}
              {t('common.add')}
            </Button>
          </SettingsBlock>
        );
      })}
    </>
  );
}

/** Every provider's extra models, each with its provider, where it stands and Remove; skeletons while `view` is loading. */
export function ExtraModelRows({ view, busy, onRemove, accessFor = () => null, onPolicy = () => {}, onSendOnly = () => {} }: {
  view: ExtraModelsView | null;
  busy: string;
  onRemove: (provider: ExtraModelsProvider, model: ExtraModel) => void;
  /** Where the model stands across its provider's accounts, or null when that isn't known. */
  accessFor?: (provider: ExtraModelsProvider, model: ExtraModel) => ModelAccessRow | null;
  onPolicy?: (provider: ExtraModelsProvider, model: ExtraModel, change: Partial<ReservePolicy>) => void;
  onSendOnly?: (model: ExtraModel, accounts: string[]) => void;
}) {
  const { t } = useI18n();
  if (!view) {
    return (
      <SettingsBlock className="flex items-center gap-3" aria-hidden="true">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3.5 w-16" />
      </SettingsBlock>
    );
  }
  const rows = view.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  if (rows.length === 0) {
    return (
      <Empty size="sm">
        <EmptyMedia><Sparkles /></EmptyMedia>
        <EmptyTitle>{t('extraModels.empty.title')}</EmptyTitle>
        <EmptyDescription>{t('extraModels.empty.description')}</EmptyDescription>
      </Empty>
    );
  }
  return (
    <>
      {rows.map(({ provider, model }) => {
        const status = extraModelStatus(model, provider, view);
        const key = busyKey(provider.provider, model.id);
        const row = status === 'builtIn' ? null : accessFor(provider, model);
        const where = row ? accessLine(row.summary, extraModelProviderLabel(provider.provider), row.names) : null;
        const partial = row ? isPartial(row.summary) : false;
        const reserve = row && partial ? reserveLine(row.policy.mode, row.recent, row.reserves, row.names) : null;
        const reserving = row !== null && (row.policy.mode === 'auto' || row.policy.mode === 'fixed');
        return (
          <SettingsBlock key={key} className="flex min-h-12 items-center gap-3 py-2">
            <RowMark provider={provider.provider} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm text-foreground" title={model.id}>{model.id}</div>
              {status === 'builtIn' ? (
                <div className="truncate text-xs text-muted-foreground">{t('extraModels.builtInHint')}</div>
              ) : model.displayName || where ? (
                <div className="truncate text-xs text-muted-foreground">
                  {[model.displayName, where ? t(where.key, where.values) : null].filter(Boolean).join(' · ')}
                </div>
              ) : null}
              {reserve ? <div className="truncate text-xs text-muted-foreground">{t(reserve.key, reserve.values)}</div> : null}
              {row && row.declined.length > 0 ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{t('extraModels.access.sentEverywhere')}</span>
                  <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => onSendOnly(model, row.declined)} disabled={Boolean(busy)}>
                    {t('extraModels.access.sendOnly')}
                  </Button>
                </div>
              ) : null}
            </div>
            {row && partial ? (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Select value={row.policy.mode} onValueChange={(value) => { if (value) onPolicy(provider, model, { mode: value as ReserveMode }); }} disabled={Boolean(busy)}>
                  <SelectTrigger size="sm" className="w-44" aria-label={t('extraModels.reserve.aria', { model: model.id })}>
                    <SelectValue>{t(RESERVE_LABEL[row.policy.mode])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {RESERVE_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        <span className="flex flex-col">
                          <span>{t(RESERVE_LABEL[mode])}</span>
                          <span className="text-xs text-muted-foreground">{t(RESERVE_HINT[mode])}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {row.policy.mode === 'fixed' ? (
                  <NumberField
                    wrapperClassName="w-20"
                    min={FIXED_RESERVE_MIN}
                    max={FIXED_RESERVE_MAX}
                    step={1}
                    value={row.policy.percent}
                    onValueChange={(next) => { if (next !== null && Number.isFinite(next)) onPolicy(provider, model, { percent: next }); }}
                    unit="%"
                    disabled={Boolean(busy)}
                    aria-label={t('extraModels.reserve.percentAria', { model: model.id })}
                  />
                ) : null}
                {reserving ? (
                  <Select value={row.policy.lend} onValueChange={(value) => { if (value) onPolicy(provider, model, { lend: value as LendMode }); }} disabled={Boolean(busy)}>
                    <SelectTrigger size="sm" className="w-44" aria-label={t('extraModels.reserve.lendAria', { model: model.id })}>
                      <SelectValue>{t(LEND_LABEL[row.policy.lend])}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      {LEND_MODES.map((lend) => (
                        <SelectItem key={lend} value={lend}>
                          <span className="flex flex-col">
                            <span>{t(LEND_LABEL[lend])}</span>
                            <span className="text-xs text-muted-foreground">{t(LEND_HINT[lend])}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </div>
            ) : null}
            <Badge variant={STATUS_BADGE[status]} className="shrink-0">{t(EXTRA_MODEL_STATUS_LABEL[status])}</Badge>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-sm"
                    className="hover:text-error"
                    onClick={() => onRemove(provider, model)}
                    disabled={Boolean(busy)}
                    focusableWhenDisabled
                    aria-label={t('extraModels.remove', { model: model.id })}
                  />
                }
              >
                {busy === key ? <Spinner /> : <Trash2 />}
              </TooltipTrigger>
              <TooltipPopup>{t('extraModels.removeConfirm.confirm')}</TooltipPopup>
            </Tooltip>
          </SettingsBlock>
        );
      })}
    </>
  );
}
