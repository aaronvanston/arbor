import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import type { MessageKey, MessageVariables } from '../src/i18n/resources';
import { alertDestination } from '../src/services/alertHistory';
import { phoneAlertFor } from '../src/services/notify';
import { setupChangeNotification, type SetupChange } from '../src/services/setupChanges';

const t = (key: MessageKey, variables?: MessageVariables) => translate(key, variables);
const change = (fields: Partial<SetupChange> & Pick<SetupChange, 'kind' | 'name' | 'change'>): SetupChange => ({ home: '~/.claude', ...fields });

describe('setupChangeNotification', () => {
  it('names what changed on the Mac, and only counts it by kind for the phone', () => {
    const message = setupChangeNotification({ machine: 'ci-01', changes: [change({ kind: 'mcp', name: 'linear', change: 'changed' })] }, t);
    expect(message).toEqual({
      title: 'Setup changed on ci-01',
      body: 'MCP server linear changed in ~/.claude.',
      phoneBody: '1 change on ci-01 (MCP servers). Open Arbor’s Sync page to see it.',
      kind: 'setupChanged',
      subject: { machine: 'ci-01', changed: ['mcp'] },
    });
    expect(phoneAlertFor(message!).body).not.toContain('linear');
  });

  it('names the first few changes and counts the rest', () => {
    const message = setupChangeNotification({
      machine: 'cedar',
      changes: [
        change({ kind: 'hook', name: 'PreToolUse', change: 'added' }),
        change({ kind: 'plugin', name: 'deploy@acme', change: 'added' }),
        change({ kind: 'marketplace', name: 'acme', change: 'changed' }),
        change({ kind: 'mcp', name: 'sentry', change: 'removed', home: '~/.codex' }),
        change({ kind: 'mcp', name: 'github', change: 'added' }),
      ],
    }, t);
    expect(message?.body).toBe(
      'New PreToolUse hook in ~/.claude; Plugin deploy@acme installed in ~/.claude; Plugin marketplace acme points somewhere else in ~/.claude, and 2 more.',
    );
    expect(message?.phoneBody).toBe('5 changes on cedar (hooks, MCP servers, plugins, plugin marketplaces). Open Arbor’s Sync page to see them.');
  });

  it('sends nothing for no changes, and opens Setup from the alert history', () => {
    expect(setupChangeNotification({ machine: 'ci-01', changes: [] }, t)).toBeNull();
    expect(alertDestination({ kind: 'setupChanged', subject: { machine: 'ci-01' } })).toEqual({ kind: 'setup' });
  });
});
