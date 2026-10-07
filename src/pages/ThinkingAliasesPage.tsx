import { useConfirmation } from '../components/ConfirmationDialog';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invokeCommand } from '../native/commands';
import { ArrowRight, BrainCircuit, Check, GitFork, Search, Trash2, Zap } from '../components/ui/icons';
import { toast } from '../components/ui/toast';
import { plainError } from '../services/plainError';
import { translate, useI18n } from '../i18n';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';
import {
  combineModelAliasEntries,
  combineModelAliasSources,
  defaultModelAlias,
  excludeModelOverrides,
  reselectAliasSource,
  thinkingAliasSourceKindLabel,
  uniqueModelAlias,
  type AliasListEntry,
  type ModelAliasSource,
  type ModelOverrideRoute,
} from '../services/modelAliases';
import type { SpeedAliasEntry, ThinkingAliasEntry, ThinkingAliasSource } from '../native/types';

type PresetThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const effortOptions = [
  { value: 'low', label: 'Low', hintKey: 'aliases.effort.low' },
  { value: 'medium', label: 'Medium', hintKey: 'aliases.effort.medium' },
  { value: 'high', label: 'High', hintKey: 'aliases.effort.high' },
  { value: 'xhigh', label: 'XHigh', hintKey: 'aliases.effort.xhigh' },
  { value: 'max', label: 'Max', hintKey: 'aliases.effort.max' },
] as const satisfies ReadonlyArray<{ value: PresetThinkingEffort; label: string; hintKey: string }>;

const thinkingAliasProviderDetail = (kind: string, provider: string) => (
  provider === thinkingAliasSourceKindLabel(kind)
    ? translate('aliases.source.available')
    : provider
);

const thinkingAliasSourceDetail = (source: ThinkingAliasSource) => (
  thinkingAliasProviderDetail(source.kind, source.provider)
);

