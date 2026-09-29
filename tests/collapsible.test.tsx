import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../src/components/ui/collapsible';

const row = (open: boolean, chevron?: 'start' | 'end' | 'none') =>
  renderToStaticMarkup(
    <Collapsible open={open} onOpenChange={() => {}}>
      <CollapsibleTrigger chevron={chevron} className="flex w-full">
        <span>Sign in on the machine</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <p>Run claude login there.</p>
      </CollapsiblePanel>
    </Collapsible>,
  );

describe('collapsible', () => {
  it('puts the chevron before the row by default, after it when asked, or leaves it out', () => {
    const chevron = /<svg[^>]*data-slot="collapsible-chevron"/;
    const start = row(false);
    expect(start).toMatch(chevron);
    expect(start.search(chevron)).toBeLessThan(start.indexOf('Sign in on the machine'));
    const end = row(false, 'end');
    expect(end.search(chevron)).toBeGreaterThan(end.indexOf('Sign in on the machine'));
    expect(row(false, 'none')).not.toMatch(chevron);
  });
});
