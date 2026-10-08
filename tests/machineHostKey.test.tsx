import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectMachineButton, HostKeyStep } from '../src/components/MachineHostKey';
import { I18nProvider, translate } from '../src/i18n';
import type { MachineCommands } from '../src/native/machines';
import type { CommandAnswers } from '../src/dev/mock/answers';
import { needsHostKey } from '../src/services/machineAlerts';
import { present } from './support/items';

const FINGERPRINT = 'ED25519 SHA256:bW9ja2VkLWtleS1mb3ItY2ktMDEtbm90LXJlYWwtYXQtYWxs';
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe('trusting a machine’s host key, shown', () => {
  it('shows the fingerprints in mono and how to see the machine’s own to compare', () => {
    const html = render(<HostKeyStep machine="ci-01" step={{ kind: 'found', scan: { fingerprints: [FINGERPRINT], alreadyTrusted: false } }} />);
    expect(html).toContain(`font-mono text-xs text-foreground">${FINGERPRINT}</li>`);
    expect(html).toContain(translate('machines.hostKey.compare', { machine: 'ci-01' }));
    expect(html).toContain('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
  });

  it('says it’s reading, or why it couldn’t, beside the dialog’s buttons', () => {
    expect(render(<HostKeyStep machine="ci-01" step={{ kind: 'reading' }} />)).toContain(translate('machines.hostKey.reading'));
    const failed = render(<HostKeyStep machine="ci-01" step={{ kind: 'failed', error: 'ci-01 didn’t answer over SSH.' }} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('ci-01 didn’t answer over SSH.');
  });

  it('starts as a Connect button with the dialog closed', () => {
    const html = render(<ConnectMachineButton machine="ci-01" />);
    expect(html).toContain(`${translate('machines.hostKey.connect')}</button>`);
    expect(html).not.toContain(translate('machines.hostKey.title', { machine: 'ci-01' }));
  });
});

describe('the mock’s ?health=newhost', () => {
  const globals = globalThis as { window?: unknown };
  const before = globals.window;
  let answers: CommandAnswers<MachineCommands>;

  beforeAll(async () => {
    // As much of a browser window as the mock reads while it loads; nothing it saves is kept.
    const stored = new Map<string, string>();
    const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) };
    globals.window = {
      location: { search: '?health=newhost' },
      localStorage,
      setTimeout: (run: () => void) => setTimeout(run, 0),
      addEventListener: () => {},
      // The event Trust key sends when the machine has been checked again goes nowhere here.
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve() },
    };
    answers = (await import('../src/dev/mock/machines')).machinesAnswers;
  });
  afterAll(() => {
    globals.window = before;
  });

  const ci01 = async () => {
    const snapshot = await answers.get_machine_health({ windowMs: 60_000 });
    return present(snapshot.machines.find((machine) => machine.machine === 'ci-01'));
  };

  it('has ci-01 waiting for its host key until the fingerprints shown are trusted', async () => {
    expect(needsHostKey(await ci01())).toBe(true);
    const scan = await answers.scan_machine_host_key({ machine: 'ci-01' });
    expect(scan).toEqual({ fingerprints: [FINGERPRINT], alreadyTrusted: false });
    await expect(answers.trust_machine_host_key({ machine: 'ci-01', fingerprints: ['ED25519 SHA256:c29tZXRoaW5nZWxzZQ'] })).rejects.toMatchObject({ kind: 'changed' });
    await answers.trust_machine_host_key({ machine: 'ci-01', fingerprints: scan.fingerprints });
    const after = await ci01();
    expect(after.status).not.toBe('unreachable');
    expect(needsHostKey(after)).toBe(false);
    expect(await answers.scan_machine_host_key({ machine: 'ci-01' })).toEqual({ fingerprints: [], alreadyTrusted: true });
  });
});
