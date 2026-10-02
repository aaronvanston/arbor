// Writes src-tauri/src/cli/commands.rs: the table the command line and the MCP server call the app's commands through.
//
// The app registers its commands in main.rs's generate_handler!; this reads that list and each command's Rust
// signature, so a new command reaches `arbor` without anyone writing a line for it, and a test fails when the file is
// out of date (`bun run cli-commands` rewrites it). Arguments the app fills in itself (its handle, its state) are filled
// in the same way here; the rest are read from the request by the name the webview passes them with.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_COMMANDS_FILE = 'src-tauri/src/cli/commands.rs';

/**
 * Commands the command line never gets, each with why. A test fails when a registered command is neither here nor in
 * the table, so every new one is a choice.
 */
export const LEFT_OUT = {
  set_tray_rows: 'the window draws the menu bar',
  set_tray_status: 'the window draws the menu bar',
  set_tray_unread: 'the window draws the menu bar',
  set_tray_waiting: 'the window draws the menu bar',
  report_working_sessions: 'the window counts its live board for the pools',
  frontend_ready: 'only the window can say it has drawn',
  set_quit_guard: 'the window owns ⌘Q',
  get_zoom_level: 'the window owns its zoom',
  set_zoom_level: 'the window owns its zoom',
  get_app_icon: 'the Dock icon is picked on Settings › Appearance',
  set_app_icon: 'the Dock icon is picked on Settings › Appearance',
  get_product_analytics: 'analytics belong to the window',
  set_product_analytics: 'analytics belong to the window',
  mark_product_analytics_notice_shown: 'analytics belong to the window',
  track_event: 'analytics belong to the window',
  report_exception: 'analytics belong to the window',
  management_request: 'it passes any request to the core, resets and claims included',
  save_digest_page: 'it opens a save dialog on the Mac',
  open_saved_page: 'it opens a page on the Mac',
  open_dev_build_log: 'it opens a file on the Mac',
  open_external_url: 'it opens any address on the Mac',
  open_fix_session: 'it opens a Terminal window on the Mac and starts an agent in it',
  open_oauth_url: 'it opens any address on the Mac',
  install_core_version: 'it reports progress to the window; the command line asks the window to run it',
  set_phone_alert_secret: 'secrets only go in through the window',
  saved_store_migrate: 'only the window has the values to move',
  save_cli_settings: "the command line can't change what it's allowed to do",
  cli_bridge_ready: 'only the window registers its actions',
  cli_respond: 'only the window answers its requests',
};

/** Changes that ask before they happen in the app (they can't be undone or they change the proxy), so `--yes` here. */
export const NEEDS_CONFIRMATION = new Set([
  'start_core_process',
  'stop_core_process',
  'restart_core_process',
  'start_app_update',
  'save_network_endpoint_settings',
  'save_core_tls_settings',
  'set_core_routing_strategy',
  'set_core_management_secret_key',
  'pause_core_api_key',
  'delete_core_api_key',
  'delete_paused_core_api_key',
  'delete_thinking_alias',
  'delete_speed_alias',
  'delete_model_override',
  'set_extra_models',
  'delete_usage_model_price',
  'set_usage_retention',
  'compact_usage_database',
  'repair_usage_cache_records',
  'clear_call_diagnostics',
  'save_machine_hosts',
  'remove_agent_home',
  'remove_pool',
  'start_pool_run',
  'update_machine_agent',
  'update_machine_harness',
  'set_agent_reporter',
  'set_agent_telemetry',
  'set_machine_telemetry',
  'keep_claude_sessions',
  'apply_setup_sync',
  'undo_setup_sync',
  'delete_setup_repo_path',
  'discard_setup_repo_changes',
  'push_setup_repo',
  'run_automation_now',
  'install_background_runner',
  'add_automations_key',
  'delete_automation',
  'cancel_automation_run',
  'apply_skill_changes',
  'apply_plugin_changes',
  'apply_codex_plugin_changes',
  'forget_plugin_leftovers',
  'apply_mcp_changes',
  'apply_hooks',
  'apply_checkout_skills',
  'apply_checkout_mcp',
  'apply_checkout_instructions',
  'remove_worktrees',
  'change_node_versions',
]);

