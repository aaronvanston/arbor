import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { AgentVersionsSection } from '../src/pages/SetupAgents';
import type { AgentVersionRow } from '../src/services/agentVersions';

const render = (rows: AgentVersionRow[] | null, error: string | null = null) =>
  renderToStaticMarkup(
    <I18nProvider>
      <AgentVersionsSection rows={rows} error={error} onOpen={() => {}} onConfigure={() => {}} />
    </I18nProvider>,
  );

const rows: AgentVersionRow[] = [
  {
    machine: 'casey-mbp',
    status: 'healthy',
    agents: {
      claude: { state: 'installed', version: '2.1.281', newer: { version: '2.1.283', machine: null } },
      codex: { state: 'installed', version: '0.156.0', newer: { version: '0.157.0', machine: 'ci-01' } },
    },
    running: { claude: 3, codex: 2 },
  },
  {
    machine: 'ci-01',
    status: 'unreachable',
    agents: { claude: { state: 'installed', version: null, newer: null }, codex: { state: 'missing' } },
    running: null,
  },
  {
    machine: 'cedar-02',
    status: 'pending',
    agents: { claude: { state: 'unchecked' }, codex: { state: 'unchecked' } },
    running: null,
  },
];

describe('Sync › Agents’ versions by machine', () => {
  it('lists each machine’s agents side by side, with the newer version each is behind', () => {
    const html = render(rows);
    expect(html).toContain('Versions by machine');
    expect(html).toContain('2.1.281');
    expect(html).toContain('2.1.283 is out');
    // The machine that has the newer version is named by its pill.
    expect(html).toMatch(/0\.157\.0 on <span class="machine-pill[^"]*"[^>]*title="ci-01"/);
    expect(html).toContain('Version unknown');
    expect(html).toContain('Not installed');
    expect(html).toContain('Not checked yet');
    // Five running on casey-mbp, counted for each agent in its title.
    expect(html).toContain('>5<');
    expect(html).toContain('Running now: Claude Code 3, Codex 2');
    // Each machine opens on Machines from a button, so the keyboard reaches it.
    expect(html).toContain('aria-label="Open ci-01 on Machines"');
    expect(html).toContain('Unreachable');
  });

  it('says it’s reading before the first read, and why when that read fails', () => {
    expect(render(null)).toContain('Reading each machine’s agents');
    expect(render(null, 'ssh: timed out')).toContain('Couldn’t read the machines’ agents: ssh: timed out');
  });

  it('keeps what it read when a later read fails, saying it may be out of date', () => {
    const html = render(rows, 'ssh: timed out');
    expect(html).toContain('2.1.281');
    expect(html).toContain('These may be out of date');
  });

  it('points to Settings › Machines when no machine has a host', () => {
    const html = render([]);
    expect(html).toContain('No machine has an SSH host yet');
    expect(html).toContain('Add hosts');
  });
});
