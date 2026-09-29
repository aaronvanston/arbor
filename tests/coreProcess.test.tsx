import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { runCoreProcess } from '../src/services/coreProcess';
import { cancelIdleUpdates, scheduleIdleUpdate, useIdleUpdates } from '../src/services/updateWhenIdle';
import type { CoreStatus } from '../src/native/types';
import { mockCommands } from '../src/dev/mock/answers';

let originalWindow: PropertyDescriptor | undefined;
const commands: string[] = [];

/** What's waiting for idle agents, read the way the app reads it. */
function Waiting() {
  return <>{useIdleUpdates().updates.map((update) => update.kind).join(',')}</>;
}
const waiting = () => renderToStaticMarkup(<Waiting />);

const running: CoreStatus = {
  installed: true, running: true, ready: true, starting: false, managed: true, processId: 2,
  currentVersion: 'v6.8.21', installDir: '/core', binaryPath: '/core/cli-proxy-api', message: '',
};

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  commands.length = 0;
  const started = (command: string) => () => {
    commands.push(command);
    return running;
  };
  mockCommands({
    start_core_process: started('start_core_process'),
    restart_core_process: started('restart_core_process'),
    stop_core_process: () => {
      commands.push('stop_core_process');
      throw 'The core didn’t stop within 10 seconds';
    },
  });
});

afterEach(() => {
  cancelIdleUpdates();
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('starting, stopping and restarting the core', () => {
  const runtime = () => {
    const published: (CoreStatus | null)[] = [];
    let refreshed = 0;
    return {
      published,
      refreshed: () => refreshed,
      publishStatus: (status: CoreStatus | null) => void published.push(status),
      refreshStatus: async () => void (refreshed += 1),
    };
  };

  it('publishes the status it ends in, and leaves nothing for a waiting restart to do', async () => {
    scheduleIdleUpdate({ kind: 'app', version: '0.3.45' });
    scheduleIdleUpdate({ kind: 'restart' });
    expect(waiting()).toBe('restart,app');
    const core = runtime();
    expect(await runCoreProcess('restart_core_process', core)).toBeNull();
    expect(commands).toEqual(['restart_core_process']);
    expect(core.published).toEqual([running]);
    expect(core.refreshed()).toBe(0);
    // Arbor's own update still waits: only the restart is done with.
    expect(waiting()).toBe('app');
  });

  it('reads the status again after a failure and returns the error', async () => {
    scheduleIdleUpdate({ kind: 'restart' });
    const core = runtime();
    expect(await runCoreProcess('stop_core_process', core)).toBe('The core didn’t stop within 10 seconds');
    expect(core.published).toEqual([]);
    expect(core.refreshed()).toBe(1);
    // Stopped by hand, even unsuccessfully, a restart waiting for idle agents mustn't go ahead later.
    expect(waiting()).toBe('');
  });
});