/** Commands that only look: everything else changes something. */
const READS = /^(?:get_|read_|list_|check_|preview_|measure_|discover_|confirm_core_settings$|system_locale$)/;

const read = (path) => readFileSync(join(root, path), 'utf8');

/** Splits at the commas that aren't inside brackets. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '<' || char === '(' || char === '[') depth += 1;
    else if (char === '>' || char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** A Rust type as the TypeScript type the webview passes, for help text and the MCP tools' schemas. */
function rustToTs(type) {
  const text = type.trim();
  const generic = /^([\w:]+)\s*<([\s\S]*)>$/.exec(text);
  if (generic) {
    const name = generic[1].split('::').pop();
    const params = splitTopLevel(generic[2]).map(rustToTs);
    if (name === 'Option') return `${params[0]} | null`;
    if (['Vec', 'VecDeque', 'HashSet', 'BTreeSet'].includes(name)) return `Array<${params[0]}>`;
    if (['HashMap', 'BTreeMap'].includes(name)) return `Record<${params[0]}, ${params[1]}>`;
    return `${name}<${params.join(', ')}>`;
  }
  const name = text.split('::').pop();
  if (['String', 'str', 'PathBuf'].includes(name)) return 'string';
  if (name === 'bool') return 'boolean';
  if (/^(?:[iu](?:8|16|32|64|128|size)|f32|f64)$/.test(name)) return 'number';
  if (name === 'Value') return 'JsonValue';
  return name;
}

/** The registered commands with the path main.rs names each by. */
function registeredCommands() {
  const list = read('src-tauri/src/main.rs').match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((path) => ({ path, name: path.split('::').pop() }));
}

/** Every command's signature and doc comment, by name. */
function commandSignatures() {
  const signatures = new Map();
  const files = readdirSync(join(root, 'src-tauri/src'), { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.rs'));
  for (const path of files.sort()) {
    const text = read(join('src-tauri/src', path));
    const pattern = /((?:[ \t]*\/\/\/[^\n]*\n)*)[ \t]*#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*pub\(crate\)\s+(async\s+)?fn\s+(\w+)\s*\(/g;
    for (const match of text.matchAll(pattern)) {
      let depth = 1;
      let end = match.index + match[0].length;
      const start = end;
      while (depth > 0 && end < text.length) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')') depth -= 1;
        end += 1;
      }
      const returns = text.slice(end, text.indexOf('{', end)).replace(/^\s*->/, '').trim();
      const params = splitTopLevel(text.slice(start, end - 1)).map((param) => {
        const [rawName, ...rest] = param.split(':');
        const type = rest.join(':').trim();
        const name = rawName.replace(/^mut\s+/, '').trim();
        if (/^(?:tauri::)?AppHandle\b/.test(type)) return { kind: 'app' };
        if (/^(?:tauri::)?State\b/.test(type)) return { kind: 'state' };
        if (/^(?:tauri::)?(?:Window|WebviewWindow)\b/.test(type)) return { kind: 'window' };
        // Tauri turns a snake_case argument into camelCase for the webview; the command line uses the same names.
        const camel = name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        return { kind: 'arg', name: camel, type: rustToTs(type), optional: /^Option\s*</.test(type) };
      });
      const doc = match[1]
        .split('\n')
        .map((line) => line.trim().replace(/^\/\/\/\s?/, ''))
        .join(' ')
        .trim();
      signatures.set(match[3], { async: Boolean(match[2]), params, returnsResult: /^Result\s*</.test(returns), doc });
    }
  }
  return signatures;
}

