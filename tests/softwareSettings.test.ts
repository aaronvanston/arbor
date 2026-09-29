import { describe, expect, it } from 'bun:test';
import { createSoftwareSaver } from '../src/services/softwareSettings';
import { itemAt, lastItem } from './support/items';
import type { SoftwareSettings } from '../src/native/types';

const loaded: SoftwareSettings = { closeBehavior: 'ask', autostartEnabled: false, startCoreOnLaunch: true, silentStartEnabled: false };

/** A saver whose saves wait until `finish` or `fail` settles them, with a record of everything it reported. */
function harness() {
  const saves: { settings: SoftwareSettings; resolve: (settings: SoftwareSettings) => void; reject: (error: unknown) => void }[] = [];
  const shown: SoftwareSettings[] = [];
  const saved: SoftwareSettings[] = [];
  const busy: boolean[] = [];
  const failed: unknown[] = [];
  const saver = createSoftwareSaver(
    (settings) => new Promise((resolve, reject) => void saves.push({ settings, resolve, reject })),
    () => ({
      show: (settings) => void shown.push(settings),
      busy: (saving) => void busy.push(saving),
      saved: (settings) => void saved.push(settings),
      failed: (error) => void failed.push(error),
    }),
  );
  const settle = async () => {
    // Lets the saver carry on from the save it was waiting for.
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };
  const finish = async (index: number) => {
    const save = itemAt(saves, index);
    save.resolve(save.settings);
    await settle();
  };
  const fail = async (index: number, error: unknown) => {
    itemAt(saves, index).reject(error);
    await settle();
  };
  return { saver, saves, shown, saved, busy, failed, finish, fail };
}

describe('saving Settings › Software as it changes', () => {
  it('shows a change at once, then what was saved', async () => {
    const { saver, saves, shown, saved, busy, finish } = harness();
    const done = saver.change(loaded, { autostartEnabled: true });
    expect(shown).toEqual([{ ...loaded, autostartEnabled: true }]);
    expect(busy).toEqual([true]);
    expect(saves.map((save) => save.settings)).toEqual([{ ...loaded, autostartEnabled: true }]);
    await finish(0);
    await done;
    expect(saved).toEqual([{ ...loaded, autostartEnabled: true }]);
    expect(lastItem(shown)).toEqual({ ...loaded, autostartEnabled: true });
    expect(busy).toEqual([true, false]);
  });

  it('puts the switch back and says why when saving fails', async () => {
    const { saver, shown, saved, busy, failed, fail } = harness();
    const done = saver.change(loaded, { autostartEnabled: true });
    await fail(0, 'the system refused the change');
    await done;
    expect(saved).toEqual([]);
    expect(lastItem(shown)).toEqual(loaded);
    expect(failed).toEqual(['the system refused the change']);
    expect(busy).toEqual([true, false]);
  });

  it('keeps a change made while another saves, and saves it on top once that one is done', async () => {
    const { saver, saves, shown, saved, busy, finish } = harness();
    const first = saver.change(loaded, { autostartEnabled: true });
    // Made before Open at login is saved: shown straight away with the first, and not dropped.
    void saver.change(loaded, { silentStartEnabled: true });
    expect(lastItem(shown)).toEqual({ ...loaded, autostartEnabled: true, silentStartEnabled: true });
    expect(saves).toHaveLength(1);
    await finish(0);
    // The first is saved; the switch made meanwhile still shows while its own save runs.
    expect(lastItem(shown)).toEqual({ ...loaded, autostartEnabled: true, silentStartEnabled: true });
    expect(saves.map((save) => save.settings)).toEqual([
      { ...loaded, autostartEnabled: true },
      { ...loaded, autostartEnabled: true, silentStartEnabled: true },
    ]);
    await finish(1);
    await first;
    expect(lastItem(saved)).toEqual({ ...loaded, autostartEnabled: true, silentStartEnabled: true });
    // Busy from the first change to the last save, once.
    expect(busy).toEqual([true, false]);
  });

  it('saves the changes made during one save together, the later one winning', async () => {
    const { saver, saves, finish } = harness();
    const first = saver.change(loaded, { autostartEnabled: true });
    void saver.change(loaded, { closeBehavior: 'exit' });
    void saver.change(loaded, { silentStartEnabled: true });
    void saver.change(loaded, { closeBehavior: 'minimize-to-tray' });
    await finish(0);
    expect(lastItem(saves.map((save) => save.settings))).toEqual({
      ...loaded, autostartEnabled: true, closeBehavior: 'minimize-to-tray', silentStartEnabled: true,
    });
    await finish(1);
    await first;
    expect(saves).toHaveLength(2);
  });

  it('goes back to what was last saved when a later save fails, dropping the changes made meanwhile', async () => {
    const { saver, saves, shown, failed, finish, fail } = harness();
    const first = saver.change(loaded, { autostartEnabled: true });
    void saver.change(loaded, { silentStartEnabled: true });
    await finish(0);
    await fail(1, 'config file is read-only');
    await first;
    expect(lastItem(shown)).toEqual({ ...loaded, autostartEnabled: true });
    expect(failed).toEqual(['config file is read-only']);
    // The next change starts from what was saved.
    void saver.change({ ...loaded, autostartEnabled: true }, { startCoreOnLaunch: false });
    expect(lastItem(saves).settings).toEqual({ ...loaded, autostartEnabled: true, startCoreOnLaunch: false });
  });
});
