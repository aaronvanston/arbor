import { useCallback, useEffect, useMemo, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { ArrowRight, Check, Route, Trash2, Zap } from '../components/ui/icons';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useI18n } from '../i18n';
import { useUnsavedChanges } from '../services/unsavedChanges';
import { errorWords, plainError } from '../services/plainError';
import { cn } from '../lib/utils';
import { thinkingAliasSourceKindLabel } from '../services/modelAliases';
import type { ModelOverrideEntry, ThinkingAliasSource } from '../native/types';

/** A model source as routing reads it: its reasoning levels don't matter here. */
export type RouteSource = Omit<ThinkingAliasSource, 'reasoningLevels'>;

/** Curated one-click routes for the common "out of the flagship, fall back to its sibling" case. */
export const QUICK_ROUTES: ReadonlyArray<{ requested: string; upstream: string; kind: string }> = [
  { requested: 'claude-fable-5-1', upstream: 'claude-opus-5', kind: 'claude-oauth' },
  { requested: 'claude-fable-5', upstream: 'claude-opus-5', kind: 'claude-oauth' },
  { requested: 'claude-opus-5', upstream: 'claude-sonnet-5', kind: 'claude-oauth' },
  { requested: 'gpt-5.6-sol', upstream: 'gpt-5.6-luna', kind: 'codex-oauth' },
];

const stripLongContext = (model: string) => model.replace(/\[1m\]$/i, '');

/** Only OAuth sources can be routed; the core ignores oauth-model-alias for API-key providers. */
export const routableSources = (sources: RouteSource[]) => sources.filter((source) => source.kind.endsWith('-oauth'));

/**
 * The provider kind a requested model belongs to when that's another provider than `upstream`'s: the core only
 * routes a request within one OAuth provider, so a route from another's model would never be used. Null when the
 * name is unknown or one of `upstream`'s own.
 */
export const otherProviderOf = (sources: RouteSource[], requested: string, upstream: RouteSource): string | null => {
  const name = stripLongContext(requested).toLowerCase();
  const owners = routableSources(sources).filter((source) => source.model.toLowerCase() === name).map((source) => source.kind);
  return owners.length && !owners.includes(upstream.kind) ? owners[0] ?? null : null;
};

/** Group routable sources by provider kind so the picker reads as "Claude OAuth → models". */
export const groupSources = (sources: RouteSource[]) => {
  const groups = new Map<string, RouteSource[]>();
  routableSources(sources).forEach((source) => {
    const list = groups.get(source.kind) ?? [];
    list.push(source);
    groups.set(source.kind, list);
  });
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
};

/** Quick routes that apply to the currently available models, with their active state. */
export const availableQuickRoutes = (sources: RouteSource[], overrides: ModelOverrideEntry[]) =>
  QUICK_ROUTES.flatMap((route) => {
    const upstream = sources.find((source) => source.kind === route.kind && source.model.toLowerCase() === route.upstream.toLowerCase());
    const requested = sources.some((source) => source.kind === route.kind && source.model.toLowerCase() === route.requested.toLowerCase());
    if (!upstream || !requested) return [];
    const active = overrides.find((entry) => entry.kind === route.kind && stripLongContext(entry.requestedModel).toLowerCase() === route.requested.toLowerCase());
    return [{ ...route, sourceId: upstream.id, active: active ?? null }];
  });

