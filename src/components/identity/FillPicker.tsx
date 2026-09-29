import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { cn } from '../../lib/utils';
import { identityFills, type IdentityFill } from '../../services/identityColors';

const FILL_LABEL: Record<IdentityFill, MessageKey> = {
  soft: 'fills.soft',
  solid: 'fills.solid',
  outline: 'fills.outline',
  neutral: 'fills.neutral',
};

/**
 * The one fill picker, beside the color picker for machines and accounts alike: each fill named, with a small
 * example of the thing filled that way in its color (`preview`), so the choice shows what it'll look like.
 */
export function FillPicker({ value, onChange, label, preview }: { value: IdentityFill; onChange: (fill: IdentityFill) => void; label: string; preview: (fill: IdentityFill) => ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid max-w-73.5 grid-cols-2 gap-1" role="radiogroup" aria-label={label}>
      {identityFills.map((fill) => (
        <button
          key={fill}
          type="button"
          role="radio"
          aria-checked={value === fill}
          className={cn(
            'flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            value === fill ? 'border-foreground/40 bg-accent text-foreground' : 'border-border/70 text-muted-foreground',
          )}
          onClick={() => onChange(fill)}
        >
          {preview(fill)}
          <span className="truncate">{t(FILL_LABEL[fill])}</span>
        </button>
      ))}
    </div>
  );
}
