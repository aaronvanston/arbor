import type * as React from 'react';
import { cn } from '../../lib/utils';

// Arbor's loader: nine dots lit on a diagonal wave, the brand's Diffusion at its smallest. Each dot starts a fifth of
// the wave after the one before it; under reduced motion they hold the wave still, brightest at the top left.
const DOTS = [0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => ({ row, column, step: row + column })));

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className={cn('size-4', className)} data-slot="spinner" {...props}>
      {DOTS.map(({ row, column, step }) => (
        <circle
          key={`${row}-${column}`}
          cx={5 + column * 7}
          cy={5 + row * 7}
          r={2.25}
          opacity={Number((1 - step * 0.18).toFixed(2))}
          className="motion-safe:animate-dot-wave"
          style={{ animationDelay: `${(step * 0.2 - 1.2).toFixed(1)}s` }}
        />
      ))}
    </svg>
  );
}

export { Spinner };