export function ModelRoutingPage() {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [overrides, setOverrides] = useState<ModelOverrideEntry[]>([]);
  const [sources, setSources] = useState<RouteSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [requested, setRequested] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [longContext, setLongContext] = useState(true);
  const [forceMapping, setForceMapping] = useState(true);
  useUnsavedChanges(requested.trim() !== '');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextOverrides, nextSources] = await Promise.all([
        invokeCommand('get_model_overrides'),
        invokeCommand('get_model_alias_sources'),
      ]);
      setOverrides(nextOverrides);
      setSources(nextSources);
      setSourceId((current) => (nextSources.some((source) => source.id === current) ? current : ''));
    } catch (requestError) {
      setError(errorWords(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupSources(sources), [sources]);
  const quick = useMemo(() => availableQuickRoutes(sources, overrides), [sources, overrides]);
  const selected = sources.find((source) => source.id === sourceId) ?? null;
  const trimmedRequested = requested.trim();
  const sameModel = Boolean(selected && trimmedRequested && stripLongContext(trimmedRequested).toLowerCase() === selected.model.toLowerCase());
  const otherProvider = selected && trimmedRequested ? otherProviderOf(sources, trimmedRequested, selected) : null;

  const create = async (nextRequested: string, nextSourceId: string, options: { longContext: boolean; forceMapping: boolean }) => {
    const source = sources.find((entry) => entry.id === nextSourceId);
    setError('');
    setNotice('');
    if (!nextRequested) {
      setError(t('overrides.error.emptyRequested'));
      return;
    }
    if (!source) {
      setError(t('overrides.error.selectUpstream'));
      return;
    }
    if (stripLongContext(nextRequested).toLowerCase() === source.model.toLowerCase()) {
      setError(t('overrides.error.sameModel'));
      return;
    }
    const owner = otherProviderOf(sources, nextRequested, source);
    if (owner) {
      setError(t('overrides.error.otherProvider', { provider: thinkingAliasSourceKindLabel(owner) }));
      return;
    }
    setBusy(nextRequested);
    try {
      setOverrides(await invokeCommand('create_model_override', {
        requestedModel: nextRequested,
        sourceId: nextSourceId,
        forceMapping: options.forceMapping,
        includeLongContext: options.longContext,
      }));
      setNotice(t('overrides.created', { requested: nextRequested, upstream: source.model }));
      setRequested('');
    } catch (requestError) {
      setError(plainError(requestError, t));
    } finally {
      setBusy('');
    }
  };

  const remove = async (entry: ModelOverrideEntry) => {
    if (!await askConfirmation({
      title: t('common.delete'),
      message: t('overrides.deleteConfirm', { requested: entry.requestedModel, upstream: entry.upstreamModel }),
      confirmText: t('common.delete'),
      variant: 'danger',
    })) return;
    setBusy(entry.requestedModel);
    setError('');
    setNotice('');
    try {
      setOverrides(await invokeCommand('delete_model_override', { requestedModel: entry.requestedModel, oauthChannel: entry.oauthChannel }));
      setNotice(t('overrides.deleted', { requested: entry.requestedModel }));
    } catch (requestError) {
      setError(plainError(requestError, t));
    } finally {
      setBusy('');
    }
  };

  // Show the base rule and fold its [1m] twin into a badge, so one route reads as one row.
  const rows = useMemo(() => {
    const base = overrides.filter((entry) => !entry.longContext);
    const twins = new Set(overrides.filter((entry) => entry.longContext).map((entry) => `${entry.oauthChannel}:${stripLongContext(entry.requestedModel).toLowerCase()}`));
    const orphans = overrides.filter((entry) => entry.longContext && !base.some((row) => row.oauthChannel === entry.oauthChannel && row.requestedModel.toLowerCase() === stripLongContext(entry.requestedModel).toLowerCase()));
    return [
      ...base.map((entry) => ({ entry, longContext: twins.has(`${entry.oauthChannel}:${entry.requestedModel.toLowerCase()}`) })),
      ...orphans.map((entry) => ({ entry, longContext: true })),
    ];
  }, [overrides]);

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('overrides.page.title')]} />
      </PageTopbar>
      <PageBody>
        <div aria-live="polite" className="empty:hidden">
          {error ? (
            <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
          ) : notice ? (
            <Alert variant="success" icon={<Check />}><AlertDescription>{notice}</AlertDescription></Alert>
          ) : null}
        </div>

        {quick.length > 0 ? (
          <SettingsSection settingId="overrides.quick" title={t('overrides.quick.title')} description={t('overrides.quick.description')}>
            {quick.map((route) => (
              <SettingsBlock key={`${route.kind}:${route.requested}`} className="flex min-h-12 items-center gap-3 py-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground dark:bg-input/32" aria-hidden="true">
                  <Zap className="size-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-sm">
                  <span className="truncate text-foreground">{route.requested}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                  <span className="truncate font-medium text-foreground">{route.upstream}</span>
                  <Badge variant="muted" className="ms-1 shrink-0">{thinkingAliasSourceKindLabel(route.kind)}</Badge>
                </div>
                {route.active ? (
                  <Badge variant="success"><Check />{t('overrides.quick.active')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy) || loading}
                    onClick={() => void create(route.requested, route.sourceId, { longContext: true, forceMapping: true })}
                    aria-label={t('overrides.quick.apply', { requested: route.requested, upstream: route.upstream })}
                  >
                    {busy === route.requested ? <Spinner /> : <Route />}
                    {t('overrides.create')}
                  </Button>
                )}
              </SettingsBlock>
            ))}
          </SettingsSection>
        ) : null}

        <SettingsSection settingId="overrides.create" title={t('overrides.create.title')} description={t('overrides.create.description')}>
          <SettingsRow
            title={<label htmlFor="route-requested">{t('overrides.requested.title')}</label>}
            description={t('overrides.requested.description')}
            control={
              <Input
                id="route-requested"
                value={requested}
                onChange={(event) => setRequested(event.currentTarget.value)}
                placeholder={t('overrides.requested.placeholder')}
                disabled={Boolean(busy)}
                wrapperClassName="w-80"
                font="mono"
                autoComplete="off"
                spellCheck={false}
              />
            }
          />
          <SettingsRow
            title={t('overrides.upstream.title')}
            description={t('overrides.upstream.description')}
            control={
              <Select value={sourceId} onValueChange={(value) => setSourceId(value ?? '')} disabled={loading || Boolean(busy)}>
                <SelectTrigger className="w-80 font-mono" aria-label={t('overrides.upstream.title')}>
                  <SelectValue placeholder={loading ? t('aliases.loadingModels') : t('overrides.upstream.hint')}>
                    {selected?.model}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {grouped.length === 0 ? (
                    <div className="px-2 py-3 text-center text-sm text-muted-foreground">{t('aliases.noModels')}</div>
                  ) : grouped.map(([kind, list]) => (
                    <SelectGroup key={kind}>
                      <SelectGroupLabel>{thinkingAliasSourceKindLabel(kind)}</SelectGroupLabel>
                      {list.map((source) => (
                        <SelectItem key={source.id} value={source.id} className="font-mono text-sm">
                          {source.model}
                          {source.displayName && source.displayName !== source.model ? <span className="ms-2 font-sans text-xs text-muted-foreground">{source.displayName}</span> : null}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title={t('overrides.longContext.title')}
            description={t('overrides.longContext.description')}
            control={<Switch checked={longContext} onCheckedChange={setLongContext} disabled={Boolean(busy)} aria-label={t('overrides.longContext.title')} />}
          />
          <SettingsRow
            title={t('overrides.forceMapping.title')}
            description={t('overrides.forceMapping.description')}
            control={<Switch checked={forceMapping} onCheckedChange={setForceMapping} disabled={Boolean(busy)} aria-label={t('overrides.forceMapping.title')} />}
          />
          <SettingsBlock className="flex items-center justify-between gap-4 bg-muted/40 py-2.5 dark:bg-input/10">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground dark:bg-input/32" aria-hidden="true">
                <Route className="size-3.5" />
              </span>
              <span className={cn('truncate font-mono text-sm', trimmedRequested ? 'text-foreground' : 'text-muted-foreground')}>{trimmedRequested || t('overrides.preview.enterRequested')}</span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              <span className={cn('truncate font-mono text-sm', selected ? 'font-medium text-foreground' : 'text-muted-foreground')}>{selected?.model || t('overrides.preview.selectUpstream')}</span>
              {sameModel ? <Badge variant="warning" className="ms-1 shrink-0">{t('overrides.error.sameModel')}</Badge> : null}
              {otherProvider ? <Badge variant="warning" className="ms-1 shrink-0">{t('overrides.error.otherProvider', { provider: thinkingAliasSourceKindLabel(otherProvider) })}</Badge> : null}
            </div>
            <Button size="sm" onClick={() => void create(trimmedRequested, sourceId, { longContext, forceMapping })} disabled={loading || Boolean(busy) || !trimmedRequested || !selected || sameModel || Boolean(otherProvider)}>
              {busy && busy === trimmedRequested ? <Spinner /> : <Route />}
              {busy && busy === trimmedRequested ? t('overrides.creating') : t('overrides.create')}
            </Button>
          </SettingsBlock>
        </SettingsSection>

        <SettingsSection
          settingId="overrides.list"
          title={t('overrides.list.title')}
          description={t('overrides.list.description')}
          headerAction={<Badge variant="muted">{rows.length}</Badge>}
        >
          {loading ? (
            Array.from({ length: 2 }, (_, index) => (
              <SettingsBlock key={index} className="flex items-center gap-3" aria-hidden="true">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-3" />
                <Skeleton className="h-3.5 w-32" />
              </SettingsBlock>
            ))
          ) : rows.length === 0 ? (
            <Empty size="sm">
              <EmptyMedia><Route /></EmptyMedia>
              <EmptyTitle>{t('overrides.empty.title')}</EmptyTitle>
              <EmptyDescription>{t('overrides.empty.description')}</EmptyDescription>
            </Empty>
          ) : rows.map(({ entry, longContext: hasLongContext }) => (
            <SettingsBlock key={`${entry.oauthChannel}:${entry.requestedModel}`} className="flex min-h-12 items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-foreground" title={entry.requestedModel}>{entry.requestedModel}</div>
                  <div className="truncate text-xs text-muted-foreground">{thinkingAliasSourceKindLabel(entry.kind)}</div>
                </div>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <strong className="truncate font-mono text-sm font-medium text-foreground" title={entry.upstreamModel}>{entry.upstreamModel}</strong>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {hasLongContext ? <Badge variant="primary">{t('overrides.badge.longContext')}</Badge> : null}
                {entry.forceMapping ? <Badge variant="secondary">{t('overrides.badge.forceMapping')}</Badge> : null}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-sm"
                      className="hover:text-error"
                      onClick={() => void remove(entry)}
                      disabled={Boolean(busy)}
                      focusableWhenDisabled
                      aria-label={t('overrides.delete', { requested: entry.requestedModel })}
                    />
                  }
                >
                  {busy === entry.requestedModel ? <Spinner /> : <Trash2 />}
                </TooltipTrigger>
                <TooltipPopup>{t('common.delete')}</TooltipPopup>
              </Tooltip>
            </SettingsBlock>
          ))}
        </SettingsSection>
        <p className="px-4 text-xs text-muted-foreground">{t('overrides.warning.restart')}</p>
      </PageBody>
    </Page>
  );
}
