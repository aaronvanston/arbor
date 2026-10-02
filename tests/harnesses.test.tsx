import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineHarnessesBlock } from '../src/components/MachineHarnesses';
import { I18nProvider } from '../src/i18n';
import type { AgentInstall, MachineAgents } from '../src/native/types';
import { harnessReady, machineHarnesses } from '../src/services/harnesses';
import { lastItem } from './support/items';

const install = (path: string): AgentInstall => ({ version: '1.0.0', path, real: null, method: 'native', updateCommand: `${path} update`, copies: [] });
const agents = (fields: Partial<MachineAgents> = {}): MachineAgents => ({
  claude: null, codex: null, checkedAt: 1, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null, ...fields,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const shown = (machine: MachineAgents) => text(renderToStaticMarkup(<I18nProvider><MachineHarnessesBlock harnesses={machineHarnesses(machine)} /></I18nProvider>));

describe('a machine’s harnesses', () => {
  const t3 = {
    version: '0.0.42', running: false,
    setups: [
      { id: 'codex_work', driver: 'codex', name: 'Codex · Work', enabled: true },
      { id: 'claudeAgent', driver: 'claudeAgent', name: null, enabled: true },
      { id: 'cursor', driver: 'cursor', name: null, enabled: false },
    ],
  };

  it('lists running harnesses first and the command line last, only for agents installed', () => {
    const found = machineHarnesses(agents({ claude: install('/x/claude'), t3, orca: { version: null, running: true, agents: ['claude'] } }));
    expect(found.map((harness) => harness.kind)).toEqual(['orca', 't3', 'headless']);
    expect(lastItem(found).setups.map((setup) => setup.id)).toEqual(['claude']);
    expect(harnessReady(found)).toBe(true);
    expect(machineHarnesses(agents())).toEqual([]);
  });

  it('names each setup by its own name or its agent, and says when nothing could follow a run', () => {
    const page = shown(agents({ codex: install('/x/codex'), t3 }));
    expect(page).toContain('T3 Code Installed, not running · 0.0.42');
    expect(page).toContain('Codex · Work Claude Cursor');
    expect(page).toContain('where you can’t follow it');
    expect(shown(agents())).toBe('No harness or agent found here yet.');
    expect(shown(agents({ orca: { version: null, running: false, agents: [] } }))).toContain('wouldn’t start');
  });
});
