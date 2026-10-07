import { lazy, Suspense, useState } from 'react';
import type { Harness } from '../native/types';
import { Button } from '../components/ui/button';
import { MoreHorizontal } from '../components/ui/icons';

/** A home's folder that names one folder, rather than a pattern or where a variable points, which the clean-up can find. */
export const concreteHomePath = (path: string) => (path.startsWith('~/') || path.startsWith('/')) && !path.includes('*');

// The clean-up's flow and menu load the first time a row's menu is opened, so the pages that list homes and agents
// don't carry them until someone asks.
const CleanupRowMenu = lazy(() => import('./cleanupActions').then((module) => ({ default: module.CleanupRowMenu })));

export type CleanupMenuProps = {
  machines: string[];
  /** A home's folder to set aside, when it names one. */
  path?: string | null;
  /** The agent to take off, on a row that stands for one. */
  harness?: Harness | null;
  /** Offer "Clean up on <machine>…" instead, for a home the clean-up can't find by its path (a pattern, a variable). */
  openPage?: boolean;
  label: string;
};

/** A row's "Remove from <machine>…" menu, its trigger drawn at once and the rest loaded when it's first opened. */
export function LazyCleanupRowMenu(props: CleanupMenuProps) {
  const [wanted, setWanted] = useState(false);
  if (!props.machines.length || (!props.path && !props.harness && !props.openPage)) return null;
  const trigger = (
    <Button variant="ghost" size="icon-xs" aria-label={props.label} title={props.label} onClick={() => setWanted(true)}>
      <MoreHorizontal />
    </Button>
  );
  if (!wanted) return trigger;
  return (
    <Suspense fallback={trigger}>
      <CleanupRowMenu {...props} defaultOpen />
    </Suspense>
  );
}
