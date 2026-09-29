import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/utils';

const toggleVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-medium text-sm text-foreground outline-none transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'h-8 min-w-8 px-[calc(--spacing(2)-1px)]',
        sm: 'h-7 min-w-7 px-[calc(--spacing(1.5)-1px)]',
        segmented: "h-6 min-w-0 rounded-md px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default: 'border-transparent hover:bg-accent data-pressed:bg-input/64',
        outline: 'border-input bg-background shadow-xs/5 dark:bg-input/32 hover:bg-accent/50 data-pressed:bg-accent dark:data-pressed:bg-input',
        segmented:
          'border-transparent text-muted-foreground shadow-none hover:bg-background/55 hover:text-foreground data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs/10 dark:hover:bg-input/32 dark:data-pressed:bg-input/72',
      },
    },
  },
);

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({ size: 'default', variant: 'default' });

function ToggleGroup({
  className,
  variant = 'segmented',
  size = variant === 'segmented' ? 'segmented' : 'default',
  children,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const value = React.useMemo(() => ({ size, variant }), [size, variant]);
  return (
    <ToggleGroupPrimitive
      className={cn('flex w-fit *:focus-visible:z-10', variant === 'segmented' ? 'gap-0.5 rounded-lg bg-input/32 p-0.5 dark:bg-input/24' : 'gap-0.5', className)}
      data-slot="toggle-group"
      data-variant={variant}
      {...props}
    >
      <ToggleGroupContext value={value}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

function Toggle({ className, variant, size, ...props }: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.use(ToggleGroupContext);
  const resolvedVariant = variant ?? context.variant;
  const resolvedSize = size ?? context.size;
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, size: resolvedSize, variant: resolvedVariant }))}
      data-slot="toggle"
      {...props}
    />
  );
}

export { ToggleGroup, Toggle, toggleVariants };
