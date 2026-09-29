import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { ChevronRight } from './icons';
import { cn } from '../../lib/utils';

function Collapsible({ className, ...props }: Omit<CollapsiblePrimitive.Root.Props, 'className'> & { className?: string }) {
  return <CollapsiblePrimitive.Root className={className} data-slot="collapsible" {...props} />;
}

/** The chevron every expanding row shows: pointing right while closed, down while open. */
function CollapsibleChevron({ className }: { className?: string }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-data-[panel-open]/collapsible-trigger:rotate-90',
        className,
      )}
      data-slot="collapsible-chevron"
    />
  );
}

/**
 * What opens and closes the panel, with the chevron at its start or, for a row whose left edge already has a mark, at
 * its end. It carries aria-expanded and aria-controls for the panel.
 */
function CollapsibleTrigger({
  className,
  chevron = 'start',
  children,
  ...props
}: Omit<CollapsiblePrimitive.Trigger.Props, 'className'> & { className?: string; chevron?: 'start' | 'end' | 'none' }) {
  return (
    <CollapsiblePrimitive.Trigger className={cn('group/collapsible-trigger cursor-pointer', className)} data-slot="collapsible-trigger" {...props}>
      {chevron === 'start' ? <CollapsibleChevron /> : null}
      {children}
      {chevron === 'end' ? <CollapsibleChevron /> : null}
    </CollapsiblePrimitive.Trigger>
  );
}

function CollapsiblePanel({ className, ...props }: Omit<CollapsiblePrimitive.Panel.Props, 'className'> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Panel
      // Grows to its content's height and back; with reduced motion it just appears.
      className={cn(
        'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0',
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel };
