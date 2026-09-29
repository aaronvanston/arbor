import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { ConfirmationContent } from '../src/components/ConfirmationDialog';
import { QuotaActionFeedback } from '../src/components/QuotaActionFeedback';
import { AlertDialog } from '../src/components/ui/dialog';
import { I18nProvider } from '../src/i18n';

describe('application confirmation and quota feedback', () => {
  // The dialog around it is a portal, which static markup leaves out; the root gives the title its context.
  const render = (content: ReactNode) => renderToStaticMarkup(<I18nProvider><AlertDialog open>{content}</AlertDialog></I18nProvider>);

  it('offers a second way to go ahead between Cancel and the confirm button', () => {
    const html = render(<ConfirmationContent title="3 agent sessions are running" message="Updating restarts the proxy." confirmText="Update when idle" secondaryText="Update now" onDecision={() => {}} onSecondary={() => {}} />);
    expect(html.indexOf('Cancel')).toBeLessThan(html.indexOf('Update now'));
    expect(html.indexOf('Update now')).toBeLessThan(html.indexOf('Update when idle</button>'));
    const withoutHandler = render(<ConfirmationContent title="Delete" message="Sure?" secondaryText="Update now" onDecision={() => {}} />);
    expect(withoutHandler).not.toContain('Update now');
  });

  it('distinguishes a submitted reset whose follow-up query failed', () => {
    const html = renderToStaticMarkup(<I18nProvider><QuotaActionFeedback quota={{ status: 'success', rows: [], actionResult: { action: 'reset', status: 'refresh-error', error: 'query failed' } }} /></I18nProvider>);
    expect(html).toContain('The reset request was submitted');
    expect(html).toContain('refreshing quota failed');
    expect(html).toContain('avoid consuming another reset credit');
    expect(html).toContain('query failed');
  });
});
