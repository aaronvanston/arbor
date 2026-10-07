/**
 * A failure in plain words. Commands, the core and the programs Arbor runs on a machine fail with their own text: ssh's
 * stderr, an OS error with its number, an HTTP status with the URL asked, a thrown Error's "Error: " in front. Screens
 * show the sentence this makes, and keep the raw words (`errorWords`) for a tooltip or details where they have one.
 *
 * A failure that's a `CommandError` is read by its fields (`readCommandError`), never by its sentence. The patterns
 * below only match other programs' text (ssh, the OS, SQLite, HTTP servers, the browser), which Arbor can't reword.
 */
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { readCommandError } from './commandError';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

// What a thrown Error's string, or a program that prints one, puts before its words.
const ERROR_PREFIX = /^\s*(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error:\s+/;

/** A failure's own words, without the "Error: " (or "TypeError: ") a thrown Error's string starts with. */
export function errorWords(error: unknown): string {
  let words = readCommandError(error).message.trim();
  // An error wrapped more than once says it more than once ("Error: Error: …").
  while (ERROR_PREFIX.test(words)) words = words.replace(ERROR_PREFIX, '');
  return words;
}

/** What went wrong, and the next step when there's a usual one, kept apart so a screen with its own can leave it off. */
type Plain = { reason: string; advice: MessageKey | null };

const plain = (reason: string, advice: MessageKey | null = null): Plain => ({ reason, advice });

// A home folder reads as ~, so a path says where it is without the account name in front.
const shortPath = (path: string) => path.trim().replace(/^\/Users\/[^/]+(?=\/|$)/, '~');

// The path an OS error is about, when the words name one: "Couldn't read /path/to/file: Permission denied".
function pathIn(words: string): string | null {
  const match = /(?:^|\s)((?:~|\/)[^:]*?):\s*(?:Permission denied|Operation not permitted|No such file or directory)/.exec(words);
  return match?.[1] ? shortPath(match[1]) : null;
}

function sshFailure(words: string, t: Translate): Plain | null {
  const host = /ssh: (?:connect to host |Could not resolve hostname )([^\s:]+)/.exec(words)?.[1]
    ?? /^(?:\S+@)?([^\s:@]+): Permission denied \(publickey/.exec(words)?.[1];
  if (!host) return null;
  const machine = { machine: host };
  if (/Could not resolve hostname/i.test(words)) return plain(t('plainError.ssh.unknownHost', machine), 'plainError.advice.sshConfig');
  if (/Connection refused/i.test(words)) return plain(t('plainError.ssh.refused', machine), 'plainError.advice.sshServer');
  if (/timed out/i.test(words)) return plain(t('plainError.ssh.timedOut', machine), 'plainError.advice.machineOn');
  if (/Permission denied/i.test(words)) return plain(t('plainError.ssh.keyRefused', machine));
  if (/No route to host|Network is unreachable|Host is down/i.test(words)) return plain(t('plainError.ssh.unreachable', machine), 'plainError.advice.machineOn');
  return plain(t('plainError.ssh.failed', machine));
}

function osFailure(words: string, t: Translate): Plain | null {
  const code = Number(/\(os error (\d+)\)/.exec(words)?.[1] ?? Number.NaN);
  const path = pathIn(words);
  if (code === 13 || code === 1 || /Permission denied|Operation not permitted/.test(words)) {
    return plain(path ? t('plainError.os.denied', { path }) : t('plainError.os.deniedNoPath'), 'plainError.advice.permissions');
  }
  if (code === 2 || /No such file or directory/.test(words)) {
    return plain(path ? t('plainError.os.missing', { path }) : t('plainError.os.missingNoPath'));
  }
  if (code === 48 || /Address already in use/.test(words)) {
    const port = /port (\d+)/.exec(words)?.[1];
    return plain(port ? t('plainError.os.portInUse', { port }) : t('plainError.os.portInUseNoPort'), 'plainError.advice.otherPort');
  }
  if (code === 28 || /No space left on device/.test(words)) return plain(t('plainError.os.diskFull'), 'plainError.advice.freeSpace');
  return null;
}

type StatusKeys = Record<'unauthorized' | 'forbidden' | 'notFound' | 'tooMany' | 'server' | 'other', MessageKey>;

// The core is Arbor's own, so its failures name it; anything else is "the server" Arbor asked.
const CORE_STATUS: StatusKeys = {
  unauthorized: 'plainError.core.unauthorized',
  forbidden: 'plainError.core.forbidden',
  notFound: 'plainError.core.notFound',
  tooMany: 'plainError.core.tooMany',
  server: 'plainError.core.server',
  other: 'plainError.core.other',
};
const HTTP_STATUS: StatusKeys = {
  unauthorized: 'plainError.http.unauthorized',
  forbidden: 'plainError.http.forbidden',
  notFound: 'plainError.http.notFound',
  tooMany: 'plainError.http.tooMany',
  server: 'plainError.http.server',
  other: 'plainError.http.other',
};

function httpFailure(status: number, t: Translate, core: boolean): Plain {
  const keys = core ? CORE_STATUS : HTTP_STATUS;
  const variables = { status };
  if (status === 401) return plain(t(keys.unauthorized, variables), core ? 'plainError.advice.restartCore' : null);
  if (status === 403) return plain(t(keys.forbidden, variables));
  if (status === 404) return plain(t(keys.notFound, variables), core ? 'plainError.advice.updateCore' : null);
  if (status === 429) return plain(t(keys.tooMany, variables), 'plainError.advice.fewMinutes');
  if (status >= 500) return plain(t(keys.server, variables), 'plainError.advice.moment');
  return plain(t(keys.other, variables));
}

function describe(error: unknown, t: Translate): Plain {
  const failure = readCommandError(error);
  // The core answered with a status: say what the status means rather than "Management API error (502): …".
  if (failure.kind === 'core' && typeof failure.status === 'number') return httpFailure(failure.status, t, true);
  const words = errorWords(error);
  if (/Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(words)) {
    return plain(t('plainError.moduleLoad'), 'plainError.advice.restartArbor');
  }
  if (/database is locked|SQLITE_BUSY/i.test(words)) return plain(t('plainError.databaseBusy'), 'plainError.advice.moment');
  // Codex's own words when a marketplace it has doesn't offer the plugin asked for.
  const missing = /plugin `([^`]+)` was not found in marketplace `([^`]+)`/.exec(words);
  if (missing?.[1] && missing[2]) return plain(t('plainError.codex.pluginNotFound', { plugin: missing[1], marketplace: missing[2] }), 'plainError.advice.codexMarketplace');
  const status = /\bHTTP (\d{3})\b/.exec(words)?.[1];
  // Words it doesn't know still end as a sentence, so the next step a screen adds after them reads as one.
  return sshFailure(words, t) ?? osFailure(words, t) ?? (status ? httpFailure(Number(status), t, false) : plain(/[.!?)]$/.test(words) || !words ? words : `${words}.`));
}

/**
 * A failure as a sentence for the screen: what went wrong and, where there's a usual one, what to do. Something it
 * doesn't recognize comes back as its own words, less any "Error: " in front.
 */
export function plainError(error: unknown, t: Translate): string {
  const { reason, advice } = describe(error, t);
  return advice ? `${reason} ${t(advice)}` : reason;
}

/** Only what went wrong, for a sentence that already says what to do next. */
export function plainErrorReason(error: unknown, t: Translate): string {
  return describe(error, t).reason;
}
