import { Fragment, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * The line of small print under a row's title: its parts split by dots and centered on the line, so a machine's pill
 * sits level with the words either side of it. Words give way (truncate) before a pill does; empty parts are left out.
 */
export function MetaLine({ parts, title, className }: { parts: ReactNode[]; title?: string; className?: string }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '');
  return (
    <span className={cn('flex min-w-0 items-center gap-1 text-2xs text-muted-foreground', className)} title={title}>
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index ? <span aria-hidden="true">·</span> : null}
          {typeof part === 'string' || typeof part === 'number' ? <span className="min-w-0 truncate">{part}</span> : part}
        </Fragment>
      ))}
    </span>
  );
}