/** "get_usage_overview" as "Get usage overview", for a command with no doc comment. */
const humanized = (name) => name.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());

const rustString = (text) => JSON.stringify(text);

/** The commands the command line can call, in main.rs's order, with how each is called. */
export function cliCommands() {
  const signatures = commandSignatures();
  return registeredCommands()
    .filter(({ name }) => !(name in LEFT_OUT))
    .map(({ path, name }) => {
      const signature = signatures.get(name);
      if (!signature) throw new Error(`No #[tauri::command] signature found for ${name}`);
      if (signature.params.some((param) => param.kind === 'window')) {
        throw new Error(`${name} takes the window, which the command line doesn't have; leave it out in scripts/cli-commands.mjs`);
      }
      const access = READS.test(name) ? 'Read' : NEEDS_CONFIRMATION.has(name) ? 'Confirm' : 'Write';
      return { path, name, access, ...signature, summary: signature.doc || humanized(name) };
    });
}

function callExpression(command) {
  const args = command.params.map((param) => {
    if (param.kind === 'app') return 'app.clone()';
    if (param.kind === 'state') return 'app.state()';
    return `arg(&args, ${rustString(param.name)})?`;
  });
  return `crate::${command.path}(${args.join(', ')})`;
}

function callArm(command) {
  const finish = command.returnsResult ? 'done' : 'plain';
  const call = callExpression(command);
  const takesArgs = command.params.some((param) => param.kind === 'arg');
  if (command.async) {
    if (!takesArgs) return `        ${rustString(command.name)} => ${finish}(Box::pin(${call}).await),`;
    // A block of its own, so a missing argument fails this command rather than the lookup.
    return `        ${rustString(command.name)} => async { ${finish}(Box::pin(${call}).await) }.await,`;
  }
  // A plain command runs on a blocking thread, as the app runs it off the async runtime.
  const usesApp = command.params.some((param) => param.kind === 'app' || param.kind === 'state');
  const captures = [usesApp && 'let app = app.clone();', takesArgs && 'let args = args.clone();'].filter(Boolean);
  const body = `blocking(move || ${finish}(${call})).await`;
  if (!captures.length) return `        ${rustString(command.name)} => ${body},`;
  return `        ${rustString(command.name)} => {\n            ${captures.join('\n            ')}\n            ${body}\n        }`;
}

function specEntry(command) {
  const args = command.params
    .filter((param) => param.kind === 'arg')
    .map((param) => `ArgSpec { name: ${rustString(param.name)}, ts_type: ${rustString(param.type)}, optional: ${param.optional} }`);
  return `    CommandSpec {\n        name: ${rustString(command.name)},\n        access: Access::${command.access},\n        summary: ${rustString(command.summary)},\n        args: &[${args.length ? `\n            ${args.join(',\n            ')},\n        ` : ''}],\n    },`;
}

/** The whole of commands.rs. */
export function renderCliCommands() {
  const commands = cliCommands();
  return `// @generated by scripts/cli-commands.mjs from main.rs's generate_handler! and each command's signature.
// Don't edit it by hand: \`bun run cli-commands\` rewrites it, and a test fails when it's out of date.

use super::dispatch::{arg, blocking, done, plain, Access, ArgSpec, CommandSpec};
use crate::command_error::CommandError;
use serde_json::Value;
use tauri::Manager;

/// Every command the command line can call, in the order the app registers them.
pub(crate) const COMMANDS: &[CommandSpec] = &[
${commands.map(specEntry).join('\n')}
];

/// Runs one command the way the window would, or None when there's no command by that name.
#[allow(clippy::too_many_lines)]
pub(crate) async fn call(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value, CommandError>> {
    let result = match name {
${commands.map(callArm).join('\n')}
        _ => return None,
    };
    Some(result)
}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(root, CLI_COMMANDS_FILE), renderCliCommands());
  console.log(`Wrote ${CLI_COMMANDS_FILE}`);
}
