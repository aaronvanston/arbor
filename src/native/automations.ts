import type { Automation, AutomationDraft, AutomationDraftInput, AutomationInput, AutomationList, AutomationRun, AutomationSource } from './types';

/**
 * Automations: Arbor's own, which it runs on a schedule, and the ones other apps keep on each machine, which it finds.
 */
export type AutomationCommands = {
  list_automations: { result: AutomationList };
  scan_automations: { args: { machine?: string | null }; result: AutomationList };
  get_automation: { args: { id: string }; result: Automation };
  list_automation_runs: { args: { id?: string | null; limit?: number | null }; result: AutomationRun[] };
  save_automation: { args: { input: AutomationInput }; result: Automation };
  delete_automation: { args: { id: string }; result: AutomationList };
  set_automation_enabled: { args: { id: string; enabled: boolean }; result: AutomationList };
  run_automation_now: { args: { id: string }; result: AutomationRun };
  cancel_automation_run: { args: { runId: string }; result: AutomationRun };
  copy_automation_into_arbor: { args: { id: string; pauseOriginal: boolean }; result: Automation };
  draft_automation: { args: { input: AutomationDraftInput }; result: AutomationDraft };
  set_automations_running: { args: { running: boolean }; result: AutomationList };
  set_automation_app_enabled: { args: { source: AutomationSource; enabled: boolean }; result: AutomationList };
  set_automation_draft_model: { args: { model: string; effort: string }; result: AutomationList };
  add_automations_key: { result: AutomationList };
  set_automation_proxy_address: { args: { address: string }; result: AutomationList };
  install_background_runner: { args: { machine: string }; result: AutomationList };
};
