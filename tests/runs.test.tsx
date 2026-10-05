import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PoolRunsBlock } from '../src/components/PoolRuns';
import { I18nProvider } from '../src/i18n';
import type { HarnessRun, MachineAgents, MachineHealth, MachinePool } from '../src/native/types';
import { canOpenRun, newRunRequest, poolRuns, reasonMessage, runDraftProblem, runSetupChoices } from '../src/services/runs';
import { itemAt } from './support/items';

const run = (fields: Partial<HarnessRun> = {}): HarnessRun => ({
  id: 'r1', trigger: null, pool: 'builds', ranPool: 'builds', machine: 'casey-mbp', harness: 't3', used: 't3', setup: 'codex_work',
  folder: '~/src/app', title: 'Tidy the tests', state: 'handedOff', reason: null, detail: null, handle: {}, queuedAtMs: 0,
  startedAtMs: 1_000, endedAtMs: null, waitUntilMs: null, ...fields,
});

const agents = (fields: Partial<MachineAgents>): MachineAgents => ({
  claude: null, codex: null, checkedAt: 1, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null, ...fields,
});
// Only what the choices read; the rest of a machine's health doesn't matter here.
const machine = (name: string, found: Partial<MachineAgents>) => ({ machine: name, agents: agents(found) }) as unknown as MachineHealth;

const pool = (members: MachinePool['members']): Pick<MachinePool, 'members'> => ({ members });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('harness runs', () => {
  it('words why a run stopped, with the harness’s failure code made plain', () => {
    expect(reasonMessage(run())).toBeNull();
    expect(reasonMessage(run({ state: 'failed', reason: 'noModel' }))?.key).toBe('runs.reason.noModel');
    expect(reasonMessage(run({ state: 'refused', reason: 'noFolder' }))?.key).toBe('runs.reason.noFolder');
    expect(reasonMessage(run({ state: 'refused', reason: 'noFolder', detail: 'cedar-02, ci-01' }))).toEqual({ key: 'runs.reason.noFolderOn', values: { machines: 'cedar-02, ci-01' }, harness: 't3' });
    expect(reasonMessage(run({ state: 'failed', reason: 'handOffFailed', detail: 'no_cli', used: 'orca' }))).toEqual({ key: 'runs.detail.noCli', values: {}, harness: 'orca' });
    expect(reasonMessage(run({ state: 'failed', reason: 'handOffFailed', detail: 'turn_500' }))).toEqual({ key: 'runs.detail.status', values: { status: '500' }, harness: 't3' });
    expect(reasonMessage(run({ state: 'failed', reason: 'handOffFailed', detail: 'orca_selector_ambiguous' }))?.values).toEqual({ code: 'orca_selector_ambiguous' });
  });

  it('offers the setups members have, ready ones first, leaving out manual-only members', () => {
    const health = [
      machine('casey-mbp', { t3: { version: null, running: true, setups: [{ id: 'codex_work', driver: 'codex', name: 'Codex · Work', enabled: true }, { id: 'cursor', driver: 'cursor', name: null, enabled: false }] } }),
      machine('cedar-02', { t3: { version: null, running: false, setups: [{ id: 'codex_work', driver: 'codex', name: 'Codex · Work', enabled: true }] } }),
      machine('ci-01', { t3: { version: null, running: true, setups: [{ id: 'claudeAgent', driver: 'claudeAgent', name: null, enabled: true }] } }),
    ];
    const choices = runSetupChoices(pool([{ machine: 'casey-mbp', weight: 'prefer' }, { machine: 'Cedar 02', weight: 'normal' }, { machine: 'ci-01', weight: 'manual' }]), health, 't3');
    expect(choices.map((choice) => [choice.id, choice.ready, choice.found])).toEqual([['codex_work', 1, 2], ['cursor', 0, 1]]);
    expect(runSetupChoices(pool([{ machine: 'casey-mbp', weight: 'normal' }]), health, 'orca')).toEqual([]);
    expect(runSetupChoices(pool([]), null, 't3')).toEqual([]);
  });

  it('asks for a setup, a rooted folder and a prompt before a run can start', () => {
    const draft = newRunRequest('builds');
    expect(runDraftProblem(draft)).toBe('runs.problem.setup');
    expect(runDraftProblem({ ...draft, setup: 'codex', folder: 'src/app' })).toBe('runs.problem.folder');
    expect(runDraftProblem({ ...draft, setup: 'codex', folder: '~/src/../..' })).toBe('runs.problem.folder');
    expect(runDraftProblem({ ...draft, setup: 'codex', folder: '~/src/app' })).toBe('runs.problem.prompt');
    expect(runDraftProblem({ ...draft, setup: 'codex', folder: '~', prompt: 'Go' })).toBeNull();
  });

  it('lists a pool’s runs, spilled-in ones too, and opens only Orca’s', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b', pool: 'other', ranPool: 'builds' }), run({ id: 'c', pool: 'other', ranPool: 'other' })];
    expect(poolRuns(runs, 'builds').map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(canOpenRun(run({ used: 'orca', handle: { terminal: 'term_1' } }))).toBe(true);
    expect(canOpenRun(run({ handle: { threadId: 't' } }))).toBe(false);
  });

  it('shows each run’s state, where it went and what can still be done', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PoolRunsBlock
          nowMs={60_000}
          runs={[
            run({ id: 'q', state: 'queued', machine: null, used: null, reason: 'noRoom', waitUntilMs: 600_000 }),
            run({ id: 'o', used: 'orca', harness: 'orca', setup: 'claude', handle: { terminal: 'term_1' } }),
            run({ id: 'h', used: 'headless', harness: 'orca', setup: 'claude', state: 'exited' }),
            run({ id: 'f', state: 'failed', reason: 'handOffFailed', detail: 'not_running' }),
          ]}
        />
      </I18nProvider>,
    );
    const rows = html.split('<li').slice(1).map(text);
    expect(itemAt(rows, 0)).toContain('Waiting');
    expect(itemAt(rows, 0)).toContain('Every member was busy');
    expect(itemAt(rows, 0)).toContain('Cancel');
    expect(itemAt(rows, 1)).toContain('Open in Orca');
    expect(itemAt(rows, 2)).toContain('wasn’t running, so it went to the command line');
    expect(itemAt(rows, 3)).toContain('T3 Code isn’t running on the machine.');
    expect(text(renderToStaticMarkup(<I18nProvider><PoolRunsBlock runs={[]} /></I18nProvider>))).toContain('No runs yet');
  });
});
