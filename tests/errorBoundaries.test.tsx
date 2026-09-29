import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MonitorBoundary, PageErrorBoundary } from '../src/components/ErrorBoundaries';

const crash = { error: new Error('boom'), at: new Date('2026-09-25T00:00:00Z'), componentStack: '' };

describe('error boundaries', () => {
  it('starts a crashed page over when another page opens or the same one is chosen again', () => {
    const state = { crash, pageId: 'accounts', resetKey: 4 };
    expect(PageErrorBoundary.getDerivedStateFromProps({ pageId: 'accounts', resetKey: 4, children: null }, state)).toBeNull();
    expect(PageErrorBoundary.getDerivedStateFromProps({ pageId: 'settings:general', resetKey: 4, children: null }, state))
      .toEqual({ crash: null, pageId: 'settings:general', resetKey: 4 });
    expect(PageErrorBoundary.getDerivedStateFromProps({ pageId: 'accounts', resetKey: 5, children: null }, state))
      .toEqual({ crash: null, pageId: 'accounts', resetKey: 5 });
  });

  it('keeps what was thrown, even when it is not an error', () => {
    expect(PageErrorBoundary.getDerivedStateFromError(undefined).crash).toMatchObject({ error: undefined, componentStack: '' });
    expect(MonitorBoundary.getDerivedStateFromError()).toEqual({ crashed: true });
  });

  it('renders its children until something throws', () => {
    const html = renderToStaticMarkup(
      <PageErrorBoundary pageId="home">
        <p>page</p>
        <MonitorBoundary name="Test"><span>monitor</span></MonitorBoundary>
      </PageErrorBoundary>,
    );
    expect(html).toBe('<p>page</p><span>monitor</span>');
  });
});
