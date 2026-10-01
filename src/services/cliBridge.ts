import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { CliAccess, CliWindowAction, CliWindowArg, JsonValue } from '../native/types';

/**
 * The window's side of `arbor`: what the window works out itself (limits, caps, routing, Sync's plan, alerts) can't
 * be run by the app alone, so the app asks the window with a `cli-request` and the window answers with `cli_respond`.
 * The actions are listed with the app when the window loads, so `arbor commands` and the MCP server can offer them.
 */

/** The app's event for a request from the command line. */
export const CLI_REQUEST_EVENT = 'cli-request';

export type CliArgs = Record<string, unknown>;

/** One action the window answers. `confirm` actions are only run once the request carries `confirm`; the app checks. */
export type CliHandler = {
  access: CliAccess;
  /** What it does, for `arbor commands` and an agent's tool list. */
  summary: string;
  args?: CliWindowArg[];
  run: (args: CliArgs) => Promise<unknown>;
};

export type CliHandlers = Record<string, CliHandler>;

type CliRequest = { id: string; action: string; args: unknown; confirm: boolean };

/** What the window answers: the action's result, or why it failed. */
type CliAnswer = { result: JsonValue | null; error: { message: string } | null };

/** The actions as the app lists them. */
export const cliActions = (handlers: CliHandlers): CliWindowAction[] =>
  Object.entries(handlers).map(([name, handler]) => ({ name, access: handler.access, summary: handler.summary, args: handler.args ?? [] }));

/** A value as JSON, which is all that crosses back to the app; anything that isn't (undefined, a function) is dropped. */
const asJson = (value: unknown): JsonValue | null => (value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue));

/** Runs one request. A change that asks first never runs without `confirm`, even if the app somehow sent it. */
export async function answerCliRequest(handlers: CliHandlers, request: CliRequest): Promise<CliAnswer> {
  const handler = Object.prototype.hasOwnProperty.call(handlers, request.action) ? handlers[request.action] : undefined;
  if (!handler) return { result: null, error: { message: `Arbor's window has no action called ${request.action}.` } };
  if (handler.access === 'confirm' && !request.confirm) {
    return { result: null, error: { message: `${request.action} changes something that asks first; run it again with --yes.` } };
  }
  const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? (request.args as CliArgs) : {};
  try {
    return { result: asJson(await handler.run(args)), error: null };
  } catch (error) {
    return { result: null, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Starts answering the command line, and tells the app which actions the window has. Returns how to stop. */
export function startCliBridge(handlers: CliHandlers): () => void {
  let stopped = false;
  const stop = listen<CliRequest>(CLI_REQUEST_EVENT, ({ payload }) => {
    void answerCliRequest(handlers, payload).then((answer) => invokeCommand('cli_respond', { id: payload.id, ...answer }));
  });
  void stop.then(() => {
    if (!stopped) void invokeCommand('cli_bridge_ready', { actions: cliActions(handlers) }).catch(() => undefined);
  }).catch(() => undefined);
  return () => {
    stopped = true;
    void stop.then((unlisten) => unlisten()).catch(() => undefined);
  };
}

/** A text argument the action needs. */
export function textArg(args: CliArgs, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is needed: pass ${name}=…`);
  return value.trim();
}

/** A yes/no argument, or `fallback` when it isn't given. */
export function booleanArg(args: CliArgs, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} is true or false`);
  return value;
}
