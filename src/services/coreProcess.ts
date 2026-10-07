import { invokeCommand } from '../native/commands';
import { translate } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { settleIdleUpdate } from './updateWhenIdle';
import type { CoreStatus } from '../native/types';
import { plainError } from './plainError';
import { trackFeature } from './productAnalytics';

export type CoreProcessCommand = 'start_core_process' | 'stop_core_process' | 'restart_core_process';

const CORE_FEATURE = { start_core_process: 'core-started', stop_core_process: 'core-stopped', restart_core_process: 'core-restarted' } as const;

/** The word for each command in "Core {action} failed". */
export const CORE_ACTION_LABEL: Record<CoreProcessCommand, MessageKey> = {
  start_core_process: 'kernel.action.start',
  stop_core_process: 'kernel.action.stop',
  restart_core_process: 'kernel.action.restart',
};

/**
 * Starts, stops or restarts the core, for the Home page's buttons and the search palette alike. Publishes the
 * status it ends in, or reads it again after a failure, and returns the error, if any, in plain words: a failed stop
 * says what to do with a core that may still be running.
 */
export async function runCoreProcess(
  command: CoreProcessCommand,
  runtime: { publishStatus: (status: CoreStatus | null) => void; refreshStatus: () => Promise<void> },
): Promise<string | null> {
  // Starting, stopping or restarting the core leaves a restart waiting for idle agents nothing to do.
  settleIdleUpdate('restart');
  try {
    runtime.publishStatus(await invokeCommand(command));
    trackFeature(CORE_FEATURE[command]);
    return null;
  } catch (error) {
    await runtime.refreshStatus();
    const words = plainError(error, translate);
    return command === 'stop_core_process' ? `${words} ${translate('kernel.stopFailed.next')}` : words;
  }
}
