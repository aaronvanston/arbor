import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarTree } from '../src/components/sidebar/SidebarTree';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { accountsView, machinesView, sessionsView, setupView, type AppView } from '../src/navigation';
import { itemAt } from './support/items';

const render = (view: AppView, coreReady = true) => renderToStaticMarkup(
  <I18nProvider>
    <TooltipProvider>
      <SidebarTree view={view} coreReady={coreReady} lockedHint="Start the core to open this" hint={false} onNavigate={() => {}} navRef={() => {}} />
    </TooltipProvider>
  </I18nProvider>,
);

/** The opening tag of the first button whose attributes match. */
const button = (html: string, attribute: RegExp) => html.match(new RegExp(`<button(?=[^>]*${attribute.source})[^>]*>`))?.[0] ?? '';

describe('the sidebar tree', () => {
  it('is the main navigation landmark, with a labeled list for each section', () => {
    const html = render(setupView({ tab: 'library' }));
    expect(html).toMatch(/^<nav[^>]*aria-label="Main navigation"/);
    expect(html).toContain('>Fleet</div>');
    expect(html).toContain('>Spend</div>');
    expect(html).toMatch(/<ul[^>]*aria-labelledby="tree-section-fleet"/);
  });

  it('opens the current page’s views under a chevron that says so, and lights the view on screen', () => {
    const html = render(setupView({ tab: 'library' }));
    const chevron = button(html, /data-tree-chevron="setup"/);
    expect(chevron).toContain('aria-expanded="true"');
    expect(chevron).toContain('aria-controls="tree-setup"');
    expect(chevron).toMatch(/aria-label="[^"]+ views"/);
    expect(html).toMatch(/<ul id="tree-setup"/);
    // The lit view is the page, to a screen reader; its page row is marked as the open page without claiming it.
    expect(button(html, /aria-current="page"/)).toContain('data-tree-parent="setup"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(button(html, /data-tree-page="setup"/)).toContain('data-current="true"');
    // Other pages' views stay folded until they're opened.
    expect(button(html, /data-tree-chevron="usage"/)).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="tree-usage"');
  });

  it('lights a page’s own row when nothing under it is the view, as for a session open in place of the list', () => {
    const html = render(sessionsView({ tab: 'sessions', session: 'a3f1' }));
    expect(button(html, /aria-current="page"/)).toContain('data-tree-page="sessions"');
  });

  it('lights Machines’ own row for a machine it doesn’t list, as for one an old alert names that has since gone', () => {
    const html = render(machinesView('old-box'));
    expect(button(html, /aria-current="page"/)).toContain('data-tree-page="machines"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('keeps a page that needs the core focusable while it’s down, with only the views that don’t need it to open', () => {
    const html = render(accountsView({ tab: 'value' }), false);
    const accounts = button(html, /data-tree-page="accounts"/);
    expect(accounts).toContain('aria-disabled="true"');
    // Value reads only Arbor's own records, so Accounts still opens to it; Limits and Sign-ins say why they won't open.
    expect(accounts).toContain('data-tree-expandable="true"');
    expect(button(html, /aria-current="page"/)).toContain('data-tree-parent="accounts"');
    const leaves = html.match(/<button(?=[^>]*data-tree-parent="accounts")[^>]*>/g) ?? [];
    expect(leaves).toHaveLength(3);
    expect(itemAt(leaves, 0)).toContain('aria-disabled="true"');
    expect(itemAt(leaves, 0)).toContain('aria-describedby=');
    expect(itemAt(leaves, 1)).toContain('aria-disabled="true"');
    expect(itemAt(leaves, 2)).not.toContain('aria-disabled');
  });

  it('lists Accounts’ Limits, Sign-ins and Value while the core is up, none of them locked', () => {
    const html = render(accountsView({ tab: 'limits' }));
    expect(html).toMatch(/<ul id="tree-accounts"/);
    expect(html).not.toMatch(/data-tree-parent="accounts"[^>]*aria-disabled|aria-disabled[^>]*data-tree-parent="accounts"/);
    expect(button(html, /aria-current="page"/)).toContain('data-tree-parent="accounts"');
  });
});
