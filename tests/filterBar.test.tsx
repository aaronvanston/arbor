import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterBar, FilterField, type FilterChip } from '../src/components/FilterBar';
import { I18nProvider } from '../src/i18n';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const render = (chips: FilterChip[]) => renderToStaticMarkup(
  <I18nProvider>
    <FilterBar chips={chips} onRemove={() => {}} onClearAll={() => {}}>
      <FilterField label="Machine" htmlFor="filter-machine">
        <button id="filter-machine" type="button">All Machines</button>
      </FilterField>
    </FilterBar>
  </I18nProvider>,
);

describe('filter bar', () => {
  it('is one Filters button that opens a popover, with its fields out of the page until then', () => {
    const html = render([]);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>/);
    expect(text(html)).toBe('Filters');
    expect(html).not.toContain('All Machines');
  });

  it('shows each set filter as a chip that removes it, counts them on the button, and offers Clear all', () => {
    const html = render([
      { id: 'machine', label: 'Machine', value: 'cam-mbp' },
      { id: 'result', label: 'Request result', value: 'Failed' },
    ]);
    expect(text(html)).toBe('Filters 2 Machine cam-mbp Request result Failed Clear all');
    expect(html).toContain('aria-label="Filters, 2 on"');
    expect(html).toContain('aria-label="Remove the Machine filter"');
    expect(html).toContain('aria-label="Remove the Request result filter"');
    // A long value keeps its full text for the pointer.
    expect(html).toContain('title="cam-mbp"');
  });
});
