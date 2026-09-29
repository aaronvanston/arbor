import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineText } from '../src/components/identity/MachineText';
import { I18nProvider, translate } from '../src/i18n';
import type { AlertRecord } from '../src/services/alertHistory';
import { machineNotifications, sshFailure, type MachineAlert } from '../src/services/machineAlerts';
import { alertMentions, machineMentions, type MachineMention } from '../src/services/machineMentions';
import { setMachineName } from '../src/services/machineNames';
import type { SystemNotification } from '../src/services/notify';
import { itemAt } from './support/items';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);
/** The parts read back, a machine in brackets. */
const read = (parts: MachineMention[]) => parts.map((part) => ('machine' in part ? `[${part.machine}]` : part.text)).join('');
const alert = (fields: Partial<AlertRecord>): AlertRecord => ({ id: 'a', atMs: 0, kind: 'agentWaiting', title: '', body: '', urgent: false, ...fields });
/** An alert as the history keeps one that was sent. */
const sent = ({ kind, title, body, subject }: SystemNotification) => alert({ kind, title, body, subject });

describe('machine mentions', () => {
  it('cuts the words around each machine named, keeping the rest as it was', () => {
    expect(machineMentions('Fix the login redirect loop on casey-mbp', ['casey-mbp'])).toEqual([
      { text: 'Fix the login redirect loop on ' },
      { machine: 'casey-mbp' },
    ]);
    expect(read(machineMentions('casey-mbp, cedar-02 and mac-mini answer again.', ['mac-mini', 'casey-mbp', 'cedar-02'])))
      .toBe('[casey-mbp], [cedar-02] and [mac-mini] answer again.');
    expect(read(machineMentions('ci-01’s alerts reporter', ['ci-01']))).toBe('[ci-01]’s alerts reporter');
  });

  it('only takes whole names, the longest where one holds another', () => {
    expect(read(machineMentions('ci-010 and old-ci-01 are not ci-01.', ['ci-01']))).toBe('ci-010 and old-ci-01 are not [ci-01].');
    expect(read(machineMentions('On mac-mini-2', ['mac-mini', 'mac-mini-2']))).toBe('On [mac-mini-2]');
    expect(read(machineMentions('Casey’s MacBook Pro is back', ['Casey’s MacBook Pro']))).toBe('[Casey’s MacBook Pro] is back');
  });

  it('finds a machine by the name it’s shown by too, and keeps its own name for the pill', () => {
    const shown = (machine: string) => (machine === 'ci-01' ? 'Build box' : machine);
    expect(machineMentions('Build box and ci-01 are one machine', ['ci-01'], shown)).toEqual([
      { machine: 'ci-01' },
      { text: ' and ' },
      { machine: 'ci-01' },
      { text: ' are one machine' },
    ]);
  });

  it('leaves text alone without machines, or with none of them in it', () => {
    expect(machineMentions('Nothing here', [])).toEqual([{ text: 'Nothing here' }]);
    expect(machineMentions('Nothing here', ['ci-01', ' ', ''])).toEqual([{ text: 'Nothing here' }]);
    expect(machineMentions('', ['ci-01'])).toEqual([]);
  });

  it('renders each machine as its pill between the words', () => {
    const html = renderToStaticMarkup(<I18nProvider><MachineText parts={machineMentions('Setup changed on ci-01', ['ci-01'])} /></I18nProvider>);
    expect(html.startsWith('Setup changed on <span')).toBe(true);
    expect(html).toContain('machine-pill');
    expect(html).toContain('>ci-01</span>');
  });
});

describe('alert mentions', () => {
  afterEach(() => setMachineName('ci-01', ''));
  const now = 1_000 * 60_000;
  const machineAlert = (name: string, kind: 'down' | 'up', error: string | null = null): MachineAlert =>
    ({ machine: name, kind, downSinceMs: now - 6 * 60_000, error, failure: kind === 'up' ? null : sshFailure(error) });

  it('goes by the machines its subject names, never by the words', () => {
    const waiting = alertMentions(alert({ title: 'Codex is waiting for you', body: 'Fix the ci-01 deploy on casey-mbp', subject: { session: 's', machine: 'casey-mbp' } }));
    expect(read(waiting.title)).toBe('Codex is waiting for you');
    expect(read(waiting.body)).toBe('Fix the ci-01 deploy on [casey-mbp]');
    // No subject, so nothing is a machine, however much it reads like one.
    expect(read(alertMentions(alert({ title: 'Heavy session on ci-01' })).title)).toBe('Heavy session on ci-01');
  });

  it('names a down machine in its title but leaves ssh’s error in its body as ssh wrote it', () => {
    const down = itemAt(machineNotifications([machineAlert('ci-01', 'down', 'ssh: connect to host ci-01 port 22: Connection refused')], now, t), 0);
    const mentions = alertMentions(sent(down));
    expect(read(mentions.title)).toBe('[ci-01] is down');
    expect(read(mentions.body)).toBe('It refused the SSH connection. Checks have failed for 6m. ssh: connect to host ci-01 port 22: Connection refused');
  });

  it('names each of several machines in the body that lists them', () => {
    const alerts = machineNotifications([
      machineAlert('ci-02', 'down', 'ci@ci-02: Permission denied (publickey).'),
      machineAlert('ci-03', 'down', 'Host key verification failed.'),
      machineAlert('lab-box', 'up'),
      machineAlert('mac-mini', 'up'),
    ], now, t);
    expect(read(alertMentions(sent(itemAt(alerts, 0))).body)).toBe('[ci-02] and [ci-03] can’t be checked over SSH until they’re fixed. The Machines page says why.');
    expect(read(alertMentions(sent(itemAt(alerts, 1))).body)).toBe('[lab-box] and [mac-mini] answer their health checks again.');
  });

  it('finds a machine renamed in Arbor by that name, as its alerts say it', () => {
    setMachineName('ci-01', 'Build box');
    const down = itemAt(machineNotifications([machineAlert('ci-01', 'down', 'ssh: connect to host ci-01 port 22: Connection refused')], now, t), 0);
    expect(down.title).toBe('Build box is down');
    expect(alertMentions(sent(down)).title).toEqual([{ machine: 'ci-01' }, { text: ' is down' }]);
  });

  it('reads a stored subject that isn’t what it should be as naming nothing', () => {
    const odd = alert({ title: 'ci-01 is back', subject: { machines: 'ci-01' as unknown as string[], machine: 7 as unknown as string } });
    expect(read(alertMentions(odd).title)).toBe('ci-01 is back');
  });
});
