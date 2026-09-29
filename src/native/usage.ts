import type {
  AntiburnStatus,
  CacheMisses,
  CapacityQuery,
  CapacityReport,
  FleetSources,
  LimitAccountRename,
  LimitCycle,
  LimitReading,
  LiveSessionsReport,
  MachineAssignment,
  MachineSessions,
  MergedPullRequests,
  ModelPrice,
  ModelPriceSyncResult,
  NamedPullRequests,
  PullRequestLink,
  SessionProjectsReport,
  UsageAnalysis,
  UsageCollectorStatus,
  UsageCompactionResult,
  UsageEventPage,
  UsageOverview,
  UsagePricing,
  UsageQuery,
  UsageRepairResult,
  UsageRetentionResult,
  UsageSessionPage,
  UsageSessionTimeline,
  UsageStorageInfo,
} from './types';

/** Usage history: the proxy's records, prices, sessions and projects, limits and capacity, and the database itself. */
export type UsageCommands = {
  get_usage_collector_status: { result: UsageCollectorStatus };
  get_usage_overview: { args: { query: UsageQuery }; result: UsageOverview };
  get_usage_analysis: { args: { query: UsageQuery }; result: UsageAnalysis };
  get_usage_events: { args: { query: UsageQuery }; result: UsageEventPage };
  get_cache_misses: { args: { query: UsageQuery }; result: CacheMisses };
  repair_usage_cache_records: { result: UsageRepairResult };

  get_usage_pricing: { args: { query: UsageQuery }; result: UsagePricing };
  save_usage_model_price: { args: { price: ModelPrice }; result: void };
  delete_usage_model_price: { args: { model: string }; result: void };
  sync_usage_model_prices: { args: { query: UsageQuery }; result: ModelPriceSyncResult };

  get_usage_sessions: { args: { query: UsageQuery }; result: UsageSessionPage };
  get_usage_session_timeline: { args: { session: string }; result: UsageSessionTimeline };
  get_live_sessions: { result: LiveSessionsReport };
  get_fleet_sources: { result: FleetSources };
  get_antiburn: { result: AntiburnStatus };
  open_antiburn: { result: void };
  get_machine_sessions: { args: { query: UsageQuery }; result: MachineSessions[] };
  get_usage_machine_assignments: { result: MachineAssignment[] };
  save_usage_machine_assignments: { args: { assignments: MachineAssignment[] }; result: void };
  get_session_projects: { args: { query: UsageQuery; checkNow?: boolean | null }; result: SessionProjectsReport };
  get_merged_pull_requests: { args: { fromMs: number; toMs: number }; result: MergedPullRequests };
  get_pull_request_states: { args: { pullRequests: PullRequestLink[] }; result: NamedPullRequests };

  get_capacity_report: { args: { query: CapacityQuery }; result: CapacityReport };
  get_limit_cycles: { args: { account: string; window: string }; result: LimitCycle[] };
  /** Returns how many readings were worth keeping and stored. */
  record_limit_samples: { args: { samples: LimitReading[] }; result: number };
  /** Returns how many readings moved to the new names. */
  rename_limit_history_accounts: { args: { renames: LimitAccountRename[] }; result: number };

  get_usage_storage_info: { result: UsageStorageInfo };
  set_usage_retention: { args: { retentionDays: number; dryRun: boolean }; result: UsageRetentionResult };
  compact_usage_database: { result: UsageCompactionResult };
};
