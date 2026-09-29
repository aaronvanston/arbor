import { useCallback } from 'react';
import { getAppPreferences, useAppPreferences } from '../appPreferences';
import { readString } from './managementApi';
import type { AuthFile } from './quotaService';

/**
 * Settings › Appearance › Hide email addresses: an account's email keeps its first and last letter and its domain
 * (c•••y@example.com), and a file name that repeats the address, or the part before the @, is hidden the same way, as
 * file names like `claude-sam@example.com.json` or `CC-P1-sam.json` are the fallback name of an account without one.
 */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const HIDDEN = '•••';

/** The part before the @ with its first and last letter kept: `samrivera` → `s•••a`. */
const maskLocal = (local: string) => {
  const letters = Array.from(local);
  if (letters.length <= 2) return `${letters[0] ?? ''}${HIDDEN}`;
  return `${letters[0]}${HIDDEN}${letters[letters.length - 1]}`;
};

/** One email address with the name hidden and the domain kept, which is what tells a work account from a personal one. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return maskLocal(email);
  return `${maskLocal(email.slice(0, at))}${email.slice(at)}`;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text with every email address in it hidden, and each of `emails`' names where it appears without the domain. Names
 * shorter than four letters are left, as they'd match ordinary words.
 */
export function maskEmailsIn(text: string, emails: readonly string[] = []): string {
  const known = [...new Set(emails.filter(Boolean))].sort((a, b) => b.length - a.length);
  // The known addresses go first, held out of the text so the pattern below can't take in what's around them, as it
  // would take `claude-sam@example.com` whole.
  const held: string[] = [];
  let masked = text;
  for (const email of known) {
    masked = masked.replace(new RegExp(escapeRegExp(email), 'giu'), (match) => {
      held.push(maskEmail(match));
      return `\uE000${held.length - 1}\uE000`;
    });
  }
  masked = masked.replace(EMAIL, (match) => maskEmail(match));
  const locals = [...new Set(known.map((email) => email.slice(0, Math.max(0, email.lastIndexOf('@')))).filter((local) => Array.from(local).length >= 4))]
    // Longer names first, so `samrivera.alt` goes before the `samrivera` inside it.
    .sort((a, b) => b.length - a.length);
  for (const local of locals) masked = masked.replace(new RegExp(escapeRegExp(local), 'giu'), (match) => maskLocal(match));
  return masked.replace(/\uE000(\d+)\uE000/g, (_, index: string) => held[Number(index)] ?? '');
}

/** Each credential file's email from the core's last listing, so a name made from its file name can be hidden anywhere. */
let emailsByFile = new Map<string, string>();

export function rememberCredentialEmails(files: AuthFile[]) {
  const next = new Map<string, string>();
  for (const file of files) {
    const name = readString(file, 'name');
    const email = readString(file, 'email');
    if (name && email) next.set(name, email);
  }
  emailsByFile = next;
}

export const credentialEmail = (fileName: string) => emailsByFile.get(fileName) ?? '';

export const emailsHidden = () => getAppPreferences().hideEmails;

/**
 * A credential's name or email as it's shown: hidden while the setting is on. `email` is the credential's own
 * address when the caller has it; otherwise the one the last listing had for a file of that name is used.
 */
export function shownIdentity(text: string, { fileName, email }: { fileName?: string; email?: string } = {}): string {
  if (!text || !emailsHidden()) return text;
  const own = email || (fileName ? credentialEmail(fileName) : '');
  return maskEmailsIn(text, own ? [own] : []);
}

export type ShownIdentity = (text: string, context?: { fileName?: string; email?: string }) => string;

/** shownIdentity for a component, which renders again when the setting changes. */
export function useShownIdentity(): ShownIdentity {
  const { hideEmails } = useAppPreferences();
  return useCallback(
    (text: string, context?: { fileName?: string; email?: string }) => (hideEmails ? shownIdentity(text, context) : text),
    [hideEmails],
  );
}
