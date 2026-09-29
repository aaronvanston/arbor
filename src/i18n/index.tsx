import { createContext, Fragment, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { getMachineNames, machineNameIn, useMachineNames, type MachineNames } from '../services/machineNames';
import { en, type MessageKey, type MessageVariables } from './resources';

/** Placeholders that always hold a machine's own name, so they say the name it's shown by (services/machineNames). */
const MACHINE_VARIABLES: ReadonlySet<string> = new Set(['machine', 'reference']);

function interpolate(template: string, variables: MessageVariables | undefined, machines: MachineNames): string {
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) return match;
    const value = variables[name];
    return MACHINE_VARIABLES.has(name) && typeof value === 'string' ? machineNameIn(machines, value) : String(value);
  });
}

export function translate(key: MessageKey, variables?: MessageVariables, machines: MachineNames = getMachineNames()): string {
  return interpolate(en[key], variables, machines);
}

/** What a rich message's placeholders take: words and numbers, or elements such as a machine's pill. */
export type RichVariables = Record<string, ReactNode>;

/**
 * A message with its `{placeholders}` filled by elements as well as words, so a machine's pill can sit in the middle
 * of a sentence. For visible text only: labels, titles and notifications need `translate`'s plain string.
 */
export function translateRich(key: MessageKey, variables: RichVariables, machines: MachineNames = getMachineNames()): ReactNode {
  return en[key].split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!part) return null;
    if (name === undefined || !Object.prototype.hasOwnProperty.call(variables, name)) return <Fragment key={index}>{part}</Fragment>;
    // A machine given as words says the name it's shown by, as in `translate`; a pill already does.
    const value = variables[name];
    return <Fragment key={index}>{MACHINE_VARIABLES.has(name) && typeof value === 'string' ? machineNameIn(machines, value) : value}</Fragment>;
  });
}

type I18nContextValue = {
  t: (key: MessageKey, variables?: MessageVariables) => string;
  /** `t` for visible text whose placeholders may be elements, like a machine's pill. */
  tRich: (key: MessageKey, variables: RichVariables) => ReactNode;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/** The UI is English only (index.html says so); dates and numbers follow the Mac's region, in src/lib/format. */
export function I18nProvider({ children }: { children: ReactNode }) {
  // A machine renamed in Arbor changes what `{machine}` says, so `t` is a new function then and its users render again.
  const machineNames = useMachineNames();
  const t = useCallback(
    (key: MessageKey, variables?: MessageVariables) => translate(key, variables, machineNames),
    [machineNames],
  );
  const tRich = useCallback(
    (key: MessageKey, variables: RichVariables) => translateRich(key, variables, machineNames),
    [machineNames],
  );
  const context = useMemo<I18nContextValue>(() => ({ t, tRich }), [t, tRich]);

  return <I18nContext.Provider value={context}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}
