import { describe, expect, it } from 'bun:test';
import {
  codexResetCreditDetailsFor,
  codexResetCreditsFor,
  quotaRowsFor,
} from '../src/services/quotaService';
import { itemAt, lastItem } from './support/items';

describe('quotaRowsFor', () => {
  it('把 Codex 的已用百分比转换为剩余额度', () => {
    const rows = quotaRowsFor('codex', {
      rate_limit: {
        allowed: true,
        primary_window: {
          used_percent: 97,
          limit_window_seconds: 604800,
          reset_at: 1784698723,
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Weekly limit');
    expect(rows[0]?.remainingPercent).toBe(3);
    expect(rows[0]?.reset).toBeTruthy();
  });

  it('区分 Codex 的 5 小时、周和月限额', () => {
    const rows = quotaRowsFor('codex', {
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 2_592_000,
        },
      },
      additional_rate_limits: [
        {
          limit_name: '代码审查增强',
          rate_limit: {
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 604_800,
            },
          },
        },
      ],
    });

    expect(rows.map((row) => row.label)).toEqual([
      '5-hour limit',
      'Monthly limit',
      '代码审查增强 Weekly limit',
    ]);
  });

  it('Team 次级窗口缺少时长时与新版一致按周窗口回退，不臆测月限额', () => {
    const rows = quotaRowsFor('codex', {
      plan_type: 'team',
      rate_limit: {
        primary_window: { used_percent: 10 },
        secondary_window: { used_percent: 20 },
      },
    });

    expect(rows.map((row) => row.label)).toEqual(['5-hour limit', 'Weekly limit']);
  });

  it('支持反序窗口且只在有重置时间时推断已耗尽额度', () => {
    const rows = quotaRowsFor('codex', {
      rateLimit: {
        allowed: false,
        primaryWindow: { limitWindowSeconds: 604800 },
        secondaryWindow: { limitWindowSeconds: 18000, resetAfterSeconds: 3600 },
      },
    });
    expect(rows.map((row) => row.label)).toEqual(['5-hour limit', 'Weekly limit']);
    expect(rows.map((row) => row.remainingPercent)).toEqual([0, null]);
    expect(rows[0]?.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('读取 Codex 可用重置额度', () => {
    expect(codexResetCreditsFor({
      rate_limit_reset_credits: { available_count: '2' },
    })).toBe(2);
  });

  it('读取 Codex 重置次数和最早有效过期时间', () => {
    const result = codexResetCreditDetailsFor({
      available_count: '2',
      credits: [
        {
          id: 'later',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-08-20T00:00:00Z',
        },
        {
          id: 'earlier',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-08-12T18:06:25Z',
        },
        {
          id: 'used',
          reset_type: 'codex_rate_limits',
          status: 'used',
          expires_at: '2026-07-20T00:00:00Z',
        },
        {
          id: 'expired',
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: '2026-07-15T00:00:00Z',
        },
      ],
    }, Date.parse('2026-07-16T00:00:00Z'));

    expect(result).toEqual({
      availableCount: 2,
      earliestExpiry: '2026-08-12T18:06:25Z',
    });
  });

  it('重置次数支持 applicable 字段、空列表，不把过期积分算入推断次数', () => {
    expect(codexResetCreditDetailsFor({ credits: [] })).toEqual({ availableCount: undefined, earliestExpiry: undefined });
    expect(codexResetCreditDetailsFor({
      applicableAvailableCount: '0',
      credits: [
        { resetType: 'codex_rate_limits', status: 'available', expiresAt: '2030-01-01T00:00:00Z' },
        { resetType: 'codex_rate_limits', status: 'available', expiresAt: '2020-01-01T00:00:00Z' },
        { resetType: 'codex_rate_limits', status: 'available', expiresAt: 'invalid' },
        { resetType: 'other', status: 'available', expiresAt: '2030-01-01T00:00:00Z' },
      ],
    }, Date.parse('2026-01-01T00:00:00Z'))).toEqual({
      availableCount: 1, applicableAvailableCount: 0, earliestExpiry: '2030-01-01T00:00:00Z',
    });
  });

  it('不会把数组、对象和布尔值当作百分比', () => {
    for (const used of [[], [25], {}, false, '', ' ', NaN, Infinity]) {
      expect(quotaRowsFor('codex', { rate_limit: { primary_window: { used_percent: used } } })[0]?.remainingPercent).toBeNull();
    }
  });

  it('不会把小于 1 的上游百分比错误放大 100 倍', () => {
    const codex = quotaRowsFor('codex', {
      rate_limit: { primary_window: { used_percent: 0.63 } },
    });
    const claude = quotaRowsFor('claude', {
      five_hour: { utilization: 0.44 },
    });

    expect(codex[0]?.remainingPercent).toBeCloseTo(99.37);
    expect(claude[0]?.remainingPercent).toBeCloseTo(99.56);
  });

  it('Claude 优先活动的现代 Fable 窗口，并去除旧字段重复项', () => {
    const limit = (percent: unknown, active: boolean, name = 'Fable') => ({
      kind: 'weekly_scoped', percent, is_active: active,
      scope: { model: { display_name: name } }, resets_at: '2030-01-01T00:00:00Z',
    });
    const rows = quotaRowsFor('claude', {
      iguana_necktie: { utilization: 41 },
      five_hour: { utilization: 10 },
      limits: [null, limit(null, true), limit(12, false, 'Fable 5'), limit(64, true), limit(99, true, 'Sonnet')],
    });
    // Every model-scoped weekly cap is shown, the Sonnet one included.
    expect(rows.map((row) => [row.label, row.remainingPercent])).toEqual([
      ['5-hour window', 90], ['7-day Fable window', 36], ['7-day Sonnet window', 1],
    ]);
    expect(rows[1]?.resetAtMs).toBe(Date.parse('2030-01-01T00:00:00Z'));
  });

  it('maps every other Claude seven_day_* cap and model weekly limit with plain labels, once each', () => {
    const scoped = (name: string, percent: unknown, active?: boolean) => ({
      kind: 'weekly_scoped', percent, ...(active === undefined ? {} : { is_active: active }),
      scope: { model: { display_name: name } }, resets_at: '2030-01-02T00:00:00Z',
    });
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 10 },
      seven_day: { utilization: 40 },
      seven_day_opus: { utilization: 20 },
      seven_day_cowork: { utilization: 5 },
      seven_day_omelette: { utilization: 70, resets_at: '2030-01-03T00:00:00Z' },
      seven_day_deep_research: { utilization: 15 },
      // The 7-day limit under another name, and caps with nothing to show.
      seven_day_overage_included: { utilization: 41 },
      seven_day_haiku: null,
      seven_day_unset: { utilization: null },
      limits: [
        scoped('Fable', 64, true),
        // Another version, or another casing, of a window already shown.
        scoped('fable 5.1', 10),
        // The model's own limit takes the field's row; a replaced version's doesn't.
        scoped('Opus 5', 99),
        scoped('Claude Haiku 4.5', 30, false),
        scoped('Haiku 5', 35, true),
        scoped('Omelette', 1, false),
        scoped('Nameless', null),
        scoped('', 50),
        { kind: 'five_hour', percent: 90 },
      ],
    });
    expect(rows.map((row) => [row.label, row.remainingPercent])).toEqual([
      ['5-hour window', 90],
      ['7-day window', 60],
      ['7-day Opus window', 1],
      ['7-day Cowork window', 95],
      ['7-day Fable window', 36],
      ['7-day Omelette window', 30],
      ['7-day Deep Research window', 85],
      ['7-day Haiku window', 65],
    ]);
    expect(rows.find((row) => row.label === '7-day Omelette window')?.resetAtMs).toBe(Date.parse('2030-01-03T00:00:00Z'));
    expect(rows.find((row) => row.label === '7-day Haiku window')?.resetAtMs).toBe(Date.parse('2030-01-02T00:00:00Z'));
  });

  it('lets a model’s own weekly limit take the row of the field with its label', () => {
    const scoped = (name: string, percent: number, active?: boolean) => ({
      kind: 'weekly_scoped', percent, ...(active === undefined ? {} : { is_active: active }),
      scope: { model: { display_name: name } }, resets_at: '2030-01-02T00:00:00Z',
    });
    const read = (value: Record<string, unknown>) => quotaRowsFor('claude', value).map((row) => [row.label, row.remainingPercent]);
    // The active Opus limit is the cap that blocks requests, whatever the older field says.
    expect(read({ five_hour: { utilization: 10 }, seven_day_opus: { utilization: 5 }, limits: [scoped('Claude Opus 5', 97, true)] }))
      .toEqual([['5-hour window', 90], ['7-day Opus window', 3]]);
    expect(read({ seven_day_opus: { utilization: 0, resets_at: null }, limits: [scoped('Opus 5', 97, true)] })).toEqual([['7-day Opus window', 3]]);
    const opus = quotaRowsFor('claude', { seven_day_opus: { utilization: 5 }, limits: [scoped('Opus 5', 97, true)] })[0]!;
    expect(opus).toMatchObject({ resetAtMs: Date.parse('2030-01-02T00:00:00Z'), windowMs: 7 * 86_400_000 });
    // A field with no figure never hides one, even a replaced version's.
    expect(read({ seven_day_sonnet: { utilization: null }, limits: [scoped('Sonnet 5', 99)] })).toEqual([['7-day Sonnet window', 1]]);
    expect(read({ seven_day_sonnet: { utilization: null }, limits: [scoped('Sonnet 4', 60, false)] })).toEqual([['7-day Sonnet window', 40]]);
    // A replaced version's limit leaves a field with a figure alone.
    expect(read({ seven_day_sonnet: { utilization: 20 }, limits: [scoped('Sonnet 4', 99, false)] })).toEqual([['7-day Sonnet window', 80]]);
  });

  it('reads a Claude reply that only has the newer caps', () => {
    const rows = quotaRowsFor('claude', {
      seven_day_overage_included: { utilization: 25 },
      limits: [{ kind: 'weekly_scoped', percent: 12, scope: { model: { displayName: 'Mythos' } } }],
    });
    expect(rows.map((row) => [row.label, row.remainingPercent])).toEqual([['7-day window', 75], ['7-day Mythos window', 88]]);
  });

  it('shows the active Fable limit when a new Fable version replaces the old one', () => {
    const scoped = (name: string, percent: number, active: boolean) => ({
      kind: 'weekly_scoped', percent, is_active: active, scope: { model: { display_name: name } },
    });
    // The old version's limit is stale and the new one is active: the active one is the cap.
    const replaced = quotaRowsFor('claude', { limits: [scoped('Fable', 5, false), scoped('Fable 5.1', 70, true)] });
    expect(replaced.map((row) => [row.label, row.remainingPercent])).toEqual([['7-day Fable window', 30]]);
    // A new version's limit wins over the legacy field, as the known versions' do.
    const legacy = quotaRowsFor('claude', { iguana_necktie: { utilization: 41 }, limits: [scoped('Claude Fable 5.1', 70, true)] });
    expect(legacy.map((row) => [row.label, row.remainingPercent])).toEqual([['7-day Fable window', 30]]);
  });

  it('Claude 无有效现代 Fable 数据时兼容旧字段', () => {
    const rows = quotaRowsFor('claude', {
      iguana_necktie: { utilization: 41 },
      limits: [{ kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Fable' } } }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: '7-day Fable window', remainingPercent: 59 });
  });

  it('显示 Claude 已启用的额外用量', () => {
    const rows = quotaRowsFor('claude', {
      five_hour: { utilization: 20, resets_at: '2027-01-01T00:00:00Z' },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1250,
        utilization: 25,
      },
    });

    expect(lastItem(rows)).toMatchObject({
      label: 'Extra usage',
      remainingPercent: 75,
    });
    expect(lastItem(rows).detail).toContain('$12.50');
    expect(lastItem(rows).detail).toContain('$50.00');
  });

  it('按剩余量计算 Kimi 和 Antigravity 百分比', () => {
    const kimi = quotaRowsFor('kimi', {
      usage: { used: 99.5, limit: 100 },
    });
    const antigravity = quotaRowsFor('antigravity', {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ remainingFraction: 0.03 }],
        },
      ],
    });

    expect(kimi[0]?.remainingPercent).toBeCloseTo(0.5);
    expect(antigravity[0]?.remainingPercent).toBe(3);
  });

  it('Kimi 短期窗口排在周汇总前，识别 protobuf 时间单位且保留小数', () => {
    const rows = quotaRowsFor('kimi', {
      usage: { used: 99.5, limit: 100 },
      limits: [
        { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, remaining: 80, reset_in: 3600 } },
        { window: { duration: 1, time_unit: 'TIME_UNIT_WEEK' }, detail: { limit: 100, used: 20 } },
        { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, used: 0 } },
        { window: { duration: 90, timeUnit: 'TIME_UNIT_SECOND' }, detail: { limit: 100, used: 0 } },
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(['5 hours window', '7 days window', '5 hours window', '90 seconds window', 'Weekly quota']);
    expect(lastItem(rows).remainingPercent).toBeCloseTo(0.5);
    expect(rows[0]?.remainingPercent).toBe(80);
    expect(rows[0]?.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('Antigravity 把 5h 排在周窗口前，兼容百分数字符串且不修改响应', () => {
    const buckets = [{ window: 'weekly', remainingFraction: '40%' }, { window: 'five_hour', remaining_fraction: 0.8 }];
    const rows = quotaRowsFor('antigravity', { groups: [{ displayName: 'Gemini', buckets }] });
    expect(rows.map((row) => row.remainingPercent)).toEqual([80, 40]);
    expect(buckets[0]?.window).toBe('weekly');
  });

  it('Antigravity 兼容 body 包装的额度响应', () => {
    expect(quotaRowsFor('antigravity', { body: JSON.stringify({ groups: [{ buckets: [{ remainingFraction: 0.5 }] }] }) })[0]?.remainingPercent).toBe(50);
  });

  it('区分 Antigravity 同一分组中的不同窗口', () => {
    const rows = quotaRowsFor('antigravity', {
      groups: [{
        displayName: 'Gemini Pro',
        buckets: [
          { window: '5h', remainingFraction: 0.8 },
          { window: 'weekly', remainingFraction: 0.4 },
        ],
      }],
    });

    expect(rows.map((row) => row.label)).toEqual([
      'Gemini Pro · 5h',
      'Gemini Pro · weekly',
    ]);
  });

  it('xAI 仅返回产品用量时仍能解析，付费账号不伪造剩余额度', () => {
    expect(quotaRowsFor('xai', { config: { productUsage: [{ product: 'grok', usagePercent: 20 }] } })[1])
      .toMatchObject({ label: 'grok', remainingPercent: 80 });
    expect(quotaRowsFor('xai', { mode: 'paid-info' })[0])
      .toMatchObject({ label: 'Paid API account', remainingPercent: null });
  });

  it('xAI 不从月账单借用周窗口的重置时间', () => {
    const rows = quotaRowsFor('xai', {
      weekly: { config: { creditUsagePercent: 25 } },
      monthly: { config: { monthlyLimit: 1000, used: 500, billingPeriodEnd: '2030-01-01T00:00:00Z' } },
    });
    expect(itemAt(rows, 0).resetAtMs).toBeUndefined();
    expect(rows[1]?.resetAtMs).toBe(Date.parse('2030-01-01T00:00:00Z'));
  });

  it('合并 xAI 每周、月度和On-demand quota', () => {
    const rows = quotaRowsFor('xai', {
      weekly: {
        config: {
          currentPeriod: { type: 'weekly', end: '2027-01-01T00:00:00Z' },
          creditUsagePercent: 25,
          productUsage: [{ product: 'grok-code', usagePercent: 40 }],
        },
      },
      monthly: {
        config: {
          monthlyLimit: { val: 1000 },
          used: { val: 1200 },
          onDemandCap: { val: 500 },
          billingPeriodEnd: '2027-01-31T00:00:00Z',
        },
      },
    });

    expect(rows.find((row) => row.label === 'Weekly quota')?.remainingPercent).toBe(75);
    expect(rows.find((row) => row.label === 'grok-code')?.remainingPercent).toBe(60);
    expect(rows.find((row) => row.label === 'Monthly included quota')?.remainingPercent).toBe(0);
    expect(rows.find((row) => row.label === 'On-demand quota')?.remainingPercent).toBe(60);
  });

  it('xAI 保留 0 和 100 的边界值，缺失用量不显示全额余额', () => {
    expect(quotaRowsFor('xai', { config: { creditUsagePercent: 0 } })[0]?.remainingPercent).toBe(100);
    expect(quotaRowsFor('xai', { config: { creditUsagePercent: 100 } })[0]?.remainingPercent).toBe(0);
    expect(quotaRowsFor('xai', { config: { monthlyLimit: { val: 15000 }, used: { val: 0 } } })[0]?.remainingPercent).toBe(100);
    const unknown = itemAt(quotaRowsFor('xai', { config: { monthlyLimit: 15000 } }), 0);
    expect(unknown.remainingPercent).toBeNull();
    expect(unknown.detail).not.toBe('US$150.00 / US$150.00');
    expect(quotaRowsFor('xai', { config: { monthlyLimit: 15000, used: 15000 } })[0]?.remainingPercent).toBe(0);
  });

  it('xAI 按字段合并并保留活动周期，不由月账单补齐周重置时间', () => {
    const rows = quotaRowsFor('xai', {
      weekly: { config: { currentPeriod: { type: 'weekly' } } },
      monthly: { config: { creditUsagePercent: 0, currentPeriod: { type: 'monthly', end: '2030-01-01T00:00:00Z' } } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.remainingPercent).toBe(100);
    expect(itemAt(rows, 0).resetAtMs).toBeUndefined();
  });
});
