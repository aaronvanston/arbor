import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { NotificationsSettingsPage } from '../src/pages/NotificationsSettingsPage';
import { setPhoneAlertSetting } from '../src/services/phoneAlerts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = () => renderToStaticMarkup(<I18nProvider><NotificationsSettingsPage /></I18nProvider>);
/** Whether the switch with this label is on, as the markup says. */
const switchOn = (html: string, label: string) => {
  const element = html.match(new RegExp(`<[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
  return element.match(/aria-checked="(true|false)"/)?.[1] ?? null;
};

afterEach(() => {
  setPhoneAlertSetting('service', 'off');
  setPhoneAlertSetting('mutedTopics', []);
});

describe('the notifications settings', () => {
  it('lets each kind of alert on or off the phone once a service is chosen', () => {
    expect(text(render())).not.toContain('What goes to your phone');

    setPhoneAlertSetting('service', 'ntfy');
    setPhoneAlertSetting('mutedTopics', ['digest']);
    const html = render();
    expect(text(html)).toContain('What goes to your phone');
    expect(text(html)).toContain('Agents that need you An agent waiting for permission, an answer or your next prompt.');
    // The weekly digest's own switch above is off by default, so its row says it isn't sent anywhere.
    expect(text(html)).toContain('Weekly digest The week before’s digest, on Monday mornings. Turned off above, so Arbor doesn’t send it anywhere.');
    expect(switchOn(html, 'Weekly digest')).toBe('false');
    expect(switchOn(html, 'Machines')).toBe('true');
  });
});
