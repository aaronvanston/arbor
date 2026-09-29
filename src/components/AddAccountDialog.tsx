import { useEffect } from 'react';
import { AlertCircle, Check, ChevronRight, Import, LogIn, Pencil } from './ui/icons';
import { useOAuthSignIn } from '../hooks/useOAuthSignIn';
import { useI18n } from '../i18n';
import { fileProfile, useAccountProfiles } from '../services/accountProfiles';
import { loadAccountFiles } from '../services/accountsStore';
import { settleSignIn, type SignInResult } from '../services/authReauth';
import { useShownIdentity } from '../services/emailPrivacy';
import { readString } from '../services/managementApi';
import { OAUTH_PROVIDERS, type OAuthProviderId } from '../services/oauthCallback';
import { trackFeature } from '../services/productAnalytics';
import { providerLabel } from '../services/providerLimits';
import type { AuthFile } from '../services/quotaService';
import { AccountAvatar } from './AccountAvatar';
import { ProviderMark } from './identity/Identity';
import { OAuthLinkBox } from './OAuthLinkBox';
import { Alert, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';

/** Add account, open: on a provider's sign-in, or on the choice of provider when `provider` is null. */
export type AddAccountTarget = { provider: OAuthProviderId | null };

/**
 * Adds an account where the accounts are listed: pick a provider (or import a file instead), finish signing in on its
 * page in the browser, and the account the sign-in saved is shown with a way to name it. A provider's own Sign in
 * starts on its sign-in straight away.
 */
export function AddAccountDialog({ target, onClose, onImport, onEditProfile }: {
  target: AddAccountTarget | null;
  onClose: () => void;
  /** Imports a credential file instead. */
  onImport: () => void;
  /** Opens a signed-in account's name and avatar. */
  onEditProfile: (file: AuthFile) => void;
}) {
  const { t } = useI18n();
  const { flow, start, cancel, openLink, setCallbackUrl, submitCallback } = useOAuthSignIn(async (provider, before): Promise<SignInResult> => {
    const result = await settleSignIn(before, provider);
    trackFeature('account-signed-in', { kind: provider });
    // The page lists the new account without waiting for its next listing.
    void loadAccountFiles({ quiet: true });
    return result;
  });

  useEffect(() => {
    if (target?.provider) void start(target.provider);
    else cancel();
  }, [cancel, start, target]);

  const provider = flow.provider;
  const name = provider ? providerLabel[provider] : '';
  const choosing = flow.phase === 'idle';
  const finished = flow.phase === 'done' || flow.phase === 'error';
  const result = flow.phase === 'done' ? flow.result : undefined;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target ? (
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{choosing ? t('addAccount.title') : t('addAccount.signInTitle', { provider: name })}</DialogTitle>
            <DialogDescription>
              {choosing
                ? t('addAccount.description')
                : t(result ? 'addAccount.doneDescription' : 'addAccount.signInDescription', { provider: name })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            {choosing ? (
              <>
                <div className="flex flex-col gap-2">
                  {OAUTH_PROVIDERS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-start text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void start(id)}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background dark:bg-input/32">
                        <ProviderMark provider={id} decorative className="size-4" />
                      </span>
                      <span className="flex-1">{t('addAccount.signInWith', { provider: providerLabel[id] })}</span>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </button>
                  ))}
                </div>
                <Button variant="ghost-muted" size="sm" className="self-start" onClick={onImport}>
                  <Import />
                  {t('signIns.importAny')}
                </Button>
              </>
            ) : null}
            {flow.phase === 'starting' || flow.phase === 'waiting' || flow.phase === 'finishing' ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner className="size-4" />
                <span>{t(flow.phase === 'starting' ? 'addAccount.starting' : flow.phase === 'finishing' ? 'addAccount.finishing' : 'addAccount.waiting')}</span>
              </div>
            ) : null}
            <OAuthLinkBox flow={flow} onOpen={() => void openLink()} onCallbackChange={setCallbackUrl} onSubmitCallback={() => void submitCallback()} />
            {result ? <SignedIn result={result} provider={name} onEditProfile={onEditProfile} /> : null}
            {flow.phase === 'error' ? (
              <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{t('addAccount.failed', { error: flow.error ?? '' })}</AlertDescription></Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            {finished && provider ? (
              <Button variant="outline" size="sm" onClick={() => void start(provider)}>
                <LogIn />
                {t(flow.phase === 'error' ? 'common.retry' : 'addAccount.another')}
              </Button>
            ) : null}
            <Button variant={finished ? 'default' : 'outline'} size="sm" disabled={flow.phase === 'finishing'} onClick={onClose}>
              {t(finished ? 'common.close' : 'common.cancel')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

/** What the sign-in saved: each account it added or signed in to again, with a way to name it. */
function SignedIn({ result, provider, onEditProfile }: { result: SignInResult; provider: string; onEditProfile: (file: AuthFile) => void }) {
  const { t } = useI18n();
  const profiles = useAccountProfiles();
  const shown = useShownIdentity();
  const written = [...result.added, ...result.refreshed]
    .map((name) => result.files.find((file) => readString(file, 'name') === name))
    .filter((file): file is AuthFile => file !== undefined);
  return (
    <>
      <Alert variant={written.length ? 'success' : 'warning'} icon={written.length ? <Check /> : <AlertCircle />}>
        <AlertDescription>{t(written.length ? 'addAccount.done' : 'addAccount.nothingSaved', { provider })}</AlertDescription>
      </Alert>
      {written.map((file) => {
        const fileName = readString(file, 'name');
        const profile = fileProfile(file, profiles);
        const email = readString(file, 'email');
        const added = result.added.includes(fileName);
        return (
          <div key={fileName} className="flex items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2">
            <AccountAvatar profile={profile} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
                <Badge variant={added ? 'success' : 'secondary'}>{t(added ? 'addAccount.added' : 'addAccount.refreshed')}</Badge>
              </div>
              {email ? <div className="truncate text-xs text-muted-foreground">{shown(email, { email })}</div> : null}
            </div>
            <Button variant="outline" size="sm" onClick={() => onEditProfile(file)}>
              <Pencil />
              {t('signIns.menu.editProfile')}
            </Button>
          </div>
        );
      })}
      {result.priorityError ? (
        <Alert variant="warning" icon={<AlertCircle />}><AlertDescription>{t('oauth.priorityApplyFailed', { error: result.priorityError })}</AlertDescription></Alert>
      ) : null}
    </>
  );
}
