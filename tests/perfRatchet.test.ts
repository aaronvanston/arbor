import { describe, expect, test } from 'bun:test';
import { allowed, check, ratchet, type Baseline } from '../perf/ratchet';
import { decodeMappings } from '../perf/sourcemap';

const baseline = (ceilings: Baseline['ceilings'], tolerance: Baseline['tolerance'] = {}): Baseline => ({ tolerance, ceilings });

describe('perf ceilings', () => {
  test('a count at its ceiling passes and one past it fails', () => {
    const rows = check(baseline({ 'default.idle.commandsPerMinute': 17.4, 'default.launch.commands': 83 }), {
      'default.idle.commandsPerMinute': 17.4,
      'default.launch.commands': 84,
    });
    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ['default.idle.commandsPerMinute', 'ok'],
      ['default.launch.commands', 'over'],
    ]);
  });

  test('tolerance applies by the counter name, the larger of its fraction and its fixed amount', () => {
    const held = baseline(
      { 'real.launch.reactCommits': 120, 'real.page.pools.reactCommits': 5, 'real.page.pools.commands': 3 },
      { reactCommits: { relative: 0.05, absolute: 2 } },
    );
    expect(allowed(held, 'real.launch.reactCommits')).toBe(126);
    expect(allowed(held, 'real.page.pools.reactCommits')).toBe(7);
    expect(allowed(held, 'real.page.pools.commands')).toBe(3);
    expect(check(held, { 'real.page.pools.reactCommits': 7 })[2]?.status).toBe('ok');
    expect(check(held, { 'real.page.pools.reactCommits': 8 })[2]?.status).toBe('over');
  });

  test('new and unmeasured counters are told apart from failures', () => {
    const rows = check(baseline({ 'default.launch.commands': 83 }), { 'default.launch.domMutations': 321 });
    expect(rows.map((row) => row.status)).toEqual(['missing', 'new']);
  });

  test('the ratchet lowers ceilings, adds new ones and never raises one', () => {
    const next = ratchet(baseline({ a: 10, b: 10, c: 10 }, { b: { relative: 0.05 } }), { a: 7, b: 12, d: 3 });
    expect(next.ceilings).toEqual({ a: 7, b: 10, c: 10, d: 3 });
    expect(next.tolerance).toEqual({ b: { relative: 0.05 } });
  });
});

describe('source map mappings', () => {
  test('decode to generated columns and source positions', () => {
    // "AAAA,CAAC;AACA": line 1 columns 0 and 1 from source 0 line 0 columns 0 and 1; line 2 column 0 from line 1.
    expect(decodeMappings('AAAA,CAAC;AACA')).toEqual([
      [[0, 0, 0, 0, -1], [1, 0, 0, 1, -1]],
      [[0, 0, 1, 1, -1]],
    ]);
  });
});
