import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from '../../lib/utils';

/**
 * One number picked along a track: dragged, clicked or stepped with the arrow keys (Shift or Page Up and Down for bigger
 * steps). `onValueChange` follows the drag; `onValueCommitted` says where it was let go.
 */
function Slider({ className, thumbLabel, ...props }: Omit<SliderPrimitive.Root.Props<number>, 'children'> & {
  /** What the number is, read out on the thumb. */
  thumbLabel: string;
}) {
  return (
    <SliderPrimitive.Root className={cn('w-full touch-none select-none data-disabled:opacity-64', className)} thumbAlignment="edge" data-slot="slider" {...props}>
      <SliderPrimitive.Control className="flex h-4 w-full cursor-pointer items-center data-disabled:cursor-not-allowed" data-slot="slider-control">
        <SliderPrimitive.Track className="relative h-1.5 w-full rounded-full bg-input/60 dark:bg-input" data-slot="slider-track">
          <SliderPrimitive.Indicator className="h-full rounded-full bg-primary" data-slot="slider-indicator" />
          <SliderPrimitive.Thumb
            className="size-4 rounded-full border border-border bg-white shadow-sm/10 outline-none transition-shadow has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background"
            getAriaLabel={() => thumbLabel}
            data-slot="slider-thumb"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
