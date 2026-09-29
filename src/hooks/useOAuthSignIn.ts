import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { useI18n } from '../i18n';
import type { AuthFileRecord } from '../services/authFiles';
import { managementApi, responseList } from '../services/managementApi';
import {
  NO_AUTO_OPEN_BROWSER_ID,
  OAUTH_POLL_INTERVAL_MS,
  loadOAuthBrowserPreference,
  oauthBrowserForOpen,
  resolveCallbackUrl,
  type OAuthProviderId,
} from '../services/oauthCallback';

export type OAuthSignInPhase = 'idle' | 'starting' | 'waiting' | 'finishing' | 'done' | 'error';

export type OAuthSignInFlow<T> = {
  phase: OAuthSignInPhase;
  provider?: OAuthProviderId;
  /** The provider's sign-in page, to open or copy. */
  url?: string;
  state?: string;
  error?: string;
  /** Why the browser didn't open the page by itself, when it didn't. */
  openError?: string;
  /** No browser opens sign-ins, by choice: the link is there to open or copy. */
  linkOnly?: boolean;
  /** What `finish` made of the saved sign-in. */
  result?: T;
  callbackUrl: string;
  callbackSubmitting: boolean;
  callbackStatus?: 'success' | 'error';
  callbackError?: string;
};

const idle = { phase: 'idle', callbackUrl: '', callbackSubmitting: false } as const;

/**
 * One OAuth sign-in at a time, for a dialog: the provider's page opens in the chosen browser, the core's status is
 * polled until it saved the login, and `finish` then works out what the login changed, from the listing just before
 * it. A callback the browser couldn't deliver can be pasted in. Starting again, `cancel` or closing drops the core's
 * pending session, and a reply for a run that's over is ignored.
 */
export function useOAuthSignIn<T>(finish: (provider: OAuthProviderId, before: AuthFileRecord[]) => Promise<T>) {
  const { t } = useI18n();
  const [flow, setFlow] = useState<OAuthSignInFlow<T>>(idle);
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const timerRef = useRef<number | undefined>(undefined);
  const checkingRef = useRef(false);
  const stateRef = useRef<string | undefined>(undefined);
  const runRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== undefined) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    checkingRef.current = false;
  }, []);

  const dropSession = useCallback(async () => {
    const state = stateRef.current;
    stateRef.current = undefined;
    if (!state) return;
    try {
      await managementApi.delete('/oauth-session', { query: { state } });
    } catch (error) {
      console.warn('Failed to cancel the OAuth session', error);
    }
  }, []);

  const fail = useCallback((run: number, error: string) => {
    if (runRef.current !== run) return;
    stopPolling();
    stateRef.current = undefined;
    setFlow((previous) => ({ ...previous, phase: 'error', error }));
  }, [stopPolling]);

  const start = useCallback(async (provider: OAuthProviderId) => {
    const run = runRef.current + 1;
    runRef.current = run;
    stopPolling();
    await dropSession();
    setFlow({ ...idle, phase: 'starting', provider });
    try {
      const before = responseList(await managementApi.get('/auth-files'), 'files');
      const browser = loadOAuthBrowserPreference() || 'default';
      const result = await invokeCommand('start_oauth_login', { provider, browser });
      const linkOnly = browser === NO_AUTO_OPEN_BROWSER_ID;
      if (runRef.current !== run) return;
      if (!result.state) {
        setFlow((previous) => ({ ...previous, phase: 'error', url: result.url, error: t('oauth.missingState') }));
        return;
      }
      const state = result.state;
      stateRef.current = state;
      setFlow((previous) => ({
        ...previous,
        phase: 'waiting',
        url: result.url,
        state,
        linkOnly,
        openError: result.opened || linkOnly ? undefined : (result.openError || t('oauth.openFailed')),
      }));
      const check = async () => {
        if (checkingRef.current || runRef.current !== run) return;
        checkingRef.current = true;
        try {
          const status = await invokeCommand('get_oauth_status', { state });
          if (runRef.current !== run) return;
          const outcome = (status.status || '').toLowerCase();
          if (outcome === 'error') {
            fail(run, status.error || t('oauth.authFailed'));
            return;
          }
          if (outcome !== 'ok') return;
          stopPolling();
          stateRef.current = undefined;
          setFlow((previous) => ({ ...previous, phase: 'finishing' }));
          const finished = await finishRef.current(provider, before);
          if (runRef.current !== run) return;
          setFlow((previous) => ({ ...previous, phase: 'done', result: finished }));
        } catch (error) {
          fail(run, String(error));
        } finally {
          checkingRef.current = false;
        }
      };
      timerRef.current = window.setInterval(() => void check(), OAUTH_POLL_INTERVAL_MS);
    } catch (error) {
      fail(run, String(error));
    }
  }, [dropSession, fail, stopPolling, t]);

  const cancel = useCallback(() => {
    runRef.current += 1;
    stopPolling();
    void dropSession();
    setFlow(idle);
  }, [dropSession, stopPolling]);

  useEffect(() => () => {
    stopPolling();
    void dropSession();
  }, [dropSession, stopPolling]);

  const openLink = async () => {
    if (!flow.url) return;
    try {
      await invokeCommand('open_oauth_url', { url: flow.url, browser: oauthBrowserForOpen(loadOAuthBrowserPreference()) });
    } catch (error) {
      setFlow((previous) => ({ ...previous, openError: String(error) }));
    }
  };

  const setCallbackUrl = (callbackUrl: string) =>
    setFlow((previous) => ({ ...previous, callbackUrl, callbackStatus: undefined, callbackError: undefined }));

  const submitCallback = async () => {
    const { provider } = flow;
    if (!provider) return;
    const redirectUrl = resolveCallbackUrl(provider, flow.callbackUrl, flow.state);
    if (!redirectUrl) {
      setFlow((previous) => ({
        ...previous,
        callbackStatus: 'error',
        callbackError: t(provider === 'xai' ? 'oauth.invalidXaiCallback' : 'oauth.invalidCallback'),
      }));
      return;
    }
    setFlow((previous) => ({ ...previous, callbackSubmitting: true, callbackStatus: undefined, callbackError: undefined }));
    try {
      await invokeCommand('submit_oauth_callback', { provider, redirectUrl });
      setFlow((previous) => ({ ...previous, callbackSubmitting: false, callbackStatus: 'success' }));
    } catch (error) {
      setFlow((previous) => ({ ...previous, callbackSubmitting: false, callbackStatus: 'error', callbackError: String(error) }));
    }
  };

  return { flow, start, cancel, openLink, setCallbackUrl, submitCallback };
}
