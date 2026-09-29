import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Info, RotateCcw } from '../ui/icons';
import { useFocusRequest } from '../../focusRequests';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import type { ResetOffer } from '../../services/settingDefaults';
import { settingEntry, type SettingsFold } from '../../services/settingsIndex';
import { Button } from '../ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';

/**
 * Marks what Settings search brought into view for a moment: the row-highlight tint in styles.css, which holds still
 * with reduced motion. src/hooks/useSettingReveal.ts sets and clears `data-highlight`.
 */
const HIGHLIGHT_CLASS = 'data-highlight:row-highlight';

/**
 * A section's header: its title and description, with its actions beside them while the title keeps 12rem, and under
 * them, still at the right, in a narrower window or a zoomed-in one, rather than spilling over the title. The actions
 * never shrink below what they hold.
 */
const SECTION_HEADER = 'flex min-h-7 flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4';
const SECTION_TITLE = 'min-w-0 flex-1 basis-48';
const SECTION_ACTION = 'ms-auto flex min-h-7 min-w-7 max-w-full shrink-0 items-center justify-end';

/** A row's own control that can be used, to hand it the keyboard. The reset button beside it isn't one. */
export const SETTING_CONTROL = [
  'input:not([disabled])', 'textarea:not([disabled])', 'select:not([disabled])',
  'button:not([disabled]):not([aria-disabled="true"]):not([data-reset-default])', '[role="switch"]:not([aria-disabled="true"])',
  '[role="combobox"]:not([aria-disabled="true"])',
].join(', ');

/** A button held back with a reason (Button's `disabledReason`), which stays focusable so it can say why. */
export const HELD_SETTING_CONTROL = 'button[aria-disabled="true"]:not([data-reset-default])';

/**
 * The control in a row to hand the keyboard: the first that can be used, so at the smallest zoom it's Zoom in rather
 * than Zoom out before it, or else the first held back, which at least says why.
 */
export function settingControl(row: ParentNode | null | undefined): HTMLElement | null {
  return row?.querySelector<HTMLElement>(SETTING_CONTROL) ?? row?.querySelector<HTMLElement>(HELD_SETTING_CONTROL) ?? null;
}

/**
 * A titled group of rows rendered as a single hairline card. `settingId` names it in Settings search's index
 * (src/services/settingsIndex.ts), for a section searched as a whole.
 */
export function SettingsSection({
  title,
  description,
  summary,
  headerAction,
  children,
  className,
  contentClassName,
  settingId,
}: {
  title: ReactNode;
  /** What the section is for, behind the info mark after its title. */
  description?: ReactNode;
  /** What's in it right now (counts, the rows shown, a failed run), which stays in view beside the title. */
  summary?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  settingId?: string;
}) {
  return (
    <section className={cn('space-y-2.5', settingId && HIGHLIGHT_CLASS, className)} data-slot="settings-section" data-setting-id={settingId}>
      <div className={SECTION_HEADER}>
        <div className={cn(SECTION_TITLE, 'flex min-h-7 flex-wrap items-center gap-x-2.5')}>
          <h2 className="flex min-h-7 items-center gap-1.5 text-sm font-normal tracking-title text-foreground/70">
            {title}
            {description ? <SectionAbout title={title} description={description} /> : null}
          </h2>
          {summary ? <p className="py-1 text-xs text-muted-foreground">{summary}</p> : null}
        </div>
        {headerAction ? <div className={SECTION_ACTION}>{headerAction}</div> : null}
      </div>
      <div className={cn(SECTION_CARD, contentClassName)}>
        {children}
      </div>
    </section>
  );
}

/**
 * What a section is for, behind an info mark after its title: headings stay one quiet line and the
 * explanation is a hover or a focus away rather than a paragraph above every card. Pages that head a part themselves
 * put it after their title too.
 */
export function SectionAbout({ title, description }: { title: ReactNode; description: ReactNode }) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label={typeof title === 'string' ? t('settings.section.about', { title }) : t('settings.section.aboutUntitled')}
          />
        }
      >
        <Info />
      </TooltipTrigger>
      <TooltipPopup className="max-w-80 text-balance">{description}</TooltipPopup>
    </Tooltip>
  );
}

const SECTION_CARD =
  'overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50';

/** A section's card without its header, for a part of a page that's already titled above it. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(SECTION_CARD, className)} data-slot="settings-card">{children}</div>;
}

/**
 * A section of advanced settings (TLS, logging, retries), folded until it's opened. Folded, it says how many of its
 * settings differ from their defaults, so a change isn't out of sight; Settings search opens it to show a row inside.
 * Its header action (a Save button) stays in reach either way, and it opens by itself when something in it needs
 * seeing, like a save that failed.
 */
