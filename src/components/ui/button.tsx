import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipPopup, TooltipTrigger } from './tooltip';

const buttonVariants = cva(
  "[--control-icon-color:currentColor] relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-sm outline-none transition-[box-shadow,scale,background-color,color] [&:active:not([aria-haspopup]):not([aria-disabled=true])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5",
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'h-8 px-[calc(--spacing(3)-1px)]',
        sm: 'h-7 gap-1.5 px-[calc(--spacing(2.5)-1px)]',
        xs: "h-6 gap-1 px-[calc(--spacing(2)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 px-[calc(--spacing(3.5)-1px)]',
        icon: 'size-8',
        'icon-sm': 'size-7',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-micro': "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        // A button disabled with aria-disabled, so its reason can show, is flat and looks the same under the pointer.
        // Its hover is undone rather than each hover limited to enabled buttons, so a hover class passed in still replaces the one here.
        default:
          'not-disabled:not-aria-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs not-aria-disabled:active:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[aria-disabled=true]]:shadow-none hover:bg-primary/90 aria-disabled:hover:bg-primary',
        destructive:
          'not-disabled:not-aria-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs not-aria-disabled:active:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[aria-disabled=true]]:shadow-none hover:bg-destructive/90 aria-disabled:hover:bg-destructive',
        'destructive-outline':
          'border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 not-disabled:not-aria-disabled:not-active:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:not-aria-disabled:not-active:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[aria-disabled=true]]:shadow-none hover:border-destructive/32 hover:bg-destructive/4 aria-disabled:hover:border-input aria-disabled:hover:bg-popover dark:aria-disabled:hover:bg-input/32',
        outline:
          '[--control-icon-color:var(--icon-muted)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-aria-disabled:not-active:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:not-aria-disabled:not-active:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[aria-disabled=true]]:shadow-none hover:bg-accent/50 dark:hover:bg-input/64 aria-disabled:hover:bg-popover dark:aria-disabled:hover:bg-input/32',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-accent dark:hover:bg-input/48 aria-disabled:hover:bg-secondary',
        ghost: '[--control-icon-color:var(--icon-muted)] border-transparent text-foreground hover:bg-accent data-[popup-open]:bg-accent aria-disabled:hover:bg-transparent',
        'ghost-muted': '[--control-icon-color:var(--icon-muted)] border-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
        link: 'h-auto border-transparent px-0 text-primary underline-offset-4 hover:underline aria-disabled:hover:no-underline',
      },
    },
  },
);

interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  /**
   * Why the button can't be used right now. Any reason disables it but leaves it hoverable and focusable, so the
   * reason shows in a tooltip and is read out with the button. Not for a button that's already a tooltip's trigger;
   * give that one `focusableWhenDisabled` and put the reason in its own tooltip.
   */
  disabledReason?: ReactNode;
  /** With `disabled`, keeps the button hoverable and focusable so the tooltip or title it sits in still shows. */
  focusableWhenDisabled?: boolean;
}

const preventActivation = (event: MouseEvent) => event.preventDefault();

function Button(buttonProps: ButtonProps) {
  const { className, variant, size, render, disabled, disabledReason, focusableWhenDisabled, children, ...props } = buttonProps;
  const reasonId = useId();
  const hasReason = disabledReason !== undefined && disabledReason !== null && disabledReason !== false && disabledReason !== '';
  // aria-disabled rather than the disabled attribute, which swallows the hover and focus a tooltip needs.
  const softDisabled = hasReason || (Boolean(disabled) && Boolean(focusableWhenDisabled));
  const typeValue: ButtonHTMLAttributes<HTMLButtonElement>['type'] = render ? undefined : 'button';
  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    'data-slot': 'button',
    // What's inside can tell a filled button from the rest: a machine pill lays itself over the page there (styles.css).
    'data-variant': variant ?? 'default',
    type: typeValue,
  };
  let ownProps: typeof props & { disabled?: boolean; children?: ReactNode } = { ...props, disabled, children };
  if (softDisabled) {
    // Drops whatever a click, press or key would set off, including the handlers a menu or popover trigger merges in.
    const { onClick, onMouseDown, onPointerDown, onKeyDown, onKeyUp, ...inert } = props;
    ownProps = {
      ...inert,
      'aria-disabled': true,
      // Enter and Space still fire click on a focused button; this also stops a submit button submitting its form.
      onClick: preventActivation,
      ...(hasReason
        ? {
            'aria-describedby': reasonId,
            // Hidden, but still read out as the button's description.
            children: <>{children}<span id={reasonId} hidden>{disabledReason}</span></>,
          }
        : { children }),
    };
  }
  const element = useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, ownProps),
    render,
  });
  // Passing `disabledReason` at all, even undefined, keeps the tooltip wrapper in place so the button isn't
  // remounted, and doesn't drop focus, as its reason comes and goes.
  if (!('disabledReason' in buttonProps)) return element;
  return (
    <Tooltip>
      <TooltipTrigger render={element} disabled={!hasReason} />
      {hasReason ? <TooltipPopup className="max-w-72">{disabledReason}</TooltipPopup> : null}
    </Tooltip>
  );
}

export { Button, buttonVariants, type ButtonProps };
