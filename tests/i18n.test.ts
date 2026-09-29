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
});
