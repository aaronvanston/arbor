import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { RolloutRow } from '../src/pages/AgentRollout';
import { agentRollout } from '../src/services/agentRollout';
import type { ClientHour, MachineHealth } from '../src/native/types';

const HOUR = 3_600_000;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % HOUR);

const machine = (name: string, version: string | null): MachineHealth =>
  ({
    machine: name,
    status: 'healthy',
    latest: { claudeRunning: 0, codexRunning: 0 },
    agents: { claude: { version, path: '/Users/a/.local/bin/claude' }, codex: null, checkedAt: T0, error: null, updating: [], reporter: null },
  }) as unknown as MachineHealth;
const hour = (name: string, version: string, requests: number, failed = 0): ClientHour => ({
  machine: name, userAgent: `claude-cli/${version} (external, cli)`, hourMs: T0, requests, failed, rateLimited: 0,
});

const render = (machines: MachineHealth[], hours: ClientHour[], latest: string | null = null) => {
  const rollout = agentRollout('claude', machines, { hours, truncated: false }, latest);
  if (!rollout) throw new Error('no rollout');
  return renderToStaticMarkup(
    <I18nProvider>
      <RolloutRow rollout={rollout} run={undefined} chosen={null} onChoose={() => {}} onTry={() => {}} onUpdateRest={() => {}} />
    </I18nProvider>,
  );
};

describe('RolloutRow', () => {
  it('holds a version that fails more, and offers the command that puts the old one back', () => {
    const html = render([machine('mbp', '2.1.283'), machine('cedar', '2.1.282')], [hour('mbp', '2.1.283', 200, 20), hour('cedar', '2.1.282', 600, 3)]);
    expect(html).toContain('Fails more');
    expect(html).toContain('2.1.283 fails more often');
    expect(html).toContain('claude install 2.1.282');
    expect(html).toContain('Update the rest (1)');
  });

  it('offers to try the latest on one machine while the fleet runs one version', () => {
    const html = render([machine('mbp', '2.1.282'), machine('cedar', '2.1.282')], [hour('mbp', '2.1.282', 50)]);
    expect(html).toContain('2.1.282 on all 2 machines');
    expect(html).toContain('Try the latest here');
    expect(html).not.toContain('claude install');
  });

  it('says when a newer release is out, and offers nothing to try once the fleet has the latest', () => {
    const fleet = [machine('mbp', '2.1.282'), machine('cedar', '2.1.282')];
    const out = render(fleet, [], '2.1.283');
    expect(out).toContain('2.1.282 on all 2 machines · 2.1.283 is out');
    expect(out).toContain('Try the latest here');
    const current = render(fleet, [], '2.1.282');
    expect(current).toContain('2.1.282 on all 2 machines · the latest release');
    expect(current).not.toContain('Try the latest here');
    // Mid-rollout, the rest are still offered whatever npm says.
    expect(render([machine('mbp', '2.1.283'), machine('cedar', '2.1.282')], [], '2.1.283')).toContain('Update the rest (1)');
  });

  it('offers nothing while no machine’s version is known', () => {
    const html = render([machine('mbp', null), machine('cedar', null)], []);
    expect(html).toContain('Version unknown');
    expect(html).not.toContain('Try the latest here');
    expect(html).not.toContain('Update the rest');
  });
});
