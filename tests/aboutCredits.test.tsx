import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { CREDITS, CreditRows } from '../src/pages/AboutSettings';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// system-12: official builds carry Hugeicons Pro icons, which aren't MIT, so its credit says so.
describe('Settings › About credits', () => {
  it('names Hugeicons Pro’s commercial license beside MIT', () => {
    const shown = text(renderToStaticMarkup(<I18nProvider><CreditRows credits={CREDITS.parts} /></I18nProvider>));
    expect(shown).toContain('Hugeicons The app’s icons. MIT License, with Hugeicons Pro icons in official builds under a commercial license');
    expect(shown).toContain('Lobe Icons The provider logos. Each logo is its owner’s trademark. MIT License');
  });
});