export function ThinkingAliasesPage() {
  const { askConfirmation } = useConfirmation();
  const { t } = useI18n();
  const [thinkingEntries, setThinkingEntries] = useState<ThinkingAliasEntry[]>([]);
  const [speedEntries, setSpeedEntries] = useState<SpeedAliasEntry[]>([]);
  const [baseSources, setBaseSources] = useState<ThinkingAliasSource[]>([]);
  const [thinkingSources, setThinkingSources] = useState<ThinkingAliasSource[]>([]);
  const [speedSources, setSpeedSources] = useState<ThinkingAliasSource[]>([]);
  const [modelOverrides, setModelOverrides] = useState<ModelOverrideRoute[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const selectedSourceRef = useRef<ThinkingAliasSource | null>(null);
  const [effort, setEffort] = useState('');
  const [fastEnabled, setFastEnabled] = useState(false);
  const [alias, setAlias] = useState('');
  const [search, setSearch] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const generatedAliasRef = useRef('');
  const [loading, setLoading] = useState(true);
  const [busyAlias, setBusyAlias] = useState('');
  const [busyAction, setBusyAction] = useState<'create' | 'delete' | ''>('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [
        nextThinkingEntries,
        nextBaseSources,
        nextThinkingSources,
        nextSpeedEntries,
        nextSpeedSources,
        nextModelOverrides,
      ] = await Promise.all([
        invokeCommand('get_thinking_aliases'),
        invokeCommand('get_model_alias_sources'),
        invokeCommand('get_thinking_alias_sources'),
        invokeCommand('get_speed_aliases'),
        invokeCommand('get_speed_alias_sources'),
        invokeCommand('get_model_overrides'),
      ]);
      setThinkingEntries(nextThinkingEntries);
      setSpeedEntries(nextSpeedEntries);
      setModelOverrides(nextModelOverrides);
      setBaseSources(nextBaseSources);
      setThinkingSources(nextThinkingSources);
      setSpeedSources(nextSpeedSources);
      setSelectedSourceId((current) => (
        reselectAliasSource(current, selectedSourceRef.current, nextBaseSources)
      ));
    } catch (requestError) {
      setError(plainError(requestError, t));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelPickerOpen) return undefined;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [modelPickerOpen]);

  const sources = useMemo(
    () => combineModelAliasSources(baseSources, thinkingSources, speedSources),
    [baseSources, speedSources, thinkingSources],
  );
  const entries = useMemo(
    () => excludeModelOverrides(
      combineModelAliasEntries(thinkingEntries, speedEntries),
      modelOverrides,
    ),
    [modelOverrides, speedEntries, thinkingEntries],
  );

  useEffect(() => {
    setSelectedSourceId((current) => (
      sources.some((source) => source.id === current) ? current : ''
    ));
  }, [sources]);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources],
  );
  useEffect(() => {
    selectedSourceRef.current = selectedSource;
  }, [selectedSource]);
  const fastAvailable = Boolean(selectedSource?.supportsFast);

  useEffect(() => {
    if (!fastAvailable) {
      setFastEnabled(false);
    }
  }, [fastAvailable]);

  const filteredSources = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sources;
    return sources
      .map((source, index) => {
        const model = source.model.toLowerCase();
        const displayName = (source.displayName ?? '').toLowerCase();
        const haystack = `${model} ${displayName} ${source.provider} ${thinkingAliasSourceKindLabel(source.kind)}`
          .toLowerCase();
        let score = 5;
        if (model === query) score = 0;
        else if (displayName === query) score = 1;
        else if (model.startsWith(query)) score = 2;
        else if (displayName.startsWith(query)) score = 3;
        else if (haystack.includes(query)) score = 4;
        return { source, index, score };
      })
      .filter((item) => item.score < 5)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((item) => item.source);
  }, [sources, search]);

  useEffect(() => {
    setActiveSourceIndex(0);
  }, [search, sources]);

  const chooseSource = (source: ModelAliasSource) => {
    setSelectedSourceId(source.id);
    setEffort('');
    setFastEnabled((current) => current && source.supportsFast);
    setAlias('');
    generatedAliasRef.current = '';
    setModelPickerOpen(false);
    setSearch('');
  };

  const chooseEffort = (nextEffort: string) => {
    setEffort(nextEffort);
  };

  const handleModelSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setModelPickerOpen(false);
      setSearch('');
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!modelPickerOpen) {
        setModelPickerOpen(true);
        return;
      }
      if (!filteredSources.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveSourceIndex((current) => (
        (current + direction + filteredSources.length) % filteredSources.length
      ));
      return;
    }
    if (event.key === 'Enter' && modelPickerOpen && filteredSources[activeSourceIndex]) {
      event.preventDefault();
      chooseSource(filteredSources[activeSourceIndex]);
    }
  };

  const normalizedEffort = effort.trim().toLowerCase();
  const defaultAlias = defaultModelAlias(selectedSource?.model, normalizedEffort, fastEnabled);
  const uniqueDefaultAlias = uniqueModelAlias(defaultAlias, sources.map((source) => source.model));
  const availableEfforts = selectedSource?.reasoningLevels ?? [];
  const visibleEffortOptions = availableEfforts.map((value) => {
    const preset = effortOptions.find((option) => option.value === value);
    return preset
      ? { value: preset.value, label: preset.label, title: t(preset.hintKey) }
      : { value, label: value, title: value };
  });

  useEffect(() => {
    // The name follows the model and options until it's typed over. The updater stays pure: React may run it twice,
    // and one that moved the ref itself refused the second run, which left the first generated name in place.
    const generated = generatedAliasRef.current;
    generatedAliasRef.current = uniqueDefaultAlias;
    setAlias((current) => {
      const currentValue = current.trim();
      return !currentValue || currentValue === generated ? uniqueDefaultAlias : current;
    });
  }, [uniqueDefaultAlias]);

  const createAlias = async () => {
    if (!selectedSource) {
      setError(t('aliases.error.selectModel'));
      return;
    }
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) {
      setError(t('aliases.error.emptyAlias'));
      return;
    }
    if (fastEnabled && !selectedSource.supportsFast) {
      setError(t('aliases.error.unsupportedFast'));
      return;
    }
    if (normalizedEffort && !selectedSource.supportsReasoning) {
      setError(t('aliases.error.unsupportedEffort'));
      return;
    }
    setBusyAlias(normalizedAlias);
    setBusyAction('create');
    setError('');
    try {
      if (normalizedEffort) {
        await invokeCommand('create_thinking_alias', {
          sourceId: selectedSource.id,
          alias: normalizedAlias,
          effort: normalizedEffort,
          fast: fastEnabled,
        });
        toast({ kind: 'success', title: t(fastEnabled ? 'aliases.createdCombined' : 'aliases.created', {
          alias: normalizedAlias,
          effort: normalizedEffort,
        }) });
      } else if (fastEnabled) {
        await invokeCommand('create_speed_alias', {
          sourceId: selectedSource.id,
          alias: normalizedAlias,
        });
        toast({ kind: 'success', title: t('speedAliases.created', { alias: normalizedAlias }) });
      } else {
        await invokeCommand('create_thinking_alias', {
          sourceId: selectedSource.id,
          alias: normalizedAlias,
          effort: '',
          fast: false,
        });
        toast({ kind: 'success', title: t('aliases.createdPlain', { alias: normalizedAlias }) });
      }
      setAlias('');
      await load();
    } catch (requestError) {
      setError(plainError(requestError, t));
    } finally {
      setBusyAlias('');
      setBusyAction('');
    }
  };

  const deleteAlias = async (entry: AliasListEntry) => {
    if (!await askConfirmation({ title: t('common.delete'), message: t('aliases.deleteConfirm', { alias: entry.alias }), confirmText: t('common.delete'), variant: 'danger' })) return;
    setBusyAlias(entry.alias);
    setBusyAction('delete');
    setError('');
    try {
      if (entry.effort || !entry.serviceTier) {
        await invokeCommand('delete_thinking_alias', {
          alias: entry.alias,
          oauthChannel: entry.oauthChannel,
        });
      } else {
        await invokeCommand('delete_speed_alias', {
          alias: entry.alias,
          oauthChannel: entry.oauthChannel,
        });
      }
      toast({ kind: 'success', title: t('aliases.deleted', { alias: entry.alias }) });
      await load();
    } catch (requestError) {
      setError(plainError(requestError, t));
    } finally {
      setBusyAlias('');
      setBusyAction('');
    }
  };

  const busy = Boolean(busyAlias);
  const effortLocked = Boolean(selectedSource && !selectedSource.supportsReasoning);
  const aliasPlaceholder = selectedSource
    ? normalizedEffort
      ? t('aliases.aliasName.example', { model: selectedSource.model, effort: normalizedEffort })
      : fastEnabled
        ? t('speedAliases.aliasName.example', { model: selectedSource.model })
        : t('aliases.aliasName.example', { model: selectedSource.model, effort: 'alias' })
    : t('aliases.aliasName.selectFirst');

  return (
    <>
      <div aria-live="polite" className="empty:hidden">
        {error ? (
          <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
        ) : null}
      </div>

      <SettingsSection settingId="aliases.create" title={t('aliases.create.title')} description={t('aliases.create.description')}>
        <SettingsRow
          title={<label htmlFor="thinking-model-search">{t('aliases.originalModel')}</label>}
          description={selectedSource ? t('aliases.sourceLabel', { source: thinkingAliasSourceDetail(selectedSource) }) : t('aliases.sourceHint')}
          align="start"
          control={
            <div className="relative w-80" ref={modelPickerRef}>
              <Input
                id="thinking-model-search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={modelPickerOpen}
                aria-controls="thinking-model-options"
                aria-activedescendant={modelPickerOpen && filteredSources[activeSourceIndex]
                  ? `thinking-model-option-${activeSourceIndex}`
                  : undefined}
                value={modelPickerOpen ? search : selectedSource?.model ?? ''}
                onFocus={(event) => {
                  setSearch(selectedSource?.model ?? '');
                  setModelPickerOpen(true);
                  event.currentTarget.select();
                }}
                onChange={(event) => {
                  const nextSearch = event.currentTarget.value;
                  setSearch(nextSearch);
                  setModelPickerOpen(true);
                  if (
                    selectedSource
                    && nextSearch.trim().toLowerCase() !== selectedSource.model.trim().toLowerCase()
                  ) {
                    setSelectedSourceId('');
                    setEffort('');
                    setFastEnabled(false);
                    setAlias('');
                    generatedAliasRef.current = '';
                  }
                }}
                onKeyDown={handleModelSearchKeyDown}
                placeholder={loading ? t('aliases.loadingModels') : t('aliases.searchModel')}
                autoComplete="off"
                spellCheck={false}
                disabled={loading}
                font="mono"
                startAddon={loading ? <Spinner /> : <Search />}
                endAddon={!modelPickerOpen && selectedSource ? (
                  <Badge variant="muted" className="me-1">{thinkingAliasSourceKindLabel(selectedSource.kind)}</Badge>
                ) : undefined}
              />
              {modelPickerOpen ? (
                <div
                  className="dropdown-glass absolute inset-x-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-lg p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
                  id="thinking-model-options"
                  role="listbox"
                  aria-label={t('aliases.availableModels')}
                >
                  {filteredSources.length === 0 ? (
                    <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                      {sources.length ? t('aliases.noMatch') : t('aliases.noModels')}
                    </div>
                  ) : filteredSources.map((source, index) => {
                    const selected = source.id === selectedSourceId;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        id={`thinking-model-option-${index}`}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none disabled:pointer-events-none disabled:opacity-64',
                          index === activeSourceIndex && 'bg-accent text-accent-foreground',
                          selected && 'bg-foreground/[0.06]',
                        )}
                        key={source.id}
                        onMouseEnter={() => setActiveSourceIndex(index)}
                        onClick={() => chooseSource(source)}
                        disabled={busy}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <strong className="truncate font-mono text-sm font-medium" title={source.model}>{source.model}</strong>
                            {source.displayName && source.displayName !== source.model
                              ? <small className="truncate text-xs text-muted-foreground">{source.displayName}</small>
                              : null}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground" title={thinkingAliasSourceDetail(source)}>
                            {thinkingAliasSourceKindLabel(source.kind)} · {thinkingAliasSourceDetail(source)}
                          </span>
                        </span>
                        {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          }
        />

        <SettingsRow
          title={t('aliases.effort.title')}
          description={effortLocked ? t('aliases.effort.unsupported') : t('aliases.effort.description')}
          control={
            <ToggleGroup
              value={[normalizedEffort || 'none']}
              disabled={busy}
              aria-label={t('aliases.effort.title')}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next !== 'string') return;
                chooseEffort(next === 'none' ? '' : next);
              }}
            >
              <Toggle value="none" title={t('aliases.effort.noneHint')}>{t('aliases.effort.none')}</Toggle>
              {visibleEffortOptions.map((option) => (
                <Toggle key={option.value} value={option.value} disabled={effortLocked} title={option.title}>
                  {option.label}
                </Toggle>
              ))}
            </ToggleGroup>
          }
        />

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <Zap className="size-3.5 text-warning" aria-hidden="true" />
              {t('aliases.fast.title')}
            </span>
          }
          description={selectedSource && !selectedSource.supportsFast
            ? t('aliases.fast.unsupported')
            : fastEnabled ? t('aliases.fast.enabled') : t('aliases.fast.disabled')}
          control={
            <Switch
              checked={fastEnabled}
              onCheckedChange={setFastEnabled}
              disabled={busy || !fastAvailable}
              aria-label={t('aliases.fast.title')}
            />
          }
        />

        <SettingsRow
          title={<label htmlFor="thinking-alias-name">{t('aliases.aliasName.title')}</label>}
          description={t('aliases.aliasName.autoDescription')}
          control={
            <Input
              id="thinking-alias-name"
              value={alias}
              onChange={(event) => setAlias(event.currentTarget.value)}
              placeholder={aliasPlaceholder}
              disabled={busy}
              wrapperClassName="w-80"
              font="mono"
            />
          }
        />

        <SettingsBlock className="flex items-center justify-between gap-4 bg-muted/40 py-2.5 dark:bg-input/10">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground dark:bg-input/32" aria-hidden="true">
              {fastEnabled && !normalizedEffort ? <Zap className="size-3.5" /> : <BrainCircuit className="size-3.5" />}
            </span>
            <span className={cn('truncate font-mono text-sm', selectedSource ? 'text-foreground' : 'text-muted-foreground')}>{selectedSource?.model || t('aliases.notSelected')}</span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            <span className={cn('truncate font-mono text-sm', alias ? 'font-medium text-foreground' : 'text-muted-foreground')}>{alias || t('aliases.enterAlias')}</span>
          </div>
          <Button size="sm" onClick={() => void createAlias()} disabled={loading || busy}>
            {busyAction === 'create' ? <Spinner /> : fastEnabled && !normalizedEffort ? <Zap /> : <GitFork />}
            {busyAction === 'create' ? t('aliases.creating') : t('aliases.create')}
          </Button>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        settingId="aliases.list"
        title={t('aliases.createdList.title')}
        description={t('aliases.createdList.description')}
        headerAction={<Badge variant="muted">{entries.length}</Badge>}
      >
        {loading ? (
          Array.from({ length: 3 }, (_, index) => (
            <SettingsBlock key={index} className="flex items-center gap-3" aria-hidden="true">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-3" />
              <Skeleton className="h-3.5 w-32" />
            </SettingsBlock>
          ))
        ) : entries.length === 0 ? (
          <Empty size="sm">
            <EmptyMedia><GitFork /></EmptyMedia>
            <EmptyTitle>{t('aliases.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('aliases.empty.description')}</EmptyDescription>
          </Empty>
        ) : entries.map((entry) => (
          <SettingsBlock key={`${entry.kind}:${entry.provider}:${entry.alias}`} className="flex min-h-12 items-center gap-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-muted-foreground" title={entry.sourceModel}>{entry.sourceModel}</div>
                <div className="truncate text-xs text-muted-foreground" title={thinkingAliasProviderDetail(entry.kind, entry.provider)}>
                  {thinkingAliasSourceKindLabel(entry.kind)} · {thinkingAliasProviderDetail(entry.kind, entry.provider)}
                </div>
              </div>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              <strong className="truncate font-mono text-sm font-medium text-foreground" title={entry.alias}>{entry.alias}</strong>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {entry.effort ? <Badge variant="primary">{entry.effort}</Badge> : null}
              {entry.serviceTier ? <Badge variant="warning"><Zap />{t('speedAliases.fast.title')}</Badge> : null}
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-sm"
                    className="hover:text-error"
                    onClick={() => void deleteAlias(entry)}
                    disabled={busy}
                    focusableWhenDisabled
                    aria-label={t('aliases.delete', { alias: entry.alias })}
                  />
                }
              >
                {busyAction === 'delete' && busyAlias === entry.alias ? <Spinner /> : <Trash2 />}
              </TooltipTrigger>
              <TooltipPopup>{t('common.delete')}</TooltipPopup>
            </Tooltip>
          </SettingsBlock>
        ))}
      </SettingsSection>
    </>
  );
}
