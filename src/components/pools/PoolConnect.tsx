import { useState } from 'react';
import { CommandLine } from '../CommandLine';
import { MachinePill } from '../identity/Identity';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../ui/dialog';
import { AlertCircle } from '../ui/icons';
import { Skeleton } from '../ui/skeleton';
import { toast } from '../ui/toast';
import { useI18n } from '../../i18n';
import { requestFocus } from '../../focusRequests';
import type { AppView } from '../../navigation';
import { invokeCommand } from '../../native/commands';
import type { PoolSsh, PoolSshConnection } from '../../native/types';
import { formatDate } from '../../lib/format';
import { READINESS_LABEL, connectionWords, forgetBlocker, spreadExample, sshBlocker, usePoolSsh } from '../../services/poolSsh';

// Settings › App's row that installs the arbor command.
const CLI_INSTALL_SETTING = 'software.cli-install';

/**
 * A pool's Connect dialog: reaching the pool as one SSH host. It sits behind a button rather than on the page, since
 * it's set up once and the page is for the pool's load and runs.
 */
export function PoolConnectDialog({ poolId, onClose, onNavigate }: { poolId: string | null; onClose: () => void; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={poolId !== null} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('pools.ssh.title')}</DialogTitle>
          <DialogDescription>{t('pools.ssh.intro')}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 pb-6">
          {poolId ? (
            <PoolConnectBody
              poolId={poolId}
              onInstallCommand={() => {
                requestFocus('setting', CLI_INSTALL_SETTING);
                onClose();
                onNavigate({ kind: 'settings', page: 'software' });
              }}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function PoolConnectBody({ poolId, onInstallCommand }: { poolId: string; onInstallCommand: () => void }) {
  const { ssh, error } = usePoolSsh(poolId);
  return <PoolSshBody poolId={poolId} ssh={ssh} error={error} onInstallCommand={onInstallCommand} />;
}

export function PoolSshBody({ poolId, ssh, error, onInstallCommand }: {
  poolId: string;
  ssh: PoolSsh | null;
  error: string | null;
  /** Opens where the arbor command is installed, which ssh needs to reach the pool. */
  onInstallCommand: () => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  if (error) return <Alert variant="error"><AlertCircle /><AlertDescription>{error}</AlertDescription></Alert>;
  if (!ssh) return <Skeleton className="h-8 w-full" />;
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
  const forget = async (connection: PoolSshConnection) => {
    setForgetting(connection.name);
    try {
      await invokeCommand('forget_pool_ssh_name', { poolId, name: connection.name });
      toast({ title: t('pools.ssh.forget.done', { name: connection.name }) });
    } catch (failure) {
      toast({ kind: 'error', title: String(failure) });
    } finally {
      setForgetting(null);
    }
  };
  return (
    <>
      {blocker === 'command' ? (
        <Alert variant="warning">
          <AlertCircle />
          <AlertDescription className="flex flex-col items-start gap-2">
            {t('pools.ssh.needsCommand')}
            <Button variant="outline" size="xs" onClick={onInstallCommand}>{t('pools.ssh.installCommand')}</Button>
          </AlertDescription>
        </Alert>
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
        <span className="text-xs font-medium text-muted-foreground">{ssh.user ? t('pools.ssh.members.as', { user: ssh.user }) : t('pools.ssh.members')}</span>
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
        <span className="text-xs font-medium text-muted-foreground">{t('pools.ssh.connections')}</span>
        {ssh.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pools.ssh.noConnections')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ssh.connections.map((connection) => {
              const words = connectionWords(connection);
              const blocked = forgetBlocker(connection);
              return (
                <li key={connection.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="font-mono text-xs text-foreground">{connection.name}</code>
                  <MachinePill name={connection.machine} size="sm" />
                  <span className="text-muted-foreground">
                    {t(words.key, words.values)} · {t('pools.ssh.connection.since', { date: formatDate(connection.pickedAtMs) })}
                  </span>
                  <Button
                    className="ml-auto"
                    size="xs"
                    variant="ghost"
                    aria-label={t('pools.ssh.forget.label', { name: connection.name })}
                    disabled={blocked !== null || forgetting === connection.name}
                    disabledReason={blocked ? t(blocked) : undefined}
                    onClick={() => void forget(connection)}
                  >
                    {t('pools.ssh.forget')}
                  </Button>
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
