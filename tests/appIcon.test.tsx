import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIconRow, appIconImage } from '../src/components/AppIconPicker';
import { I18nProvider } from '../src/i18n';
import { APP_ICON_CHOICES, APP_ICON_LABEL } from '../src/services/appIcon';

describe('App icon picker', () => {
  test('offers Auto first, then every color, with Auto picked until the native side says otherwise', () => {
    const html = renderToStaticMarkup(<I18nProvider><AppIconRow /></I18nProvider>);
    const radios = [...html.matchAll(/role="radio" aria-checked="(true|false)" aria-label="([^"]+)"/g)].map(([, checked, label]) => [label, checked]);
    expect(radios).toEqual([
      ['Auto (Forest)', 'true'],
      ['Forest', 'false'],
      ['Amber', 'false'],
      ['Sky', 'false'],
      ['Ember', 'false'],
      ['Signal', 'false'],
      ['Paper', 'false'],
      ['Mono', 'false'],
    ]);
    expect(html).toContain('data-setting-id="appearance.app-icon"');
  });

  test('every color has a label and a picture, and auto pictures as Forest', () => {
    for (const choice of APP_ICON_CHOICES) {
      expect(APP_ICON_LABEL[choice]).toStartWith('appIcon.');
      expect(appIconImage(choice)).toBeTruthy();
    }
    expect(appIconImage('auto')).toBe(appIconImage('forest'));
  });
});
