import { describe, expect, it } from 'bun:test';
import { copyToast, pendingCopyToast } from '../src/hooks/useCopyToClipboard';
import { translate } from '../src/i18n';
import type { MessageKey, MessageVariables } from '../src/i18n/resources';
import { copyPendingText, writeClipboardText, type ClipboardWriter } from '../src/lib/clipboard';

const t = (key: MessageKey, variables?: MessageVariables) => translate(key, variables);

function writer({ api, command }: { api?: 'works' | 'refuses'; command?: 'works' | 'fails' | 'throws' }) {
  const calls: string[] = [];
  return {
    calls,
    writer: {
      clipboard: api
        ? {
            writeText: async (text: string) => {
              calls.push(`api:${text}`);
              if (api === 'refuses') throw new DOMException('Write permission denied.', 'NotAllowedError');
            },
          }
        : undefined,
      execCopy: command
        ? (text: string) => {
            calls.push(`command:${text}`);
            if (command === 'throws') throw new Error('No document');
            return command === 'works';
          }
        : undefined,
    },
  };
}

describe('copying to the clipboard', () => {
  it('uses the Clipboard API when it works, without the copy command', async () => {
    const { writer: clipboard, calls } = writer({ api: 'works', command: 'works' });
    expect(await writeClipboardText('sk-123', clipboard)).toBe(true);
    expect(calls).toEqual(['api:sk-123']);
  });

  it('falls back to the copy command when the API refuses or is missing', async () => {
    const refused = writer({ api: 'refuses', command: 'works' });
    expect(await writeClipboardText('https://auth.example/x', refused.writer)).toBe(true);
    expect(refused.calls).toEqual(['api:https://auth.example/x', 'command:https://auth.example/x']);

    const missing = writer({ command: 'works' });
    expect(await writeClipboardText('a3f1', missing.writer)).toBe(true);
    expect(missing.calls).toEqual(['command:a3f1']);
  });

  it('says it failed, without throwing, when neither way works', async () => {
    expect(await writeClipboardText('x', writer({ api: 'refuses', command: 'fails' }).writer)).toBe(false);
    expect(await writeClipboardText('x', writer({ api: 'refuses', command: 'throws' }).writer)).toBe(false);
    expect(await writeClipboardText('x', writer({ api: 'refuses' }).writer)).toBe(false);
    expect(await writeClipboardText('x', {})).toBe(false);
  });

  it('shows a copy in one toast, unless the button has its own tick, and always says when it failed, until dismissed', () => {
    expect(copyToast(true, { inline: false }, t)).toEqual({ id: 'clipboard', kind: 'success', title: 'Copied' });
    expect(copyToast(true, { inline: false, label: 'Sign-in link copied' }, t)).toMatchObject({ title: 'Sign-in link copied' });
    expect(copyToast(true, { inline: true, label: 'Sign-in link copied' }, t)).toBeNull();
    const failed = { id: 'clipboard', kind: 'error' as const, title: 'Couldn’t copy', description: 'The clipboard wasn’t available. Try again.' };
    expect(copyToast(false, { inline: false }, t)).toEqual(failed);
    expect(copyToast(false, { inline: true }, t)).toEqual(failed);
  });
});

/** A clipboard that can take text still on its way, recording what reached it and when each write started. */
function pendingWriter({ refuse = false, api = 'works' }: { refuse?: boolean; api?: 'works' | 'refuses' } = {}) {
  const log: string[] = [];
  const copied: string[] = [];
  const writer: ClipboardWriter = {
    clipboard: {
      writeText: async (text) => {
        log.push('writeText');
        if (api === 'refuses') throw new DOMException('Write permission denied.', 'NotAllowedError');
        copied.push(text);
      },
      write: async (items) => {
        log.push('write');
        if (refuse) throw new DOMException('Write permission denied.', 'NotAllowedError');
        const item = items[0] as { items: Record<string, Promise<Blob>> };
        const blob = await item.items['text/plain'];
        if (blob) copied.push(await blob.text());
      },
    },
    Item: class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    },
    execCopy: (text) => {
      log.push('command');
      copied.push(text);
      return true;
    },
  };
  return { writer, log, copied };
}

