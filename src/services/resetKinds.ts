import type { MessageKey } from '../i18n/resources';
import type { ClaudeResetKind } from './quotaService';

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/** A kind of Claude banked reset as it reads mid-sentence: "Fable reset". */
export const resetKindName = (t: Translate, kind: ClaudeResetKind) => t(`quota.bankedReset.kind.${kind}`);

/** "3 Fable resets". */
export const resetKindCount = (t: Translate, kind: ClaudeResetKind, count: number) =>
  t(`quota.bankedReset.count.${kind}.${count === 1 ? 'one' : 'other'}`, { count });
