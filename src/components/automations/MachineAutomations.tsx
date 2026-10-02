import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { formatWhen } from '../../lib/format';
import { automationsView, automationView, type AppView } from '../../navigation';
import { filterAutomations, RUN_STATUS_LABEL, scheduleWords, SOURCE_LABEL, useAutomations } from '../../services/automations';
import { ProviderMark } from '../identity/Identity';
import { SettingsBlock, SettingsSection } from '../layout/settings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ArrowUpRight, TimeSchedule } from '../ui/icons';

/** A machine's page: what's scheduled to run there, Arbor's own first, each opening its own page. */
export function MachineAutomations({ machine, small, onNavigate }: { machine: string; small: ReactNode; onNavigate: (view: AppView) => void }) {
  const { t, tRich } = useI18n();
  const { list } = useAutomations();
  if (!list) return null;
  const here = filterAutomations(list.automations.filter((item) => item.target.kind === 'machine'), { search: '', source: 'all', machine });
  return (
    <SettingsSection
      title={t('automations.machine.title')}
      description={t('automations.machine.description')}
      summary={here.length ? t(here.length === 1 ? 'automations.machine.count.one' : 'automations.machine.count.other', { count: here.length }) : undefined}
      headerAction={(
        <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(automationsView({ machine }))}>
          {t('automations.machine.all')}
          <ArrowUpRight />
        </Button>
      )}
    >
      {here.length ? (
        <div className="flex flex-col py-1.5">
          {here.map((item) => (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 dark:hover:bg-input/16 dark:focus-visible:bg-input/16"
              onClick={() => onNavigate(automationView(item.id))}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1.5 dark:bg-input/32">
                {item.agent ? <ProviderMark provider={item.agent} decorative className="size-full object-contain" fallback={<TimeSchedule className="size-3.5 text-muted-foreground" />} /> : <TimeSchedule className="size-3.5 text-muted-foreground" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate">{item.name}</span>
                  {item.source !== 'arbor' ? <Badge variant="outline" size="sm" className="shrink-0">{t(SOURCE_LABEL[item.source])}</Badge> : null}
                  {!item.enabled ? <Badge variant="outline" size="sm" className="shrink-0">{t('automations.status.paused')}</Badge> : null}
                </span>
                <span className="truncate text-xs text-muted-foreground">{scheduleWords(item.schedule, t)}</span>
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums">
                <span className="block text-foreground">{item.nextRunAtMs ? formatWhen(item.nextRunAtMs) : '—'}</span>
                {item.lastRun ? (
                  <span className={item.lastRun.status === 'failed' || item.lastRun.status === 'unreachable' ? 'block text-error-foreground' : 'block text-muted-foreground'}>
                    {t(RUN_STATUS_LABEL[item.lastRun.status])}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <SettingsBlock className="text-xs text-muted-foreground">{tRich('automations.machine.none', { machine: small })}</SettingsBlock>
      )}
    </SettingsSection>
  );
}