export function FoldedSettingsSection({
  fold,
  title,
  description,
  headerAction,
  changed,
  attention = false,
  children,
}: {
  fold: SettingsFold;
  title: ReactNode;
  description?: ReactNode;
  headerAction?: ReactNode;
  /** How many of its settings differ from their defaults. */
  changed: number;
  /** Something inside needs seeing (a failed save), so the group opens. */
  attention?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const requested = useFocusRequest('setting');
  // Opened by search as it mounts, or with something in it to see, a group shows it at once rather than growing open
  // around it.
  const [open, setOpen] = useState(() => attention || settingEntry(requested)?.fold === fold);
  useEffect(() => {
    if (settingEntry(requested)?.fold === fold) setOpen(true);
  }, [requested, fold]);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-2.5" data-slot="settings-section" data-fold={fold}>
      <div className={SECTION_HEADER}>
        <div className={SECTION_TITLE}>
          <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal tracking-title text-foreground/70">
            <CollapsibleTrigger className="-ms-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none ring-ring transition-colors hover:text-foreground focus-visible:ring-2">
              {title}
            </CollapsibleTrigger>
            {!open && changed > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={t(changed === 1 ? 'settings.fold.changedHint.one' : 'settings.fold.changedHint.other', { count: changed })}>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                {t('settings.fold.changed', { count: changed })}
              </span>
            ) : null}
            {description ? <SectionAbout title={title} description={description} /> : null}
          </h2>
        </div>
        {headerAction ? <div className={SECTION_ACTION}>{headerAction}</div> : null}
      </div>
      <CollapsiblePanel>
        <div className={SECTION_CARD}>{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Title + description on the left, control on the right. `settingId` names the row in Settings search's index
 * (src/services/settingsIndex.ts), so search can bring it into view.
 */
export function SettingsRow({
  title,
  description,
  status,
  control,
  children,
  className,
  align = 'center',
  settingId,
  reset,
  marker,
  held,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
  align?: 'center' | 'start';
  settingId?: string;
  /** Offered beside the control while the value differs from a default Arbor knows (src/services/settingDefaults.ts). */
  reset?: ResetOffer;
  /** After the title: where a machine-scoped value comes from (src/components/layout/machineScope.tsx). */
  marker?: ReactNode;
  /** Why the control can't be changed here, as for a fleet-wide setting while one machine is picked. */
  held?: string;
}) {
  const controls = control !== undefined ? (
    <div className={cn('flex shrink-0 items-center justify-end gap-2', held && 'pointer-events-none opacity-50')} inert={held ? true : undefined}>
      {reset && !held ? <ResetToDefault reset={reset} /> : null}
      {control}
    </div>
  ) : null;
  return (
    <div className={cn('px-4 py-3', settingId && HIGHLIGHT_CLASS, className)} data-slot="settings-row" data-setting-id={settingId}>
      <div className={cn('grid grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] gap-8', align === 'center' ? 'items-center' : 'items-start')}>
        <div className="min-w-0 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium tracking-title text-foreground">{title}</h3>
            {marker}
          </div>
          {description ? <p className="max-w-xl text-xs leading-[1.45] text-muted-foreground">{description}</p> : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {controls && held ? (
          <Tooltip>
            <TooltipTrigger render={<div className="flex justify-end" />}>{controls}</TooltipTrigger>
            <TooltipPopup>{held}</TooltipPopup>
          </Tooltip>
        ) : controls}
      </div>
      {children ? <div className="pt-3">{children}</div> : null}
    </div>
  );
}

/** Puts a setting back at its default. The tooltip says what that is. */
function ResetToDefault({ reset }: { reset: ResetOffer }) {
  const { t } = useI18n();
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const row = event.currentTarget.closest('[data-slot="settings-row"]');
    reset.onReset();
    // The button goes once the value is back at its default, so the keyboard moves on to the control it reset.
    window.requestAnimationFrame(() => settingControl(row)?.focus());
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            disabled={reset.disabled}
            focusableWhenDisabled
            aria-label={t('settings.reset.label')}
            data-reset-default
            onClick={onClick}
          />
        }
      >
        <RotateCcw />
      </TooltipTrigger>
      <TooltipPopup>{reset.tooltip ?? t('settings.reset.tooltip', { value: reset.value })}</TooltipPopup>
    </Tooltip>
  );
}

/** Stacked content row without the two-column grid. */
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-3', className)} data-slot="settings-block">{children}</div>;
}

/** Key/value line used inside settings blocks. */
export function DetailRow({ label, value, mono = false, className }: { label: ReactNode; value: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-h-9 items-center justify-between gap-6 px-4 text-sm', className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-foreground', mono && 'font-mono text-sm')}>{value}</span>
    </div>
  );
}
