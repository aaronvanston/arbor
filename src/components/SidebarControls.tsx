import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type Ref, type RefObject } from 'react';
import { PanelLeft, PanelLeftClose } from './ui/icons';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { draggedSidebarWidth, resetSidebarWidth, setSidebarWidth, SIDEBAR_MIN_WIDTH, sidebarWidthForKey } from '../services/sidebarLayout';
import { WithShortcut } from './ShortcutKbd';
import { Button } from './ui/button';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';
import { TOGGLE_BUTTON_CLASS, TOGGLE_INK_CLASS } from './sidebar/shellParts';

/** The id the sidebar's buttons and resize handle point at. */
export const SIDEBAR_ID = 'app-sidebar';

/**
 * The one sidebar button, as T3 has it: fixed to the window beside the Mac window buttons, in the same place whether
 * the sidebar is open or hidden, so the page's title starts past it. Over the sidebar's artwork it takes the art's
 * ink. Its tooltip names ⌘B.
 */
export function SidebarToggle({ shown, onToggle, className, buttonRef, ink }: {
  shown: boolean;
  onToggle: () => void;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** The artwork's ink, while the button sits over it. */
  ink?: string;
}) {
  const { t } = useI18n();
  const label = t(shown ? 'app.sidebar.hide' : 'app.sidebar.show');
  const Icon = shown ? PanelLeftClose : PanelLeft;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            variant="ghost-muted"
            size="icon-sm"
            className={cn(TOGGLE_BUTTON_CLASS, ink && TOGGLE_INK_CLASS, className)}
            style={ink ? { color: ink } : undefined}
            onClick={onToggle}
            aria-label={label}
            aria-expanded={shown}
            aria-controls={SIDEBAR_ID}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipPopup side="bottom"><WithShortcut id="sidebar.toggle">{label}</WithShortcut></TooltipPopup>
    </Tooltip>
  );
}

/**
 * The sidebar's right edge. Dragging it writes the width straight into the shell's `--sidebar-width` and saves it on
 * release, so a drag re-renders nothing. The arrow keys move it a step, Home and End all the way, and a double-click
 * puts it back to the default. It never takes the page under 640px (`max`, the window's widest).
 */
export function SidebarResizeHandle({ width, max, shell }: { width: number; max: number; shell: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const show = (value: number) => shell.current?.style.setProperty('--sidebar-width', `${value}px`);
  // Never leaves the whole window on the resize cursor, even if the handle goes mid-drag.
  useEffect(() => () => { delete document.documentElement.dataset.sidebarResizing; }, []);

  const finish = (keep: boolean, handle: HTMLElement) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    delete handle.dataset.dragging;
    delete document.documentElement.dataset.sidebarResizing;
    if (keep) setSidebarWidth(current.width);
    else show(current.startWidth);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    // No text selection starts and the focus stays put, as it does dragging a window's edge.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = '';
    // Keeps the resize cursor over whatever the pointer crosses on the way (styles.css).
    document.documentElement.dataset.sidebarResizing = '';
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = draggedSidebarWidth(current.startWidth, current.startX, event.clientX, max);
    if (next === current.width) return;
    current.width = next;
    show(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = sidebarWidthForKey(width, event.key, max);
    if (next === null || drag.current) return;
    event.preventDefault();
    setSidebarWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('app.sidebar.resize')}
      aria-controls={SIDEBAR_ID}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      title={t('app.sidebar.resizeHint')}
      // T3's 16px strip, centered on the border so it's easy to catch from either side; above the page it overlaps.
      className="group absolute inset-y-0 -right-2 z-20 w-4 cursor-col-resize touch-none outline-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(true, event.currentTarget)}
      // The system took the pointer away mid-drag: back to where it started.
      onPointerCancel={(event) => finish(false, event.currentTarget)}
      onLostPointerCapture={(event) => finish(true, event.currentTarget)}
      onDoubleClick={resetSidebarWidth}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors',
          // T3's: the border color as soon as the pointer is on it, the accent only while it's dragged.
          'group-hover:bg-sidebar-border group-focus-visible:bg-ring group-data-[dragging]:bg-primary/60',
        )}
      />
    </div>
  );
}
