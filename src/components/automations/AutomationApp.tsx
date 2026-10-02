import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import type { AutomationSource } from '../../native/types';
import { SOURCE_LABEL } from '../../services/automations';
import { useAppIcon } from '../../services/appIcon';
import { appIconImage } from '../AppIconPicker';
import claudeIcon from '../../assets/icons/claude.svg';
import codexIcon from '../../assets/icons/codex.svg';
import orcaIcon from '../../assets/icons/orca.svg';

/** The other apps' marks. Orca's is drawn in black, so it's lightened in dark mode, and wider than it's tall. */
const MARKS: Record<Exclude<AutomationSource, 'arbor'>, { icon: string; tint?: boolean; wide?: boolean }> = {
  codexApp: { icon: codexIcon },
  claudeDesktop: { icon: claudeIcon },
  orca: { icon: orcaIcon, tint: true, wide: true },
};

/** The mark of the app that keeps an automation; Arbor's own wear the Dock icon the user picked. */
export function AutomationAppMark({ source, className }: { source: AutomationSource; className?: string }) {
  const { shown } = useAppIcon();
  const mark = source === 'arbor' ? { icon: appIconImage(shown), tint: false, wide: false } : MARKS[source];
  return <img src={mark.icon} alt="" aria-hidden="true" className={cn('h-3.5 shrink-0 object-contain', mark.wide ? 'w-5' : 'w-3.5', mark.tint && 'dark:invert', className)} />;
}

/** The app that keeps an automation, its mark and its name. */
export function AutomationAppName({ source, className }: { source: AutomationSource; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <AutomationAppMark source={source} />
      <span className="truncate">{t(SOURCE_LABEL[source])}</span>
    </span>
  );
}
