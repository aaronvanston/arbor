import { resumePausedAccount } from './accountReserves';
import { loadAccountFiles, refreshAccountQuotas } from './accountsStore';
import { setOAuthCredentialFileDisabled } from './authFiles';
import { quotaKey, type AuthFile } from './quotaService';

/**
 * Turns an account off in the core by hand, as Disable on Accounts does. Arbor never turns it back on by
 * itself: only accounts it paused at their cap come back at the reset.
 */
export async function pauseAccount(file: AuthFile) {
  await setOAuthCredentialFileDisabled(file, true);
  await loadAccountFiles();
}

/** Turns an account that's off back on, whoever paused it, then reads its limits again. */
export async function resumeAccount(key: string, file: AuthFile) {
  await resumePausedAccount(key, file);
  const next = await loadAccountFiles();
  void refreshAccountQuotas(next.filter((item) => quotaKey(item) === key));
}
