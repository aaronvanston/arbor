import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../src/components/layout/page';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';

const page = (width?: 'main' | 'readable', actions?: string) => renderToStaticMarkup(
  <I18nProvider>
    <Page width={width}>
      <PageTopbar actions={actions}>
        <PageBreadcrumb segments={['Sessions', 'Fix the login loop']} />
      </PageTopbar>
      <PageBody>content</PageBody>
    </Page>
  </I18nProvider>,
);

describe('page column', () => {
  test('with actions the title keeps its width; only its last segment truncates', () => {
    const html = page('main', 'tabs');
    const title = html.slice(html.indexOf('data-slot="page-topbar"'), html.indexOf('<h1'));
    expect(title).toContain('max-w-[60%] shrink-0');
    expect(html).toMatch(/<span class="[^"]*shrink-0 whitespace-nowrap text-muted-foreground">Sessions<\/span>/);
    expect(html).toMatch(/<span class="[^"]*truncate text-foreground">Fix the login loop<\/span>/);
    expect(page('main')).not.toContain('max-w-[60%]');
  });

  test('the breadcrumb is T3’s: medium weight throughout, a muted "/" between items, 12px apart', () => {
    const html = page('main');
    const [, heading = ''] = html.match(/<h1 class="([^"]*)">/) ?? [];
    expect(heading.split(' ')).toEqual(expect.arrayContaining(['gap-3', 'text-sm', 'font-medium']));
    expect(html).toContain('<span aria-hidden="true" class="shrink-0 text-icon-muted">/</span>');
    const crumbs = html.slice(html.indexOf('<h1'), html.indexOf('</h1>'));
    expect(crumbs).not.toContain('<svg');
  });

  test('the body contains what is absolutely positioned inside it, so nothing stretches the window past its height', () => {
    // An sr-only label far down a page was placed against the window; jumping to it scrolled the window itself.
    const [, scroll = ''] = page('main').match(/<div class="([^"]*)" data-slot="page-scroll">/) ?? [];
    expect(scroll.split(' ')).toContain('relative');
    expect(scroll.split(' ')).toContain('overflow-y-auto');
  });

  test('actions that don’t fit fold into ⋯ instead of scrolling sideways, and refresh stays last', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TooltipProvider>
          <Page width="main">
            <PageTopbar collapsible={[{ id: 'range', bar: 'range', menu: 'range rows' }, false, { id: 'compare', bar: 'compare', menu: 'machine rows' }]} actions="refresh">
              <PageBreadcrumb segments={['Sync', 'Checks']} />
            </PageTopbar>
          </Page>
        </TooltipProvider>
      </I18nProvider>,
    );
    const [, strip = ''] = html.match(/<div class="([^"]*)" data-slot="page-topbar-actions">/) ?? [];
    // Clipped, never scrolled: what doesn't fit is in the menu.
    expect(strip.split(' ')).toContain('overflow-hidden');
    expect(strip).not.toContain('overflow-x-auto');
    // In order, the skipped one left out, and the pinned group after them.
    const order = [...html.matchAll(/data-slot="page-topbar-(action|pinned)"[^>]*>([^<]*)</g)].map(([, , text]) => text);
    expect(order).toEqual(['range', 'compare', 'refresh']);
    // Everything fits until the window says otherwise, so there's no ⋯ yet.
    expect(html).not.toContain('More actions');
    expect(html).not.toContain('data-folded');
    expect(page('main')).not.toContain('page-topbar-actions');
  });

  test('a bar with only folding actions still gives the title its share, and hides an empty pinned group', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PageTopbar collapsible={[{ id: 'filter', bar: 'filter', menu: 'filter rows' }]}>
          <PageBreadcrumb segments={['Alerts']} />
        </PageTopbar>
      </I18nProvider>,
    );
    expect(html).toContain('max-w-[60%] shrink-0');
    const [, pinned = ''] = html.match(/<div class="([^"]*)" data-slot="page-topbar-pinned">/) ?? [];
    expect(pinned.split(' ')).toContain('hidden');
  });
});
