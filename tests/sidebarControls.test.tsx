import { describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarToggle } from '../src/components/SidebarControls';
import { I18nProvider } from '../src/i18n';

const render = (node: ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const attribute = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe('the sidebar’s buttons', () => {
  it('say which way they go and point at the sidebar', () => {
    const hide = render(<SidebarToggle shown onToggle={() => {}} />);
    expect(attribute(hide, 'aria-label')).toBe('Hide sidebar');
    expect(attribute(hide, 'aria-expanded')).toBe('true');
    expect(attribute(hide, 'aria-controls')).toBe('app-sidebar');
    const show = render(<SidebarToggle shown={false} onToggle={() => {}} />);
    expect(attribute(show, 'aria-label')).toBe('Show sidebar');
    expect(attribute(show, 'aria-expanded')).toBe('false');
  });
});
