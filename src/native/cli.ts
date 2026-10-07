import type {
  CliInstallResult,
  CliOverview,
  CliSettings,
  CliSkillInstall,
  CliWindowAction,
  CliWindowError,
  JsonValue,
  SavedStoreSnapshot,
} from './types';

/** The command line's side of the app: the settings the app keeps for the window, and the window's answers to `arbor`. */
export type CliCommands = {
  saved_store_snapshot: { args: { only?: string[] | null; except?: string[] | null }; result: SavedStoreSnapshot };
  saved_store_set: { args: { name: string; value?: string | null }; result: void };
  saved_store_migrate: { args: { values: Record<string, string> }; result: SavedStoreSnapshot };

  cli_bridge_ready: { args: { actions: CliWindowAction[] }; result: void };
  cli_respond: { args: { id: string; result?: JsonValue | null; error?: CliWindowError | null }; result: void };

  get_cli_overview: { result: CliOverview };
  save_cli_settings: { args: { settings: CliSettings }; result: CliSettings };
  install_cli_link: { result: CliInstallResult };
  remove_cli_link: { result: CliInstallResult };
  install_cli_skill: { result: CliSkillInstall };
};
