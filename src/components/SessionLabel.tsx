import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { MachinePill } from './identity/Identity';
import { MetaLine } from './MetaLine';
import { sessionClient, sessionPlace, shortSessionId } from '../services/usageSessions';
import type { UsageSession } from '../native/types';

/**
 * A session as the Sessions list names it, for places that only show it: its title (or its client), then
 * its project and branch (or its short id), optionally the machine it ran on as its pill, and anything else after that.
 */
export function SessionLabel({ session, machine = false, extra, className }: { session: UsageSession; machine?: boolean; extra?: ReactNode; className?: string }) {
  const { t } = useI18n();
  const client = sessionClient(session.userAgent);
  const name = client ? [client.name, client.version].filter(Boolean).join(' ') : t('usage.sessions.unknownClient');
  const title = session.transcript?.title ?? '';
  const place = sessionPlace(session.transcript);
  const where = machine ? session.machine || session.transcript?.machine || '' : '';
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="block truncate font-medium text-foreground">
        {title || name}
        {!title && client?.host ? <span className="font-normal text-muted-foreground"> · {client.host}</span> : null}
      </span>
      <MetaLine
        className="mt-0.5"
        title={place?.folder ?? session.id}
        parts={[
          place ? place.project : <span key="id" className="min-w-0 truncate font-mono">{shortSessionId(session.id)}</span>,
          place?.branch && place.branch !== place.project ? <span key="branch" className="min-w-0 truncate font-mono">{place.branch}</span> : null,
          where ? <MachinePill key="machine" name={where} size="sm" className="shrink-0" /> : null,
          extra,
        ]}
      />
    </span>
  );
}
