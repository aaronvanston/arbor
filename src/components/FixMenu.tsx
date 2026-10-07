import { useState, type ReactNode } from 'react';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import type { AgentKind, MachineHealth } from '../native/types';
import { fixPrompt, fixSessions, type FixProblem } from '../services/fixPrompt';
import { fetchMachineHealth } from '../services/machineHealth';
import { machineName } from '../services/machineNames';
import { plainError } from '../services/plainError';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Copy, TerminalSquare, Wrench } from './ui/icons';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';
import { toast } from './ui/toast';

const AGENT_NAME = { claude: 'machines.agents.name.claude', codex: 'machines.agents.name.codex' } as const;

/**
 * Beside a problem on a machine: copies a prompt for an agent to fix it, or opens Terminal with Claude Code or Codex
 * already started on it, on the machine or on this Mac. The machines are read again as the menu opens, so the prompt
 * carries their latest details and each agent's item says where it would run.
 */
export function FixMenu({ machine, problem, item = null, compact = false, children, className }: {
  machine: string;
  problem: FixProblem;
  /** The machine as the page has it, used until the menu's own read comes back. */
  item?: MachineHealth | null;
  /** Just the wrench, for a table cell. */
  compact?: boolean;
  /** The button's words in place of "Fix", such as "Fix on" a machine's pill. */
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const { copy } = useCopyToClipboard();
  const [machines, setMachines] = useState<MachineHealth[] | null>(null);
  const current = machines?.find((entry) => entry.machine === machine) ?? item;
  const thisMac = machines?.find((entry) => entry.local) ?? null;
  const shown = machineName(machine);

  const refresh = (open: boolean) => {
    if (!open) return;
    fetchMachineHealth(null, 60_000, true).then((snapshot) => setMachines(snapshot.machines), () => undefined);
  };

  const open = async (agent: AgentKind, onMachine: boolean) => {
    const name = t(AGENT_NAME[agent]);
    const prompt = fixPrompt(machine, current, problem, onMachine ? 'machine' : 'thisMac', t);
    try {
      await invokeCommand('open_fix_session', { machine, agent, prompt, onMachine });
      toast({ kind: 'success', title: t('fix.menu.opened', { agent: name }) });
    } catch (error) {
      toast({ kind: 'error', title: t('fix.menu.openFailed'), description: plainError(error, t) });
    }
  };

  return (
    <Menu onOpenChange={refresh}>
      <MenuTrigger
        render={(
          <Button
            variant="ghost"
            size={compact ? 'icon-xs' : 'xs'}
            className={cn('shrink-0', className)}
            aria-label={t('fix.menu.aria', { machine: shown })}
            title={compact ? t('fix.menu.aria', { machine: shown }) : undefined}
          />
        )}
      >
        <Wrench />
        {compact ? null : children ?? t('fix.menu.label')}
      </MenuTrigger>
      <MenuPopup className="w-72">
        <MenuItem onClick={() => void copy(fixPrompt(machine, current, problem, current?.local ? 'machine' : 'unknown', t), { label: t('fix.menu.copied') })}>
          <Copy />
          <span className="flex min-w-0 flex-col">
            <span>{t('fix.menu.copy')}</span>
            <span className="text-xs text-muted-foreground">{t('fix.menu.copyHint')}</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>{t('fix.menu.open')}</MenuGroupLabel>
          {fixSessions(current, problem, thisMac).map(({ agent, onMachine, available }) => (
            <MenuItem
              key={agent}
              disabled={!available}
              disabledReason={available ? undefined : t('fix.menu.missing')}
              onClick={() => void open(agent, onMachine)}
            >
              <TerminalSquare />
              <span className="min-w-0 truncate">
                {onMachine && !current?.local
                  ? t('fix.menu.onMachine', { agent: t(AGENT_NAME[agent]), machine: shown })
                  : t('fix.menu.onThisMac', { agent: t(AGENT_NAME[agent]) })}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
