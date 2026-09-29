import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_PREFERENCE_DEFAULTS, setAppPreference } from '../src/appPreferences';
import { SettingsRow } from '../src/components/layout/settings';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { NotificationsSettingsPage } from '../src/pages/NotificationsSettingsPage';
import {
  CORE_CONFIG_DEFAULTS,
  changedFromDefaults,
  differsFromDefault,
  onOffLabel,
  preferenceReset,
  resetOffer,
} from '../src/services/settingDefaults';
import { present } from './support/items';

afterEach(() => {
  setAppPreference('limitNotifications', APP_PREFERENCE_DEFAULTS.limitNotifications);
  setAppPreference('heavySessionTokens', APP_PREFERENCE_DEFAULTS.heavySessionTokens);
});

const resetButtons = (html: string) => html.match(/<button[^>]*data-reset-default[^>]*>/g) ?? [];

describe('settings at their defaults', () => {
  it('tell a changed value from its default, reading a field’s text by what it says', () => {
    expect(differsFromDefault('3', CORE_CONFIG_DEFAULTS.requestRetry)).toBe(false);
    expect(differsFromDefault(' 03 ', CORE_CONFIG_DEFAULTS.requestRetry)).toBe(false);
    expect(differsFromDefault('5', CORE_CONFIG_DEFAULTS.requestRetry)).toBe(true);
    // An emptied number field isn't the default either.
    expect(differsFromDefault('', CORE_CONFIG_DEFAULTS.maxRetryCredentials)).toBe(true);
    expect(differsFromDefault(' 127.0.0.1 ', CORE_CONFIG_DEFAULTS.host)).toBe(false);
    expect(differsFromDefault(true, CORE_CONFIG_DEFAULTS.debug)).toBe(true);
    expect(differsFromDefault(8317, CORE_CONFIG_DEFAULTS.port)).toBe(false);
  });

  it('count how many of a group are changed', () => {
    expect(changedFromDefaults([['3', 3], [false, false], ['2', 0], [true, false]])).toBe(2);
    expect(changedFromDefaults([])).toBe(0);
  });

  it('offer a reset only while a value is changed, saying what the default is', () => {
    let reset = 0;
    expect(resetOffer('3', 3, '3', () => { reset += 1; })).toBeUndefined();
    const offer = present(resetOffer('7', 3, '3', () => { reset += 1; }, true));
    expect(offer.value).toBe('3');
    expect(offer.disabled).toBe(true);
    offer.onReset();
    expect(reset).toBe(1);
  });

  it('put an app preference back at its default', () => {
    const onOff = onOffLabel((key) => (key === 'settings.reset.on' ? 'On' : 'Off'));
    expect(preferenceReset({ ...APP_PREFERENCE_DEFAULTS }, 'limitNotifications', onOff)).toBeUndefined();
    setAppPreference('limitNotifications', false);
    const offer = present(preferenceReset({ ...APP_PREFERENCE_DEFAULTS, limitNotifications: false }, 'limitNotifications', onOff));
    expect(offer.value).toBe('On');
    offer.onReset();
    const html = renderToStaticMarkup(<I18nProvider><TooltipProvider><NotificationsSettingsPage /></TooltipProvider></I18nProvider>);
    expect(resetButtons(html)).toEqual([]);
  });
});

describe('the reset button', () => {
  it('sits beside the control, named for what it does, only when offered', () => {
    const row = (reset?: Parameters<typeof SettingsRow>[0]['reset']) =>
      renderToStaticMarkup(
        <I18nProvider>
          <TooltipProvider>
            <SettingsRow settingId="network.request-retry" title="Request Retries" control={<input aria-label="Request Retries" />} reset={reset} />
          </TooltipProvider>
        </I18nProvider>,
      );
    expect(resetButtons(row())).toEqual([]);
    const html = row({ value: '3', onReset: () => {} });
    expect(resetButtons(html)).toHaveLength(1);
    expect(present(resetButtons(html)[0])).toContain('aria-label="Reset to default"');
    expect(html.indexOf('data-reset-default')).toBeLessThan(html.indexOf('<input'));
    expect(html).toContain('data-setting-id="network.request-retry"');
  });

  it('shows on each alert that’s been changed from its default', () => {
    setAppPreference('limitNotifications', false);
    setAppPreference('heavySessionTokens', 0);
    const html = renderToStaticMarkup(<I18nProvider><TooltipProvider><NotificationsSettingsPage /></TooltipProvider></I18nProvider>);
    expect(resetButtons(html)).toHaveLength(2);
  });
});
