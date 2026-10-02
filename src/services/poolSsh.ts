import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { PoolSsh, PoolSshConnection, PoolSshReadiness } from '../native/types';
import { MACHINE_POOLS_UPDATED_EVENT } from './pools';

/**
 * Pools as SSH hosts (see `pool_ssh.rs`): `ssh arbor-<pool>` reaches a member Arbor picks, and each host name is pinned
 * to the member its first connection went to until that member is gone or the name is forgotten. This file has what
 * the pool's page says about it.
 */

export const POOL_SSH_UPDATED_EVENT = 'pool-ssh-updated';

export const READINESS_LABEL: Record<PoolSshReadiness, MessageKey> = {
  ready: 'pools.ssh.readiness.ready',
  noAddress: 'pools.ssh.readiness.noAddress',
  noHostKey: 'pools.ssh.readiness.noHostKey',
  otherUser: 'pools.ssh.readiness.otherUser',
  thisMac: 'pools.ssh.readiness.thisMac',
};

/** What stands between the pool and `ssh <host>`, the first thing to fix first; null once nothing does. */
export type SshBlocker = 'command' | 'include' | 'members';

export function sshBlocker(ssh: Pick<PoolSsh, 'commandReady' | 'included' | 'members'>): SshBlocker | null {
  if (!ssh.commandReady) return 'command';
  if (!ssh.included) return 'include';
  if (!ssh.members.some((member) => member.readiness === 'ready')) return 'members';
  return null;
}

/** A host name's state in words: its connections open now, or that none is. */
export function connectionWords(connection: PoolSshConnection): { key: MessageKey; values: Record<string, number> } {
  if (connection.open > 0) {
    return { key: connection.open === 1 ? 'pools.ssh.connection.open.one' : 'pools.ssh.connection.open.other', values: { count: connection.open } };
  }
  return { key: 'pools.ssh.connection.closed', values: {} };
}

/** Why a host name can't be forgotten yet, or null when it can: connections still open would be left on its machine. */
export const forgetBlocker = (connection: PoolSshConnection): MessageKey | null => (connection.open > 0 ? 'pools.ssh.forget.open' : null);

/** Another host name for the same pool, for showing how to spread workspaces. */
export const spreadExample = (host: string) => `${host}-b`;

/** A pool's SSH, read again whenever its connections or the pools change. */
export function usePoolSsh(poolId: string) {
  const [ssh, setSsh] = useState<PoolSsh | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setSsh(await invokeCommand('get_pool_ssh', { poolId }));
      setError(null);
    } catch (failure) {
      setError(String(failure));
    }
  }, [poolId]);
  useEffect(() => {
    setSsh(null);
    void reload();
    const unlisten = [POOL_SSH_UPDATED_EVENT, MACHINE_POOLS_UPDATED_EVENT].map((event) => listen(event, () => void reload()));
    return () => {
      for (const stop of unlisten) void stop.then((off) => off());
    };
  }, [reload]);
  return { ssh, error, reload };
}
