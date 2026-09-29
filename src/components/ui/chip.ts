import { cva } from 'class-variance-authority';

/**
 * A small bordered button that says a count or a setting and opens more about it, like an account's banked resets or
 * its cap. One height and padding for every chip, so a row of them lines up.
 */
export const chipVariants = cva(
  'inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-xs font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        default: 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground',
        /** Nothing to act on: no border until it's hovered. */
        quiet: 'border-transparent text-muted-foreground hover:border-border/70 hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground',
        primary: 'border-primary/30 bg-primary/8 text-primary hover:bg-primary/14 data-popup-open:bg-primary/14 dark:bg-primary/16',
        warning: 'border-warning/30 bg-warning/8 text-warning-foreground hover:bg-warning/14 data-popup-open:bg-warning/14 dark:bg-warning/16',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);
