import { useI18n } from '../i18n';
import { HARNESS_LABEL, harnessReady, type MachineHarness } from '../services/harnesses';
import { Badge } from './ui/badge';
import { StatusDot } from './ui/status-dot';
import { SettingsBlock } from './layout/settings';
import { cn } from '../lib/utils';

/**
 * The harnesses on one machine that a pool's run could be handed to, each with whether it's running and the setups it
 * would start an agent with. Setups switched off in the harness stay listed, grayed, so the list matches it.
 */
export function MachineHarnessesBlock({ harnesses }: { harnesses: MachineHarness[] }) {
  const { t } = useI18n();
  if (harnesses.length === 0) return <SettingsBlock className="text-xs text-muted-foreground">{t('harness.none')}</SettingsBlock>;
  return (
    <>
      {harnesses.map((harness) => (
        <div key={harness.kind} className="flex flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3" data-harness={harness.kind}>
          <div className="w-44 shrink-0 space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              {harness.running === null ? null : <StatusDot tone={harness.running ? 'success' : 'muted'} />}
              {t(HARNESS_LABEL[harness.kind])}
            </div>
            <p className="text-xs text-muted-foreground">
              {harness.running === null
                ? t('harness.headless.note')
                : harness.version
                  ? t(harness.running ? 'harness.runningVersion' : 'harness.stoppedVersion', { version: harness.version })
                  : t(harness.running ? 'harness.running' : 'harness.stopped')}
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5 pt-0.5">
            {harness.setups.length === 0 ? (
              <span className="text-xs text-muted-foreground">{t('harness.noSetups')}</span>
            ) : (
              harness.setups.map((setup) => (
                <Badge
                  key={setup.id}
                  variant="outline"
                  size="lg"
                  className={cn(!setup.enabled && 'opacity-50')}
                  title={setup.enabled ? setup.id : t('harness.setupOff', { id: setup.id })}
                >
                  {setup.name ?? (setup.driver ? t(setup.driver) : setup.rawDriver)}
                </Badge>
              ))
            )}
          </div>
        </div>
      ))}
      {harnessReady(harnesses) ? null : (
        <SettingsBlock className="py-2 text-xs text-muted-foreground">
          {t(harnesses.some((harness) => harness.kind === 'headless') ? 'harness.noneRunning' : 'harness.noneRunningNoAgents')}
        </SettingsBlock>
      )}
    </>
  );
}
