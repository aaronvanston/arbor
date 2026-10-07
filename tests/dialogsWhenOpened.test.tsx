import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPalette, OpeningDialog } from '../src/components/dialogsWhenOpened';
import { I18nProvider } from '../src/i18n';

describe('a dialog whose code loads on first open', () => {
  test('says it’s opening, as a status, while its code is slow to arrive', () => {
    const html = renderToStaticMarkup(<I18nProvider><OpeningDialog /></I18nProvider>);
    expect(html).toContain('role="status"');
    expect(html).toContain('Opening…');
  });

  test('shows nothing in the first moment, so a quick load doesn’t flash it', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <CommandPalette open onOpenChange={() => {}} pages={[]} settings={[]} lockedHint="" coreReady onNavigate={() => {}} onOpenSetting={() => {}} />
      </I18nProvider>,
    );
    expect(html).toBe('');
  });
});
