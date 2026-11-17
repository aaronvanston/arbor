import { useI18n } from '../i18n';
import { computeByMachineView, type AppView } from '../navigation';
import { useComputeSelect } from '../services/compute';
import { useConnectedComputeProviders } from '../services/computeHint';
import { sandboxesStartedOn } from '../services/computeHome';
import { ArrowUpRight, Cloud } from './ui/icons';

/**
 * One quiet line on a machine's page when the user's running sandboxes were linked to it. Nothing at all while no
 * compute provider is connected, so the page reads nothing more for it.
 */
export function MachineComputeLine({ machine, onNavigate }: { machine: string; onNavigate: (view: AppView) => void }) {
  const connected = useConnectedComputeProviders();
  return connected.length ? <StartedHere machine={machine} onNavigate={onNavigate} /> : null;
}

function StartedHere({ machine, onNavigate }: { machine: string; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  // A count, so the page renders again only when it changes, not on every round.
  const count = useComputeSelect((state) => sandboxesStartedOn(state.snapshot?.providers ?? [], machine));
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={() => onNavigate(computeByMachineView())}
      title={t('compute.machineLine.open')}
      className="group flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none ring-ring hover:text-foreground focus-visible:ring-2"
    >
      <Cloud aria-hidden="true" className="size-3.5" />
      <span>{t(count === 1 ? 'compute.machineLine.one' : 'compute.machineLine.other', { count })}</span>
      <ArrowUpRight aria-hidden="true" className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}
