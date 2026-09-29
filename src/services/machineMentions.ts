import type { AlertRecord, AlertSubject } from './alertHistory';
import { machineName } from './machineNames';

/** A stretch of words, or one machine named among them. */
export type MachineMention = { text: string } | { machine: string };

// What a name can run on into: ci-01 inside ci-010 or old-ci-01 isn't ci-01. A full stop or ’s after it still ends it.
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * `text` cut around each of `machines` it names, so what shows it can put that machine's pill where its name was.
 * A machine is found by its own name and by the one it's shown by (`shownAs`, a name given in Arbor), and either way
 * the part holds its own name, which its pill is looked up by. Only whole names count, and where one name holds
 * another the longer is taken. The words are kept as they are, so the parts read back as `text`.
 */
export function machineMentions(text: string, machines: readonly string[], shownAs: (machine: string) => string = (machine) => machine): MachineMention[] {
  const own = new Map<string, string>();
  for (const machine of machines.map((name) => name.trim()).filter(Boolean)) {
    for (const name of [machine, shownAs(machine).trim()]) if (name && !own.has(name)) own.set(name, machine);
  }
  const names = [...own.keys()].sort((a, b) => b.length - a.length);
  const parts: MachineMention[] = [];
  let plain = '';
  let index = 0;
  while (index < text.length) {
    const before = text[index - 1];
    const found = before !== undefined && NAME_CHAR.test(before)
      ? undefined
      : names.find((name) => text.startsWith(name, index) && !NAME_CHAR.test(text[index + name.length] ?? ''));
    if (found) {
      if (plain) parts.push({ text: plain });
      parts.push({ machine: own.get(found) ?? found });
      plain = '';
      index += found.length;
    } else {
      plain += text[index];
      index += 1;
    }
  }
  if (plain) parts.push({ text: plain });
  return parts;
}

// The history is read from storage, so a list that isn't one, or a name that isn't a string, names nothing.
const namesIn = (values: unknown[]) => values.filter((name): name is string => typeof name === 'string' && name !== '');

/**
 * An alert's title and body cut around the machines it's about, as its subject named them when it was sent, never
 * guessed from its words. Its words say the name each was shown by then, so that's looked for too. A down machine's
 * alert names it in its title, and in its body only inside ssh's own error, which stays as ssh wrote it; one about
 * several machines names them in its body in Arbor's words.
 */
export function alertMentions(alert: Pick<AlertRecord, 'kind' | 'title' | 'body' | 'subject'>): { title: MachineMention[]; body: MachineMention[] } {
  const subject: AlertSubject = alert.subject ?? {};
  const several = namesIn(Array.isArray(subject.machines) ? subject.machines : []);
  const machines = [...namesIn([subject.machine]), ...several];
  const sshInBody = alert.kind === 'machineDown' && !several.length;
  return {
    title: machineMentions(alert.title, machines, machineName),
    body: machineMentions(alert.body, sshInBody ? [] : machines, machineName),
  };
}
