import type * as React from 'react';
import { splitForMiddleTruncate } from '../../lib/middleTruncate';
import { cn } from '../../lib/utils';

/**
 * Shortens a path or a branch name in the middle, the way Finder does, so both ends stay: a path keeps its file name
 * and `fix/cache-main-20260918` keeps the date that tells it from its neighbors. The full value is the title.
 *
 * CSS has no middle ellipsis, so the text is split into a head that truncates and a tail that doesn't. Nothing is
 * measured, so it costs no more than `truncate` in a long table, and both halves are real text: a selection copies
 * the whole value and a screen reader reads it through.
 */
function MiddleTruncate({
  value,
  tail,
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  value: string;
  /** Characters kept at the end. By default a path's last segment, when it's short, or ten. */
  tail?: number;
}) {
  const split = splitForMiddleTruncate(value, tail);
  return (
    <span title={value} className={cn('inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap', className)} data-slot="middle-truncate" {...props}>
      {split ? (
        <>
          <span className="min-w-0 truncate">{split.head}</span>
          <span className="shrink-0">{split.tail}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{value}</span>
      )}
    </span>
  );
}

export { MiddleTruncate };
