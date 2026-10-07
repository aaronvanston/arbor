import { useLibrary } from '../hooks/useLibrary';
import type { SetupMachine, SetupRepo } from '../native/types';
import { SyncReviewDialog } from './SetupSync';

/**
 * The checklist's repo step: what's different on the machine, and Bring it in line with the same plan as Overview.
 * Loaded when it opens, so a machine's page doesn't carry the Library's modules until then.
 */
export function ChecklistRepoReview({ repo, machine, machines, onClose, onRepo }: {
  repo: SetupRepo;
  machine: SetupMachine | null;
  machines: SetupMachine[];
  onClose: () => void;
  onRepo: (repo: SetupRepo) => void;
}) {
  const { rows, sources } = useLibrary(machines);
  return <SyncReviewDialog repo={repo} machine={machine} onClose={onClose} line={{ rows, sources, machines }} onRepo={onRepo} />;
}
