import { CircleAlert, CircleCheck } from './ui/icons';
import { useI18n } from '../i18n';
import type { QuotaState } from '../services/quotaService';
import { cn } from '../lib/utils';

export function QuotaActionFeedback({ quota }: { quota: QuotaState }) {
  const { t } = useI18n();
  const result = quota.actionResult;
  if (!result) return null;
  // A reset that went through but left something undone is told as a warning.
  const warning = result.status === 'success' ? result.warning : undefined;
  const successful = result.status === 'success' && !warning;
  // The provider declined and nothing was spent, or the warning above: worth reading, not an error.
  const declined = result.status === 'not-used' || Boolean(warning);
  const message = warning ?? result.message ?? t(successful ? 'quota.resetResult.submitted' : result.status === 'refresh-error'
      ? 'quota.resetResult.refreshFailed' : 'quota.resetResult.failed', { error: result.error ?? '' });
  return (
    <div
      className={cn(
        'quota-action-feedback flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
        successful
          ? 'success border-success/32 bg-success/4 text-success-foreground'
          : declined
            ? 'warning border-warning/32 bg-warning-surface text-warning-foreground'
            : 'error border-error/32 bg-error-surface text-error-foreground',
      )}
      role={successful || declined ? 'status' : 'alert'}
    >
      {successful ? <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}
