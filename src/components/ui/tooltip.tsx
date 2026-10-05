import { createContext, useContext } from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { usePopupShown } from './layers';

const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Whether the tooltip's popup is on screen or on its way off. Outside `Tooltip` (no such use today) a popup always
 * renders, leaving Base UI to decide.
 */
const TooltipShown = createContext(true);

/** A tooltip, whose popup renders only while it's shown (`usePopupShown`). */
function Tooltip({ onOpenChange, onOpenChangeComplete, ...props }: TooltipPrimitive.Root.Props) {
  const popup = usePopupShown(props);
  return (
    <TooltipShown.Provider value={popup.shown}>
      <TooltipPrimitive.Root
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
    </TooltipShown.Provider>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

const tooltipPopupVariants = cva(
  'relative flex origin-(--transform-origin) text-balance rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md/5 transition-[scale,opacity] duration-150 not-dark:bg-clip-padding data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0',
  {
    variants: {
      // Prose wraps at one width, so a long hint reads as a short paragraph rather than a line across the window; a
      // command or a path gets more room, in monospace. Both break inside a word that's wider than they are.
      variant: {
        default: 'max-w-72 wrap-anywhere',
        code: 'max-w-120 wrap-anywhere font-mono text-2xs leading-relaxed',
        // A few facts laid out as a small card (the sidebar's machines and limits): wider, with room between its parts.
        card: 'w-64 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg px-3 py-2.5 text-pretty',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function TooltipPopup({
  className,
  variant,
  align = 'center',
  sideOffset = 4,
  side = 'top',
  children,
  ...props
}: TooltipPrimitive.Popup.Props & VariantProps<typeof tooltipPopupVariants> & {
  align?: TooltipPrimitive.Positioner.Props['align'];
  side?: TooltipPrimitive.Positioner.Props['side'];
  sideOffset?: TooltipPrimitive.Positioner.Props['sideOffset'];
}) {
  if (!useContext(TooltipShown)) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner align={align} className="pointer-events-none z-[140] max-w-(--available-width)" data-slot="tooltip-positioner" side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup className={cn(tooltipPopupVariants({ variant }), className)} data-slot="tooltip-popup" {...props}>
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup, tooltipPopupVariants };
