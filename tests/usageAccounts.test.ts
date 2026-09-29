import { describe, expect, it } from 'bun:test';
import type { ResolvedProfile } from '../src/services/accountProfiles';
import { accountUsageRows } from '../src/services/usageAccounts';

const profile = (name: string): ResolvedProfile => ({ name, avatar: name, color: 'blue', fill: 'soft', custom: true });
const counts = { requests: 10, failures: 1, tokens: 1_000 };

describe('accountUsageRows', () => {
  it('names each credential by its profile, so one email signed in twice reads as its two accounts', () => {
    const rows = accountUsageRows(
      [
        { authIndex: 'claude-1', label: 'sam@example.com', ...counts },
        { authIndex: 'codex-1', label: 'sam@example.com', ...counts },
      ],
      new Map([['claude-1', profile('P4')], ['codex-1', profile('P1')]]),
      (text) => text,
    );
    expect(rows.map((row) => [row.key, row.label, row.profile?.name])).toEqual([
      ['index:claude-1', 'P4', 'P4'],
      ['index:codex-1', 'P1', 'P1'],
    ]);
    expect(rows[0]).toMatchObject(counts);
  });

  it('keeps what the core called an account whose credential has gone, or requests that carried no index, hidden like any email', () => {
    const hide = (text: string) => text.replace(/^[^@]+/, 's•••m');
    const rows = accountUsageRows(
      [
        { authIndex: 'gone-7', label: 'sam@example.com', ...counts },
        { authIndex: '', label: 'sam@example.com', ...counts },
      ],
      new Map(),
      hide,
    );
    expect(rows.map((row) => [row.key, row.label, 'profile' in row])).toEqual([
      // The same text as an index and as a source stays two rows.
      ['index:gone-7', 's•••m@example.com', false],
      ['source:sam@example.com', 's•••m@example.com', false],
    ]);
  });
});
