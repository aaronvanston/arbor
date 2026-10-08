import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, translate } from '../src/i18n';
import { toolUpdateProblem } from '../src/services/fixPrompt';
import {
  changesByMachine,
  newerOn,
  removesNatively,
  resultsByTool,
  toolUpdates,
  trialMachine,
  updatesByTool,
  updateVerdict,
} from '../src/services/toolUpdates';
import { ToolUpdatesCard } from '../src/pages/SetupToolUpdates';
import { itemAt } from './support/items';
import type { MachineToolchain, OwnerKind, ToolFound, ToolOwner } from '../src/native/types';

const NOW = Date.parse('2026-10-08T12:00:00Z');

const own = (kind: OwnerKind, name: string | null = null, prefix: string | null = null): ToolOwner => ({ kind, name, prefix });
const tool = (name: string, version: string | null, owner: ToolOwner | null): ToolFound => ({ tool: name, path: `/opt/homebrew/bin/${name}`, version, owner });
const machine = (name: string, tools: ToolFound[], latest: Record<string, string> | null, fields: Partial<MachineToolchain> = {}): MachineToolchain => ({
  machine: name, homeDir: '/Users/cam', os: 'Darwin', arch: 'arm64', scannedAt: NOW, partial: false, scanning: false, error: null, tools, kept: [], projects: [],
  checking: false, checkError: null,
  updates: latest ? { checkedAt: NOW, latest: Object.entries(latest).map(([entry, version]) => ({ tool: entry, version })), problems: [] } : null,
  ...fields,
});

