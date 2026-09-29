import { useEffect, useState, type ReactNode } from 'react';
import { invokeCommand } from '../native/commands';
import { ArrowUpRight } from '../components/ui/icons';
import { MachinePill } from '../components/identity/Identity';
import { SettingsBlock } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { ANTIBURN_URL, antiburnReach } from '../services/antiburn';
import { trackFeature } from '../services/productAnalytics';
import type { AntiburnStatus, SessionTranscript } from '../native/types';

/** Antiburn's mark: its lowercase a, lit in a five-by-five grid of dots. */
const MARK = ['.###.', '....#', '.####', '#...#', '.##.#'];

function AntiburnMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={cn('size-5 shrink-0', className)}>
      <rect width="20" height="20" rx="5" fill="#474b54" />
      {MARK.flatMap((row, y) =>
        [...row].map((cell, x) => <circle key={`${x}-${y}`} cx={3.6 + x * 3.2} cy={3.6 + y * 3.2} r="1.2" fill={cell === '#' ? '#f26b21' : '#585d67'} />),
      )}
    </svg>
  );
}

/**
 * The last row of a session's checks: Antiburn checks more than Arbor can see from the proxy, like skills and MCP
 * servers that go unused. It opens Antiburn when it's on this Mac, saying whether Antiburn lists this session, and
 * links to its site when it isn't.
 */
export function SessionAntiburn({ transcript }: { transcript: SessionTranscript | null }) {
  const [status, setStatus] = useState<AntiburnStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    invokeCommand('get_antiburn')
      .then((next) => {
        if (!disposed) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  return status ? <AntiburnRow status={status} transcript={transcript} /> : null;
}

/** The row itself, once Arbor knows whether Antiburn is on this Mac. */
export function AntiburnRow({ status, transcript }: { status: AntiburnStatus; transcript: SessionTranscript | null }) {
  const { t, tRich } = useI18n();
  const reach = antiburnReach(status, transcript);
  const body: ReactNode =
    reach === 'missing'
      ? t('sessions.antiburn.missing')
      : reach === 'listed'
        ? t('sessions.antiburn.listed')
        : reach === 'otherHome'
          ? t('sessions.antiburn.otherHome', { home: transcript?.agentHome ?? '' })
          : reach === 'otherMachine'
            ? tRich('sessions.antiburn.otherMachine', { machine: <MachinePill name={transcript?.machine} size="sm" /> })
            : t('sessions.antiburn.unknown');

  const open = () => {
    const opened = reach === 'missing' ? invokeCommand('open_external_url', { url: ANTIBURN_URL }) : invokeCommand('open_antiburn');
    opened
      .then(() => trackFeature('antiburn-opened', { kind: reach === 'missing' ? 'site' : 'app' }))
      .catch((error: unknown) => toast({ kind: 'error', title: t('about.openFailed', { name: 'Antiburn' }), description: String(error) }));
  };

  return (
    <SettingsBlock className="flex items-start gap-3">
      <AntiburnMark className="-mt-px" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{t('sessions.antiburn.title')}</p>
        <p className="mt-0.5 text-xs leading-[1.45] text-muted-foreground">{body}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button variant="outline" size="xs" onClick={open}>
            {t(reach === 'missing' ? 'sessions.antiburn.get' : 'sessions.antiburn.open')}
            <ArrowUpRight />
          </Button>
          <span className="text-2xs text-muted-foreground">{t('sessions.antiburn.credit')}</span>
        </div>
      </div>
    </SettingsBlock>
  );
}
