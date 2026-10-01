import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { TriangleAlert } from '../components/ui/icons';
import { SectionAbout } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Spinner } from '../components/ui/spinner';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { machinesView, type AppView } from '../navigation';
import {
  getTelemetryBreakdown,
  isTelemetrySpan,
  setTelemetrySpan,
  telemetryWindow,
  TELEMETRY_SPANS,
  useTelemetrySpan,
  type TelemetrySpan,
} from '../services/agentTelemetry';
import { STARTING_CONTEXT_DAYS } from '../services/startingContext';
import { SetupContext } from './SetupContext';
import { TelemetryView } from './UsageTelemetryView';
import type { SetupMachine, TelemetryBreakdown } from '../native/types';

/** Claude Code sends once a minute while a session runs, so its spend is read again about as often. */
const TELEMETRY_POLL_MS = 60_000;

const SPAN_LABEL: Record<TelemetrySpan, MessageKey> = {
  1: 'setup.cost.telemetry.span.day',
  7: 'setup.cost.telemetry.span.week',
  30: 'setup.cost.telemetry.span.month',
};

/**
 * Sync › Cost: what the agent setup itself costs. First what every session pays before it starts, each home's
 * starting context, then what Claude Code says its skills, plugins, MCP servers and subagents spent, on every machine
 * or the one the breadcrumb picked. Both compare homes and machines, so they're on Sync.
 */
export function SetupCost({ machines, homeLabel, machine, reads, onNavigate }: {
  machines: SetupMachine[];
  homeLabel: (key: string) => string;
  /**
   * The machine the breadcrumb narrowed the view to, from the view so Back returns to it; null for every machine.
   */
  machine: string | null;
  /** Goes up each time the page's refresh (Scan again, ⌘R) asks for the spend to be read again. */
  reads: number;
  onNavigate: (view: AppView) => void;
}) {
  const { t } = useI18n();
  const span = useTelemetrySpan();
  const [telemetry, setTelemetry] = useState<{ span: TelemetrySpan; machine: string | null; data: TelemetryBreakdown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (current: () => boolean) => {
    const { fromMs, toMs } = telemetryWindow(span, Date.now());
    try {
      const data = await getTelemetryBreakdown(fromMs, toMs, machine);
      if (!current()) return;
      setTelemetry({ span, machine, data });
      setError(null);
    } catch (failure) {
      if (current()) setError(String(failure));
    }
  }, [span, machine]);
  useEffect(() => {
    let live = true;
    const current = () => live;
    void load(current);
    const timer = window.setInterval(() => { if (!document.hidden) void load(current); }, TELEMETRY_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [load, reads]);

  // Another span's or machine's numbers wait for their own read rather than showing under the new pick.
  const shown = telemetry?.span === span && telemetry.machine === machine ? telemetry.data : null;
  return (
    <div className="flex flex-col gap-8">
      <CostPart
        id="cost-context"
        title={t('setup.cost.context.title')}
        description={t('setup.context.intro', { days: STARTING_CONTEXT_DAYS })}
      >
        {/* The breadcrumb's machine narrows the starting context too, so the whole view is about it. */}
        <SetupContext machines={machines} machine={machine} homeLabel={homeLabel} />
      </CostPart>
      <CostPart
        id="cost-telemetry"
        title={t('telemetry.title')}
        description={t('setup.cost.telemetry.description')}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={[String(span)]}
              onValueChange={(value) => {
                const next = Number(value[0]);
                if (isTelemetrySpan(next)) setTelemetrySpan(next);
              }}
              aria-label={t('setup.cost.telemetry.span')}
            >
              {TELEMETRY_SPANS.map((days) => <Toggle key={days} value={String(days)}>{t(SPAN_LABEL[days])}</Toggle>)}
            </ToggleGroup>
          </div>
        )}
      >
        {error && !shown ? (
          <Alert variant="error" icon={<TriangleAlert />}>
            <AlertDescription>{t('setup.cost.telemetry.loadFailed', { error })}</AlertDescription>
          </Alert>
        ) : shown ? (
          <TelemetryView
            data={shown}
            machine={machine}
            onOpenSettings={() => onNavigate({ kind: 'settings', page: 'machines' })}
            onOpenMachines={() => onNavigate(machinesView())}
          />
        ) : (
          <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Spinner />{t('setup.cost.telemetry.loading')}</p>
        )}
      </CostPart>
    </div>
  );
}

/** One of Cost's two parts, headed as Sync's other views head theirs, with what picks its numbers at the end. */
function CostPart({ id, title, description, action, children }: {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      {/* Inset like SettingsSection's header, so these titles line up with the ones above every other card. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4">
        <h2 id={id} className="flex min-h-7 min-w-0 flex-1 basis-48 items-center gap-1.5 text-sm font-normal tracking-title text-foreground/70">
          {title}
          <SectionAbout title={title} description={description} />
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
