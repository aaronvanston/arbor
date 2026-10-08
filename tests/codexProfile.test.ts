import { describe, expect, it } from 'bun:test';
import { codexProfileFor } from '../src/services/codexProfile';

const answer = {
  profile: { username: 'cam', display_name: 'Cam Example', profile_picture_url: 'https://example.com/cam.png' },
  stats: {
    lifetime_tokens: 18_009_410_108,
    peak_daily_tokens: 1_951_152_385,
    current_streak_days: 0,
    longest_streak_days: 11,
    total_threads: 5_884,
    longest_running_turn_sec: 41_495,
    fast_mode_usage_percentage: 2.83,
    most_used_reasoning_effort: 'xhigh',
    most_used_reasoning_effort_percentage: 37.8,
    total_skills_used: 2_419,
    unique_skills_used: 84,
    daily_usage_buckets: [{ start_date: '2026-08-06', tokens: 515_522_364 }, { start_date: 'bad' }, 'nope'],
    top_invocations: [{ type: 'skill', skill_name: 'code-review' }],
  },
  metadata: { stats_as_of: '2026-10-08' },
};

describe('ChatGPT’s profile counts for a Codex account', () => {
  it('keep the numbers and leave the names, picture and skills out', () => {
    const profile = codexProfileFor(answer);
    expect(profile).toMatchObject({ lifetimeTokens: 18_009_410_108, peakDailyTokens: 1_951_152_385, threads: 5_884, reasoningEffort: 'xhigh', asOf: '2026-10-08' });
    expect(profile?.days).toEqual([{ day: '2026-08-06', tokens: 515_522_364 }]);
    const shown = JSON.stringify(profile);
    for (const kept of ['cam', 'Cam Example', 'example.com', 'code-review']) expect(shown).not.toContain(kept);
  });

  it('are nothing without a lifetime count', () => {
    expect(codexProfileFor({ stats: {} })).toBeNull();
    expect(codexProfileFor({ detail: 'Unauthorized' })).toBeNull();
    expect(codexProfileFor(null)).toBeNull();
  });
});
