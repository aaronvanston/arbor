import { RefreshCw } from './icons';
import type * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * The refresh arrows, turning while what they refresh is under way, so a refresh button keeps its icon rather than
 * swapping it for a spinner. Inside a Button the button sizes it.
 */
function RefreshIcon({ refreshing = false, className, ...props }: React.ComponentProps<typeof RefreshCw> & { refreshing?: boolean }) {
  return <RefreshCw aria-hidden="true" className={cn(refreshing && 'motion-safe:animate-spin', className)} data-refreshing={refreshing || undefined} data-slot="refresh-icon" {...props} />;
}

export { RefreshIcon };
