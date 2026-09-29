import { describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, buttonVariants } from '../src/components/ui/button';

const render = (element: ReactElement) => renderToStaticMarkup(element);

describe('a button that says why it is disabled', () => {
  it('stays focusable and hoverable, and carries the reason as its description', () => {
    const html = render(<Button disabledReason="Refresh quota first">Reset</Button>);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(' disabled=""');
    const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<span id="${id}" hidden="">Refresh quota first</span>`);
  });

  it('is an ordinary button while there is no reason', () => {
    const html = render(<Button disabledReason={undefined}>Reset</Button>);
    expect(html).not.toContain('aria-disabled="');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain(' disabled=""');
  });

  it('looks the same under the pointer, and isn’t raised, whatever its variant', () => {
    const variants = ['default', 'destructive', 'destructive-outline', 'outline', 'secondary', 'ghost', 'ghost-muted', 'link'] as const;
    // What a utility sets: bg, text, border or underline.
    const property = (utility: string) => utility.replace(/^no-/, '').split('-')[0];
    for (const variant of variants) {
      const classes = buttonVariants({ variant }).split(' ');
      const changed = (prefix: RegExp) => new Set(classes.filter((name) => prefix.test(name)).map((name) => property(name.replace(prefix, ''))));
      const hovered = changed(/^(dark:)?hover:/);
      const undone = changed(/^(dark:)?aria-disabled:hover:/);
      expect({ variant, notUndone: [...hovered].filter((name) => !undone.has(name)) }).toEqual({ variant, notUndone: [] });
      const raised = classes.filter((name) => name.includes('not-disabled:') && !name.includes('not-aria-disabled:'));
      expect({ variant, raised }).toEqual({ variant, raised: [] });
    }
  });

  it('can stay reachable for the tooltip it already sits in', () => {
    const soft = render(<Button disabled focusableWhenDisabled aria-label="Previous page" />);
    expect(soft).toContain('aria-disabled="true"');
    expect(soft).not.toContain(' disabled=""');
    expect(soft).not.toContain('aria-describedby');
    expect(render(<Button disabled>Save</Button>)).toContain(' disabled=""');
    expect(render(<Button focusableWhenDisabled>Save</Button>)).not.toContain('aria-disabled="');
  });
});
