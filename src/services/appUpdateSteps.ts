import type { AppUpdatePhase, AppUpdateTask } from '../native/types';

export type AppUpdateStepId = 'check' | 'download' | 'copy' | 'verify' | 'unpack' | 'restart';
export type AppUpdateStepState = 'done' | 'current' | 'upcoming';

export type AppUpdateStep = {
  id: AppUpdateStepId;
  state: AppUpdateStepState;
  /** Only the download step has a percent; copying a dev build and the checks after it don't measure their progress. */
  percent: number | null;
};

const STEP_PHASES: Record<AppUpdateStepId, AppUpdatePhase> = {
  check: 'checking',
  download: 'downloading',
  copy: 'downloading',
  verify: 'verifying',
  unpack: 'staging',
  restart: 'restarting',
};

/**
 * The steps a running install goes through, so the dialog can show where it is instead of one bar that sits still
 * through everything that isn't a download. A dev build is copied from this Mac rather than downloaded.
 */
export function appUpdateSteps(task: Pick<AppUpdateTask, 'phase' | 'fromThisMac' | 'percent' | 'downloadedBytes' | 'totalBytes'>): AppUpdateStep[] {
  const ids: AppUpdateStepId[] = ['check', task.fromThisMac ? 'copy' : 'download', 'verify', 'unpack', 'restart'];
  const currentIndex = ids.findIndex((id) => STEP_PHASES[id] === task.phase);
  const percent = task.fromThisMac
    ? null
    : task.percent ?? (task.totalBytes && task.totalBytes > 0 ? (task.downloadedBytes / task.totalBytes) * 100 : null);
  return ids.map((id, index) => ({
    id,
    state: currentIndex < 0 || index > currentIndex ? 'upcoming' : index < currentIndex ? 'done' : 'current',
    percent: id === 'download' && index === currentIndex ? percent : null,
  }));
}
