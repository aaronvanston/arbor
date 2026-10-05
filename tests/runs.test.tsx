import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PoolRunsBlock } from '../src/components/PoolRuns';
import { I18nProvider } from '../src/i18n';
import type { HarnessRun, MachineAgents, MachineHealth, MachinePool } from '../src/native/types';
import { canOpenRun, newRunRequest, poolRuns, reasonMessage, runCommands, runDraftProblem, runSetupChoices } from '../src/services/runs';
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

  it('says how an agent on the command line stopped, by its exit code', () => {
    const failed = (detail: string | null) => reasonMessage(run({ state: 'failed', reason: 'agentFailed', used: 'headless', detail }));
    expect(failed(null)?.key).toBe('runs.reason.agentFailed');
    expect(failed('1')).toEqual({ key: 'runs.exit.code', values: { code: '1' }, harness: 'headless' });
    expect(failed('127')?.key).toBe('runs.exit.notFound');
    expect(failed('137')).toEqual({ key: 'runs.exit.killed', values: { code: '137' }, harness: 'headless' });
    expect(failed('gone')?.key).toBe('runs.exit.gone');
  });

  it('gives commands to read a command-line run’s log and pick up its session on its machine', () => {
    const host = (endpoint: string, port = 22, local = false) => ({ machine: 'Cedar 02', host: { endpoint, port }, local }) as unknown as MachineHealth;
    const headless = run({ machine: 'cedar-02', used: 'headless', harness: 'headless', setup: 'claude', folder: '~/src/it’s here', handle: { pid: 1, log: '~/.arbor/runs/r1.log', sessionId: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7' } });
    expect(runCommands(headless, [host('casey@cedar-02.local')])).toEqual({
      log: "ssh casey@cedar-02.local 'cat ~/.arbor/runs/r1.log'",
      resume: "ssh -t casey@cedar-02.local 'cd ~/'\\''src/it’s here'\\'' && claude --resume a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7'",
    });
    // This Mac needs no ssh, and a home folder stays bare so the shell expands it.
    expect(runCommands({ ...headless, folder: '~' }, [host('localhost', 22, true)])).toEqual({
      log: 'cat ~/.arbor/runs/r1.log',
      resume: 'cd ~ && claude --resume a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7',
    });
    expect(runCommands(headless, [host('cedar-02', 2222)]).log).toBe("ssh -p 2222 cedar-02 'cat ~/.arbor/runs/r1.log'");
    // Codex has no session id to resume by, a run from before logs has no log, and an unlisted machine has no way in.
    expect(runCommands({ ...headless, setup: 'codex', handle: { pid: 1, log: '~/.arbor/runs/r1.log' } }, [host('cedar-02')]).resume).toBeNull();
    expect(runCommands({ ...headless, handle: { pid: 1 } }, [host('cedar-02')]).log).toBeNull();
    expect(runCommands(headless, [])).toEqual({ log: null, resume: null });
    expect(runCommands({ ...headless, used: 't3' }, [host('cedar-02')])).toEqual({ log: null, resume: null });
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
            run({ id: 'q', state: 'queued', machine: null, used: null, reason: 'noRoom', startedAtMs: null, waitUntilMs: 600_000 }),
            run({ id: 'o', used: 'orca', harness: 'orca', setup: 'claude', handle: { terminal: 'term_1' } }),
            run({ id: 'h', used: 'headless', harness: 'orca', setup: 'claude', state: 'exited' }),
            run({ id: 'f', state: 'failed', reason: 'handOffFailed', detail: 'not_running' }),
            run({ id: 'a', used: 'headless', harness: 'headless', setup: 'claude', state: 'failed', reason: 'agentFailed', detail: '1', handle: { pid: 1, sessionId: 's-1', log: '~/.arbor/runs/a.log' } }),
          ]}
          onNavigate={() => undefined}
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
    expect(itemAt(rows, 4)).toContain('The agent stopped with an error (exit code 1).');
    expect(itemAt(rows, 4)).toContain('Session');
    expect(itemAt(rows, 4)).toContain('Details');
    // A run that never started has nothing more to show.
    expect(itemAt(rows, 0)).not.toContain('Details');
    expect(text(renderToStaticMarkup(<I18nProvider><PoolRunsBlock runs={[]} /></I18nProvider>))).toContain('No runs yet');
  });
});
