import { Combobox } from '@base-ui/react/combobox';
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { findModelChoice, searchModelChoices, typedModel, type ModelChoicesState } from '../services/modelPicker';
import { ModelName } from './identity/Identity';
import { Button } from './ui/button';
import { Check, ChevronDown, Search } from './ui/icons';
import { selectTriggerVariants } from './ui/select';
import { Spinner } from './ui/spinner';

const ITEM_CLASS = 'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-selected:bg-foreground/[0.06] data-highlighted:bg-accent data-highlighted:text-accent-foreground';

/**
 * Picks one of the models the proxy serves: a button naming the model, which opens a search over the list. A name
 * the list doesn't have can be used as typed, so an alias works, and so does any model while the proxy can't be asked
 * for its list.
 */
export function ModelPicker({ value, models, onChange, onRetry, disabled, className, 'aria-label': ariaLabel }: {
  value: string;
  models: ModelChoicesState;
  onChange: (model: string) => void;
  /** Reads the list again after it failed. */
  onRetry: () => void;
  disabled?: boolean;
  className?: string;
  'aria-label': string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const { choices } = models;
  const typed = typedModel(choices, query);
  const rows = useMemo(() => {
    const names = searchModelChoices(choices, query).map((choice) => choice.model);
    return typed ? [...names, typed] : names;
  }, [choices, query, typed]);

  return (
    <Combobox.Root
      items={rows}
      filteredItems={rows}
      value={value || null}
      inputValue={query}
      onInputValueChange={setQuery}
      // Each opening starts from the whole list, not from what was last searched for.
      onOpenChange={(open) => { if (open) setQuery(''); }}
      onValueChange={(next) => { if (typeof next === 'string' && next !== value) onChange(next); }}
      autoHighlight
      disabled={disabled}
    >
      <Combobox.Trigger aria-label={ariaLabel} className={cn(selectTriggerVariants(), 'min-w-0', className)} data-slot="model-picker-trigger">
        {value
          ? <ModelName model={value} exact className="flex-1 font-normal" />
          : <span className="flex-1 truncate text-placeholder">{t('modelPicker.pick')}</span>}
        <ChevronDown className="-me-1 size-3.5 opacity-60" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="end" sideOffset={4} className="z-50">
          <Combobox.Popup
            aria-label={ariaLabel}
            className="dropdown-glass flex max-h-[min(24rem,var(--available-height))] w-80 max-w-(--available-width) origin-(--transform-origin) flex-col rounded-lg text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none transition-[scale,opacity] duration-150 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
            data-slot="model-picker-popup"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <Search className="size-4 shrink-0 text-icon-muted" aria-hidden="true" />
              <Combobox.Input
                aria-label={t('modelPicker.search')}
                placeholder={t('modelPicker.search')}
                autoComplete="off"
                spellCheck={false}
                className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-placeholder"
              />
              {models.status === 'loading' ? <Spinner /> : null}
            </div>
            {models.status === 'failed' ? (
              <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground" role="alert">
                <span className="min-w-0 flex-1">{t('modelPicker.failed', { error: models.error })}</span>
                <Button size="xs" variant="outline" onClick={onRetry}>{t('common.tryAgain')}</Button>
              </div>
            ) : null}
            <div className="px-3 py-3 text-center text-sm text-muted-foreground empty:hidden" role="status">
              {rows.length ? null
                : models.status === 'loading' ? t('modelPicker.loading')
                  : query.trim() ? t('modelPicker.noMatch')
                    : models.status === 'ready' ? t('modelPicker.none') : null}
            </div>
            <Combobox.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 empty:hidden">
              {(model: string) => {
                const choice = findModelChoice(choices, model);
                return (
                  <Combobox.Item key={model} value={model} className={ITEM_CLASS}>
                    <span className="min-w-0 flex-1">
                      {choice ? <ModelName model={model} exact className="flex" /> : <span className="block truncate font-medium">{t('modelPicker.useTyped', { model })}</span>}
                      <span className="block truncate text-xs text-muted-foreground">
                        {choice
                          ? [choice.displayName !== model ? choice.displayName : null, ...choice.providers].filter(Boolean).join(' · ')
                          : t('modelPicker.typedHint')}
                      </span>
                    </span>
                    <Combobox.ItemIndicator className="flex shrink-0 items-center text-primary">
                      <Check className="size-3.5" />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