describe('tool updates', () => {
  const mac = machine('cam-mbp', [
    tool('node', '22.17.0', own('nvm')),
    tool('uv', '0.8.3', own('brew', 'uv')),
    tool('rust', '1.88.0', own('rustup')),
    tool('cargo', '1.88.0', own('rustup')),
    tool('gh', '2.74.0', own('brew', 'gh')),
    tool('jq', '1.7.1', own('system', 'system')),
    tool('go', '1.24.0', null),
  ], { node: '22.18.0', uv: '0.9.1', rust: '1.89.0', cargo: '1.89.0', gh: '2.74.0', jq: '1.8.0', go: '1.25.0' });
  const box = machine('cedar-02', [tool('uv', '0.7.20', own('uv')), tool('git', '2.43.0', own('system', 'apt-get'))], { uv: '0.9.1' });

  it('lists what each installer has newer, by tool then machine, with cargo going with rust', () => {
    const updates = toolUpdates([mac, box]);
    expect(updates.map((update) => `${update.tool}@${update.machine}`)).toEqual(['node@cam-mbp', 'uv@cam-mbp', 'uv@cedar-02', 'rust@cam-mbp', 'jq@cam-mbp']);
    // A Node version manager is told the version to move to; the rest go to the newest their installer has.
    expect(itemAt(updates, 0).change).toEqual({ tool: 'node', action: 'update', version: '22.18.0', via: null });
    expect(itemAt(updates, 1).change).toEqual({ tool: 'uv', action: 'update', version: null, via: null });
    // The system's packages need sudo, so they're an agent's; a tool nothing proves isn't listed at all.
    expect(itemAt(updates, 4).native).toBe(false);
    expect(updates.some((update) => update.tool === 'go')).toBe(false);
    expect(toolUpdates([machine('x', [tool('uv', '0.8.3', own('brew', 'uv'))], null)])).toEqual([]);
    expect(newerOn(mac, 'uv')).toBe('0.9.1');
    expect(newerOn(mac, 'gh')).toBeNull();
  });

  it('checks an update against the next scan, and says when it did not take', () => {
    const [node] = toolUpdates([mac]);
    if (!node) throw new Error('node');
    expect(updateVerdict(node, machine('cam-mbp', [tool('node', '22.18.0', own('nvm'))], null))).toEqual({ kind: 'updated', version: '22.18.0' });
    expect(updateVerdict(node, machine('cam-mbp', [tool('node', '22.17.0', own('nvm'))], null))).toEqual({ kind: 'stillBehind', version: '22.17.0' });
    expect(updateVerdict(node, machine('cam-mbp', [], null))).toEqual({ kind: 'stillBehind', version: null });
  });

  it('tries a tool going to several machines on the one with most of them first', () => {
    const updates = toolUpdates([mac, box]);
    expect(trialMachine(updates)).toBe('cam-mbp');
    expect(trialMachine(updates.filter((update) => update.tool !== 'uv'))).toBeNull();
    expect([...changesByMachine(updates).keys()]).toEqual(['cam-mbp', 'cedar-02']);
  });

  it('names each tool once in a batch, with every machine it goes to', () => {
    const uv = updatesByTool(toolUpdates([mac, box])).find((group) => group.tool === 'uv');
    expect(uv).toEqual({ tool: 'uv', machines: ['cam-mbp', 'cedar-02'], haves: ['0.8.3', '0.7.20'], latests: ['0.9.1'] });
  });

  it('counts a change the run never answered for as a failure', () => {
    const results = resultsByTool([{ tool: 'uv', action: 'update', version: null, via: null }, { tool: 'gh', action: 'update', version: null, via: null }], [{ tool: 'uv', action: 'update', ok: true, message: null }]);
    expect(results.get('uv')?.ok).toBe(true);
    expect(results.get('gh')?.ok).toBe(false);
  });

  it('takes a tool off itself only with an installer that can, and never npm from its Node', () => {
    expect(removesNatively(tool('uv', '0.8.3', own('brew', 'uv')))).toBe(true);
    expect(removesNatively(tool('npm', '10.9.2', own('npm', 'npm', '/n')))).toBe(false);
    expect(removesNatively(tool('bun', '1.3.2', own('bun')))).toBe(false);
    expect(removesNatively(tool('git', '2.43.0', own('system', 'apt-get')))).toBe(false);
    expect(removesNatively(tool('jq', '1.7.1', null))).toBe(false);
  });

  it('hands an update that failed to an agent with what the installer said', () => {
    const problem = toolUpdateProblem({ tool: 'uv', version: '0.8.3', latest: '0.9.1', installer: 'Homebrew', path: '/opt/homebrew/bin/uv', output: 'Error: no bottle' }, translate);
    expect(problem.text).toBe('uv 0.8.3 here is older than 0.9.1, the newest Homebrew has.');
    expect(problem.goal).toContain('with Homebrew');
    expect(problem.details).toEqual(['Path: /opt/homebrew/bin/uv', 'Output:\nError: no bottle']);
  });

  it('shows each update with its installer, and the system’s as needing sudo', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ToolUpdatesCard toolchains={[mac, box]} reachable={new Set(['cam-mbp', 'cedar-02'])} toolName={(name) => name} />
      </I18nProvider>,
    );
    expect(html).toContain('5 updates');
    expect(html).toContain('Update all 4');
    expect(html).toContain('System packages (system)');
    expect(html).toContain('Needs sudo');
    expect(html).toContain('uv self update');
    const none = renderToStaticMarkup(
      <I18nProvider>
        <ToolUpdatesCard toolchains={[machine('cam-mbp', [tool('uv', '0.9.1', own('brew', 'uv'))], { uv: '0.9.1' })]} reachable={new Set()} toolName={(name) => name} />
      </I18nProvider>,
    );
    expect(none).toContain('Every tool is the newest its installer has.');
  });
});

describe('pinning a tool in the repo', () => {
  it('pins a fast-moving major alone, and a slow one with its minor', async () => {
    const { pinLine } = await import('../src/pages/SetupToolchain');
    expect(['22.17.0', '10.12.1', '1.24.4', '3.12.4', '0.8.3', '2.50.1'].map(pinLine)).toEqual(['22', '10', '1.24', '3.12', '0.8', '2.50']);
  });
});
