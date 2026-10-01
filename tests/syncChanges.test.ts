import { beforeEach, describe, expect, it } from 'bun:test';
import { clearSyncChanges, requestSyncReview, setSyncMcp, setSyncPlugins, syncCounts, takeSyncReview, withSettled } from '../src/services/syncChanges';
import type { PendingMcp } from '../src/services/setupMcp';
import type { PendingPlugins } from '../src/services/setupPlugins';
import type { PluginAction } from '../src/native/types';

const key = (machine: string, what: string) => `${machine}\u0000~/.claude\u0000plugin\u0000${what}`;

// What the store holds, read through its setters' updaters, which see it as it is.
function held() {
  let plugins: PendingPlugins = {};
  let mcp: PendingMcp = {};
  setSyncPlugins((current) => (plugins = current));
  setSyncMcp((current) => (mcp = current));
  return { plugins, mcp };
}

describe('Sync’s chosen changes', () => {
  beforeEach(() => clearSyncChanges());

  it('keeps what each page chose', () => {
    setSyncPlugins({ [key('mini', 'a@m')]: 'uninstall' });
    setSyncPlugins((current) => ({ ...current, [key('air', 'a@m')]: 'uninstall' }));
    setSyncMcp({ 'mini\u0000~/.claude\u0000mcp\u0000linear': 'remove' });
    const now = held();
    expect(Object.keys(now.plugins)).toEqual([key('mini', 'a@m'), key('air', 'a@m')]);
    expect(Object.keys(now.mcp)).toEqual(['mini\u0000~/.claude\u0000mcp\u0000linear']);
    clearSyncChanges();
    expect(held()).toEqual({ plugins: {}, mcp: {} });
  });

  it('counts plugins and MCP servers together, across machines', () => {
    const counts = syncCounts({
      plugins: { [key('mini', 'a@m')]: 'uninstall', [key('air', 'a@m')]: 'uninstall' },
      mcp: { 'mini\u0000~/.claude\u0000mcp\u0000linear': 'remove' },
      review: null,
    });
    expect(counts).toEqual({ total: 3, machines: 2 });
  });

  it('hands a review to the page it belongs to, once', () => {
    expect(takeSyncReview('plugins')).toBeNull();
    requestSyncReview({ kind: 'plugins' });
    expect(takeSyncReview('plugins')).toEqual({ kind: 'plugins' });
    expect(takeSyncReview('plugins')).toBeNull();
  });

  it('keeps the choices for machines a scoped page isn’t showing', () => {
    const current: PendingPlugins = { [key('mini', 'a@m')]: 'uninstall', [key('air', 'b@m')]: 'enable' };
    // Showing only mini, whose choice no longer holds.
    expect(withSettled(current, {}, new Set(['mini']))).toEqual({ [key('air', 'b@m')]: 'enable' });
    expect(withSettled<PluginAction>(current, { [key('mini', 'a@m')]: 'uninstall' }, new Set(['mini', 'air']))).toEqual({ [key('mini', 'a@m')]: 'uninstall' });
  });
});
