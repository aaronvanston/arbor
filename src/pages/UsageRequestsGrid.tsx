import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AccountAvatar } from '../components/AccountAvatar';
import { ClientPill, MachinePill, ModelName, ProviderPill } from '../components/identity/Identity';
import { Button } from '../components/ui/button';
import { DataGrid, useDataGrid, type DataGridColumnDef, type DataGridColumnMeta, type DataGridFeatures } from '../components/ui/data-grid/data-grid';
import { DataGridColumnsMenu } from '../components/ui/data-grid/data-grid-columns';
import { TablePage, TablePager, TableSkeleton } from '../components/ui/data-table';
import { Check, Copy, X } from '../components/ui/icons';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import { formatCount, formatDateTime, formatNumber, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import type { ResolvedProfile } from '../services/accountProfiles';
import { useAccountsByAuthIndex } from '../hooks/useAccountsByAuthIndex';
import { normalizeAuthIndex } from '../services/managementApi';
import { calculateCacheReadRate, calculateGenerationSpeed } from '../services/usageMetrics';
import {
  FAILED_REQUESTS_GRID_KEY,
  REQUEST_COLUMNS,
  REQUEST_PRESET_IDS,
  REQUEST_PRESETS,
  REQUEST_SORT_KEYS,
  REQUESTS_GRID_KEY,
  defaultFailedRequestsLayout,
  defaultRequestsLayout,
  failureSummary,
  legacyRequestsLayout,
  readableFailureBody,
  requestJson,
  requestOrderFor,
  requestSortColumn,
  steppedRecord,
  type RequestColumnId,
} from '../services/usageRequestsGrid';
import type { UsageEventPage, UsageRecord, UsageRequestOrder } from '../native/types';
import { useShownIdentity } from '../services/emailPrivacy';

const helper = createColumnHelper<DataGridFeatures, UsageRecord>();
const columnSize = new Map(REQUEST_COLUMNS.map((column) => [column.id, column]));

const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted-foreground">{children}</span>;

/** A token count, compact, with the exact number on hover; nothing reads fainter than a count. */
function Tokens({ count, title }: { count: number; title?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn(count === 0 && 'text-muted-foreground')} title={title ?? t('usage.events.tokensTitle', { count: formatNumber(count) })}>
      {formatCount(count)}
    </span>
  );
}

/** A duration in ms or seconds, the unit quieter than the number. */
function Duration({ ms }: { ms: number | null }) {
  const { t } = useI18n();
  if (ms == null || !Number.isFinite(ms)) return <Muted>—</Muted>;
  const seconds = ms >= 1000;
  const value = seconds ? (ms / 1000).toFixed(ms < 10_000 ? 2 : 1) : String(Math.round(ms));
  return (
    <span title={`${formatNumber(ms)} ms`}>
      {value} <span className="text-muted-foreground">{seconds ? t('usage.unit.seconds') : 'ms'}</span>
    </span>
  );
}

function CacheRate({ record }: { record: UsageRecord }) {
  const rate = calculateCacheReadRate({ inputTokens: record.tokens.input_tokens, cacheReadTokens: record.tokens.cache_read_tokens });
  if (rate === null) return <Muted>—</Muted>;
  return (
    // A block flex, not inline: an inline one sits the bar on the text's baseline and pushes the number down.
    <span className="flex items-center justify-end gap-2" title={`${rate.toFixed(2)}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-muted-foreground/15" aria-hidden="true">
        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${rate}%` }} />
      </span>
      <span className="w-9">{Math.round(rate)}%</span>
    </span>
  );
}

