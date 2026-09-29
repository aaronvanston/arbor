import { AlertCircle, Check, Copy, ExternalLink } from './ui/icons';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import type { OAuthSignInFlow } from '../hooks/useOAuthSignIn';
import { useI18n } from '../i18n';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';

/**
 * A sign-in in progress: the provider's page to open again or copy, a field for the callback address when the browser
 * couldn't hand it back, and how that went.
 */
export function OAuthLinkBox<T>({ flow, onOpen, onCallbackChange, onSubmitCallback }: {
  flow: OAuthSignInFlow<T>;
  onOpen: () => void;
  onCallbackChange: (value: string) => void;
  onSubmitCallback: () => void;
}) {
  const { t } = useI18n();
  const { copy, copied } = useCopyToClipboard({ inline: true });
  if (!flow.url || flow.phase !== 'waiting') return null;
  const { url } = flow;
  return (
    <>
      {flow.openError ? (
        <Alert variant="info" icon={<AlertCircle />}><AlertDescription>{flow.openError}</AlertDescription></Alert>
      ) : flow.linkOnly ? (
        <p className="text-sm text-muted-foreground">{t('oauth.linkOnly')}</p>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40 dark:bg-input/16">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{t('oauth.authorizationLink')}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={url}>{url}</code>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={t(copied ? 'oauth.linkCopied' : 'oauth.copyLink')} onClick={() => void copy(url)} />}>
              {copied ? <Check className="text-success" /> : <Copy />}
            </TooltipTrigger>
            <TooltipPopup>{t(copied ? 'oauth.linkCopied' : 'oauth.copyLink')}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={t('oauth.openLink')} onClick={onOpen} />}>
              <ExternalLink />
            </TooltipTrigger>
            <TooltipPopup>{t('oauth.openLink')}</TooltipPopup>
          </Tooltip>
        </div>
        <form
          className="flex items-center gap-2 border-t border-border/50 px-3 py-2"
          onSubmit={(event) => { event.preventDefault(); onSubmitCallback(); }}
        >
          <Input
            size="sm"
            value={flow.callbackUrl}
            font="mono"
            aria-label={t('oauth.submitCallback')}
            onChange={(event) => onCallbackChange(event.currentTarget.value)}
            placeholder={flow.provider === 'xai' ? t('oauth.xaiCallbackPlaceholder') : t('oauth.callbackPlaceholder')}
          />
          <Button type="submit" variant="outline" size="xs" className="shrink-0" disabled={flow.callbackSubmitting}>
            {flow.callbackSubmitting ? <Spinner className="size-3.5" /> : <Check />}
            {t('oauth.submitCallback')}
          </Button>
        </form>
      </div>
      {flow.callbackStatus === 'success' ? (
        <Alert variant="success" icon={<Check />}><AlertDescription>{t('oauth.callbackSubmitted')}</AlertDescription></Alert>
      ) : null}
      {flow.callbackStatus === 'error' ? (
        <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{t('oauth.callbackFailed', { detail: flow.callbackError ? `: ${flow.callbackError}` : '' })}</AlertDescription></Alert>
      ) : null}
    </>
  );
}
