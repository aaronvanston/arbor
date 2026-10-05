import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Check, ChevronRight } from './icons';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { LayerPopupContext, pressedLayerAbove, useLayerPopup, useLayerPopupRef, usePopupShown } from './layers';

/** Whether the menu's popup is on screen or on its way off; a popup outside `Menu` and `ContextMenu` always renders. */
const MenuShown = createContext(true);

/**
 * Stays open under a dialog it opened, such as a confirmation, while a press in that dialog is answered. Its popup
 * renders only while it's shown (`usePopupShown`).
 */
function Menu<Payload>({ onOpenChange, onOpenChangeComplete, ...props }: MenuPrimitive.Root.Props<Payload>) {
  const popupRef = useLayerPopupRef();
  const popup = usePopupShown(props);
  return (
    <LayerPopupContext value={popupRef}>
      <MenuShown value={popup.shown}>
        <MenuPrimitive.Root
          {...props}
          onOpenChange={(open, details) => {
            if (!open && details.reason === 'outside-press' && pressedLayerAbove(popupRef.current, details.event)) {
              details.cancel();
              return;
            }
            popup.onOpenChange(open);
            onOpenChange?.(open, details);
          }}
          onOpenChangeComplete={(open) => {
            popup.onOpenChangeComplete(open);
            onOpenChangeComplete?.(open);
          }}
        />
      </MenuShown>
    </LayerPopupContext>
  );
}

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

/**
 * A menu a right-click opens over an area, at the pointer. It takes the same MenuPopup and items as Menu, since Base
 * UI's context menu is built from the menu's own parts; its popup too renders only while it's shown.
 */
function ContextMenu({ onOpenChange, onOpenChangeComplete, ...props }: ContextMenuPrimitive.Root.Props) {
  const popup = usePopupShown(props);
  return (
    <MenuShown value={popup.shown}>
      <ContextMenuPrimitive.Root
        {...props}
        onOpenChange={(open, details) => {
          popup.onOpenChange(open);
          onOpenChange?.(open, details);
        }}
        onOpenChangeComplete={(open) => {
          popup.onOpenChangeComplete(open);
          onOpenChangeComplete?.(open);
        }}
      />
    </MenuShown>
  );
}

function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = 'end',
  side = 'bottom',
  anchor,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  side?: MenuPrimitive.Positioner.Props['side'];
  anchor?: MenuPrimitive.Positioner.Props['anchor'];
}) {
  const popupRef = useLayerPopup();
  if (!useContext(MenuShown)) return null;
  return (
    <MenuPrimitive.Portal>
      {/* Same layer as dialogs (see dialog.tsx), so whichever opened last is on top. */}
      <MenuPrimitive.Positioner align={align} anchor={anchor} className="z-50" data-slot="menu-positioner" side={side} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          className={cn(
            'dropdown-glass relative flex min-w-40 origin-(--transform-origin) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none transition-[scale,opacity] duration-150 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]',
            className,
          )}
          data-slot="menu-popup"
          ref={popupRef ?? undefined}
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** How an item's icons sit, on the item itself or on the row an item with a reason keeps its icon and label in. */
const iconClassName =
  "[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground [&>svg]:pointer-events-none [&>svg]:shrink-0";

const itemClassName = cn(
  'flex min-h-7 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-sm text-foreground outline-none data-disabled:pointer-events-none data-disabled:opacity-64 data-highlighted:bg-accent data-highlighted:text-accent-foreground',
  iconClassName,
);

/**
 * `disabledReason` grays the item out and says why under its label, still readable, as a disabled item can't show a
 * tooltip. The item stays reachable with the arrow keys, and the reason is read out with it, once: named by its label
 * alone and described by the reason, rather than named by both.
 */
function MenuItem({ className, variant = 'default', disabled, disabledReason, children, ...props }: MenuPrimitive.Item.Props & {
  variant?: 'default' | 'destructive';
  disabledReason?: ReactNode;
}) {
  const labelId = useId();
  const reasonId = useId();
  const hasReason = disabledReason !== undefined && disabledReason !== null && disabledReason !== false && disabledReason !== '';
  return (
    <MenuPrimitive.Item
      className={cn(
        itemClassName,
        "data-[variant=destructive]:text-destructive-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current",
        // Only the icon and label fade, not the reason under them.
        hasReason && 'flex-col items-stretch gap-0.5 data-disabled:opacity-100',
        className,
      )}
      data-slot="menu-item"
      data-variant={variant}
      disabled={disabled || hasReason}
      aria-labelledby={hasReason ? labelId : undefined}
      aria-describedby={hasReason ? reasonId : undefined}
      {...props}
    >
      {hasReason ? (
        <>
          <span id={labelId} className={cn('flex items-center gap-2 opacity-64', iconClassName)}>{children}</span>
          <span id={reasonId} className="max-w-60 ps-6 text-xs text-muted-foreground" data-slot="menu-item-reason">{disabledReason}</span>
        </>
      ) : children}
    </MenuPrimitive.Item>
  );
}

/** A menu inside a menu: a MenuSubTrigger and the MenuPopup it opens, to the side. */
// A submenu's popup isn't the menu's own, so it doesn't take the menu's popup ref.
function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return (
    <LayerPopupContext value={null}>
      <MenuPrimitive.SubmenuRoot {...props} />
    </LayerPopupContext>
  );
}

function MenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger className={cn(itemClassName, 'data-popup-open:bg-accent', className)} data-slot="menu-sub-trigger" {...props}>
      {children}
      <ChevronRight aria-hidden="true" className="ms-auto size-3.5 text-muted-foreground" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

/** A menu row that turns something on or off; the box is drawn like Checkbox and screen readers hear its state. */
function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(itemClassName, 'group/menu-checkbox', className)} data-slot="menu-checkbox-item" {...props}>
      <span
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[.25rem] border border-input text-primary-foreground group-data-checked/menu-checkbox:border-primary group-data-checked/menu-checkbox:bg-primary"
        aria-hidden="true"
      >
        <MenuPrimitive.CheckboxItemIndicator render={<Check className="size-2.5" strokeWidth={3} />} />
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

/** One choice of a MenuRadioGroup, ticked when it's the group's value. */
function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClassName, className)} data-slot="menu-radio-item" {...props}>
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        <MenuPrimitive.RadioItemIndicator render={<Check className="size-3.5 text-primary" />} />
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn('mx-2 my-1 h-px bg-border', className)} data-slot="menu-separator" {...props} />;
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuGroupLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} data-slot="menu-group-label" {...props} />;
}

export { ContextMenu, ContextMenuTrigger, Menu, MenuTrigger, MenuPopup, MenuItem, MenuSub, MenuSubTrigger, MenuCheckboxItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuGroup, MenuGroupLabel };
