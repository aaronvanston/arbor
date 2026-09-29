import type { ReactNode } from 'react';
import type { PaletteEntry } from '../services/commandPalette';
import type { ShortcutId } from '../services/shortcuts';

/** The lists that open in place of the palette's own, for an action that needs an account chosen. */
export type PaletteSubmenu = 'pause' | 'resume';

export type PaletteItem = PaletteEntry & {
  icon: ReactNode;
  content?: ReactNode;
  /** Said at the end of the row, like the account's provider or which appearance is on. */
  detail?: string;
  shortcut?: ShortcutId;
  /** Why it can't run now. The row stays listed, grayed out, and says so. */
  disabledReason?: string;
  /** Opens this list instead of running. */
  submenu?: PaletteSubmenu;
  /** Runs once the palette has closed; an action says how it went in a toast. */
  run?: () => void | Promise<void>;
};

export function IconBox({ children }: { children: ReactNode }) {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1 text-muted-foreground dark:bg-input/32 [&_svg]:size-3.5">
      {children}
    </span>
  );
}
