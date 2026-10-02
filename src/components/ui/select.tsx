import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, ChevronUp } from './icons';
import { useScrollEdges } from '../../hooks/useScrollFade';
import { cn } from '../../lib/utils';

const Select = SelectPrimitive.Root;

const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg border text-left text-sm outline-none transition-[color,box-shadow,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      variant: {
        default:
          "w-full min-w-36 border-input bg-background not-dark:bg-clip-padding text-foreground shadow-xs/5 ring-ring/24 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-visible:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:border-ring focus-visible:ring-[3px] dark:bg-input/32 dark:not-data-disabled:not-focus-visible:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='text-'])]:text-icon-muted [[data-disabled],:focus-visible,[data-pressed]]:shadow-none",
        ghost: 'border-transparent text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground',
      },
      size: {
        default: 'min-h-8 px-[calc(--spacing(3)-1px)]',
        sm: 'min-h-7 gap-1.5 px-[calc(--spacing(2.5)-1px)]',
        xs: "h-6 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
  },
);

function SelectTrigger({
  className,
  size,
  variant,
  children,
  ...props
}: SelectPrimitive.Trigger.Props & VariantProps<typeof selectTriggerVariants>) {
  return (
    <SelectPrimitive.Trigger className={cn(selectTriggerVariants({ size, variant }), className)} data-slot="select-trigger" {...props}>
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <ChevronDown className="-me-1 size-3.5 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value className={cn('flex-1 truncate data-placeholder:text-placeholder', className)} data-slot="select-value" {...props} />;
}

function SelectPopup({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  alignItemWithTrigger = false,
  ...props
}: SelectPrimitive.Popup.Props & {
  side?: SelectPrimitive.Positioner.Props['side'];
  sideOffset?: SelectPrimitive.Positioner.Props['sideOffset'];
  align?: SelectPrimitive.Positioner.Props['align'];
  alignItemWithTrigger?: boolean;
}) {
  // Base UI shows a scroll arrow when the list is a single pixel taller than its box, which zoom's rounding alone
  // does (two options at 120%). The arrow sits over the last option and takes its clicks, so each one also waits
  // for more than a pixel to scroll its way.
  const [listRef, listEdges] = useScrollEdges<HTMLDivElement>();
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner align={align} alignItemWithTrigger={alignItemWithTrigger} className="z-50 select-none" data-slot="select-positioner" side={side} sideOffset={sideOffset}>
        <SelectPrimitive.Popup
          className="origin-(--transform-origin) rounded-lg text-foreground outline-none transition-[scale,opacity] duration-150 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0"
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className={cn('top-0 z-50 flex h-6 w-full cursor-default items-center justify-center', !listEdges.start && 'hidden')}>
            <ChevronUp className="size-4" />
          </SelectPrimitive.ScrollUpArrow>
          <div className="dropdown-glass relative min-w-(--anchor-width) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
            <SelectPrimitive.List ref={listRef} className={cn('max-h-(--available-height) overflow-y-auto p-1', className)} data-slot="select-list">
              {children}
            </SelectPrimitive.List>
          </div>
          <SelectPrimitive.ScrollDownArrow className={cn('bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center', !listEdges.end && 'hidden')}>
            <ChevronDown className="size-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm outline-none data-selected:bg-foreground/[0.06] data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate" data-slot="select-item-text">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="flex shrink-0 items-center text-primary" data-slot="select-item-indicator">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel(props: SelectPrimitive.GroupLabel.Props) {
  return <SelectPrimitive.GroupLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground" data-slot="select-group-label" {...props} />;
}

export { Select, SelectTrigger, selectTriggerVariants, SelectValue, SelectPopup, SelectItem, SelectGroup, SelectGroupLabel };