/** A read that finishes only when told to, like a call into the app. */
function slowRead(value: string | null) {
  let finish = () => {};
  const read = () => new Promise<string | null>((resolve) => {
    finish = () => resolve(value);
  });
  return { read, finish: () => finish() };
}

describe('copying text the app still has to read', () => {
  it('starts the write before the read finishes, so WebKit counts the key press', async () => {
    const { writer, log, copied } = pendingWriter();
    const { read, finish } = slowRead('http://127.0.0.1:8317/v1');
    const copying = copyPendingText(read, writer);
    expect(log).toEqual(['write']);
    finish();
    expect(await copying).toEqual({ status: 'copied', text: 'http://127.0.0.1:8317/v1' });
    expect(copied).toEqual(['http://127.0.0.1:8317/v1']);
  });

  it('copies nothing when there’s nothing to copy', async () => {
    const { writer, copied } = pendingWriter();
    expect(await copyPendingText(async () => null, writer)).toEqual({ status: 'empty' });
    expect(await copyPendingText(async () => '', writer)).toEqual({ status: 'empty' });
    expect(copied).toEqual([]);
  });

  it('copies once it’s read, the usual way, where a pending write isn’t possible or is refused', async () => {
    const plain = writer({ api: 'works' });
    expect(await copyPendingText(async () => 'sk-key', plain.writer)).toEqual({ status: 'copied', text: 'sk-key' });
    expect(plain.calls).toEqual(['api:sk-key']);
    const refused = pendingWriter({ refuse: true });
    expect(await copyPendingText(async () => 'sk-key', refused.writer)).toEqual({ status: 'copied', text: 'sk-key' });
    expect(refused.log).toEqual(['write', 'writeText']);
    // And down to the copy command, as every copy button falls back to.
    const command = pendingWriter({ refuse: true, api: 'refuses' });
    expect(await copyPendingText(async () => 'sk-key', command.writer)).toEqual({ status: 'copied', text: 'sk-key' });
    expect(command.log).toEqual(['write', 'writeText', 'command']);
  });

  it('says so, without throwing, when the clipboard won’t take it or the read fails', async () => {
    expect(await copyPendingText(async () => 'sk-key', writer({ api: 'refuses', command: 'fails' }).writer)).toEqual({ status: 'refused' });
    const { writer: clipboard, copied } = pendingWriter();
    expect(await copyPendingText(async () => {
      throw new Error('The core’s config couldn’t be read');
    }, clipboard)).toEqual({ status: 'unreadable', error: 'The core’s config couldn’t be read' });
    expect(copied).toEqual([]);
  });

  it('always says how it went, in the same toast as every other copy', () => {
    const options = { label: (text: string) => `Copied ${text}`, empty: 'There’s no API key to copy.' };
    expect(pendingCopyToast({ status: 'copied', text: 'http://127.0.0.1:8317/v1' }, options, t)).toEqual({ id: 'clipboard', kind: 'success', title: 'Copied http://127.0.0.1:8317/v1' });
    expect(pendingCopyToast({ status: 'empty' }, options, t)).toEqual({ id: 'clipboard', kind: 'warning', title: 'There’s no API key to copy.' });
    expect(pendingCopyToast({ status: 'refused' }, options, t)).toEqual({ id: 'clipboard', kind: 'error', title: 'Couldn’t copy', description: 'The clipboard wasn’t available. Try again.' });
    expect(pendingCopyToast({ status: 'unreadable', error: 'no config' }, options, t)).toEqual({ id: 'clipboard', kind: 'error', title: 'Couldn’t copy', description: 'no config' });
  });
});
