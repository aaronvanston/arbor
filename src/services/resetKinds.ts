import type { MessageKey } from '../i18n/resources';
import type { ResetMark } from './limitForecast';
import type { ClaudeResetKind } from './quotaService';

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/** A kind of Claude banked reset as it reads mid-sentence: "Fable reset". */
export const resetKindName = (t: Translate, kind: ClaudeResetKind) => t(`quota.bankedReset.kind.${kind}`);

/** "3 Fable resets". */
export const resetKindCount = (t: Translate, kind: ClaudeResetKind, count: number) =>
  t(`quota.bankedReset.count.${kind}.${count === 1 ? 'one' : 'other'}`, { count });

/**
 * A mark on the forecast chart in words: "Used a weekly reset on cam-work · +80%". `gain` is what it added back, as
 * it reads, or null when the readings show nothing for it.
 */
export function resetMarkLine(t: Translate, mark: ResetMark, gain: string | null): string {
  const { name } = mark;
  const reset = mark.reset ? resetKindName(t, mark.reset) : null;
  const event = mark.how === 'early' ? t('forecast.mark.early', { name })
    : mark.how === 'planned' ? (reset ? t('forecast.mark.plannedKind', { reset, name }) : t('forecast.mark.planned', { name }))
      : reset ? t('forecast.mark.usedKind', { reset, name }) : t('forecast.mark.used', { name });
  return gain === null ? event : t('forecast.mark.gain', { event, gain });
}
