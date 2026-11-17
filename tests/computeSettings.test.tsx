import { afterEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockCommands } from '../src/dev/mock/answers';
import { computeScenarioSnapshot, type ComputeScenario } from '../src/dev/mock/computeScenarios';
import { I18nProvider } from '../src/i18n';
import type { CommandError } from '../src/native/types';
import { ComputeSettingsPage, LINK_LABELS, LOAD_KEY_COMMANDS, linkCommand, linkedCount, loadHeldBack, submitComputeKey, unlinkCommand } from '../src/pages/ComputeSettings';
import { currentCompute, resetComputeStore, takeComputeSnapshot } from '../src/services/compute';
import { COMPUTE_HINT_KEY, COMPUTE_PROVIDERS } from '../src/services/computeHint';
import { translate } from '../src/i18n';
import { indexSettings, SETTINGS_INDEX, searchSettings } from '../src/services/settingsIndex';
import { readFileSync } from 'node:fs';
import { present } from './support/items';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = () => renderToStaticMarkup(<I18nProvider><ComputeSettingsPage onNavigate={() => undefined} /></I18nProvider>);
const show = (scenario: ComputeScenario) => {
  takeComputeSnapshot(computeScenarioSnapshot(scenario, Date.now()));
  return render();
};
const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(async () => {
  // The saved hint outlives the store; nothing connected puts it back to none for the next test.
  takeComputeSnapshot({ providers: [] });
  // Clearing the hint stops the store, whose unlisten needs `window` until it settles.
  await resetComputeStore();
  if (typeof window !== 'undefined') clearMocks();
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('Settings › Compute', () => {
  it('offers the key field, the read-only key command and how to link before anything is connected', () => {
    const html = render();
    const words = text(html);
    expect(words).toContain('Boat');
    // In the order it's done: what each of the two keys shows, then where the key goes.
    expect(words).toContain('This one can only read, and shows everything but CPU and memory:');
    expect(words).toContain('Paste the key it prints. Arbor only reads with it, once a minute.');
    expect(words.indexOf('This one can only read')).toBeLessThan(words.indexOf('Or this one, which also shows CPU and memory'));
    expect(words.indexOf('Or this one, which also shows CPU and memory')).toBeLessThan(words.indexOf('Paste the key it prints'));
    // Boat's own mark sits before its name: one drawing, in the blue Boat uses on each ground.
    expect(html).toMatch(/<svg viewBox="0 0 498 462\.1" aria-hidden="true" class="[^"]*fill-\[#263FA9\] dark:fill-\[#8C9EF2\]/);
    expect(html).not.toContain('<img');
    // A password field that starts empty, so a key is never drawn back into it.
    expect(html).toMatch(/<input[^>]*type="password"[^>]*aria-label="Boat API key"/);
    expect(html).toContain('placeholder="boat_…"');
    expect(html).toContain('value=""');
    expect(words).toContain('Connect');
    // The command comes from the provider record.
    expect(COMPUTE_PROVIDERS.boat.readOnlyKeyCommand).toBe('boat api-key create arbor --actions sandbox.read,account.read --ttl 365d');
    expect(unescape(html)).toContain(COMPUTE_PROVIDERS.boat.readOnlyKeyCommand);
    // Boat gives CPU and memory only to a key that may run commands, so the key that can read them is offered too.
    expect(LOAD_KEY_COMMANDS.boat).toBe('boat api-key create arbor --actions sandbox.read,account.read,exec --ttl 365d');
    expect(unescape(html)).toContain(LOAD_KEY_COMMANDS.boat ?? 'missing');
    expect(words).toContain('Arbor never runs any');
    // What linking is for is said from the start; its commands wait for a provider that lists sandboxes.
    expect(words).toContain('Tell Arbor when an agent creates one');
    expect(words).toContain('A linked sandbox shows the machine and session that started it');
    expect(unescape(html)).not.toContain(linkCommand('boat'));
    expect(unescape(html)).not.toContain(LINK_LABELS);
    expect(html).toContain('data-setting-id="compute.linking"');
    // Nothing that needs a connected provider, and no provider that isn't built.
    expect(words).not.toContain('Disconnect');
    expect(words).not.toContain('Linked now');
    for (const unbuilt of ['Fly', 'E2B', 'Daytona']) expect(words).not.toContain(unbuilt);
  });

  it('spells the link commands as `arbor commands` lists them, the same as the CLI’s skill and the docs', () => {
    expect(linkCommand('boat')).toBe('arbor call link-compute-sandbox provider=boat sandboxId=<sandbox id> machine=<machine name> session=<session id>');
    expect(unlinkCommand('boat')).toBe('arbor call unlink-compute-sandbox provider=boat sandboxId=<sandbox id>');
    const skill = readFileSync(new URL('../src-tauri/src/cli/skill.md', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('../docs/internals/compute.md', import.meta.url), 'utf8');
    for (const source of [skill, docs]) {
      expect(source).toContain('arbor call link-compute-sandbox provider=');
      expect(source).toContain('arbor call unlink-compute-sandbox provider=');
      expect(source).not.toMatch(/(un)?link_compute_sandbox/);
      expect(source).not.toContain('sandbox-id=');
    }
    expect(skill).toContain(linkCommand('boat'));
    expect(skill).toContain(unlinkCommand('boat'));
  });

  it('shows each command in a code block that scrolls rather than break a word or an =', () => {
    const html = unescape(show('typical'));
    expect(html).toMatch(/<pre class="[^"]*overflow-x-auto[^"]*">arbor call link-compute-sandbox /);
    expect(html).toContain(LINK_LABELS);
    expect(html).toContain(unlinkCommand('boat'));
    expect(html).not.toContain('break-all');
  });

  it('is found by a provider’s name, which comes from its record rather than a string', () => {
    const index = indexSettings((key, variables) => translate(key, variables));
    expect(searchSettings(index, 'boat').flatMap((group) => group.settings.map((setting) => setting.entry.id))).toContain('compute.providers');
  });

  it('shows a connected provider: read, the saved key, Check now, Disconnect and what’s linked', () => {
    const html = show('typical');
    const words = text(html);
    expect(words).toContain('Connected · read just now');
    // Boat says neither what a key can do nor when it expires, so nothing is claimed about either.
    expect(words).not.toContain('Read-only key');
    expect(words).not.toContain('Expires');
    expect(words).toContain('Replace');
    expect(words).toContain('Checks once a minute');
    expect(words).toContain('Check now');
    expect(words).toContain('Forgets the key and hides Compute. Nothing changes at Boat.');
    expect(words).not.toContain('can also change things');
    // Five of the six running are linked to a machine; cam-mbp-docs isn't.
    expect(words).toContain('5 sandboxes running now are linked to a machine.');
    expect(html).not.toContain('type="password"');
    for (const id of ['compute.key', 'compute.check', 'compute.disconnect']) expect(html).toContain(`data-setting-id="${id}"`);
  });

  it('names the key that can read CPU and memory only while the saved one can’t', () => {
    const command = LOAD_KEY_COMMANDS.boat ?? 'missing';
    expect(unescape(show('typical'))).not.toContain(command);
    const html = show('noload');
    expect(text(html)).toContain('The saved key can’t read CPU and memory.');
    expect(unescape(html)).toContain(command);
    // A stopped sandbox has no load to read, and a running one with no sample is not the key's doing: neither asks
    // for another key.
    expect(loadHeldBack(present(computeScenarioSnapshot('empty', Date.now()).providers[0]))).toBe(false);
    const big = present(computeScenarioSnapshot('big', Date.now()).providers[0]);
    expect(big.sandboxes.some((sandbox) => sandbox.state === 'running' && sandbox.load.kind === 'unavailable')).toBe(true);
    expect(loadHeldBack(big)).toBe(false);
  });

  it('says a refused key and opens the field for a new one', () => {
    const words = text(show('refused'));
    // Not "Connected": the key is what's wrong. The button says what the banner and the alert say, and a check that
    // could only be turned down again isn't offered.
    expect(words).toMatch(/Key refused · last read \d+m ago/);
    expect(words).not.toContain('Connected');
    expect(words).toContain('Boat turned down the saved key. Paste a new one to replace it.');
    expect(words).toContain('Replace');
    expect(words).toContain('Paste a new key first');
    expect(show('refused')).toContain('type="password"');
    expect(show('refused')).toContain('data-setting-id="compute.key"');
    // The field can't be put away until a new key is in.
    expect(words).not.toContain('Cancel');
  });

  it('where a provider says what the key can do: a read-only key with its expiry, and a quiet warning for one that can write', () => {
    const readOnly = text(show('readonlykey'));
    expect(readOnly).toContain('Read-only key');
    expect(readOnly).toContain('Expires');
    expect(readOnly).not.toContain('can also change things');

    const writes = text(show('writekey'));
    expect(writes).toContain('This key can also change things at Boat. Arbor only reads.');
    expect(writes).not.toContain('Read-only key');
  });

  it('says when the provider isn’t answering, and when it asked Arbor to slow down', () => {
    expect(text(show('unreachable'))).toContain('Connected · not answering');
    const slowed = text(show('trouble'));
    expect(slowed).toContain('Connected · asked to slow down');
    expect(slowed).not.toContain('not answering');
  });

  it('counts only the user’s own running sandboxes that are linked', () => {
    const now = Date.now();
    expect(linkedCount(null)).toBeNull();
    expect(linkedCount({ providers: [] })).toBeNull();
    expect(linkedCount(computeScenarioSnapshot('unlinked', now))).toBe(0);
    expect(linkedCount(computeScenarioSnapshot('empty', now))).toBe(0);
  });

  it('indexes the connected rows for search, landing on Providers until they show', () => {
    for (const id of ['compute.key', 'compute.check', 'compute.disconnect']) {
      expect(SETTINGS_INDEX.find((entry) => entry.id === id)?.fallback).toBe('compute.providers');
    }
  });
});

describe('the pasted key (SECRET)', () => {
  const KEY = 'boat_SECRET_made_up_5f2c9a';

  /** A window and storage to watch, with every console line kept. */
  function watch() {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    };
    const win: Record<string, unknown> = {
      crypto: globalThis.crypto,
      location: { search: '' },
      localStorage: storage,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    Object.defineProperty(globalThis, 'window', { value: win, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true });
    const logged: unknown[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) console[name] = (...args: unknown[]) => void logged.push(args);
    const restore = () => methods.forEach((name, index) => {
      const original = originals[index];
      if (original) console[name] = original;
    });
    return { stored, win, logged, restore };
  }

  it('goes to the app once and nowhere else: not storage, the saved store, the snapshot, a log or the field', async () => {
    const { stored, win, logged, restore } = watch();
    try {
      // A connect that answers as the app does. Not the browser mock's own module: its scenario is read from the window
      // once, when it first loads, and bun shares loaded modules across test files, so loading it here under this
      // made-up window would leave every later file's mock (machineHostKey's `?health=newhost`) on this one's.
      const calls = mockCommands({
        connect_compute_provider: () => computeScenarioSnapshot('typical', Date.now()),
        saved_store_set: () => null,
      }, { events: true });
      const field = { value: `  ${KEY}  ` };

      expect(await submitComputeKey('boat', field)).toEqual({ ok: true });
      expect(field.value).toBe('');
      // The page switches to the connected card through the hint and the snapshot.
      expect(JSON.parse(stored.get(COMPUTE_HINT_KEY) ?? '[]')).toEqual(['boat']);
      expect(currentCompute().snapshot?.providers.map((provider) => provider.id)).toEqual(['boat']);

      const withKey = calls.filter((call) => JSON.stringify(call.args).includes(KEY));
      expect(withKey.map((call) => call.command)).toEqual(['connect_compute_provider']);
      expect([...stored.values()].join('\n')).not.toContain(KEY);
      expect(JSON.stringify(currentCompute())).not.toContain(KEY);
      expect(JSON.stringify(logged)).not.toContain(KEY);
      expect(JSON.stringify(win.__mockLog ?? [])).not.toContain(KEY);
      expect(render()).not.toContain(KEY);
    } finally {
      restore();
    }
  });

  it('is cleared from the field when it’s turned down, and the failure says the kind, not the key', async () => {
    const { logged, restore } = watch();
    try {
      for (const kind of ['refused', 'unreachable', 'failed'] as const) {
        mockCommands({ connect_compute_provider: () => { const failure: CommandError = { kind, message: 'No.' }; throw failure; } });
        const field = { value: KEY };
        const outcome = await submitComputeKey('boat', field);
        expect(outcome).toEqual({ ok: false, kind, message: 'No.' });
        expect(field.value).toBe('');
        expect(JSON.stringify(currentCompute())).not.toContain(KEY);
      }
      expect(JSON.stringify(logged)).not.toContain(KEY);
    } finally {
      restore();
    }
  });
});
