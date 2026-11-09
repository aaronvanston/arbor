import { useEffect, useState } from 'react';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { invokeCommand } from '../native/commands';
import type { ThinkingAliasSource } from '../native/types';
import { plainErrorReason } from './plainError';

/** A model the proxy serves, once per name however many providers serve it, as a model picker lists it. */
export type ModelChoice = {
  model: string;
  displayName: string | null;
  /** The providers that serve it, in the order the core lists them. */
  providers: string[];
  /** The reasoning efforts it takes; none when it has no say over reasoning. */
  reasoningLevels: string[];
};

/**
 * The proxy's models, one per name: a request names a model, not the provider behind it, so a model two providers
 * serve is one choice that takes any effort either does.
 */
export function modelChoices(sources: readonly ThinkingAliasSource[]): ModelChoice[] {
  const choices = new Map<string, ModelChoice>();
  for (const source of sources) {
    const key = source.model.trim().toLowerCase();
    if (!key) continue;
    const known = choices.get(key);
    if (!known) {
      choices.set(key, { model: source.model.trim(), displayName: source.displayName, providers: [source.provider], reasoningLevels: [...source.reasoningLevels] });
      continue;
    }
    known.displayName ??= source.displayName;
    if (!known.providers.includes(source.provider)) known.providers.push(source.provider);
    for (const level of source.reasoningLevels) {
      if (!known.reasoningLevels.includes(level)) known.reasoningLevels.push(level);
    }
  }
  return [...choices.values()];
}

/** The choice a saved model name is, when the proxy lists it. */
export const findModelChoice = (choices: readonly ModelChoice[], model: string): ModelChoice | null => {
  const key = model.trim().toLowerCase();
  return choices.find((choice) => choice.model.toLowerCase() === key) ?? null;
};

/** How well one word of a search matches a choice, lower is better; null when it doesn't. */
function wordScore(choice: ModelChoice, word: string): number | null {
  const model = choice.model.toLowerCase();
  const name = (choice.displayName ?? '').toLowerCase();
  if (model === word) return 0;
  if (name === word) return 1;
  if (model.startsWith(word)) return 2;
  if (name.startsWith(word)) return 3;
  // A word that starts a part of the name: `luna` in `gpt-6-luna`.
  if (model.split(/[^a-z0-9]+/).some((part) => part.startsWith(word))) return 4;
  if (name.split(/[^a-z0-9]+/).some((part) => part.startsWith(word))) return 5;
  if (model.includes(word) || name.includes(word)) return 6;
  if (choice.providers.some((provider) => provider.toLowerCase().includes(word))) return 7;
  return null;
}

/** The choices a search keeps, best match first, in the core's order between equals. Every word has to match. */
export function searchModelChoices(choices: readonly ModelChoice[], query: string): ModelChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...choices];
  const scored: Array<{ choice: ModelChoice; score: number; index: number }> = [];
  choices.forEach((choice, index) => {
    let score = 0;
    for (const word of words) {
      const matched = wordScore(choice, word);
      if (matched === null) return;
      score += matched;
    }
    scored.push({ choice, score, index });
  });
  return scored.sort((left, right) => left.score - right.score || left.index - right.index).map((item) => item.choice);
}

/**
 * The name a search offers to use as typed: an alias, or a model the list doesn't have while the proxy can't be
 * asked. Null when it's one of the choices already, or isn't one word.
 */
export function typedModel(choices: readonly ModelChoice[], query: string): string | null {
  const name = query.trim();
  if (!name || /\s/.test(name) || findModelChoice(choices, name)) return null;
  return name;
}

/** The efforts offered for a model nobody can vouch for: one typed in, or any while the proxy's list isn't read. */
const COMMON_EFFORTS = ['low', 'medium', 'high'];

/**
 * The efforts to offer beside a model: its own when the proxy lists it, the common three otherwise. The saved one
 * stays in an unknown model's list, so the control never shows a value it doesn't offer.
 */
export function effortChoices(choice: ModelChoice | null, saved: string): string[] {
  if (choice) return choice.reasoningLevels;
  return !saved || COMMON_EFFORTS.includes(saved) ? COMMON_EFFORTS : [...COMMON_EFFORTS, saved];
}

/** The effort a newly picked model starts with: the one in use when it takes it, else its lowest, else none. */
export function effortForModel(choice: ModelChoice | null, current: string): string {
  const levels = effortChoices(choice, current);
  if (levels.includes(current)) return current;
  return levels.includes('low') ? 'low' : levels[0] ?? '';
}

const EFFORT_LABEL: Record<string, MessageKey> = {
  none: 'modelPicker.effort.none',
  auto: 'modelPicker.effort.auto',
  minimal: 'modelPicker.effort.minimal',
  low: 'modelPicker.effort.low',
  medium: 'modelPicker.effort.medium',
  high: 'modelPicker.effort.high',
  xhigh: 'modelPicker.effort.xhigh',
  max: 'modelPicker.effort.max',
};

/** An effort's name, or null for one Arbor has no word for, which shows as the core spells it. */
export const effortLabelKey = (effort: string): MessageKey | null => EFFORT_LABEL[effort] ?? null;

/** The proxy's models for a picker: still being read, read, or why they couldn't be. */
export type ModelChoicesState =
  | { status: 'loading'; choices: ModelChoice[] }
  | { status: 'ready'; choices: ModelChoice[] }
  | { status: 'failed'; choices: ModelChoice[]; error: string };

/**
 * Reads the proxy's models once for the control that shows them, and again on `reload`. A failed read keeps what
 * the last one found.
 */
export function useModelChoices(t: (key: MessageKey, variables?: MessageVariables) => string): ModelChoicesState & { reload: () => void } {
  const [state, setState] = useState<ModelChoicesState>({ status: 'loading', choices: [] });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    invokeCommand('get_model_alias_sources').then(
      (sources) => { if (current) setState({ status: 'ready', choices: modelChoices(sources) }); },
      (reason) => { if (current) setState((previous) => ({ status: 'failed', choices: previous.choices, error: plainErrorReason(reason, t) })); },
    );
    return () => { current = false; };
  }, [round, t]);
  return { ...state, reload: () => setRound((value) => value + 1) };
}
