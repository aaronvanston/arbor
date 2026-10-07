import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoreRuntimeProvider } from '../src/coreRuntime';
import { I18nProvider } from '../src/i18n';
import { AccountRouting } from '../src/pages/AccountRouting';
import { updateQuotaCache } from '../src/services/quotaCache';
import { quotaKey, type QuotaState } from '../src/services/quotaService';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const weekly = (left: number, resetIn: number): QuotaState => ({
  status: 'success',
  rows: [{ label: '7-day window', remainingPercent: left, resetAtMs: Date.now() + resetIn }],
});
const render = (files: Record<string, unknown>[]) =>
  renderToStaticMarkup(<I18nProvider><AccountRouting files={files} onError={() => undefined} /></I18nProvider>);

afterEach(() => updateQuotaCache({}));

describe('the account order on Settings › Routing', () => {
  it('orders each provider’s accounts in use on its headline window', () => {
    const later = { name: 'later.json', provider: 'claude', auth_index: 'later', priority: 1 };
    const soon = { name: 'soon.json', provider: 'claude', auth_index: 'soon' };
    const off = { name: 'off.json', provider: 'claude', auth_index: 'off', disabled: true };
    updateQuotaCache({ [quotaKey(later)]: weekly(80, 3 * DAY), [quotaKey(soon)]: weekly(45, 20 * HOUR), [quotaKey(off)]: weekly(90, DAY) });
    const html = render([later, soon, off, { name: 'key.json', provider: 'gemini', auth_index: 'key' }]);
    expect(html).toContain('aria-label="About Account order"');
    expect(text(html)).toContain('Claude · ranked by the 7-day window Apply automatically Apply');
    // Each account after its rank with its avatar, as it's marked everywhere else.
    expect(text(html)).toMatch(/1 SO soon · 45% left, resets in \S+ \S+ Priority 0 → 2 2 LA later · 80% left, resets in 3d 0h Priority 1$/);
    // Accounts that are off stay out of the order.
    expect(text(html)).not.toContain('off');
    expect(html).toContain('aria-label="Apply Claude priorities automatically"');
  });

  // money-22: with nothing to order the section stays and says why.
  it('says an order needs two accounts from one provider', () => {
    const only = { name: 'only.json', provider: 'claude', auth_index: 'only' };
    updateQuotaCache({ [quotaKey(only)]: weekly(45, 20 * HOUR) });
    expect(text(render([only]))).toContain('One account per provider');
  });

  it('says when there are no accounts or the core is stopped', () => {
    expect(text(render([]))).toContain('No accounts in use');
    expect(text(renderToStaticMarkup(<I18nProvider><CoreRuntimeProvider><AccountRouting files={[]} coreReady={false} onError={() => undefined} /></CoreRuntimeProvider></I18nProvider>))).toContain('The core isn’t running');
  });
});
