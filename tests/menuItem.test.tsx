import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Menu, MenuItem } from '../src/components/ui/menu';

// The item alone, in an open menu: the popup's portal doesn't render outside a browser.
const item = (reason?: string) =>
  renderToStaticMarkup(<Menu open><MenuItem disabledReason={reason}>Change priority</MenuItem></Menu>);
const attribute = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const byId = (html: string, id: string) => html.match(new RegExp(`<span id="${id}"[^>]*>([^<]*)</span>`))?.[1];

describe('a menu item that says why it can’t be used', () => {
  it('is named by its label and described by the reason, so the reason is read once', () => {
    const html = item('Enable this file first.');
    expect(html).toContain('aria-disabled="true"');
    const label = attribute(html, 'aria-labelledby') ?? '';
    const reason = attribute(html, 'aria-describedby') ?? '';
    expect(byId(html, label)).toBe('Change priority');
    expect(byId(html, reason)).toBe('Enable this file first.');
  });

  it('is named by its content as usual without a reason', () => {
    const html = item();
    expect(html).not.toContain('aria-labelledby');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-disabled');
  });
});