function Speed({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const speed = calculateGenerationSpeed({ outputTokens: record.tokens.output_tokens, latencyMs: record.latency_ms, ttftMs: record.ttft_ms });
  if (speed === null) return <Muted>—</Muted>;
  return (
    <span title={`${speed.toFixed(1)} ${t('usage.unit.tokensPerSecond')}`}>
      {speed.toFixed(speed < 100 ? 1 : 0)} <span className="text-muted-foreground">{t('usage.unit.tokensPerSecond')}</span>
    </span>
  );
}

/** How it went on one line: a dot, a word and, for a failure, its HTTP status. The failure body is its title. */
function Result({ record }: { record: UsageRecord }) {
  const { t } = useI18n();
  const state = record.canceled ? 'canceled' : record.failed ? 'failed' : 'success';
  const tone: StatusTone = state === 'success' ? 'success' : state === 'failed' ? 'error' : 'muted';
  const detail = [record.failure_status > 0 ? `HTTP ${record.failure_status}` : '', record.failure_body.trim()].filter(Boolean).join(' · ');
  return (
    <span className="inline-flex max-w-full items-center gap-1.5" title={detail || t(`usage.result.${state}`)}>
      <StatusDot tone={tone} />
      <span className={cn('truncate', state === 'failed' ? 'font-medium text-error-foreground' : state === 'canceled' ? 'text-muted-foreground' : 'text-foreground')}>
        {t(`usage.result.${state}`)}
      </span>
      {record.failure_status > 0 ? <span className="shrink-0 tabular-nums text-muted-foreground">{record.failure_status}</span> : null}
    </span>
  );
}

/** The model as Usage names it everywhere, with the reasoning effort as the proxy recorded it, untranslated. */
function Model({ record }: { record: UsageRecord }) {
  return <ModelName model={record.alias || record.model} provider={record.provider} effort={record.reasoning_effort || 'auto'} className="flex" />;
}

/** Where a request came from: the account's avatar, found by the auth index the request carries, and what the core calls it. */
function Source({ record, profile, className }: { record: UsageRecord; profile: ResolvedProfile | undefined; className?: string }) {
  const shown = useShownIdentity();
  const raw = record.source_display || record.source;
  const source = raw ? shown(raw, { fileName: record.source }) : raw;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle" title={source || undefined}>
      {profile ? <AccountAvatar profile={profile} size="xs" /> : null}
      <span className={cn('truncate', !source && 'text-muted-foreground', className)}>{source || '—'}</span>
    </span>
  );
}

function useRequestColumns(): DataGridColumnDef<UsageRecord>[] {
  const { t } = useI18n();
  const accounts = useAccountsByAuthIndex();
  return useMemo(() => {
    const column = (id: RequestColumnId, header: string, cell: (record: UsageRecord) => ReactNode, meta: Partial<DataGridColumnMeta> = {}) => {
      const { size, minSize } = columnSize.get(id)!;
      const sort = REQUEST_SORT_KEYS[id] ? (id === 'time' ? 'time' : 'number') : undefined;
      return helper.display({ id, header, size, minSize, cell: ({ row }) => cell(row.original), meta: { label: header, sort, ...meta } });
    };
    const numeric = { numeric: true };
    const cacheTitle = (record: UsageRecord) =>
      record.tokens.cache_creation_tokens > 0
        ? t('usage.events.cacheCreationTitle', { read: formatNumber(record.tokens.cache_read_tokens), creation: formatNumber(record.tokens.cache_creation_tokens) })
        : t('usage.events.cacheTitle', { read: formatNumber(record.tokens.cache_read_tokens) });
    const columns: Record<RequestColumnId, DataGridColumnDef<UsageRecord>> = {
      time: column('time', t('usage.column.time'), (record) => (
        <span className="tabular-nums text-muted-foreground" title={formatDateTime(record.timestamp, { seconds: true, year: 'always' })}>
          {Number.isNaN(Date.parse(record.timestamp)) ? record.timestamp : formatWhen(record.timestamp, { seconds: true })}
        </span>
      )),
      machine: column('machine', t('usage.column.machine'), (record) => <MachinePill name={record.machine} fallback={t('usage.events.unassigned')} />, {
        description: t('usage.events.machineHint'),
      }),
      client: column('client', t('usage.column.client'), (record) => <ClientPill userAgent={record.user_agent} version={false} />),
      model: column('model', t('usage.column.model'), (record) => <Model record={record} />),
      input: column('input', t('usage.column.input'), (record) => <Tokens count={record.tokens.input_tokens} />, numeric),
      output: column('output', t('usage.column.output'), (record) => <Tokens count={record.tokens.output_tokens} />, numeric),
      cache: column('cache', t('usage.column.cache'), (record) => <Tokens count={record.tokens.cache_read_tokens} title={cacheTitle(record)} />, numeric),
      cacheRate: column('cacheRate', t('usage.column.cacheRate'), (record) => <CacheRate record={record} />, numeric),
      total: column('total', t('usage.column.total'), (record) => <Tokens count={record.tokens.total_tokens} />, { ...numeric, cellClassName: 'font-medium text-foreground' }),
      speed: column('speed', t('usage.column.short.speed'), (record) => <Speed record={record} />, { ...numeric, label: t('usage.column.speed') }),
      ttft: column('ttft', t('usage.column.short.ttft'), (record) => <Duration ms={record.ttft_ms} />, { ...numeric, label: t('usage.column.ttft') }),
      latency: column('latency', t('usage.column.short.latency'), (record) => <Duration ms={record.latency_ms} />, { ...numeric, label: t('usage.column.latency') }),
      result: column('result', t('usage.column.result'), (record) => <Result record={record} />),
      source: column('source', t('usage.column.source'), (record) => <Source record={record} profile={accounts.get(normalizeAuthIndex(record.auth_index))} className="text-muted-foreground" />),
      provider: column('provider', t('usage.column.provider'), (record) => (record.provider ? <ProviderPill provider={record.provider} /> : <Muted>—</Muted>)),
      key: column('key', t('usage.column.key'), (record) => (
        <span className="flex min-w-0 items-baseline gap-1.5" title={record.api_key_display || undefined}>
          <span className="truncate text-foreground">{record.api_key_remark || t('usage.key.noRemark')}</span>
          {record.api_key_display ? <span className="truncate font-mono text-2xs text-muted-foreground">{record.api_key_display}</span> : null}
        </span>
      )),
      reasoning: column('reasoning', t('usage.column.reasoning'), (record) => <Tokens count={record.tokens.reasoning_tokens} />, numeric),
      clientIp: column('clientIp', t('usage.column.clientIp'), (record) => <span className="font-mono text-xs">{record.client_ip || '—'}</span>),
      forwardedIp: column('forwardedIp', t('usage.column.forwardedIp'), (record) => <span className="font-mono text-xs">{record.x_forwarded_for || '—'}</span>, {
        description: t('usage.events.forwardedHint'),
      }),
      message: column('message', t('usage.column.message'), (record) => {
        if (!record.failed) return <Muted>—</Muted>;
        const summary = failureSummary(record.failure_body);
        return (
          <span className="block truncate font-mono text-xs text-muted-foreground" title={summary || undefined}>
            {summary || t('usage.request.noBody')}
          </span>
        );
      }, { description: t('usage.events.messageHint') }),
    };
    return REQUEST_COLUMNS.map(({ id }) => columns[id]);
  }, [t, accounts]);
}

