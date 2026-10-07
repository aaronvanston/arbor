import { describe, expect, it } from 'bun:test';
import { durationWords } from '../src/services/durationWords';

describe('durationWords', () => {
  it('says a setting the way its picker does', () => {
    expect(durationWords(15)).toBe('15 s');
    expect(durationWords(300)).toBe('5 min');
    expect(durationWords(3600)).toBe('1 h');
    expect(durationWords(12 * 3600)).toBe('12 h');
    expect(durationWords(90 * 60)).toBe('1 h 30 min');
    expect(durationWords(24 * 3600)).toBe('24 h');
  });

  it('reads nothing sensible as zero seconds', () => {
    expect(durationWords(Number.NaN)).toBe('0 s');
    expect(durationWords(-5)).toBe('0 s');
  });
});
