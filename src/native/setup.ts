import type {
  AgentKind,
  CheckoutInstructionsChange,
  CheckoutInstructionsResult,
  CheckoutMcpChange,
  CheckoutMcpResult,
  CheckoutSkillChange,
  CheckoutSkillResult,
  CodexPluginChange,
  HookRegistry,
  HookWanted,
  HubSync,
  MachineProjects,
  MachineToolchain,
  McpChange,
  McpHealth,
  McpRegistry,
  McpResult,
  McpUsageReport,
  McpWanted,
  NodeChange,
  NodeResult,
  PluginChange,
  PluginCosts,
  PluginLeftover,
  PluginResult,
  PluginWanted,
  ProjectFixRequest,
  ProjectFixes,
  ProjectSkillsOutcome,
  ProjectsDrift,
  SyncStanding,
  RepoKeeper,
  AutoLine,
  RemovalResult,
  RepoChange,
  RepoCommit,
  RepoText,
  RepoTree,
  SettingsEdit,
  SetupBackup,
  SetupInventory,
  SetupRepo,
  SetupSkillFile,
  SetupText,
  SkillChange,
  SkillUsageReport,
  SkillWanted,
  SourceCheck,
  MarketplaceCatalog,
  StartingContext,
  SyncChange,
  SyncOutcome,
  WorktreeRemoval,
  ToolChange,
  ToolResult,
} from './types';