const getRowId = (record: UsageRecord) => record.id;
const initialLayout = () => legacyRequestsLayout(localStorage);

/**
 * Usage › Requests: one page of requests, as the server paged them, in a grid whose columns can be picked, moved,
 * pinned and resized. It's the page's one table, so it fills the window: the page's filters and Columns stay at the
 * top, the pager at the bottom, and the rows scroll between them.
 */
export function RequestsView({ events, filters, summary, failedOnly = false, pageSize, order, empty, onPage, onPageSizeChange, onOrderChange }: {
  /** Null while the first page loads. */
  events: UsageEventPage | null;
  /** The page's filters, at the start of the toolbar. */
  filters: ReactNode;
  /** A line about the rows, at the end of the toolbar: Failed on's failures at a glance. */
  summary?: ReactNode;
  /**
   * Only failed requests are listed. The grid keeps a separate layout for them, which starts on the failure columns;
   * give the view a different `key` for each, as a grid reads its layout once.
   */
  failedOnly?: boolean;
  pageSize: number;
  /** The order the server lists them in; null is newest first. */
  order: UsageRequestOrder | null;
  /** Shown instead of the grid when there are no requests. */
  empty: ReactNode;
  onPage: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOrderChange: (order: UsageRequestOrder | null) => void;
}) {
  const { t } = useI18n();
  // The request whose detail is open. It's the record itself, so it stays open while its page refreshes or turns.
  const [open, setOpen] = useState<UsageRecord | null>(null);
  const columns = useRequestColumns();
  const grid = useDataGrid({
    data: events?.items ?? NO_RECORDS,
    columns,
    getRowId,
    storageKey: failedOnly ? FAILED_REQUESTS_GRID_KEY : REQUESTS_GRID_KEY,
    initialLayout: failedOnly ? defaultFailedRequestsLayout : initialLayout,
  });
  const presets = useMemo(
    () => REQUEST_PRESET_IDS.map((id) => ({ id, label: t(`usage.events.preset.${id}`), columns: REQUEST_PRESETS[id] })),
    [t],
  );
  // Counted from the size these rows were loaded with; the selector can already show a newer size that is still loading.
  const first = events && events.total > 0 ? (events.page - 1) * events.pageSize + 1 : 0;
  const last = events ? Math.min(events.page * events.pageSize, events.total) : 0;

  return (
    <TablePage
      label={failedOnly ? t('usage.failures.title') : t('usage.events.title')}
      toolbar={
        <>
          <div className="min-w-0 flex-1">{filters}</div>
          {summary}
          <DataGridColumnsMenu grid={grid} presets={presets} defaultLayout={failedOnly ? defaultFailedRequestsLayout : defaultRequestsLayout} />
        </>
      }
      footer={events ? (
        <TablePager
          first={first}
          last={last}
          total={events.total}
          page={events.page}
          totalPages={events.totalPages}
          pageSize={pageSize}
          onPage={onPage}
          onPageSizeChange={onPageSizeChange}
        />
      ) : null}
    >
      {!events ? (
        <TableSkeleton surface="page" />
      ) : events.items.length ? (
        <div
          className="relative flex min-h-0 flex-1"
          onKeyDown={(event: KeyboardEvent) => {
            if (!open || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            // Keys pressed in a menu or a field are theirs.
            if (event.target instanceof Element && event.target.closest('input, textarea, [role="menu"], [role="listbox"]')) return;
            if (event.key === 'Escape') {
              setOpen(null);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              const next = steppedRecord(events.items, open.id, event.key === 'ArrowDown' ? 1 : -1);
              if (!next) return;
              event.preventDefault();
              setOpen(next);
            }
          }}
        >
          <DataGrid
            grid={grid}
            label={t('usage.events.title')}
            surface="page"
            className="min-h-0 min-w-0 flex-1"
            sorting={requestSortColumn(order)}
            onSortingChange={(sorting) => onOrderChange(requestOrderFor(sorting))}
            onRowClick={(record) => setOpen((current) => (current?.id === record.id ? null : record))}
            activeRowId={open?.id ?? null}
          />
          {open ? <RequestDetail record={open} onClose={() => setOpen(null)} /> : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">{empty}</div>
      )}
    </TablePage>
  );
}

const NO_RECORDS: UsageRecord[] = [];

const orDash = (value: string | null | undefined) => (value?.trim() ? value : <Muted>—</Muted>);

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <dl className="flex flex-col">{children}</dl>
    </section>
  );
}

