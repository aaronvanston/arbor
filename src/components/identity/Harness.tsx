import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import type { Harness } from '../../native/types';
import ampIcon from '../../assets/icons/amp.svg';
import claudeIcon from '../../assets/icons/claude.svg';
import codexIcon from '../../assets/icons/codex.svg';
import droidIcon from '../../assets/icons/droid.svg';
import geminiIcon from '../../assets/icons/gemini.svg';
import opencodeIcon from '../../assets/icons/opencode.svg';
import piIcon from '../../assets/icons/pi.svg';

/**
 * Each harness's own name and mark. The facts about it (homes, skills, how it's started) come from the native
 * catalog (`AgentHomesView.harnesses`); this only draws it. One without a published mark wears its initial. A mark drawn in
 * black is lightened in dark mode.
 */
const HARNESSES: Record<Exclude<Harness, 'other'>, { name: string; icon?: string; tint?: boolean }> = {
  claude: { name: 'Claude Code', icon: claudeIcon },
  codex: { name: 'Codex', icon: codexIcon },
  pi: { name: 'Pi', icon: piIcon, tint: true },
  primeAgent: { name: 'Prime Agent' },
  openCode: { name: 'OpenCode', icon: opencodeIcon, tint: true },
  droid: { name: 'Droid', icon: droidIcon },
  amp: { name: 'Amp', icon: ampIcon, tint: true },
  gemini: { name: 'Gemini CLI', icon: geminiIcon },
};

/** A harness's name; one Arbor doesn't know reads as another agent. */
export function useHarnessName(): (harness: Harness | null) => string {
  const { t } = useI18n();
  return (harness) => (harness && harness !== 'other' ? HARNESSES[harness].name : t('harness.other'));
}

/** Just the mark, beside a name that says which harness it is. */
export function HarnessMark({ harness, className }: { harness: Harness | null; className?: string }) {
  const known = harness && harness !== 'other' ? HARNESSES[harness] : null;
  if (known?.icon) {
    return <img src={known.icon} alt="" aria-hidden="true" className={cn('size-3.5 shrink-0', known.tint && 'dark:invert', className)} />;
  }
  return (
    <span aria-hidden="true" className={cn('inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-muted text-3xs font-semibold leading-none text-muted-foreground', className)}>
      {known ? known.name.charAt(0) : '?'}
    </span>
  );
}

/** A harness's mark and name. */
export function HarnessName({ harness, className }: { harness: Harness | null; className?: string }) {
  const name = useHarnessName();
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <HarnessMark harness={harness} />
      <span className="truncate">{name(harness)}</span>
    </span>
  );
}
