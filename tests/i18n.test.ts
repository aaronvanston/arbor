import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { en } from '../src/i18n/resources';
import { britishSpellings } from '../scripts/us-spelling.mjs';

describe('English-only interface', () => {
  it('preserves interpolation and technical terminology', () => {
    expect(translate('releaseNotes.changesIn', { version: '1.2.3' })).toBe('Changes in 1.2.3');
    expect(translate('kernel.access.openaiDescription')).toBe('OpenAI-compatible format');
    expect(translate('accounts.left')).toBe('left');
  });

  it('contains nonempty English messages without Chinese or Japanese translations', () => {
    expect(Object.entries(en).filter(([, message]) => !message.trim() || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(message))).toEqual([]);
  });

  it('is spelled the US way, apart from search keywords, which also match what people type', () => {
    const british = Object.entries(en)
      .filter(([key]) => !key.includes('.keywords.'))
      .flatMap(([key, message]) => britishSpellings(message).map((word) => `${key}: ${word}`));
    expect(british).toEqual([]);
  });

  // money-8: one name for a provider's sign-in file, apart from search keywords that also match the old one.
  it('calls sign-in files credential files', () => {
    expect(Object.entries(en).filter(([key, message]) => !key.toLowerCase().includes('keywords') && /authentication files?\b/i.test(message))).toEqual([]);
  });

  // money-27: Settings' machine-scope copy puts the machine's pill in the sentence, and a pill can't take a possessive.
  it('never puts a possessive straight after a machine pill in scoped Settings copy', () => {
    expect(Object.entries(en).filter(([key, message]) => /^(machineScope|agentHomes)\./.test(key) && /\{machine\}[’']s\b/.test(message))).toEqual([]);
  });

  // money-4: a confirm's warning names its button the way the button reads.
  it('names the reset button as it reads', () => {
    expect(en['quota.confirm.warning']).toContain(en['quota.confirm.button']);
    expect(en['quota.bankedReset.confirm.warning']).toContain(en['quota.confirm.button']);
  });
});
