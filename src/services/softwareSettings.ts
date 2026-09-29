import type { SoftwareSettings } from '../native/types';

export type SoftwareSaverEvents = {
  /** What the controls show: the settings as saved, with any change not saved yet on top. */
  show: (settings: SoftwareSettings) => void;
  /** Whether a save is under way. */
  busy: (saving: boolean) => void;
  /** The settings as saved, after each save that worked. */
  saved: (settings: SoftwareSettings) => void;
  /** A save failed. The controls are back at what was last saved, and a change made meanwhile went with it. */
  failed: (error: unknown) => void;
};

/**
 * Saves Settings › Software as each setting changes, one save at a time. A change shows at once; one made while
 * another saves (turning on Open at login takes the system a moment) waits for it and then saves on top of what it
 * saved, rather than being dropped, and changes made meanwhile go in one save. `events` is read as each one happens,
 * so a component can hand in its latest.
 */
export function createSoftwareSaver(
  save: (settings: SoftwareSettings) => Promise<SoftwareSettings>,
  events: () => SoftwareSaverEvents,
) {
  // Changes made since the last save began, merged; they go in the next one.
  let pending: Partial<SoftwareSettings> | null = null;
  let shown: SoftwareSettings | null = null;
  let saving = false;
  // Read through these rather than directly: `change` below is called again while it awaits a save.
  const waiting = () => pending ?? {};
  const takeWaiting = () => {
    const taken = pending;
    pending = null;
    return taken;
  };

  /** `saved` is the settings as last loaded or saved, which the change goes on top of when nothing is saving. */
  async function change(saved: SoftwareSettings, update: Partial<SoftwareSettings>): Promise<void> {
    shown = { ...(saving && shown ? shown : saved), ...update };
    events().show(shown);
    pending = { ...pending, ...update };
    if (saving) return;
    saving = true;
    events().busy(true);
    let base = saved;
    try {
      for (let next = takeWaiting(); next; next = takeWaiting()) {
        base = await save({ ...base, ...next });
        events().saved(base);
        shown = { ...base, ...waiting() };
        events().show(shown);
      }
    } catch (error) {
      pending = null;
      shown = base;
      events().show(base);
      events().failed(error);
    } finally {
      saving = false;
      events().busy(false);
    }
  }

  return { change };
}
