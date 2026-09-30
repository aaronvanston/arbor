export type OAuthProviderId = 'codex' | 'claude' | 'xai';

/** The providers Arbor signs in to, in the order the Accounts views list them. */
export const OAUTH_PROVIDERS: readonly OAuthProviderId[] = ['claude', 'codex', 'xai'];
export const isOAuthProvider = (value: string | null | undefined): value is OAuthProviderId =>
  (OAUTH_PROVIDERS as readonly string[]).includes(value ?? '');

export const XAI_CALLBACK_URL = 'http://127.0.0.1:56121/callback';
export const OAUTH_BROWSER_STORAGE_KEY = 'arbor.oauth-browser.v3';
export const NO_AUTO_OPEN_BROWSER_ID = 'none';
export const OAUTH_POLL_INTERVAL_MS = 3000;

export const loadOAuthBrowserPreference = (): string => {
  try {
    return window.localStorage.getItem(OAUTH_BROWSER_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
};

/** Keeps the browser sign-ins open in: a browser's id, `default`, or NO_AUTO_OPEN_BROWSER_ID to only show the link. */
export function saveOAuthBrowserPreference(id: string) {
  try {
    window.localStorage.setItem(OAUTH_BROWSER_STORAGE_KEY, id);
  } catch {
    // The choice lasts until the app closes when storage is unavailable.
  }
}

/** Browser id to pass to `open_oauth_url` for a stored preference. */
export const oauthBrowserForOpen = (preference: string) =>
  !preference || preference === NO_AUTO_OPEN_BROWSER_ID ? 'default' : preference;

function isAbsoluteUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function readQueryLikeCallbackInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  const rawParams = queryStart >= 0
    ? trimmed.slice(queryStart + 1)
    : hashStart >= 0
      ? trimmed.slice(hashStart + 1)
      : trimmed;
  if (!/(^|[&#?])(code|state|error)=/i.test(rawParams)) return null;
  return new URLSearchParams(rawParams.replace(/^[?#]/, ''));
}

export function buildXaiCallbackUrl(input: string, state?: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isAbsoluteUrl(trimmed)) return trimmed;
  const params = readQueryLikeCallbackInput(trimmed);
  if (params) {
    const callbackState = params.get('state')?.trim() || state?.trim();
    if (!callbackState) return null;
    const callbackUrl = new URL(XAI_CALLBACK_URL);
    callbackUrl.searchParams.set('state', callbackState);
    for (const key of ['code', 'error', 'error_description']) {
      const value = params.get(key)?.trim();
      if (value) callbackUrl.searchParams.set(key, value);
    }
    return callbackUrl.toString();
  }
  const code = (trimmed.match(/\bcode\s*[:=]\s*([^\s&]+)/i)?.[1] ?? trimmed).trim();
  const callbackState = state?.trim();
  if (!code || !callbackState) return null;
  const callbackUrl = new URL(XAI_CALLBACK_URL);
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', callbackState);
  return callbackUrl.toString();
}

export function resolveCallbackUrl(provider: OAuthProviderId, input: string, state?: string) {
  return provider === 'xai' ? buildXaiCallbackUrl(input, state) : input.trim();
}
