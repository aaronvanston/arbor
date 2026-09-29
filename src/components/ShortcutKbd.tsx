import type { ReactNode } from 'react';
import { useShortcutKeys } from '../hooks/useShortcuts';
import { cn } from '../lib/utils';
import type { ShortcutId } from '../services/shortcuts';
import { Kbd } from './ui/kbd';

/** A shortcut's keys as this platform writes them (`⌘R`, `Ctrl+R`), for tooltips, hints and palette rows. */
export function ShortcutKbd({ id, className }: { id: ShortcutId; className?: string }) {
  const keys = useShortcutKeys(id);
  return keys ? <Kbd className={cn('h-4.5 min-w-4.5 px-1 text-2xs', className)}>{keys}</Kbd> : null;
}

/** A tooltip's text with the shortcut that does the same thing beside it. */
export function WithShortcut({ id, children }: { id: ShortcutId; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {children}
      <ShortcutKbd id={id} className="-me-1" />
    </span>
  );
}
