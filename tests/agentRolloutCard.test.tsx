import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { RolloutCard, type AgentMachineRow } from '../src/pages/AgentRollout';
import { HarnessCard } from '../src/pages/SetupHarnessHomes';
import { agentRollout } from '../src/services/agentRollout';
import { harnessGroups } from '../src/services/agentFleet';
import type { HarnessHomeRow } from '../src/services/harnessHomes';
import type { ClientHour, MachineHealth } from '../src/native/types';

const HOUR = 3_600_000;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % HOUR);

const machine = (name: string, version: string | null): MachineHealth =>
  ({
    machine: name,
    status: 'healthy',
    latest: { claudeRunning: 0, codexRunning: 0 },
    agents: { claude: { version, path: '/Users/a/.local/bin/claude', updateCommand: 'claude update' }, codex: null, checkedAt: T0, error: null, updating: [], reporter: null },
  }) as unknown as MachineHealth;
const hour = (name: string, version: string, requests: number, failed = 0): ClientHour => ({
  machine: name, userAgent: `claude-cli/${version} (external, cli)`, hourMs: T0, requests, failed, rateLimited: 0,
});
const row = (name: string, version: string | null, state: AgentMachineRow['state']): AgentMachineRow => ({ machine: name, version, state, running: 0 });

const render = (machines: MachineHealth[], hours: ClientHour[], latest: string | null = null, rows: AgentMachineRow[] = []) => {
  const rollout = agentRollout('claude', machines, { hours, truncated: false }, latest);
  if (!rollout) throw new Error('no rollout');
  return renderToStaticMarkup(
    <I18nProvider>
      <RolloutCard rollout={rollout} machines={rows} run={undefined} onUpdateAll={() => {}} onTry={() => {}} onOpen={() => {}} />
    </I18nProvider>,
  );
};

describe('Claude Code’s card on Sync › Agents', () => {
  it('holds a version that fails more, and offers the command that puts the old one back', () => {
    const html = render([machine('mbp', '2.1.283'), machine('cedar', '2.1.282')], [hour('mbp', '2.1.283', 200, 20), hour('cedar', '2.1.282', 600, 3)]);
    expect(html).toContain('Fails more');
    expect(html).toContain('2.1.283 fails more often');
    expect(html).toContain('claude install 2.1.282');
    expect(html).toContain('Update all to 2.1.283 (1)');
  });

  it('brings every machine up to a newer release at once, with trying it on one first beside it', () => {
    const fleet = [machine('mbp', '2.1.282'), machine('cedar', '2.1.282')];
    const html = render(fleet, [], '2.1.283');
    expect(html).toContain('2.1.283 is out');
    expect(html).toContain('2.1.282 on all 2 machines');
    expect(html).toContain('Update all to 2.1.283 (2)');
    expect(html).toContain('aria-label="Try 2.1.283 on one machine first"');
  });

  it('offers nothing to do once the fleet has the latest release', () => {
    const html = render([machine('mbp', '2.1.282'), machine('cedar', '2.1.282')], [], '2.1.282');
    expect(html).toContain('Up to date');
    expect(html).not.toContain('Update all');
    expect(html).not.toContain('one machine first');
  });

  it('shows how far a trial is toward enough requests, and each machine under the card', () => {
    const html = render(
      [machine('mbp', '2.1.283'), machine('cedar', '2.1.282')],
      [hour('mbp', '2.1.283', 40), hour('cedar', '2.1.282', 600, 3)],
      null,
      [row('mbp', '2.1.283', 'trying'), row('cedar', '2.1.282', 'behind'), row('lab', null, 'missing')],
    );
    expect(html).toContain('Waiting for requests');
    expect(html).toContain('Trying 2.1.283 on 1 of 2 machines');
    expect(html).toContain('40 of 100');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Behind');
    expect(html).toContain('Not installed');
    expect(html).toContain('Version history');
  });

  it('offers nothing while no machine’s version is known', () => {
    const html = render([machine('mbp', null), machine('cedar', null)], []);
    expect(html).toContain('Version unknown');
    expect(html).not.toContain('Update all');
  });
});

const home = (name: string, version: string | null, path = '~/.pi/agent'): HarnessHomeRow => ({
  machine: name, harness: 'pi', path, instructions: null, state: 'missing', skills: 0, installed: true, version, updateCommand: 'pi update',
});

describe('another agent’s card on Sync › Agents', () => {
  const renderGroup = (rows: HarnessHomeRow[]) => {
    const [group] = harnessGroups(rows);
    if (!group) throw new Error('no group');
    return renderToStaticMarkup(
      <I18nProvider>
        <HarnessCard group={group} run={undefined} onUpdateAll={() => {}} onUpdate={() => {}} onOpen={() => {}} />
      </I18nProvider>,
    );
  };

  it('lists every machine’s home under one card, marking the ones behind the newest', () => {
    const html = renderGroup([home('cam-mbp', '0.70.2'), home('ci-01', '0.68.0')]);
    expect(html.match(/data-slot="agent-card"/g)?.length).toBe(1);
    expect(html).toContain('1 behind');
    expect(html).toContain('Newest is 0.70.2');
    // The button brings up what's behind, so its count agrees with the badge's.
    expect(html).toContain('Update the one behind');
    expect(html).not.toContain('Update all');
    expect(html).toContain('aria-label="Update Pi on ci-01"');
    expect(renderGroup([home('cam-mbp', '0.70.2'), home('ci-01', '0.70.2')])).toContain('Update all (2)');
  });

  it('leaves a lone machine’s update to its own row', () => {
    const html = renderGroup([home('cam-mbp', '0.70.2')]);
    expect(html).toContain('0.70.2 on 1 machine');
    expect(html).not.toContain('Update all');
    expect(html).toContain('aria-label="Update Pi on cam-mbp"');
  });
});
