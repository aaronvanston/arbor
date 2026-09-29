import type { QuotaProvider } from './quotaService';
import { savedStore, storedRecord } from './savedStore';

/**
 * What each subscription account costs a month, in US dollars, by account
 * key. Accounts without an entry use their plan's list price.
 */
type PlanCosts = Record<string, number>;

const parseCosts = (raw: string | null): PlanCosts =>
  Object.fromEntries(
    Object.entries(storedRecord(raw)).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
    ),
  );

const store = savedStore<PlanCosts>({ key: 'cpa-gui.plan-costs.v1', parse: parseCosts, fallback: {} });

export const getPlanCosts = store.get;
export const usePlanCosts = store.useValue;

/** Sets an account's monthly cost, or goes back to its plan's list price with null. */
export function setPlanCost(key: string, monthly: number | null) {
  const next = { ...store.get() };
  if (monthly === null || !Number.isFinite(monthly) || monthly < 0) delete next[key];
  else next[key] = Math.round(monthly * 100) / 100;
  store.set(next);
}

/** Moves costs to a credential's new key after a rename. A cost already saved under the new key wins. */
export function renamePlanCosts(renames: { from: string; to: string }[]) {
  const costs = store.get();
  let next = costs;
  for (const { from, to } of renames) {
    const moved = next[from];
    if (from === to || moved === undefined) continue;
    next = { ...next };
    if (next[to] === undefined) next[to] = moved;
    delete next[from];
  }
  store.set(next);
}

/**
 * The monthly list price of a plan in US dollars, from the plan name the
 * provider reports. Null when the plan or its price is unknown, such as an
 * enterprise plan, or a Claude Max account whose tier isn't reported.
 */
export function listPrice(provider: QuotaProvider, plan: string | undefined): number | null {
  const name = (plan ?? '').toLowerCase();
  if (!name) return null;
  if (/free/.test(name)) return 0;
  if (provider === 'claude') {
    if (/max/.test(name)) return /20\s*x/.test(name) ? 200 : /5\s*x/.test(name) ? 100 : null;
    if (/team/.test(name)) return 30;
    if (/pro/.test(name)) return 20;
    return null;
  }
  if (provider === 'codex') {
    if (/pro/.test(name)) return 200;
    if (/plus/.test(name)) return 20;
    if (/team|business/.test(name)) return 30;
    return null;
  }
  return null;
}

/** Plan pills: the top tier reads in brand color, paid tiers neutral, free muted. */
export const planVariant = (plan: string): 'primary' | 'secondary' | 'muted' => {
  const key = plan.toLowerCase();
  if (/max|team|enterprise|business/.test(key)) return 'primary';
  if (/free/.test(key)) return 'muted';
  return 'secondary';
};
export const planLabel = (plan: string) => plan.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
