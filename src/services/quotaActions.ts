import {
  captureQuotaCacheGeneration,
  commitQuotaCacheIfCurrent,
  getQuotaCacheSnapshot,
  updateQuotaCache,
} from './quotaCache';
import { readBoolean } from './managementApi';
import {
  claimClaudeBankedReset, consumeCodexResetCredit, idleQuota, providerForFile, quotaKey,
  type AuthFile, type QuotaState,
} from './quotaService';

const pendingActions = new Set<string>();
type QuotaActionResult = NonNullable<QuotaState['actionResult']>;
type QuotaActionOutcome = 'canceled' | QuotaActionResult['status'];

/** The last reset's outcome is unknown, so quota has to be refreshed before another is offered. */
export const resetUnconfirmed = (quota: QuotaState): boolean =>
  quota.actionResult?.action === 'reset'
  && (quota.actionResult.status === 'error' || quota.actionResult.status === 'refresh-error');

export const canResetCodexQuota = (file: AuthFile, quota: QuotaState): boolean =>
  providerForFile(file) === 'codex'
  && !readBoolean(file, 'disabled')
  && quota.status === 'success'
  && (quota.resetCredits ?? 0) > 0
  && quota.resetCreditsApplicable !== 0
  && !resetUnconfirmed(quota);

export const canResetClaudeQuota = (file: AuthFile, quota: QuotaState): boolean =>
  providerForFile(file) === 'claude'
  && !readBoolean(file, 'disabled')
  && quota.status === 'success'
  && Boolean(quota.bankedReset?.grantId)
  && !resetUnconfirmed(quota);

export const canResetQuota = (file: AuthFile, quota: QuotaState): boolean =>
  canResetCodexQuota(file, quota) || canResetClaudeQuota(file, quota);

async function runConfirmedQuotaAction(
  file: AuthFile,
  action: 'reset',
  confirmAction: () => Promise<boolean>,
  execute: (file: AuthFile) => Promise<QuotaState>,
): Promise<QuotaActionOutcome> {
  const key = quotaKey(file);
  const original = getQuotaCacheSnapshot()[key];
  const previous = original ?? idleQuota();
  if (pendingActions.has(key) || previous.status === 'loading' || readBoolean(file, 'disabled')) return 'canceled';
  const generation = captureQuotaCacheGeneration();
  pendingActions.add(key);
  let pending: QuotaState | undefined;
  const commit = (quota: QuotaState) => {
    commitQuotaCacheIfCurrent(generation, () => {
      updateQuotaCache((current) => current[key] === pending ? { ...current, [key]: quota } : current);
    });
  };
  try {
    if (await confirmAction() !== true || captureQuotaCacheGeneration() !== generation
      || getQuotaCacheSnapshot()[key] !== original) return 'canceled';
    pending = { ...previous, status: 'loading', pendingAction: action, actionResult: undefined };
    updateQuotaCache((current) => ({ ...current, [key]: pending! }));
    const result = await execute(file);
    // A provider that reports its own outcome sets it on the result.
    const reported = result.actionResult;
    if (result.status === 'error') {
      // The refresh afterward failed, so keep the last quota shown. Only an
      // outcome that spent nothing stands; anything else needs a refresh first.
      const actionResult: QuotaActionResult = reported && reported.status !== 'success'
        ? reported
        : { action, status: 'refresh-error', error: result.error };
      commit({ ...previous, actionResult });
      return actionResult.status;
    }
    const actionResult: QuotaActionResult = reported ?? { action, status: 'success' };
    commit({ ...result, actionResult });
    return actionResult.status;
  } catch (error) {
    if (!pending) throw error;
    commit({ ...previous, actionResult: { action, status: 'error', error: error instanceof Error ? error.message : String(error) } });
    return 'error';
  } finally {
    pendingActions.delete(key);
  }
}

export function resetCodexQuotaWithConfirmation(file: AuthFile, confirmReset: () => Promise<boolean>): Promise<QuotaActionOutcome> {
  if (!canResetCodexQuota(file, getQuotaCacheSnapshot()[quotaKey(file)] ?? idleQuota())) return Promise.resolve('canceled');
  return runConfirmedQuotaAction(file, 'reset', confirmReset, consumeCodexResetCredit);
}

/** Uses the Claude banked reset shown on the account, once confirmed. */
export function resetClaudeQuotaWithConfirmation(file: AuthFile, confirmReset: () => Promise<boolean>): Promise<QuotaActionOutcome> {
  const quota = getQuotaCacheSnapshot()[quotaKey(file)] ?? idleQuota();
  const grantId = quota.bankedReset?.grantId;
  if (!grantId || !canResetClaudeQuota(file, quota)) return Promise.resolve('canceled');
  const expected = { grantId, earlyUse: quota.bankedReset?.earlyUse !== undefined };
  return runConfirmedQuotaAction(file, 'reset', confirmReset, (target) => claimClaudeBankedReset(target, expected));
}
