import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { LayerPopupContext, pressedLayerAbove, useLayerPopup, useLayerPopupRef } from './layers';

/** Stays open under a dialog it opened, such as a confirmation, while a press in that dialog is answered. */
function Popover<Payload>({ onOpenChange, ...props }: PopoverPrimitive.Root.Props<Payload>) {
  const popupRef = useLayerPopupRef();
  return (
    <LayerPopupContext value={popupRef}>
      <PopoverPrimitive.Root
        {...props}
        onOpenChange={(open, details) => {
          if (!open && details.reason === 'outside-press' && pressedLayerAbove(popupRef.current, details.event)) {
            details.cancel();
            return;
          }
          onOpenChange?.(open, details);
        }}
      />
    </LayerPopupContext>
  );
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

const popoverPopupVariants = cva(
  'dropdown-glass relative flex origin-(--transform-origin) rounded-lg text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none transition-[scale,opacity] duration-150 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]',
  {
    variants: {
      // A popover holds prose or a small form, so it has a width rather than growing with its longest line.
      width: {
        auto: '',
        sm: 'w-64 max-w-[calc(100vw-2rem)]',
        md: 'w-80 max-w-[calc(100vw-2rem)]',
        lg: 'w-96 max-w-[calc(100vw-2rem)]',
      },
    },
    defaultVariants: { width: 'auto' },
  },
);

const popoverContentVariants = cva('max-h-(--available-height) w-full overflow-y-auto', {
  variants: {
    // `compact` for a list or a few facts; `none` for content that draws its own edges.
    padding: {
      default: 'p-4',
      compact: 'px-3 py-2',
      none: '',
    },
  },
  defaultVariants: { padding: 'default' },
});

/**
 * What a trigger opens beside itself: facts or a small form that stays until it's closed, rather than a tooltip's hint
 * that goes when the pointer does. Escape, a click outside and PopoverClose close it, and focus goes back to the trigger.
 */
function PopoverPopup({
  children,
  className,
  width,
  padding,
  side = 'bottom',
  align = 'center',
  sideOffset = 4,
  alignOffset = 0,
  anchor,
  keepMounted = false,
  ...props
}: PopoverPrimitive.Popup.Props & VariantProps<typeof popoverPopupVariants> & VariantProps<typeof popoverContentVariants> & {
  side?: PopoverPrimitive.Positioner.Props['side'];
  align?: PopoverPrimitive.Positioner.Props['align'];
  sideOffset?: PopoverPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: PopoverPrimitive.Positioner.Props['alignOffset'];
  anchor?: PopoverPrimitive.Positioner.Props['anchor'];
  keepMounted?: PopoverPrimitive.Portal.Props['keepMounted'];
}) {
  const popupRef = useLayerPopup();
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50 max-w-(--available-width)"
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup className={cn(popoverPopupVariants({ width }), className)} data-slot="popover-popup" ref={popupRef ?? undefined} {...props}>
          <div className={popoverContentVariants({ padding })}>{children}</div>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title className={cn('text-sm font-semibold leading-none', className)} data-slot="popover-title" {...props} />;
}

function PopoverClose(props: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

/** Opens and closes a popover from code: the update pill opens its card on keyboard focus. */
const createPopoverHandle = PopoverPrimitive.createHandle;

export { Popover, PopoverTrigger, PopoverPopup, PopoverTitle, PopoverClose, createPopoverHandle, popoverPopupVariants, popoverContentVariants };
