import { describe, expect, it } from 'bun:test';
import { focusReturnTarget, type FocusReturnTarget } from '../src/services/focusReturn';

type Fake = FocusReturnTarget & { name: string };
const element = (name: string, { connected = true, showing = true, tagName = 'BUTTON' } = {}): Fake => ({
  name,
  isConnected: connected,
  tagName,
  getClientRects: () => ({ length: showing ? 1 : 0 }),
});

const sidebarButton = element('sidebar button');
const inSidebar = (target: Fake) => target.name.startsWith('sidebar');

describe('where a dialog hands the focus back as it closes', () => {
  it('is the control that opened it, while it’s still there and showing', () => {
    const search = element('sidebar search');
    expect(focusReturnTarget(search, { inSidebar, sidebarButton })).toBe(search);
    const pageButton = element('page button');
    expect(focusReturnTarget(pageButton, { inSidebar, sidebarButton })).toBe(pageButton);
  });

  it('is the sidebar button when the dialog’s action hid the sidebar the opener was in', () => {
    expect(focusReturnTarget(element('sidebar search', { showing: false }), { inSidebar, sidebarButton })).toBe(sidebarButton);
  });

  it('is nowhere when nothing had the focus, or the opener went with its page', () => {
    // Anything else would move the focus to whatever held it some time before: the bell from a popover opened earlier.
    expect(focusReturnTarget(null, { inSidebar, sidebarButton })).toBe(false);
    expect(focusReturnTarget(element('body', { tagName: 'BODY' }), { inSidebar, sidebarButton })).toBe(false);
    expect(focusReturnTarget(element('page button', { connected: false }), { inSidebar, sidebarButton })).toBe(false);
    expect(focusReturnTarget(element('page button', { showing: false }), { inSidebar, sidebarButton })).toBe(false);
    expect(focusReturnTarget(element('sidebar search', { showing: false }), { inSidebar, sidebarButton: null })).toBe(false);
  });
});
