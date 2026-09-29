import { useState } from 'react';
import { Sparkles } from '../components/ui/icons';
import { SectionAbout, SettingsCard } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { TABLE_NUMERIC_CLASS, TableCard, TableShowAll } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatMoney, formatNumber, formatPercent, formatTokens } from '../lib/format';
import { cn } from '../lib/utils';
import {
  spendName,
  spendShares,
  totalTokens,
  useAgentTelemetry,
  type SpendDimension,
} from '../services/agentTelemetry';
import type { Spend, SpendGroup, TelemetryBreakdown } from '../native/types';
import { MachinePill, ModelName } from '../components/identity/Identity';

const ROWS = 8;

/** The groups shown, in order, each with its title and what it means. */
const SECTIONS: { dimension: SpendDimension; title: MessageKey; description: MessageKey }[] = [
  { dimension: 'sources', title: 'telemetry.section.sources', description: 'telemetry.section.sourcesHint' },
  { dimension: 'skills', title: 'telemetry.section.skills', description: 'telemetry.section.skillsHint' },
  { dimension: 'plugins', title: 'telemetry.section.plugins', description: 'telemetry.section.pluginsHint' },
  { dimension: 'mcpServers', title: 'telemetry.section.mcpServers', description: 'telemetry.section.mcpServersHint' },
  { dimension: 'agents', title: 'telemetry.section.agents', description: 'telemetry.section.agentsHint' },
  { dimension: 'models', title: 'telemetry.section.models', description: 'telemetry.section.modelsHint' },
  { dimension: 'machines', title: 'telemetry.section.machines', description: 'telemetry.section.machinesHint' },
  { dimension: 'versions', title: 'telemetry.section.versions', description: 'telemetry.section.versionsHint' },
];

/**
 * What Claude Code says it spent, by the skill, plugin, MCP server and subagent that spent it, from the metrics each
 * machine sends Arbor: Sync › Cost's part under the starting context, which titles it, so an empty one is a bare card.
 */
export function TelemetryView({ data, machine, onOpenSettings, onOpenMachines }: {
  data: TelemetryBreakdown;
  machine: string | null;
  onOpenSettings?: () => void;
  onOpenMachines?: () => void;
}) {
  const { t } = useI18n();
  const { status } = useAgentTelemetry();

  if (data.total.cost <= 0 && totalTokens(data.total) <= 0) {
    const off = status !== null && !status.enabled;
    const noMachines = status !== null && status.enabled && !status.machines.length;
    return (
      <SettingsCard>
        <Empty size="sm">
          <EmptyMedia><Sparkles /></EmptyMedia>
          <EmptyTitle>{t(off ? 'telemetry.empty.offTitle' : noMachines ? 'telemetry.empty.noMachinesTitle' : 'telemetry.empty.quietTitle')}</EmptyTitle>
          <EmptyDescription>{t(off ? 'telemetry.empty.off' : noMachines ? 'telemetry.empty.noMachines' : 'telemetry.empty.quiet')}</EmptyDescription>
          {off && onOpenSettings ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={onOpenSettings}>{t('telemetry.openSettings')}</Button>
          ) : noMachines && onOpenMachines ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={onOpenMachines}>{t('telemetry.openMachines')}</Button>
          ) : null}
        </Empty>
      </SettingsCard>
    );
  }

  const tokens = totalTokens(data.total);
  const hidden = SECTIONS.some(({ dimension }) => data[dimension].some((group) => spendName(dimension, group.name, t).hidden));
  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={4}>
        <StatBlock label={t('telemetry.stat.cost')} value={formatMoney(data.total.cost)} hint={t('telemetry.stat.costHint')} />
        <StatBlock
          label={t('telemetry.stat.tokens')}
          value={formatTokens(tokens)}
          hint={t('telemetry.stat.tokensHint', { input: formatTokens(data.total.inputTokens), output: formatTokens(data.total.outputTokens) })}
        />
        <StatBlock label={t('telemetry.stat.sessions')} value={formatNumber(data.total.sessions)} hint={t('telemetry.stat.sessionsHint')} />
        <StatBlock
          label={t('telemetry.stat.machines')}
          value={machine !== null ? <MachinePill name={machine} size="lg" /> : formatNumber(data.machines.length)}
          hint={t('telemetry.stat.machinesHint')}
        />
      </StatsGrid>
      {SECTIONS.map(({ dimension, title, description }) => {
        const groups = data[dimension];
        // One machine's own name, or a single version, says nothing a table would add.
        if (!groups.length || ((dimension === 'machines' || dimension === 'versions') && groups.length < 2)) return null;
        return <SpendTable key={dimension} dimension={dimension} groups={groups} total={data.total} title={t(title)} description={t(description)} />;
      })}
      {hidden ? <p className="max-w-3xl text-xs text-muted-foreground">{t('telemetry.hiddenNote')}</p> : null}
    </div>
  );
}

function SpendTable({ dimension, groups, total, title, description }: {
  dimension: SpendDimension;
  groups: SpendGroup[];
  total: Spend;
  title: string;
  description: string;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const shares = spendShares(groups, total);
  const shown = all ? groups : groups.slice(0, ROWS);
  return (
    // A card of its own rather than a section, so "Show all" sits in the table's footer.
    <TableCard
      title={<span className="inline-flex items-center gap-1.5">{title}<SectionAbout title={title} description={description} /></span>}
      footer={groups.length > ROWS ? <TableShowAll shown={shown.length} total={groups.length} expanded={all} onToggle={() => setAll(!all)} /> : null}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('telemetry.column.name')}</TableHead>
            <TableHead className="w-44">{t('telemetry.column.share')}</TableHead>
            <TableHead className={cn('w-28', TABLE_NUMERIC_CLASS)}>{t('telemetry.column.cost')}</TableHead>
            <TableHead className={cn('w-28', TABLE_NUMERIC_CLASS)}>{t('telemetry.column.tokens')}</TableHead>
            <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('telemetry.column.sessions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((group, index) => {
            const name = spendName(dimension, group.name, t);
            const share = shares[index] ?? 0;
            return (
              <TableRow key={group.name}>
                {dimension === 'machines' && group.name && !name.hidden ? (
                  <TableCell className="max-w-0"><MachinePill name={group.name} size="sm" className="max-w-full" /></TableCell>
                ) : dimension === 'models' && group.name && !name.hidden ? (
                  <TableCell className="max-w-0"><ModelName model={group.name} /></TableCell>
                ) : (
                  <TableCell className={cn('max-w-0 truncate', name.hidden ? 'text-muted-foreground' : 'font-medium text-foreground')} title={name.hidden ? t('telemetry.hiddenHint') : name.text}>
                    {name.text}
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
                    </div>
                    <span className="w-10 text-end text-2xs tabular-nums text-muted-foreground">{formatPercent(share)}</span>
                  </div>
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>{formatMoney(group.cost)}</TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>{formatTokens(totalTokens(group))}</TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>{formatNumber(group.sessions)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableCard>
  );
}
