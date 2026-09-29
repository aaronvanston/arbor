import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefreshIcon } from '../src/components/ui/refresh-icon';

const icon = (html: string) => html.match(/<svg[^>]*data-slot="refresh-icon"[^>]*>/)?.[0] ?? '';
const classes = (tag: string) => tag.match(/class="([^"]*)"/)?.[1]?.split(' ') ?? [];

describe('refresh icon', () => {
  it('stays still until something is refreshing', () => {
    const still = icon(renderToStaticMarkup(<RefreshIcon />));
    expect(classes(still)).not.toContain('motion-safe:animate-spin');
    expect(still).not.toContain('data-refreshing');
  });

  it('turns while it refreshes, unless the Mac asks for less motion', () => {
    const turning = icon(renderToStaticMarkup(<RefreshIcon refreshing />));
    expect(classes(turning)).toContain('motion-safe:animate-spin');
    expect(classes(turning)).not.toContain('animate-spin');
    expect(turning).toContain('data-refreshing="true"');
  });

  it('keeps the classes a page gives it', () => {
    expect(classes(icon(renderToStaticMarkup(<RefreshIcon refreshing className="size-3" />)))).toEqual(expect.arrayContaining(['size-3', 'motion-safe:animate-spin']));
  });
});
