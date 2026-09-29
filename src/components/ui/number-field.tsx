import { NumberField as NumberFieldPrimitive } from '@base-ui/react/number-field';
import { ChevronDown, ChevronUp } from './icons';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { getFormatRegion } from '../../lib/format';
import { cn } from '../../lib/utils';
import { INPUT_WRAPPER_CLASS } from './input';

/** What goes to the text field itself rather than the group around it. */
type FieldInputProps = Pick<ComponentProps<'input'>, 'placeholder' | 'autoFocus' | 'maxLength' | 'aria-label' | 'aria-invalid' | 'aria-describedby' | 'onBlur' | 'onKeyDown'>;

type NumberFieldProps = Omit<NumberFieldPrimitive.Root.Props, 'className' | 'style' | 'render' | 'children' | keyof FieldInputProps> & FieldInputProps & {
  size?: 'sm' | 'default';
  /** Monospace with even-width digits, as Input's. */
  font?: 'default' | 'mono';
  /** Before the number, such as a currency sign. */
  startAddon?: ReactNode;
  /** After the number, such as MB or s. It's read out as the field's description. */
  unit?: ReactNode;
  /** Classes for the text field, as Input's `className`. */
  className?: string;
  /** Classes for the bordered group, its width among them. */
  wrapperClassName?: string;
};

const STEPPER_CLASS =
  "flex w-5 flex-1 cursor-pointer items-center justify-center rounded-sm text-icon-muted outline-none transition-colors hover:bg-accent hover:text-foreground dark:hover:bg-input/64 data-disabled:cursor-default data-disabled:opacity-40 data-disabled:hover:bg-transparent data-disabled:hover:text-icon-muted [&_svg]:size-3";

/**
 * A number typed in, or stepped with the arrows beside it, the arrow keys, or Shift for tens.
 *
 * Typing isn't held to `min` and `max`, so a page's own check can say what's wrong with a number rather than it quietly
 * becoming another one; the arrows stay inside them. Numbers show in the Mac's region, without thousands separators
 * (a port reads 8317, not 8,317) and with up to ten decimals, so a price per million tokens keeps every digit.
 */
function NumberField({
  size = 'default',
  font = 'default',
  startAddon,
  unit,
  className,
  wrapperClassName,
  format,
  locale,
  allowOutOfRange = true,
  placeholder,
  autoFocus,
  maxLength,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  onBlur,
  onKeyDown,
  ...props
}: NumberFieldProps) {
  const { t } = useI18n();
  const unitId = useId();
  const describedBy = [ariaDescribedBy, unit ? unitId : null].filter(Boolean).join(' ') || undefined;
  return (
    <NumberFieldPrimitive.Root
      className={cn(INPUT_WRAPPER_CLASS, wrapperClassName)}
      data-size={size}
      data-slot="number-field"
      format={{ useGrouping: false, maximumFractionDigits: 10, ...format }}
      locale={locale ?? getFormatRegion().locale}
      allowOutOfRange={allowOutOfRange}
      {...props}
    >
      {startAddon ? (
        <span aria-hidden="true" className="pointer-events-none shrink-0 ps-2.5 text-xs text-muted-foreground">
          {startAddon}
        </span>
      ) : null}
      <NumberFieldPrimitive.Input
        className={cn(
          'h-7.5 w-full min-w-0 rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] leading-7.5 outline-none placeholder:text-placeholder disabled:cursor-not-allowed',
          size === 'sm' && 'h-6.5 px-[calc(--spacing(2.5)-1px)] text-xs leading-6.5',
          startAddon && 'ps-1',
          unit && 'pe-1',
          font === 'mono' && 'tabular-nums',
          className,
        )}
        data-slot="number-field-input"
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={maxLength}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={describedBy}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {unit ? (
        <span id={unitId} className="pointer-events-none shrink-0 pe-1 text-xs text-muted-foreground">
          {unit}
        </span>
      ) : null}
      {/* Spans rather than buttons: an arrow at the end of the range is disabled, and a disabled button would match
          the group's :has(:disabled) and fade the whole field. They stay out of the tab order either way. */}
      <span className="flex shrink-0 flex-col self-stretch py-px pe-px" data-slot="number-field-steppers">
        <NumberFieldPrimitive.Increment render={<span />} nativeButton={false} className={STEPPER_CLASS} aria-label={t('numberField.increase')} data-slot="number-field-increment">
          <ChevronUp aria-hidden="true" />
        </NumberFieldPrimitive.Increment>
        <NumberFieldPrimitive.Decrement render={<span />} nativeButton={false} className={STEPPER_CLASS} aria-label={t('numberField.decrease')} data-slot="number-field-decrement">
          <ChevronDown aria-hidden="true" />
        </NumberFieldPrimitive.Decrement>
      </span>
    </NumberFieldPrimitive.Root>
  );
}

/** A number kept as draft text, as the field takes it: blank, or text that isn't a number, is an empty field. */
function numberFromDraft(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The field's number back as draft text for a page that checks and saves text: an emptied field is blank. */
function draftFromNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

export { NumberField, numberFromDraft, draftFromNumber, type NumberFieldProps };
