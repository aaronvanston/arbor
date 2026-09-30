import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReserveChip } from '../src/components/ReserveControl';
import { I18nProvider } from '../src/i18n';
import { resetAccountReserves, setAccountReserve } from '../src/services/accountReserves';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (always = false) =>
  renderToStaticMarkup(<I18nProvider><ReserveChip accountKey="work.json::work" name="work.json" provider="claude" always={always} /></I18nProvider>);

afterEach(() => resetAccountReserves());

describe('the cap control', () => {
  it('shows nothing on an account without a cap, and says what the cap is once there is one', () => {
    expect(render()).toBe('');
    // A paused account's row keeps it, as just its icon.
    expect(text(render(true))).toBe('');
    expect(render(true)).toContain('aria-label="Set how much of work.json the proxy may use"');
    setAccountReserve('work.json::work', { percent: 90, ease: false });
    expect(text(render())).toBe('Cap 90%');
    expect(render()).toContain('aria-label="Change how much of work.json the proxy may use: Up to 90%"');
    // A cap that eases toward the reset says so, as it lets the proxy use more than its number.
    setAccountReserve('work.json::work', { percent: 25, ease: true });
    expect(text(render())).toBe('Cap 25% · easing');
    expect(render()).toContain('aria-label="Change how much of work.json the proxy may use: Up to 25%, easing"');
  });

  it('says an account turned back on early stays on until its limit resets', () => {
    resetAccountReserves({ caps: { 'work.json::work': 90 }, easing: {}, paused: {}, skipUntil: { 'work.json::work': Date.now() + 2 * 3_600_000 } });
    expect(render()).toMatch(/title="[^"]*Turned back on early, so Arbor leaves it on until that limit resets in [12]h \d+m\./);
  });
});
