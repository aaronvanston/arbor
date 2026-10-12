/**
 * Plays a provider's pool of accounts forward against a spend rate. The headline's pace color and the forecast chart
 * both run on this, so the color can't say the pool lasts while the chart shows it running dry.
 *
 * The proxy moves to another account when one empties, so spending takes the account that resets soonest first, as
 * soonest-reset-first routing does. Each account refills to 100% at its reset and every window after. Accounts with no
 * known reset are spent last and never refill.
 */

export type PoolAccount = {
  key: string;
  /** Percent left, 0 to 100. */
  left: number;
  resetAtMs: number | null;
  windowMs: number | null;
  /** Resets the account can claim when it runs out (banked or manual), when `claimCredits` is on. */
  credits?: number;
};

export type PoolPoint = { t: number; left: number };
export type PoolEvent = { atMs: number; key: string; kind: 'reset' | 'credit'; /** Percent left just before. */ before: number };

export type PoolRun = {
  /** The pool's total at each step, starting now. Only with `points`. */
  points: PoolPoint[];
  /** When the whole pool first runs dry, or null when it lasts. */
  dryAtMs: number | null;
  /** How long the pool spends dry before the end. */
  dryMs: number;
  events: PoolEvent[];
  /** When each account first runs out. */
  emptyAtMs: Record<string, number>;
};

export type PoolOptions = {
  startMs: number;
  endMs: number;
  /** Percent of one account spent per ms, read once for each step. */
  rate: (atMs: number) => number;
  /** How often the rate can change; steps also break at every reset. Infinity for a steady rate. */
  stepMs?: number;
  /** Record the pool's total at each step, for drawing. */
  points?: boolean;
  /** Claim an account's credit when it runs out, for the accounts listed, or every account with `true`. */
  claimCredits?: boolean | ReadonlySet<string>;
  /** A credit claimed at a set time rather than when the account runs out (the forecast's advice tries these). */
  claimAt?: ReadonlyArray<{ key: string; atMs: number }>;
  /** Stop at the first dry moment, when only whether it happens matters. */
  stopWhenDry?: boolean;
};

const sum = (accounts: { left: number }[]) => accounts.reduce((total, account) => total + account.left, 0);

export function simulatePool(start: PoolAccount[], options: PoolOptions): PoolRun {
  const { startMs, endMs, rate, stepMs = Number.POSITIVE_INFINITY } = options;
  const pool = start.map((account) => ({ ...account, left: Math.max(0, Math.min(100, account.left)), credits: account.credits ?? 0 }));
  const claims = [...(options.claimAt ?? [])].sort((a, b) => a.atMs - b.atMs);
  const canClaim = (key: string) =>
    options.claimCredits === true || (options.claimCredits instanceof Set && options.claimCredits.has(key));
  const run: PoolRun = { points: [], dryAtMs: null, dryMs: 0, events: [], emptyAtMs: {} };
  // A refill records the pool just before and just after it, so it draws as a step rather than a slope.
  const record = (t: number) => {
    if (!options.points) return;
    const left = sum(pool);
    const last = run.points[run.points.length - 1];
    if (!last || last.t !== t || last.left !== left) run.points.push({ t, left });
  };
  const refill = (account: (typeof pool)[number], atMs: number, kind: PoolEvent['kind']) => {
    run.events.push({ atMs, key: account.key, kind, before: account.left });
    record(atMs);
    account.left = 100;
    record(atMs);
  };
  pool.forEach((account) => { if (account.left <= 0) run.emptyAtMs[account.key] = startMs; });
  record(startMs);
  let time = startMs;
  while (time < endMs) {
    // Resets and set claims due now.
    pool.forEach((account) => {
      while (account.resetAtMs !== null && account.windowMs !== null && account.windowMs > 0 && account.resetAtMs <= time) {
        refill(account, account.resetAtMs, 'reset');
        account.resetAtMs += account.windowMs;
      }
    });
    for (let claim = claims[0]; claim && claim.atMs <= time; claim = claims[0]) {
      claims.shift();
      const account = pool.find((item) => item.key === claim.key);
      if (account && account.credits > 0) {
        account.credits -= 1;
        refill(account, claim.atMs, 'credit');
      }
    }
    record(time);
    const nextReset = Math.min(...pool.map((account) => (account.resetAtMs !== null && account.windowMs ? account.resetAtMs : Number.POSITIVE_INFINITY)));
    const nextStep = Number.isFinite(stepMs) ? (Math.floor(time / stepMs) + 1) * stepMs : Number.POSITIVE_INFINITY;
    const until = Math.min(endMs, nextReset, nextStep, claims[0]?.atMs ?? Number.POSITIVE_INFINITY);
    const perMs = Math.max(0, rate(time));
    let need = perMs * (until - time);
    let spent = 0;
    if (need > 0) {
      const order = [...pool].sort((a, b) => (a.resetAtMs ?? Number.POSITIVE_INFINITY) - (b.resetAtMs ?? Number.POSITIVE_INFINITY));
      for (let index = 0; index < order.length && need > 0; index += 1) {
        const account = order[index];
        if (!account) break;
        const take = Math.min(account.left, need);
        account.left -= take;
        need -= take;
        spent += take;
        if (account.left <= 0 && take > 0 && run.emptyAtMs[account.key] === undefined) {
          run.emptyAtMs[account.key] = time + spent / perMs;
        }
        if (account.left <= 0 && need > 0 && account.credits > 0 && canClaim(account.key)) {
          account.credits -= 1;
          refill(account, time + spent / perMs, 'credit');
          index -= 1;
        }
      }
    }
    if (need > 0) {
      const dryFrom = time + spent / perMs;
      run.dryAtMs ??= dryFrom;
      run.dryMs += until - dryFrom;
      record(dryFrom);
      if (options.stopWhenDry) return run;
    }
    time = until;
  }
  record(endMs);
  return run;
}
