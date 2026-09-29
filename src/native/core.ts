import type {
  CoreConfigView,
  CoreInstallResult,
  CoreInstallTask,
  CoreLatest,
  CoreLoggingSettingsInput,
  CoreStatus,
  CoreTlsSettings,
  ExtraModel,
  ExtraModelsView,
  GuiNetworkEndpointSettings,
  GuiRetrySettings,
  GuiSessionRoutingSettings,
  JsonValue,
  ManagementRequest,
  ModelOverrideEntry,
  OAuthBrowserOption,
  OAuthStartResult,
  OAuthStatusResult,
  ProxyChecks,
  SettingsInEffect,
  SpeedAliasEntry,
  ThinkingAliasEntry,
  ThinkingAliasSource,
} from './types';

/** The core: its process and updates, its config, model routing, its management API and signing in to accounts. */
export type CoreCommands = {
  get_core_status: { result: CoreStatus };
  start_core_process: { result: CoreStatus };
  stop_core_process: { result: CoreStatus };
  restart_core_process: { result: CoreStatus };
  check_latest_core: { result: CoreLatest };
  get_core_install_task: { result: CoreInstallTask };
  /** Fails with a `CommandError` whose kind says whether it was canceled. */
  install_core_version: { args: { version?: string | null }; result: CoreInstallResult };
  cancel_core_install: { result: void };

  get_core_config_settings: { result: CoreConfigView };
  get_core_tls_settings: { result: CoreTlsSettings };
  save_core_tls_settings: { args: { settings: CoreTlsSettings }; result: CoreTlsSettings };
  save_core_logging_settings: { args: { settings: CoreLoggingSettingsInput }; result: CoreConfigView };
  /** What the proxy checks offer when the running core has usage statistics off. */
  turn_on_usage_statistics: { result: CoreConfigView };
  /** The settings Arbor depends on, as the running core has them. */
  check_proxy_settings: { result: ProxyChecks };
  /** After a save the core takes without a restart: waits up to 3 s for it to run what config.yaml now says. */
  confirm_core_settings: { result: SettingsInEffect };
  save_network_endpoint_settings: { args: { settings: GuiNetworkEndpointSettings }; result: CoreConfigView };
  save_retry_settings: { args: { settings: GuiRetrySettings }; result: CoreConfigView };
  save_session_routing_settings: { args: { settings: GuiSessionRoutingSettings }; result: CoreConfigView };
  set_core_management_secret_key: { args: { secretKey: string }; result: CoreConfigView };
  set_core_routing_strategy: { args: { strategy: string }; result: CoreConfigView };
  add_core_api_key: { args: { apiKey: string; remark: string }; result: CoreConfigView };
  update_core_api_key: { args: { originalApiKey: string; apiKey: string; remark: string }; result: CoreConfigView };
  delete_core_api_key: { args: { apiKey: string }; result: CoreConfigView };
  pause_core_api_key: { args: { apiKeyHash: string }; result: CoreConfigView };
  resume_core_api_key: { args: { apiKeyHash: string }; result: CoreConfigView };
  delete_paused_core_api_key: { args: { apiKeyHash: string }; result: CoreConfigView };

  get_model_overrides: { result: ModelOverrideEntry[] };
  create_model_override: {
    args: { requestedModel: string; sourceId: string; forceMapping?: boolean | null; includeLongContext?: boolean | null };
    result: ModelOverrideEntry[];
  };
  delete_model_override: { args: { requestedModel: string; oauthChannel: string }; result: ModelOverrideEntry[] };
  get_extra_models: { result: ExtraModelsView };
  /** `expected` is the list as last read; a list that's changed since is left alone. */
  set_extra_models: { args: { provider: string; expected: ExtraModel[]; models: ExtraModel[] }; result: ExtraModelsView };
  get_model_alias_sources: { result: ThinkingAliasSource[] };
  get_thinking_alias_sources: { result: ThinkingAliasSource[] };
  get_speed_alias_sources: { result: ThinkingAliasSource[] };
  get_thinking_aliases: { result: ThinkingAliasEntry[] };
  create_thinking_alias: {
    args: { sourceId: string; alias: string; effort: string; fast?: boolean | null };
    result: ThinkingAliasEntry[];
  };
  delete_thinking_alias: { args: { alias: string; oauthChannel?: string | null }; result: ThinkingAliasEntry[] };
  get_speed_aliases: { result: SpeedAliasEntry[] };
  create_speed_alias: { args: { sourceId: string; alias: string }; result: SpeedAliasEntry[] };
  delete_speed_alias: { args: { alias: string; oauthChannel?: string | null }; result: SpeedAliasEntry[] };

  /** The core's own JSON, which the Rust side passes through untyped. Fails with a `CommandError` of kind `core`. */
  management_request: { args: { request: ManagementRequest }; result: JsonValue };
  upload_auth_file: { args: { name: string; data: number[] }; result: JsonValue };
  open_auth_files_directory: { result: void };
  open_core_logs_directory: { result: void };
  reveal_core_config_file: { result: void };

  start_oauth_login: { args: { provider: string; browser?: string | null }; result: OAuthStartResult };
  get_oauth_status: { args: { state: string }; result: OAuthStatusResult };
  submit_oauth_callback: { args: { provider: string; redirectUrl: string }; result: void };
  list_oauth_browsers: { result: OAuthBrowserOption[] };
  open_oauth_url: { args: { url: string; browser?: string | null }; result: void };
};
