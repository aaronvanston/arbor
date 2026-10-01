import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { answerCliRequest, booleanArg, cliActions, textArg, type CliHandlers } from '../src/services/cliBridge';
import { accountId, cliHandlers } from '../src/services/cliHandlers';

const handlers: CliHandlers = {
  'demo.read': { access: 'read', summary: 'Reads', run: async (args) => ({ got: args.name ?? null, skipped: undefined }) },
  'demo.stop': { access: 'confirm', summary: 'Stops', run: async () => ({ stopped: true }) },
  'demo.fail': { access: 'write', summary: 'Fails', run: async () => { throw new Error('No such account'); } },
};

const ask = (action: string, args: unknown = {}, confirm = false) => answerCliRequest(handlers, { id: 'cli-1', action, args, confirm });

describe('the window’s answers to the command line', () => {
  test('run the action and send back only JSON', async () => {
    expect(await ask('demo.read', { name: 'casey-mbp' })).toEqual({ result: { got: 'casey-mbp' }, error: null });
    expect(await ask('demo.read', ['not', 'an', 'object'])).toEqual({ result: { got: null }, error: null });
  });

  test('say why an action failed, or that there is no such action', async () => {
    expect(await ask('demo.fail')).toEqual({ result: null, error: { message: 'No such account' } });
    expect((await ask('toString')).error?.message).toContain('no action called toString');
  });

  test('never run a change that asks first without confirm', async () => {
    expect((await ask('demo.stop')).error?.message).toContain('--yes');
    expect(await ask('demo.stop', {}, true)).toEqual({ result: { stopped: true }, error: null });
  });

  test('are listed with the app by name, access and arguments', () => {
    expect(cliActions(handlers)[1]).toEqual({ name: 'demo.stop', access: 'confirm', summary: 'Stops', args: [] });
    const pause = cliActions(cliHandlers).find((action) => action.name === 'accounts.pause');
    expect(pause).toMatchObject({ access: 'confirm', args: [{ name: 'account', tsType: 'string', optional: false }] });
  });

  test('name each account by a short id that keeps its email out', () => {
    const key = 'casey@example.com.json::7';
    expect(accountId(key)).toMatch(/^a[0-9a-f]{6}$/);
    expect(accountId(key)).toBe(accountId(key));
    expect(accountId(key)).not.toBe(accountId('casey@example.com.json::8'));
  });

  test('read their arguments strictly', () => {
    expect(textArg({ account: ' work ' }, 'account')).toBe('work');
    expect(() => textArg({}, 'account')).toThrow('account=');
    expect(booleanArg({}, 'refresh', false)).toBe(false);
    expect(() => booleanArg({ refresh: 'yes' }, 'refresh', false)).toThrow();
  });

  test('can’t reach anything that spends or claims a reset', () => {
    const source = readFileSync(new URL('../src/services/cliHandlers.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/consumeCodexResetCredit|claimClaudeBankedReset|codexResetRedeem|quotaActions|reset-quota|managementApi/);
    // Every change that turns an account off or writes to a machine asks first.
    for (const name of ['accounts.pause', 'sync.apply', 'core.install']) expect(cliHandlers[name]?.access).toBe('confirm');
  });
});
