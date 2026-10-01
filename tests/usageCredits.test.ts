import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { claudeUsageCreditsFor, codexUsageCreditsFor, usageCreditsText } from '../src/services/usageCredits';

describe('Codex usage credits', () => {
  it('reads the balance Codex sends as a string', () => {
    expect(codexUsageCreditsFor({ credits: { has_credits: true, unlimited: false, balance: '489.25' } })).toEqual({ balance: 489.25 });
  });

  it('marks unlimited credits, which have no balance to run down', () => {
    expect(codexUsageCreditsFor({ credits: { has_credits: true, unlimited: true, balance: null } })).toEqual({ balance: 0, unlimited: true });
  });

  it('gives nothing for an empty or missing balance', () => {
    expect(codexUsageCreditsFor({ credits: { has_credits: false, unlimited: false, balance: '0' } })).toBeUndefined();
    expect(codexUsageCreditsFor({ credits: { balance: '' } })).toBeUndefined();
    expect(codexUsageCreditsFor({ rate_limit: {} })).toBeUndefined();
    expect(codexUsageCreditsFor(null)).toBeUndefined();
  });
});

describe('Claude prepaid credits', () => {
  it('reads the amount in cents, its currency and how long it lasts', () => {
    expect(claudeUsageCreditsFor({ amount: 4250, currency: 'aud', expiry_policy_months: 12 }))
      .toEqual({ balance: 4250, currency: 'AUD', expiryMonths: 12 });
  });

  it('takes US dollars without a currency and ignores an unusable lapse policy', () => {
    expect(claudeUsageCreditsFor({ amount: 500, expiry_policy_months: 0 })).toEqual({ balance: 500, currency: 'USD' });
    expect(claudeUsageCreditsFor({ amount: 500, expiry_policy_months: 1.5 })).toEqual({ balance: 500, currency: 'USD' });
  });

  it('gives nothing with no balance or an unrecognized reply', () => {
    expect(claudeUsageCreditsFor({ amount: 0, currency: 'USD' })).toBeUndefined();
    expect(claudeUsageCreditsFor({ currency: 'USD' })).toBeUndefined();
    expect(claudeUsageCreditsFor('not found')).toBeUndefined();
  });
});

describe('usage credits text', () => {
  const t = translate;
  it('says a Codex count, a Claude amount and unlimited credits plainly', () => {
    expect(usageCreditsText({ balance: 489.25 }, t)).toEqual({ label: '489.25 credits' });
    expect(usageCreditsText({ balance: 0, unlimited: true }, t)).toEqual({ label: 'Unlimited credits' });
    expect(usageCreditsText({ balance: 4250, currency: 'USD', expiryMonths: 12 }, t))
      .toEqual({ label: '$42.50 in credits', detail: 'Credits lapse 12 months after purchase' });
    expect(usageCreditsText({ balance: 100, currency: 'USD', expiryMonths: 1 }, t).detail).toBe('Credits lapse 1 month after purchase');
  });
});
