import { useConfirmation } from '../components/ConfirmationDialog';
import { useState } from 'react';
import { invokeCommand } from '../native/commands';
import { AlertCircle, CircleCheck, Pencil, Plus, Search, Trash2 } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatCount, formatMoney } from '../lib/format';
import { SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { draftFromNumber, NumberField, numberFromDraft } from '../components/ui/number-field';
import { Label } from '../components/ui/label';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { cn } from '../lib/utils';
import { ModelName } from '../components/identity/Identity';
import type { ModelPrice, UsagePricing, UsageQuery } from '../native/types';
import { trackFeature } from '../services/productAnalytics';
import { TableEmpty } from '../components/ui/data-table';
import { UsageEmpty } from './UsageEmpty';

type PriceDraft = {
  model: string;
  prompt: string;
  completion: string;
  cache: string;
  cacheRead: string;
  cacheCreation: string;
};

const emptyPriceDraft = (): PriceDraft => ({
  model: '',
  prompt: '',
  completion: '',
  cache: '',
  cacheRead: '',
  cacheCreation: '',
});
const priceDraftFor = (model = '', price?: ModelPrice | null): PriceDraft => ({
  model,
  prompt: price ? String(price.prompt) : '',
  completion: price ? String(price.completion) : '',
  cache: price ? String(price.cache) : '',
  cacheRead: price && (price.cacheReadConfigured || price.cacheRead > 0) ? String(price.cacheRead) : '',
  cacheCreation: price && (price.cacheCreationConfigured || price.cacheCreation > 0) ? String(price.cacheCreation) : '',
});

const parsePrice = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const priceUnit = (value: number | undefined) => (Number.isFinite(value) ? `$${Number(value).toFixed(4)}` : '—');

export function PricingView({
  pricing,
  query,
  onChanged,
}: {
  pricing: UsagePricing;
  query: UsageQuery;
  onChanged: () => void | Promise<void>;
}) {
  const { askConfirmation } = useConfirmation();
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  // Said beside the field, in the dialog, rather than on the page behind it.
  const [modelMissing, setModelMissing] = useState(false);
  const visibleRows = pricing.rows.filter((row) => {
    const keyword = search.trim().toLowerCase();
    return !keyword || row.model.toLowerCase().includes(keyword);
  });

  // What the editor said goes with it, so the next one opens clean.
  const closeEditor = () => {
    setDraft(null);
    setModelMissing(false);
    setLocalError('');
  };

  const savePrice = async () => {
    if (!draft?.model.trim()) {
      setModelMissing(true);
      return;
    }
    setSaving(true);
    setLocalError('');
    try {
      await invokeCommand('save_usage_model_price', {
        price: {
          model: draft.model.trim(),
          prompt: parsePrice(draft.prompt),
          completion: parsePrice(draft.completion),
          cache: draft.cache.trim() ? parsePrice(draft.cache) : parsePrice(draft.prompt),
          cacheRead: parsePrice(draft.cacheRead),
          cacheCreation: parsePrice(draft.cacheCreation),
          promptConfigured: draft.prompt.trim() !== '',
          completionConfigured: draft.completion.trim() !== '',
          cacheReadConfigured: draft.cacheRead.trim() !== '',
          cacheCreationConfigured: draft.cacheCreation.trim() !== '',
          source: 'manual',
          sourceModelId: '',
          updatedAtMs: 0,
        } satisfies ModelPrice,
      });
      setDraft(null);
      setMessage('');
      toast({ kind: 'success', title: t('usage.pricing.saved') });
      await onChanged();
    } catch (saveError) {
      setLocalError(String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const deletePrice = async (model: string) => {
    if (!await askConfirmation({ title: t('common.delete'), message: t('usage.pricing.deleteConfirm', { model }), confirmText: t('common.delete'), variant: 'danger' })) return;
    try {
      await invokeCommand('delete_usage_model_price', { model });
      setMessage('');
      toast({ kind: 'success', title: t('usage.pricing.deleted') });
      await onChanged();
    } catch (deleteError) {
      setLocalError(String(deleteError));
    }
  };

  const syncPrices = async () => {
    setSyncing(true);
    setLocalError('');
    try {
      const result = await invokeCommand('sync_usage_model_prices', { query });
      trackFeature('prices-synced');
      setMessage(
        t(result.filled.length ? 'usage.pricing.syncResultFilled' : 'usage.pricing.syncResult', {
          imported: result.imported,
          skipped: result.skipped,
          unmatched: result.unmatched.length,
          filled: result.filled.join(', '),
        })
      );
      await onChanged();
    } catch (syncError) {
      setLocalError(String(syncError));
    } finally {
      setSyncing(false);
    }
  };

  const priceField = (label: string, key: Exclude<keyof PriceDraft, 'model'>, placeholder?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`usage-price-${key}`}>{label}</Label>
      <NumberField
        id={`usage-price-${key}`}
        min={0}
        step={0.0001}
        font="mono"
        value={numberFromDraft(draft?.[key] ?? '')}
        onValueChange={(next) => draft && setDraft({ ...draft, [key]: draftFromNumber(next) })}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={3}>
        <StatBlock label={t('usage.pricing.total')} value={formatMoney(pricing.totalCost)} />
        <StatBlock
          label={t('usage.pricing.coverageLabel')}
          value={`${pricing.totalRequests ? ((pricing.pricedRequests / pricing.totalRequests) * 100).toFixed(1) : '0.0'}%`}
          hint={t('usage.pricing.coverageHint', { priced: formatCount(pricing.pricedRequests), total: formatCount(pricing.totalRequests) })}
        />
        <StatBlock label={t('usage.pricing.savedPrices')} value={formatCount(pricing.savedPrices)} hint={t('usage.pricing.savedPricesHint')} />
      </StatsGrid>

      {localError && draft === null ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{localError}</AlertDescription></Alert> : null}
      {message ? <Alert variant="success" icon={<CircleCheck />}><AlertDescription>{message}</AlertDescription></Alert> : null}

      <SettingsSection
        title={t('usage.pricing.tableTitle')}
        description={t('usage.pricing.perMillion')}
        headerAction={
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              wrapperClassName="w-56"
              startAddon={<Search />}
              data-page-search
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={t('usage.pricing.search')}
              aria-label={t('usage.pricing.search')}
            />
            <Button variant="outline" size="sm" onClick={() => setDraft(emptyPriceDraft())}>
              <Plus />
              {t('usage.pricing.add')}
            </Button>
            <Button size="sm" disabled={syncing} onClick={() => void syncPrices()}>
              <RefreshIcon refreshing={syncing} />
              {syncing ? t('usage.pricing.syncing') : t('usage.pricing.sync')}
            </Button>
          </div>
        }
      >
        {visibleRows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('usage.pricing.model')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.calls')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.tokens')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.cost')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.column.prompt')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.column.completion')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.column.cacheRead')}</TableHead>
                <TableHead className="text-end">{t('usage.pricing.column.cacheCreation')}</TableHead>
                <TableHead className="w-16 text-end"><span className="sr-only">{t('usage.pricing.actions')}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow key={row.model}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ModelName model={row.model} className="text-sm" />
                      {row.price ? (
                        row.price.source === 'manual' ? <Badge variant="primary" size="sm">{row.price.source}</Badge> : <Badge variant="muted" size="sm">{row.price.source}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatCount(row.requests)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCount(row.totalTokens)}</TableCell>
                  <TableCell className={cn('text-end font-semibold tabular-nums text-foreground', !row.price && 'font-normal text-muted-foreground')}>{formatMoney(row.price ? row.estimatedCost : null)}</TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">{row.price ? priceUnit(row.price.prompt) : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">{row.price ? priceUnit(row.price.completion) : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">
                    {row.price
                      ? priceUnit(row.price.cacheReadConfigured || row.price.cacheRead > 0 ? row.price.cacheRead : row.price.cache)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">
                    {row.price
                      ? priceUnit(row.price.cacheCreationConfigured || row.price.cacheCreation > 0 ? row.price.cacheCreation : row.price.prompt)
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5">
                      <Tooltip>
                        <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" onClick={() => setDraft(priceDraftFor(row.model, row.price))} aria-label={t('common.edit')} />}>
                          <Pencil />
                        </TooltipTrigger>
                        <TooltipPopup>{t('common.edit')}</TooltipPopup>
                      </Tooltip>
                      {row.price?.source === 'manual' ? (
                        <Tooltip>
                          <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" className="hover:text-destructive-foreground" onClick={() => void deletePrice(row.model)} aria-label={t('common.delete')} />}>
                            <Trash2 />
                          </TooltipTrigger>
                          <TooltipPopup>{t('common.delete')}</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : pricing.rows.length && search.trim() ? (
          // The range has models; the search is what left none.
          <TableEmpty>{t('usage.pricing.noMatch', { query: search.trim() })}</TableEmpty>
        ) : (
          <UsageEmpty />
        )}
      </SettingsSection>

      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('usage.pricing.editorTitle')}</DialogTitle>
            <DialogDescription>{t('usage.pricing.editorDescription')}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id="usage-price-form"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void savePrice();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="usage-price-model">{t('usage.pricing.model')}</Label>
                <Input
                  id="usage-price-model"
                  font="mono"
                  autoFocus
                  value={draft?.model ?? ''}
                  onChange={(event) => { setModelMissing(false); if (draft) setDraft({ ...draft, model: event.currentTarget.value }); }}
                  placeholder="gpt-5.6-terra"
                  aria-invalid={modelMissing || undefined}
                  aria-describedby={modelMissing ? 'usage-price-model-error' : undefined}
                />
                {modelMissing ? <p id="usage-price-model-error" className="text-xs text-error-foreground">{t('usage.pricing.modelRequired')}</p> : null}
              </div>
              <div className="grid grid-cols-2 gap-4">
                {priceField(t('usage.pricing.prompt'), 'prompt')}
                {priceField(t('usage.pricing.completion'), 'completion')}
                {priceField(t('usage.pricing.cacheRead'), 'cacheRead', t('usage.pricing.optional'))}
                {priceField(t('usage.pricing.cacheCreation'), 'cacheCreation', t('usage.pricing.optional'))}
                {priceField(t('usage.pricing.cache'), 'cache', t('usage.pricing.optional'))}
              </div>
              {localError ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{localError}</AlertDescription></Alert> : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor}>{t('common.cancel')}</Button>
            <Button type="submit" form="usage-price-form" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? t('usage.pricing.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
