import { useCallback, useId, useReducer } from 'react';
import { CircleAlert, CircleCheck, Info, X } from './components/ui/icons';
import { cn } from './lib/utils';
import { useI18n } from './i18n';
import type { MessageKey } from './i18n/resources';
import {
  appNoticeReducer,
  initialAppNoticeState,
  type AppNotice,
  type NoticeTone,
  type NoticeMessage,
} from './services/appNotice';

export type { NoticeTone, NoticeMessage, AppNotice };

export interface UseAppNoticeReturn {
  showNotice: (message: NoticeMessage, tone?: NoticeTone) => void;
  clearNotice: () => void;
  notice: AppNotice | null;
  revision: number;
}

export function useAppNotice(source?: MessageKey): UseAppNoticeReturn {
  const [state, dispatch] = useReducer(appNoticeReducer, initialAppNoticeState);
  const owner = useId();

  const showNotice = useCallback((message: NoticeMessage, tone: NoticeTone = 'success') => {
    dispatch({ type: 'show', notice: { owner, source, message, tone } });
  }, [owner, source]);

  const clearNotice = useCallback(() => {
    dispatch({ type: 'dismiss', owner });
  }, [owner]);

  return {
    showNotice,
    clearNotice,
    notice: state.notice,
    revision: state.revision,
  };
}

export interface InlineNoticeProps {
  notice?: AppNotice | null;
  onDismiss?: () => void;
  className?: string;
}

const TONE_CLASS: Record<NoticeTone, string> = {
  success: 'border-success/32 bg-success/4 [&_[data-slot=notice-icon]]:text-success',
  error: 'border-error/32 bg-error-surface text-error-foreground [&_[data-slot=notice-icon]]:text-error',
  info: 'border-info/32 bg-info/4 [&_[data-slot=notice-icon]]:text-info',
};

export function InlineNotice({ notice, onDismiss, className = '' }: InlineNoticeProps) {
  const { t } = useI18n();

  const message = notice
    ? typeof notice.message === 'string' ? notice.message : t(notice.message.key, notice.message.variables)
    : '';

  if (!notice || !message.trim()) {
    return null;
  }

  const Icon = notice.tone === 'error' ? CircleAlert : notice.tone === 'success' ? CircleCheck : Info;
  const isError = notice.tone === 'error';

  return (
    <div
      className={cn('action-feedback inline-notice', notice.tone, 'relative flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm text-card-foreground', TONE_CLASS[notice.tone], className)}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="flex h-5 w-4 shrink-0 items-center justify-center">
        <Icon className="size-4" data-slot="notice-icon" aria-hidden="true" />
      </div>
      <div className="action-feedback-text min-w-0 flex-1 whitespace-pre-wrap break-words leading-5 outline-none" tabIndex={0}>
        {notice.source ? <strong className="action-feedback-source font-medium">{t(notice.source)}: </strong> : null}
        <span className="action-feedback-message">{message}</span>
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="-my-0.5 -me-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onDismiss}
          aria-label={t('app.notice.dismiss')}
          title={t('app.notice.dismiss')}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
