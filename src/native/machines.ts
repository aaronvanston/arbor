import type {
  AgentKind,
  AgentUpdate,
  CallDiagnostics,
  ClearedCalls,
  ClientVersions,
  DiscoveredHost,
  LatestVersions,
  MachineHealthSnapshot,
  MachineHost,
  ReporterSetup,
  SettingsEdit,
  T3Policy,
  TelemetryBreakdown,
  TelemetrySetup,
  TelemetryStatus,
} from './types';

/** The machines: their list and health, the agents on them, what the agents report back, and each script run on one. */
export type MachineCommands = {
  get_machine_hosts: { result: MachineHost[] };
  save_machine_hosts: { args: { hosts: MachineHost[] }; result: MachineHost[] };
  discover_machine_hosts: { result: DiscoveredHost[] };
  get_machine_health: {
    args: { since?: number | null; windowMs?: number | null; passive?: boolean | null };
    result: MachineHealthSnapshot;
  };

  get_agent_latest_versions: { result: LatestVersions };
  get_t3_compatibility: { result: T3Policy[] | null };
  get_client_versions: { args: { fromMs: number; toMs: number }; result: ClientVersions };
  update_machine_agent: { args: { machine: string; agent: AgentKind; command?: string | null }; result: AgentUpdate };
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
