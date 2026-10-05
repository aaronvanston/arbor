import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '../lib/utils';

/**
 * A column's right edge, dragged the way the sidebar's is: `onPreview` shows each width as the pointer moves, without a
 * render, and `onCommit` keeps it on release. The arrow keys, Home and End go through `forKey`, and a double-click
 * puts back `initial`. The caller places it on the column's border.
 */
export function ColumnResizeHandle({ width, min, max, initial, label, hint, clamp, forKey, onPreview, onCommit, className }: {
  width: number;
  min: number;
  max: number;
  initial: number;
  label: string;
  hint: string;
  clamp: (width: number) => number;
  forKey: (width: number, key: string) => number | null;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
  className?: string;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  // Never leaves the whole window on the resize cursor, even if the handle goes mid-drag.
  useEffect(() => () => { delete document.documentElement.dataset.columnResizing; }, []);

  const finish = (keep: boolean, handle: HTMLElement) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    delete handle.dataset.dragging;
    delete document.documentElement.dataset.columnResizing;
    if (keep) onCommit(current.width);
    else onPreview(current.startWidth);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = '';
    // Keeps the resize cursor over whatever the pointer crosses on the way (styles.css).
    document.documentElement.dataset.columnResizing = '';
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = clamp(current.startWidth + event.clientX - current.startX);
    if (next === current.width) return;
    current.width = next;
    onPreview(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = forKey(width, event.key);
    if (next === null || drag.current) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={hint}
      className={cn('group absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none select-none', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(true, event.currentTarget)}
      onPointerCancel={(event) => finish(false, event.currentTarget)}
      onLostPointerCapture={(event) => finish(true, event.currentTarget)}
      onDoubleClick={() => onCommit(initial)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-border group-focus-visible:bg-ring group-data-[dragging]:bg-primary/60"
      />
    </div>
  );
}
