import { requestFocus } from '../focusRequests';
import { accountSignInsView, type AppView } from '../navigation';
import type { OAuthProviderId } from './oauthCallback';

/** What a sign-in request names when no provider was picked: Add account opens on the choice of one. */
const ANY_PROVIDER = 'any';

/**
 * Adds an account: Accounts › Sign-ins with Add account open, on `provider`'s sign-in or on the choice of provider. It
 * goes as a focus request, so it reaches the page when it's already open too.
 */
export function addAccount(onNavigate: (view: AppView) => void, provider?: OAuthProviderId) {
  requestFocus('sign-in', provider ?? ANY_PROVIDER);
  onNavigate(accountSignInsView());
}
