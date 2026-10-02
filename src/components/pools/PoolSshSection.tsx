import { useState } from 'react';
import { CommandLine } from '../CommandLine';
import { MachinePill } from '../identity/Identity';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { AlertCircle } from '../ui/icons';
import { Skeleton } from '../ui/skeleton';
import { toast } from '../ui/toast';
import { useI18n } from '../../i18n';
import { invokeCommand } from '../../native/commands';
import type { PoolSsh } from '../../native/types';
import { useNow } from '../../hooks/useNow';
import { READINESS_LABEL, connectionWords, spreadExample, sshBlocker, usePoolSsh } from '../../services/poolSsh';

/** A pool's page: reaching the pool as one SSH host. */
export function PoolSshSection({ poolId }: { poolId: string }) {
  const { ssh, error } = usePoolSsh(poolId);
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-xs/5">
      <PoolSshBody ssh={ssh} error={error} />
    </section>
  );
}

export function PoolSshBody({ ssh, error }: { ssh: PoolSsh | null; error: string | null }) {
  const { t } = useI18n();
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const title = <h3 className="text-sm font-medium">{t('pools.ssh.title')}</h3>;
  if (error) {
    return (
      <>
        {title}
        <Alert variant="error"><AlertCircle /><AlertDescription>{error}</AlertDescription></Alert>
      </>
    );
  }
  if (!ssh) {
    return (
      <>
        {title}
        <Skeleton className="h-8 w-full" />
      </>
    );
  }
  const blocker = sshBlocker(ssh);
  const addInclude = async () => {
    setAdding(true);
    try {
      await invokeCommand('add_pool_ssh_include');
      toast({ title: t('pools.ssh.include.added') });
    } catch (failure) {
      toast({ kind: 'error', title: String(failure) });
    } finally {
      setAdding(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-1">
        {title}
        <p className="text-sm text-muted-foreground">{t('pools.ssh.intro')}</p>
      </div>
      {blocker === 'command' ? (
        <Alert variant="warning"><AlertCircle /><AlertDescription>{t('pools.ssh.needsCommand')}</AlertDescription></Alert>
      ) : (
        <CommandLine command={`ssh ${ssh.host}`} />
      )}
      {blocker !== 'command' && !ssh.included ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{t('pools.ssh.include.title')}</span>
              <span className="text-xs text-muted-foreground">{t('pools.ssh.include.description')}</span>
            </div>
            <Button size="sm" onClick={() => void addInclude()} disabled={adding}>{t('pools.ssh.include.add')}</Button>
          </div>
          <span className="text-xs text-muted-foreground">{t('pools.ssh.include.orCopy')}</span>
          <CommandLine command={ssh.includeLine} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{ssh.user ? t('pools.ssh.members.as', { user: ssh.user }) : t('pools.ssh.members')}</span>
        {blocker === 'members' ? <p className="text-sm text-muted-foreground">{t('pools.ssh.noneReady')}</p> : null}
        <ul className="flex flex-col gap-1.5">
          {ssh.members.map((member) => (
            <li key={member.machine} className="flex flex-wrap items-center gap-2 text-sm">
              <MachinePill name={member.machine} size="sm" />
              <span className={member.readiness === 'ready' ? 'text-foreground' : 'text-muted-foreground'}>
                {t(READINESS_LABEL[member.readiness], { user: ssh.user ?? '' })}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{t('pools.ssh.connections')}</span>
        {ssh.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pools.ssh.noConnections')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ssh.connections.map((connection) => {
              const words = connectionWords(connection, now);
              return (
                <li key={connection.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="font-mono text-xs text-foreground">{connection.name}</code>
                  <MachinePill name={connection.machine} size="sm" />
                  <span className="text-muted-foreground">{t(words.key, words.values)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('pools.ssh.sticky', { example: spreadExample(ssh.host) })}</p>
    </>
  );
}
