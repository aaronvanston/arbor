import type {
  HarnessRun,
  RunRequest,
  AgentHome,
  AgentHomeKind,
  AgentHomesView,
  AgentKind,
  AgentUpdate,
  CallDiagnostics,
  ClearedCalls,
  ClientVersions,
  DiscoveredHost,
  LatestVersions,
  MachinePool,
  MachineHealthSnapshot,
  MachineHost,
  PoolPreview,
  ReporterSetup,
  SettingsEdit,
  T3Policy,
  TelemetryBreakdown,
  TelemetrySetup,
  TelemetryStatus,
  ThisMac,
} from './types';

/** The machines: their list and health, the agents on them, what the agents report back, and each script run on one. */
export type MachineCommands = {
  get_machine_hosts: { result: MachineHost[] };
  get_this_mac: { result: ThisMac };
  save_machine_hosts: { args: { hosts: MachineHost[]; removed?: string[] | null }; result: MachineHost[] };
  discover_machine_hosts: { result: DiscoveredHost[] };
  get_agent_homes: { result: AgentHomesView };
  save_agent_home: { args: { home: AgentHome }; result: AgentHomesView };
  remove_agent_home: { args: { machine: string; agent: AgentHomeKind; path: string }; result: AgentHomesView };
  scan_agent_homes: { args: { machine?: string | null }; result: AgentHomesView };
  preview_agent_home: { args: { machine: string; agent: AgentHomeKind; path: string }; result: string[] };
  get_pools: { result: MachinePool[] };
  save_pool: { args: { pool: MachinePool }; result: MachinePool[] };
  remove_pool: { args: { id: string }; result: MachinePool[] };
  preview_pools: { args: { watching?: boolean | null }; result: PoolPreview[] };
  report_working_sessions: { args: { counts: Record<string, number> }; result: void };
  start_pool_run: { args: { request: RunRequest }; result: HarnessRun };
  get_runs: { result: HarnessRun[] };
  cancel_run: { args: { id: string }; result: HarnessRun[] };
  open_run: { args: { id: string }; result: void };
  get_machine_health: {
    args: { since?: number | null; windowMs?: number | null; passive?: boolean | null };
    result: MachineHealthSnapshot;
  };

  get_agent_latest_versions: { result: LatestVersions };
  get_t3_compatibility: { result: T3Policy[] | null };
  get_client_versions: { args: { fromMs: number; toMs: number }; result: ClientVersions };
  update_machine_agent: { args: { machine: string; agent: AgentKind; command?: string | null }; result: AgentUpdate };
  open_fix_session: { args: { machine: string; agent: AgentKind; prompt: string; onMachine: boolean }; result: void };
  keep_claude_sessions: { args: { machine: string; homes: string[] }; result: SettingsEdit[] };
  set_t3_threads_enabled: { args: { enabled: boolean }; result: void };

  set_agent_reporter: { args: { machine: string; enabled: boolean; plan?: boolean | null }; result: ReporterSetup };
  get_agent_telemetry: { result: TelemetryStatus };
  set_agent_telemetry: { args: { enabled: boolean; port: number }; result: TelemetryStatus };
  set_machine_telemetry: { args: { machine: string; enabled: boolean; plan?: boolean | null }; result: TelemetrySetup };
  get_agent_telemetry_breakdown: {
    args: { fromMs: number; toMs: number; machine?: string | null };
    result: TelemetryBreakdown;
  };

  get_call_diagnostics: { result: CallDiagnostics };
  clear_call_diagnostics: { result: ClearedCalls };
  undo_clear_call_diagnostics: { args: { clearedAtMs: number; previousClearedAtMs?: number | null }; result: void };
};