/** Setup: what each machine's agents load, the setup repo that keeps them in line, and the changes Arbor makes to them. */
export type SetupCommands = {
  get_setup_inventory: { result: SetupInventory };
  scan_setup: { args: { machine?: string | null; staleOnly?: boolean | null }; result: void };
  read_setup_text: { args: { machine: string; path: string }; result: SetupText };
  read_setup_skill: { args: { machine: string; path: string }; result: SetupSkillFile[] };

  get_setup_repo: { args: { repo: string }; result: SetupRepo };
  get_project_drift: { args: { repo: string }; result: ProjectsDrift };
  get_sync_standing: { args: { repo: string }; result: SyncStanding };
  get_setup_repo_keeper: { result: RepoKeeper };
  keep_setup_repo_now: { args: { olderThanMs?: number | null }; result: RepoKeeper };
  get_setup_autoline: { result: AutoLine };
  set_setup_autoline_paused: { args: { machine: string; paused: boolean }; result: AutoLine };
  add_setup_schemas: { args: { repo: string }; result: SetupRepo };
  apply_project_fixes: { args: { repo: string; machine: string; fixes: ProjectFixRequest[] }; result: ProjectFixes };
  apply_project_skills: { args: { repo: string; machine: string; project: string }; result: ProjectSkillsOutcome };
  sync_local_project: { args: { repo: string; project: string }; result: HubSync };
  read_setup_repo_file: { args: { repo: string; commit: string; path: string }; result: SetupText };
  start_setup_repo: { args: { repo: string }; result: SetupRepo };
  take_setup_file: { args: { repo: string; machine: string; path: string }; result: SetupRepo };
  set_setup_file_machine: { args: { repo: string; path: string; machine: string; wanted: SkillWanted | null }; result: SetupRepo };
  set_setup_file_removed: { args: { repo: string; path: string; removed: boolean }; result: SetupRepo };
  set_setup_skill_off: { args: { repo: string; skill: string; off: boolean }; result: SetupRepo };
  set_setup_file_off: { args: { repo: string; path: string; off: boolean }; result: SetupRepo };
  set_setup_skill_removed: { args: { repo: string; skill: string; removed: boolean }; result: SetupRepo };
  drop_setup_skills: { args: { repo: string; skills: string[] }; result: SetupRepo };
  set_setup_skill_machine: { args: { repo: string; skill: string; machine: string; wanted: SkillWanted | null }; result: SetupRepo };
  set_setup_skill_project: {
    args: { repo: string; skill: string; project: string; machine: string | null; wanted: PluginWanted | null };
    result: SetupRepo;
  };
  set_setup_mcp_project: {
    args: { repo: string; server: string; project: string; machine: string | null; wanted: PluginWanted | null };
    result: SetupRepo;
  };
  set_setup_plugin: {
    args: { repo: string; plugin: string; source: string | null; project: string | null; machine: string | null; wanted: PluginWanted | null };
    result: SetupRepo;
  };
  set_setup_codex_plugin: { args: { repo: string; plugin: string; source: string | null; machine: string | null; wanted: PluginWanted | null }; result: SetupRepo };
  pull_setup_repo: { args: { repo: string }; result: SetupRepo };
  push_setup_repo: { args: { repo: string }; result: SetupRepo };
  apply_setup_sync: {
    args: { repo: string; commit: string; machine: string; changes: SyncChange[] };
    result: SyncOutcome;
  };
  list_setup_backups: { args: { machine: string }; result: SetupBackup[] };
  undo_setup_sync: { args: { machine: string; backup: string }; result: SyncOutcome };

  list_setup_repo_tree: { args: { repo: string }; result: RepoTree };
  read_setup_repo_text: { args: { repo: string; path: string; commit: string | null }; result: RepoText };
  write_setup_repo_text: { args: { repo: string; path: string; content: string; expected: string | null }; result: RepoTree };
  move_setup_repo_path: { args: { repo: string; from: string; to: string }; result: RepoTree };
  delete_setup_repo_path: { args: { repo: string; path: string }; result: RepoTree };
  discard_setup_repo_changes: { args: { repo: string; paths: string[] }; result: RepoTree };
  get_setup_repo_changes: { args: { repo: string; commit: string | null }; result: RepoChange[] };
  get_setup_repo_log: { args: { repo: string; limit: number }; result: RepoCommit[] };
  commit_setup_repo: { args: { repo: string; paths: string[]; message: string }; result: SetupRepo };

  take_setup_skills: { args: { repo: string; machine: string; paths: string[] }; result: SetupRepo };
  read_setup_repo_skill: { args: { repo: string; commit: string; name: string; ck: boolean }; result: SetupSkillFile[] };
  check_setup_skill_sources: { args: { repo: string; force: boolean }; result: SourceCheck[] };
  get_marketplace_catalog: { args: { source: string; force: boolean }; result: MarketplaceCatalog };
  update_setup_skills: { args: { repo: string; names: string[] }; result: SetupRepo };
  apply_skill_changes: { args: { machine: string; changes: SkillChange[] }; result: SyncOutcome };
  get_skill_usage: { args: { days: number }; result: SkillUsageReport };

  apply_plugin_changes: { args: { machine: string; changes: PluginChange[] }; result: PluginResult[] };
  apply_codex_plugin_changes: { args: { machine: string; changes: CodexPluginChange[] }; result: PluginResult[] };
  forget_plugin_leftovers: { args: { machine: string; leftovers: PluginLeftover[] }; result: SettingsEdit[] };
  apply_checkout_skills: { args: { machine: string; changes: CheckoutSkillChange[] }; result: CheckoutSkillResult[] };
  apply_checkout_mcp: { args: { repo: string; machine: string; changes: CheckoutMcpChange[] }; result: CheckoutMcpResult[] };
  apply_checkout_instructions: {
    args: { repo: string; project: string; machine: string; changes: CheckoutInstructionsChange[] };
    result: CheckoutInstructionsResult[];
  };
  check_mcp_health: { args: { machine: string; home: string }; result: McpHealth };
  measure_plugin_costs: { args: { machine: string; home: string }; result: PluginCosts };
  get_mcp_usage: { args: { days: number; plugins: string[] }; result: McpUsageReport };
  get_mcp_registry: { args: { repo: string }; result: McpRegistry };
  apply_mcp_changes: {
    args: { repo: string; commit: string; machine: string; changes: McpChange[] };
    result: McpResult[];
  };
  take_mcp_server: {
    args: { repo: string; machine: string; home: string; name: string; own: boolean };
    result: McpRegistry;
  };
  set_mcp_wanted: {
    args: { repo: string; name: string; machine: string | null; wanted: McpWanted };
    result: McpRegistry;
  };
  put_back_mcp_server: { args: { repo: string; name: string }; result: McpRegistry };
  get_hook_registry: { args: { repo: string }; result: HookRegistry };
  set_hook_wanted: {
    args: { repo: string; name: string; machine: string | null; wanted: HookWanted };
    result: HookRegistry;
  };
  take_hook: {
    args: { repo: string; machine: string; home: string; event: string; script: string };
    result: HookRegistry;
  };
  apply_hooks: { args: { repo: string; commit: string; machine: string }; result: SettingsEdit[] };
  set_hook_agents: { args: { repo: string; name: string; agents: AgentKind[] }; result: HookRegistry };

  get_projects: { result: MachineProjects[] };
  scan_projects: { args: { machine: string; fetch?: boolean | null; repo?: string | null }; result: MachineProjects };
  measure_projects: { args: { machine: string }; result: MachineProjects };
  read_project_file: { args: { machine: string; repo: string; name: string }; result: SetupText };
  remove_worktrees: { args: { machine: string; removals: WorktreeRemoval[] }; result: RemovalResult[] };

  get_toolchain: { result: MachineToolchain[] };
  scan_toolchain: { args: { machine: string }; result: MachineToolchain };
  change_node_versions: { args: { machine: string; changes: NodeChange[] }; result: NodeResult[] };
  check_tool_updates: { args: { machine: string; refresh: boolean }; result: MachineToolchain };
  change_tools: { args: { machine: string; changes: ToolChange[] }; result: ToolResult[] };

  get_starting_context: { args: { fromMs: number; toMs: number }; result: StartingContext };
};
