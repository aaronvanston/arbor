/** How text gets to the clipboard: the Clipboard API, and the older copy command for when it's missing or refused. */
export type ClipboardWriter = {
  clipboard?: {
    writeText(text: string): Promise<void>;
    /** Takes `ClipboardItem`s, whose text can still be on its way, so a write can start before the text is read. */
    write?(items: unknown[]): Promise<void>;
  };
  /** `ClipboardItem`, where there is one. */
  Item?: new (items: Record<string, Promise<Blob>>) => unknown;
  execCopy?: (text: string) => boolean;
};

/** Copies text, falling back to the copy command. Resolves false when neither worked, and never throws. */
export async function writeClipboardText(text: string, writer: ClipboardWriter = browserClipboard()): Promise<boolean> {
  if (writer.clipboard) {
    try {
      await writer.clipboard.writeText(text);
      return true;
    } catch {
      // The webview can refuse the API outside a click it trusts; the copy command may still work.
    }
  }
  try {
    return writer.execCopy?.(text) ?? false;
  } catch {
    return false;
  }
}

/** How copying text that first had to be read went. */
export type PendingCopy =
  | { status: 'copied'; text: string }
  /** The read found nothing to copy. */
  | { status: 'empty' }
  /** The clipboard wouldn't take it. */
  | { status: 'refused' }
  /** The read failed, with why. */
  | { status: 'unreadable'; error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Copies text that still has to be read from the app, such as the API key. WebKit only lets a page write to the
 * clipboard during the click or key press that asked for it, and the read outlasts that, so the write starts at once
 * with the text to follow. Where that isn't supported, or it's refused, the text is copied the usual way once it's
 * read. Never throws.
 */
export async function copyPendingText(read: () => Promise<string | null>, writer: ClipboardWriter = browserClipboard()): Promise<PendingCopy> {
  const text = read().then((value) => value || null);
  // Settled below, whichever way the write goes.
  text.catch(() => undefined);
  const { clipboard, Item } = writer;
  if (clipboard?.write && Item) {
    const blob = text.then((value) => {
      if (value === null) throw new Error('Nothing to copy');
      return new Blob([value], { type: 'text/plain' });
    });
    blob.catch(() => undefined);
    try {
      await clipboard.write([new Item({ 'text/plain': blob })]);
      const value = await text;
      if (value !== null) return { status: 'copied', text: value };
    } catch {
      // Nothing to copy, a failed read, or no pending write here: what follows says which.
    }
  }
  let value: string | null;
  try {
    value = await text;
  } catch (error) {
    return { status: 'unreadable', error: errorText(error) };
  }
  if (value === null) return { status: 'empty' };
  return (await writeClipboardText(value, writer)) ? { status: 'copied', text: value } : { status: 'refused' };
}

function browserClipboard(): ClipboardWriter {
  if (typeof document === 'undefined') return {};
  return {
    clipboard: typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : undefined,
    Item: typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem,
    execCopy: execCommandCopy,
  };
}

/** Copies through a hidden text field, putting focus back where it was. */
function execCommandCopy(text: string) {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  field.style.pointerEvents = 'none';
  const previous = document.activeElement;
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
}
