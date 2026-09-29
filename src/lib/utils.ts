import { type CxOptions, cx } from 'class-variance-authority';
import { extendTailwindMerge } from 'tailwind-merge';

// The theme's extra font sizes and letter spacings (styles.css), registered so cn() treats them as what they are rather
// than relying on tailwind-merge guessing from the name. Read as a color, text-2xs would be dropped next to
// text-muted-foreground; unregistered, tracking-title wouldn't replace tracking-tight.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['2xs', '3xs'], tracking: ['title'] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
