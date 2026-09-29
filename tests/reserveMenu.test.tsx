import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReserveMenu } from '../src/components/ReserveMenu';
import { I18nProvider } from '../src/i18n';
import { resetAccountReserves, setAccountReserve } from '../src/services/accountReserves';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (always = false) =>
  renderToStaticMarkup(<I18nProvider><ReserveMenu accountKey="work.json::work" name="work.json" always={always} /></I18nProvider>);

afterEach(() => resetAccountReserves());

describe('the cap control', () => {
  it('shows nothing on an account without a cap, and says what the cap is once there is one', () => {
    expect(render()).toBe('');
    // A paused account's row keeps it, as just its icon.
    expect(text(render(true))).toBe('');
    expect(render(true)).toContain('aria-label="Set how much of work.json the proxy may use"');
    setAccountReserve('work.json::work', 90);
    expect(text(render())).toBe('Cap 90%');
    expect(render()).toContain('aria-label="Change how much of work.json the proxy may use, now up to 90%"');
  });

  it('says an account turned back on early stays on until its limit resets', () => {
    resetAccountReserves({ caps: { 'work.json::work': 90 }, paused: {}, skipUntil: { 'work.json::work': Date.now() + 2 * 3_600_000 } });
    expect(render()).toMatch(/title="[^"]*Turned back on early, so Arbor leaves it on until that limit resets in [12]h \d+m\./);
  });
});