function DetailRow({ label, children, wrap = false, className }: { label: string; children: ReactNode; wrap?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-h-7 items-baseline justify-between gap-4 py-1 text-sm', wrap && 'flex-col items-stretch gap-1')}>
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 tabular-nums', wrap ? 'break-all' : 'truncate text-end', className)}>{children}</dd>
    </div>
  );
}

function CopyButton({ text, label, size = 'icon-xs' }: { text: string; label: string; size?: 'icon-xs' | 'icon-sm' }) {
  const { copy, copied } = useCopyToClipboard({ inline: true });
  const done = copied === text;
  return (
    <Button variant="ghost-muted" size={size} aria-label={label} title={label} onClick={() => void copy(text)}>
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/**
 * One request, opened in a sheet floating over the grid's end: everything the proxy recorded about it, so a row can be
 * read without widening every column. It has no backdrop, so the rows stay live: another click, or ↑ and ↓, swaps the
 * request it shows. The failure comes first when there is one, since it's what the row was opened for.
 */
export function RequestDetail({ record, onClose }: { record: UsageRecord; onClose: () => void }) {
  const { t } = useI18n();
  const account = useAccountsByAuthIndex().get(normalizeAuthIndex(record.auth_index));
  const { tokens } = record;
  const exact = (count: number) => <span className={cn(count === 0 && 'text-muted-foreground')}>{formatNumber(count)}</span>;
  const tier = [record.service_tier, record.response_service_tier].filter((value) => value.trim());
  const body = record.failure_body.trim();
  // Near solid, unlike the dialogs' glass: that reads over a dimmed backdrop, and this sits straight on rows of numbers.
  return (
    <aside
      aria-label={t('usage.request.title')}
      className="absolute inset-y-3 end-3 z-10 flex w-[380px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/92 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.45)] backdrop-blur-xl backdrop-saturate-150 transition-[translate,opacity] duration-200 ease-out starting:translate-x-4 starting:opacity-0 dark:border-white/8 dark:bg-card/92"
      data-slot="request-detail"
    >
      <header className="flex items-start gap-2 border-b border-border/50 py-2.5 ps-4 pe-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Model record={record} />
          <p className="flex min-w-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
            <span className="truncate">{formatDateTime(record.timestamp, { seconds: true, year: 'always' })}</span>
            <Result record={record} />
          </p>
        </div>
        <CopyButton text={requestJson(record)} label={t('usage.request.copyJson')} size="icon-sm" />
        <Button variant="ghost-muted" size="icon-sm" aria-label={t('usage.request.close')} title={t('usage.request.close')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3 [scrollbar-width:thin]">
        {record.failed ? (
          <DetailSection title={t('usage.request.section.failure')}>
            {record.failure_status > 0 ? <DetailRow label={t('usage.request.status')}>{record.failure_status}</DetailRow> : null}
            <div className="flex flex-col gap-1.5 pt-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">{t('usage.request.body')}</span>
                {body ? <CopyButton text={body} label={t('usage.request.copyBody')} /> : null}
              </div>
              {body ? (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">{readableFailureBody(body)}</pre>
              ) : (
                <p className="text-sm text-muted-foreground">{t('usage.request.noBody')}</p>
              )}
            </div>
          </DetailSection>
        ) : null}
        <DetailSection title={t('usage.request.section.tokens')}>
          <DetailRow label={t('usage.column.input')}>{exact(tokens.input_tokens)}</DetailRow>
          <DetailRow label={t('usage.column.output')}>{exact(tokens.output_tokens)}</DetailRow>
          <DetailRow label={t('usage.column.reasoning')}>{exact(tokens.reasoning_tokens)}</DetailRow>
          <DetailRow label={t('usage.request.cacheRead')}>{exact(tokens.cache_read_tokens)}</DetailRow>
          <DetailRow label={t('usage.request.cacheWrite')}>{exact(tokens.cache_creation_tokens)}</DetailRow>
          <DetailRow label={t('usage.column.cacheRate')}><CacheRate record={record} /></DetailRow>
          <DetailRow label={t('usage.column.total')} className="font-medium">{exact(tokens.total_tokens)}</DetailRow>
        </DetailSection>
        <DetailSection title={t('usage.request.section.timing')}>
          <DetailRow label={t('usage.column.ttft')}><Duration ms={record.ttft_ms} /></DetailRow>
          <DetailRow label={t('usage.column.latency')}><Duration ms={record.latency_ms} /></DetailRow>
          <DetailRow label={t('usage.column.speed')}><Speed record={record} /></DetailRow>
        </DetailSection>
        <DetailSection title={t('usage.request.section.route')}>
          <DetailRow label={t('usage.column.machine')}>
            <MachinePill name={record.machine} fallback={t('usage.events.unassigned')} className="max-w-full" />
          </DetailRow>
          <DetailRow label={t('usage.column.client')}><ClientPill userAgent={record.user_agent} className="max-w-full" /></DetailRow>
          <DetailRow label={t('usage.column.key')}>
            <span title={record.api_key_display || undefined}>
              {record.api_key_remark || t('usage.key.noRemark')}
              {record.api_key_display ? <span className="ms-1.5 font-mono text-xs text-muted-foreground">{record.api_key_display}</span> : null}
            </span>
          </DetailRow>
          <DetailRow label={t('usage.column.source')}><Source record={record} profile={account} /></DetailRow>
          <DetailRow label={t('usage.column.provider')}>{record.provider ? <ProviderPill provider={record.provider} /> : <Muted>—</Muted>}</DetailRow>
          <DetailRow label={t('usage.request.effort')}>{record.reasoning_effort || 'auto'}</DetailRow>
          {tier.length ? <DetailRow label={t('usage.request.serviceTier')}>{tier.join(' → ')}</DetailRow> : null}
          <DetailRow label={t('usage.request.authType')}>{orDash(record.auth_type)}</DetailRow>
          <DetailRow label={t('usage.request.endpoint')} className="font-mono text-xs">{orDash(record.endpoint)}</DetailRow>
        </DetailSection>
        <DetailSection title={t('usage.request.section.network')}>
          <DetailRow label={t('usage.column.clientIp')} className="font-mono text-xs">{orDash(record.client_ip)}</DetailRow>
          <DetailRow label={t('usage.column.forwardedIp')} className="font-mono text-xs">{orDash(record.x_forwarded_for)}</DetailRow>
          <DetailRow label={t('usage.request.userAgent')} wrap className="font-mono text-xs">{orDash(record.user_agent)}</DetailRow>
        </DetailSection>
        <DetailSection title={t('usage.request.section.ids')}>
          <DetailRow label={t('usage.request.requestId')} className="font-mono text-xs">
            {record.request_id ? (
              <span className="flex min-w-0 items-center justify-end gap-1">
                <span className="truncate" title={record.request_id}>{record.request_id}</span>
                <CopyButton text={record.request_id} label={t('usage.request.copyId')} />
              </span>
            ) : <Muted>—</Muted>}
          </DetailRow>
          <DetailRow label={t('usage.request.authIndex')} className="font-mono text-xs">{orDash(record.auth_index)}</DetailRow>
        </DetailSection>
      </div>
    </aside>
  );
}
