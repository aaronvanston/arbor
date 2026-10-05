import { mockIPC } from '@tauri-apps/api/mocks';
import type { CommandName, CommandResult, Commands } from '../../native/commands';
import type { JsonValue } from '../../native/types';

/** What a command is sent: the arguments its entry lists, or nothing for one that takes none. */
type CommandInput<K extends CommandName> = Commands[K] extends { args: infer Args } ? Args : Record<string, never>;

/** A command that returns nothing in Rust sends back `null`. */
type Reply<T> = [T] extends [void] ? null | void : T;

/** A stand-in for a native command: what it returns for these arguments, or a throw where it would fail. */
export type CommandAnswer<K extends CommandName> = (args: CommandInput<K>) => Reply<CommandResult<K>> | Promise<Reply<CommandResult<K>>>;

/** An answer for every command in a domain's list, so the compiler checks each against what Rust returns. */
export type CommandAnswers<Domain> = { [K in keyof Domain & CommandName]: CommandAnswer<K> };

type MockOptions = {
  /** Answers the commands of Tauri's own plugins, which the webview reaches through their APIs; by default `null`. */
  plugins?: (command: string, args: Record<string, unknown>) => unknown;
  /** How long each answer takes, as the native side would. */
  delayMs?: number;
  /** Whether events go between listeners in the page, as `emit` and `listen` would through the native side. */
  events?: boolean;
  /** Sees each call and what it answered once it settles (`failed` when it threw), for `bun run perf`'s counts. */
  observe?: CommandObserver;
};

/** A command the webview sent, with its arguments. */
type CommandCall = { command: string; args: Record<string, unknown> };

export type CommandObserver = (call: CommandCall, reply: unknown, failed: boolean) => void;

/**
 * Stands in for the native side, answering each command the webview invokes. The browser mock passes every domain's
 * answers; a test passes the few its code calls. Either way each answer is checked against the command list, so a
 * stand-in can't drift from what Rust takes and returns. A command with no answer fails. Returns the calls as they
 * come, for a test to check what was sent.
 */
export function mockCommands(answers: Partial<CommandAnswers<Commands>>, { plugins = () => null, delayMs = 0, events = false, observe }: MockOptions = {}) {
  const calls: CommandCall[] = [];
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    const call = { command, args };
    calls.push(call);
    const answer: unknown = Object.prototype.hasOwnProperty.call(answers, command) ? Reflect.get(answers, command) : undefined;
    const answerOnce = () => {
      if (typeof answer === 'function') return (answer as (args: unknown) => unknown)(args);
      if (command.startsWith('plugin:')) return plugins(command, args);
      throw `No answer for ${command}`;
    };
    const reply = () => {
      if (!observe) return answerOnce();
      try {
        const result = answerOnce();
        if (result instanceof Promise) result.then((value) => observe(call, value, false), (error: unknown) => observe(call, error, true));
        else observe(call, result, false);
        return result;
      } catch (error) {
        observe(call, error, true);
        throw error;
      }
    };
    if (!delayMs) return reply();
    const result = reply();
    // A failing answer is a rejected promise from the start; marking it handled now keeps the browser from calling
    // it unhandled during the delay. The chain below still hands the failure to the caller.
    if (result instanceof Promise) result.catch(() => undefined);
    return new Promise((resolve) => window.setTimeout(resolve, delayMs)).then(() => result);
  }, { shouldMockEvents: events });
  return calls;
}

/** A reply from the core's management API, which the native side hands on as it came, built from the webview's types. */
export const coreReply = (reply: unknown) => reply as JsonValue;
