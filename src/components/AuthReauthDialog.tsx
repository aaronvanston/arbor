import { useEffect } from 'react';
import { AlertCircle, Check, LogIn } from './ui/icons';
import { useOAuthSignIn } from '../hooks/useOAuthSignIn';
import { useI18n } from '../i18n';
import { snapshotAuthFiles, type AuthFileRecord } from '../services/authFiles';
import { authAccountLabel, completeReauth, type ReauthOutcome } from '../services/authReauth';
import { useShownIdentity } from '../services/emailPrivacy';
import { readString } from '../services/managementApi';
import type { OAuthProviderId } from '../services/oauthCallback';
import { OAuthLinkBox } from './OAuthLinkBox';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';

export type ReauthTarget = { file: AuthFileRecord; provider: OAuthProviderId };

export function AuthReauthDialog({
  target,
  onClose,
  onCompleted,
}: {
  target: ReauthTarget | null;
  onClose: () => void;
  onCompleted: (outcome: ReauthOutcome) => void;
}) {
  const { t } = useI18n();
  const shown = useShownIdentity();
  const { flow, start, cancel, openLink, setCallbackUrl, submitCallback } = useOAuthSignIn(async (provider, before) => {
    if (!target) throw new Error('No credential to sign in again');
    const outcome = await completeReauth(target.file, provider, snapshotAuthFiles(before));
    onCompleted(outcome);
    return outcome;
  });

  useEffect(() => {
    if (target) void start(target.provider);
    else cancel();
  }, [cancel, start, target]);

  // Names and addresses are hidden with the rest while Hide email addresses is on. The core's file names repeat the
  // account's email, which is told to the mask so a prefix like `codex-9f1e2a3b-` isn't taken in as part of it.
  const email = target ? readString(target.file, 'email') : '';
  const hide = (text: string) => shown(text, { fileName: text, email });
  const name = target ? hide(readString(target.file, 'name')) : '';
  const account = target ? shown(authAccountLabel(target.file), { email: readString(target.file, 'email') }) : '';
  const busy = flow.phase === 'starting' || flow.phase === 'finishing';
  const finished = flow.phase === 'done' || flow.phase === 'error';
  const result = flow.phase === 'done' ? flow.result : undefined;

  const outcomeMessage = (outcome: ReauthOutcome) => {
    const done = hide(outcome.name);
    switch (outcome.kind) {
      // The core's temporary copy is cleaned up out of sight, so a transplant reads like a refresh in place.
      case 'in-place':
      case 'transplanted': return t('authFiles.reauth.done', { name: done });
      case 'renamed': return t('authFiles.reauth.doneRenamed', { name: done, from: hide(outcome.from) });
      case 'mismatch': return t('authFiles.reauth.mismatch', {
        name: done,
        account,
        accounts: outcome.signedInAs.map((email) => shown(email, { email })).join(', ') || t('authFiles.reauth.unknownAccount'),
      });
      case 'other-workspace': return t('authFiles.reauth.otherWorkspace', { name: done, saved: hide(outcome.saved), account: account || t('authFiles.reauth.unknownAccount') });
      case 'missing': return t('authFiles.reauth.missing', { name: done, account: account || t('authFiles.reauth.unknownAccount') });
      case 'none': return t('authFiles.reauth.none', { name: done });
    }
  };
  const outcomeNeedsAttention = (outcome: ReauthOutcome) =>
    outcome.kind === 'mismatch' || outcome.kind === 'other-workspace' || outcome.kind === 'missing' || outcome.kind === 'none';

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target ? (
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('authFiles.reauth.title')}</DialogTitle>
            <DialogDescription>{t('authFiles.reauth.description', { account, name })}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            {!finished ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner className="size-4" />
                <span>{t(flow.phase === 'waiting' ? 'authFiles.reauth.waiting' : flow.phase === 'finishing' ? 'authFiles.reauth.finalizing' : 'authFiles.reauth.starting')}</span>
              </div>
            ) : null}
            <OAuthLinkBox flow={flow} onOpen={() => void openLink()} onCallbackChange={setCallbackUrl} onSubmitCallback={() => void submitCallback()} />
            {result ? (
              <Alert
                variant={outcomeNeedsAttention(result) ? 'warning' : 'success'}
                icon={outcomeNeedsAttention(result) ? <AlertCircle /> : <Check />}
              >
                <AlertDescription>{outcomeMessage(result)}</AlertDescription>
              </Alert>
            ) : null}
            {flow.phase === 'error' ? (
              <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{t('authFiles.reauth.failed', { error: flow.error ?? '' })}</AlertDescription></Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            {flow.phase === 'error' ? (
              <Button variant="outline" size="sm" onClick={() => void start(target.provider)}>
                <LogIn />
                {t('common.retry')}
              </Button>
            ) : null}
            <Button variant={finished ? 'default' : 'outline'} size="sm" disabled={busy} onClick={onClose}>
              {t(finished ? 'common.close' : 'common.cancel')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
