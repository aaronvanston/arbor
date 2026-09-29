import { describe, expect, test } from 'bun:test';
import { calculateCacheReadRate, calculateGenerationSpeed } from '../src/services/usageMetrics';

describe('generation speed', () => {
  test('uses only the generation interval after the first token', () => {
    const input = { outputTokens: 344, latencyMs: 10_600, ttftMs: 2_770 };
    expect(calculateGenerationSpeed(input)).toBeCloseTo(43.9336, 4);
  });

  test.each([
    { outputTokens: 344, latencyMs: 10_600, ttftMs: 0 },
    { outputTokens: 344, latencyMs: 10_600, ttftMs: null },
    { outputTokens: 344, latencyMs: 2_770, ttftMs: 2_770 },
    { outputTokens: 344, latencyMs: 2_000, ttftMs: 2_770 },
    { outputTokens: 0, latencyMs: 10_600, ttftMs: 2_770 },
  ])('has no speed when it cannot be worked out', (input) => {
    expect(calculateGenerationSpeed(input)).toBeNull();
  });
});

describe('cache read rate', () => {
  test('calculates the percentage from cache-read and input tokens', () => {
    const input = { inputTokens: 1_000, cacheReadTokens: 250 };
    expect(calculateCacheReadRate(input)).toBe(25);
  });

  test('clamps inconsistent values to 100 percent', () => {
    const input = { inputTokens: 400, cacheReadTokens: 600 };
    expect(calculateCacheReadRate(input)).toBe(100);
  });

  test.each([0, -1])('has no rate when input tokens are %s', (inputTokens) => {
    const input = { inputTokens, cacheReadTokens: 250 };
    expect(calculateCacheReadRate(input)).toBeNull();
  });
});
