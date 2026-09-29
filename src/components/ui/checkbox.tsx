import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from '../../lib/utils';

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[.25rem] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none ring-ring transition-shadow focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background data-disabled:cursor-not-allowed data-disabled:opacity-64 dark:not-data-checked:bg-input/32 [[data-disabled],[data-checked]]:shadow-none',
        className,
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="-inset-px absolute flex items-center justify-center rounded-[.25rem] text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:bg-primary"
        data-slot="checkbox-indicator"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            <svg className="size-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" aria-hidden="true">
              {state.indeterminate ? <path d="M5.252 12h13.496" /> : <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />}
            </svg>
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
