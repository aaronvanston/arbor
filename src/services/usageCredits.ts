import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatMoney, formatNumber } from '../lib/format';
import { isRecord, readString } from './managementApi';

/**
 * Credits an account holds for use past its plan's limits: Codex credits, or Claude's prepaid usage credits. Neither
 * provider says when a given credit lapses; Claude only gives the months after purchase its credits last.
 */
export type UsageCredits = {
  /** Codex: a count of credits. Claude: an amount in the currency's minor units (cents). */
  balance: number;
  /** Set for Claude, whose credits are money. */
  currency?: string;
  /** Codex credits with no balance to run down. */
  unlimited?: boolean;
  /** Claude: how many months after purchase its credits lapse. */
  expiryMonths?: number;
};

const amountOf = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Codex credits from the `credits` block of its usage reply (`has_credits`, `unlimited`, and `balance`, which Codex
 * sends as a string). An account with none left gives nothing, the same as one never given any.
 */
export const codexUsageCreditsFor = (payload: unknown): UsageCredits | undefined => {
  const credits = isRecord(payload) && isRecord(payload.credits) ? payload.credits : null;
  if (!credits) return undefined;
  if (credits.unlimited === true) return { balance: 0, unlimited: true };
  const balance = amountOf(credits.balance);
  return balance !== null && balance > 0 ? { balance } : undefined;
};

/** Claude's prepaid usage credits, from its organization's `prepaid/credits` reply, read the way Claude Code reads it. */
export const claudeUsageCreditsFor = (payload: unknown): UsageCredits | undefined => {
  if (!isRecord(payload)) return undefined;
  const amount = amountOf(payload.amount);
  if (amount === null || amount <= 0) return undefined;
  const months = amountOf(payload.expiry_policy_months);
  return {
    balance: amount,
    currency: (readString(payload, 'currency') || 'USD').toUpperCase(),
    ...(months !== null && Number.isInteger(months) && months > 0 ? { expiryMonths: months } : {}),
  };
};

const formatCurrency = (cents: number, currency: string) => {
  if (currency === 'USD') return formatMoney(cents / 100);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    // A code Intl doesn't know still reads plainly.
    return `${formatNumber(cents / 100, 2)} ${currency}`;
  }
};

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** "489.25 credits", "$12.50 in credits" or "Unlimited credits", with how long Claude's last when it says. */
export const usageCreditsText = (credits: UsageCredits, t: Translate): { label: string; detail?: string } => {
  const label = credits.unlimited
    ? t('signIns.credits.unlimited')
    : credits.currency
      ? t('signIns.credits.money', { amount: formatCurrency(credits.balance, credits.currency) })
      : t('signIns.credits.count', { amount: formatNumber(credits.balance, 2) });
  const months = credits.expiryMonths;
  return months
    ? { label, detail: t(months === 1 ? 'signIns.credits.lapse.one' : 'signIns.credits.lapse.other', { months }) }
    : { label };
};
