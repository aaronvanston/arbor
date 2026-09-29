import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatBlock, StatsGrid } from '../src/components/layout/stats';

const grid = (columns: 2 | 3 | 4 | 6) => renderToStaticMarkup(
  <StatsGrid columns={columns}>
    {Array.from({ length: columns }, (_, index) => <StatBlock key={index} label={`Stat ${index}`} value={index} />)}
  </StatsGrid>,
);
const classesOf = (html: string, slot: string) => {
  const match = html.match(new RegExp(`<div class="([^"]*)" data-slot="${slot}"`));
  return (match?.[1] ?? '').split(' ');
};

describe('stats grid', () => {
  it('sizes its columns by its own width, so a hidden or wider sidebar counts, not the window', () => {
    const html = grid(6);
    expect(classesOf(html, 'stats-grid')).toContain('@container');
    expect(classesOf(html, 'stats-grid-columns')).not.toContain('grid-cols-6');
  });
});
