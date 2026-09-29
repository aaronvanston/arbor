import { describe, expect, test } from 'bun:test';
import { failureSummary } from '../src/services/usageRequestsGrid';

describe('failure summary', () => {
  test('reads nested provider error messages and falls back to the raw body', () => {
    expect(failureSummary('{"error":{"type":"rate_limit_error","message":"Rate limited"}}')).toBe('Rate limited');
    expect(failureSummary('{"error":"Bad key"}')).toBe('Bad key');
    expect(failureSummary('{"detail":"Not found"}')).toBe('Not found');
    expect(failureSummary('upstream timeout')).toBe('upstream timeout');
    expect(failureSummary('   ')).toBe('');
    expect(failureSummary('{"unexpected":true}')).toBe('{"unexpected":true}');
  });
});
