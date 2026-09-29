import type { CSSProperties } from 'react';
import { Pipette } from '../ui/icons';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { cn } from '../../lib/utils';
import { identityColors, identityColorValue, isCustomColor, type CustomColor, type PickedColor } from '../../services/identityColors';

/** Where the custom color's well starts when none is picked yet: indigo, in the middle of the palette. */
const CUSTOM_START: CustomColor = '#6366f1';

/**
 * The one color picker for anything named by a color, machines and accounts alike: the palette as tinted swatches
 * (the account chip's tint, with the color's dot), then a well that opens the system's picker for any other color.
 */
export function ColorPicker({ value, onChange, label, className }: { value: PickedColor; onChange: (color: PickedColor) => void; label: string; className?: string }) {
  const { t } = useI18n();
  const custom = isCustomColor(value) ? value : null;
  const swatch = 'relative flex size-6 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    // As wide as the machine look popover lays it out, so the swatches keep one spacing wherever the picker sits.
    <div className={cn('grid max-w-73.5 grid-cols-10 gap-1', className)} role="radiogroup" aria-label={label}>
      {identityColors.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(`colors.${color}` as MessageKey)}
          title={t(`colors.${color}` as MessageKey)}
          className={cn(swatch, 'account-chip', value === color && 'ring-2 ring-foreground/50')}
          style={{ '--account-color': identityColorValue[color] } as CSSProperties}
          onClick={() => onChange(color)}
        >
          <span className="size-3 rounded-full" style={{ backgroundColor: identityColorValue[color] }} aria-hidden="true" />
        </button>
      ))}
      {/* Any color at all, from the system's picker. Its well shows the one picked, or a pipette until then. */}
      <label
        className={cn(swatch, 'border border-dashed border-border has-focus-visible:ring-2 has-focus-visible:ring-ring', custom && 'border-solid ring-2 ring-foreground/50')}
        title={t('colors.custom')}
        style={custom ? ({ backgroundColor: custom } as CSSProperties) : undefined}
      >
        {custom ? null : <Pipette className="size-3.5 text-muted-foreground" aria-hidden="true" />}
        <input
          type="color"
          role="radio"
          aria-checked={Boolean(custom)}
          aria-label={t('colors.custom')}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={custom ?? CUSTOM_START}
          onChange={(event) => { if (isCustomColor(event.target.value)) onChange(event.target.value); }}
        />
      </label>
    </div>
  );
}
