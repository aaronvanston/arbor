import { useCallback, useEffect, useRef, useState } from 'react';
import { toast, type ToastInput } from '../components/ui/toast';
import { useI18n } from '../i18n';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { writeClipboardText, type PendingCopy } from '../lib/clipboard';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** How long a button's own tick stays after a copy. */
const COPIED_MS = 1_500;
// Every copy uses this toast, so copying a few things in a row updates one toast instead of stacking them.
const COPY_TOAST_ID = 'clipboard';

const refusedToast = (t: Translate): ToastInput => ({ id: COPY_TOAST_ID, kind: 'error', title: t('copy.failed'), description: t('copy.failedHint') });

/**
 * What a copy says in the corner: a success only when the button has no tick of its own, and a failure always, as an
 * error that stays until it's dismissed or the next copy works. A refused clipboard is about the app, not the row.
 */
export function copyToast(ok: boolean, { inline, label }: { inline: boolean; label?: string }, t: Translate): ToastInput | null {
  if (!ok) return refusedToast(t);
  return inline ? null : { id: COPY_TOAST_ID, kind: 'success', title: label ?? t('copy.done') };
}

/**
 * What copying text the app had to read first says in the corner, however it went, in the same toast as every other
 * copy. `label` names what was copied, and `empty` says why there was nothing to copy.
 */
export function pendingCopyToast(result: PendingCopy, { label, empty }: { label: (text: string) => string; empty: string }, t: Translate): ToastInput {
  switch (result.status) {
    case 'copied': return { id: COPY_TOAST_ID, kind: 'success', title: label(result.text) };
    case 'empty': return { id: COPY_TOAST_ID, kind: 'warning', title: empty };
    case 'refused': return refusedToast(t);
    case 'unreadable': return { id: COPY_TOAST_ID, kind: 'error', title: t('copy.failed'), description: result.error };
  }
}

/**
 * Copies text and says so the same way on every page. `copied` and `failed` hold the id of what was just copied
 * (the text itself unless `id` is given) for a moment, for buttons that show a tick; pass `inline` for those, and
 * a success shows only as the tick. `label` names what was copied in the toast, such as "Sign-in link copied".
 */
export function useCopyToClipboard({ inline = false }: { inline?: boolean } = {}) {
  const { t } = useI18n();
  const [result, setResult] = useState<{ id: string; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string, { label, id = text }: { label?: string; id?: string } = {}) => {
    const ok = await writeClipboardText(text);
    const note = copyToast(ok, { inline, label }, t);
    if (note) toast(note);
    setResult({ id, ok });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), COPIED_MS);
    return ok;
  }, [inline, t]);

  return { copy, copied: result?.ok ? result.id : null, failed: result && !result.ok ? result.id : null };
}
