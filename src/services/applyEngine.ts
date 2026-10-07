import type { CodexPluginChange, McpChange, PluginChange, SetupRepo, SyncChange } from '../native/types';
import { applyHooks } from './setupHooks';
import { applyMcpChanges } from './setupMcp';
import { applyCodexPluginChanges, applyPluginChanges } from './setupPlugins';
import { applySetupSync } from './setupSync';
import { runSkillPlan, type SkillPlan, type SkillRunProgress } from './skillRuns';
import { reloadSyncStanding } from './syncStanding';

/**
 * The one way the window changes a machine to match the setup repo. Every path that does (Bring in line on Overview
 * and in the Repo review, the Library's switches, the Per home grids' buttons, skill runs, decisions on an edit made on
 * a machine and `arbor sync apply`) goes through these steps, which:
 * - make the change through the guarded, backed-up command for its kind, which checks the machine still has what the
 *   last scan found and lands it on Sync › Repo › History;
 * - have the machine rescanned and Sync's standing worked out again in Rust, which records its bases (Rust does this
 *   for runs by themselves too, `setup_autoline.rs`, in the same order);
 * - then read the standing here again, so every page shows the result.
 *
 * Bringing a whole machine in line (`libraryToggle.bringInLine`) runs them in one order: files and hook scripts, then
 * plugins, MCP servers, the machine's hooks, and skills. `tests/applyEngine.test.ts` keeps the commands these wrap out
 * of every other file, so a new apply path can't skip the steps.
 */

async function then<T>(change: Promise<T>): Promise<T> {
  try {
    return await change;
  } finally {
    reloadSyncStanding();
  }
}

/** Files, hook scripts and skills in the store, as the repo has them at `commit`. */
export const applyFiles = (repo: string, commit: string, machine: string, changes: SyncChange[]) => then(applySetupSync(repo, commit, machine, changes));

/** The machine's hooks, written together, as the repo has them at `commit`. */
export const applyHookSet = (repo: string, commit: string, machine: string) => then(applyHooks(repo, commit, machine));

/** MCP servers in the machine's homes. */
export const applyMcp = (repo: string, commit: string, machine: string, changes: McpChange[]) => then(applyMcpChanges(repo, commit, machine, changes));

/** Claude Code's plugins and marketplaces, through its own command. */
export const applyPlugins = (machine: string, changes: PluginChange[]) => then(applyPluginChanges(machine, changes));

/** Codex's plugins and marketplaces. */
export const applyCodexPlugins = (machine: string, changes: CodexPluginChange[]) => then(applyCodexPluginChanges(machine, changes));

/** Skills into or out of the store and the homes, machine by machine (`skillRuns` is this step's own planner). */
export const runSkills = (plan: SkillPlan, repo: SetupRepo | null, onProgress: (progress: SkillRunProgress) => void) => then(runSkillPlan(plan, repo, onProgress));
