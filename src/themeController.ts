export type AppTheme = 'light' | 'dark';
/** What the user picked. `system` follows the OS appearance live. */
export type ThemePreference = AppTheme | 'system';
type Unlisten = () => void;

/** The desktop shell's window appearance. Absent in the browser preview. */
export interface NativeThemeSource {
  /** Pins the window appearance, or hands it back to the OS with `null`. */
  setTheme(theme: AppTheme | null): Promise<void>;
  readTheme(): Promise<AppTheme | null>;
  listen(listener: (theme: AppTheme) => void): Promise<Unlisten>;
  setBackground(theme: AppTheme): Promise<void>;
}

export interface ThemeEnvironment {
  readPreference(): ThemePreference;
  savePreference(preference: ThemePreference): void;
  readMediaTheme(): AppTheme;
  listenMedia(listener: () => void): Unlisten;
  /** Fires when the window comes back (focus, visibility) to catch changes missed while hidden. */
  listenResume(listener: () => void): Unlisten;
  applyTheme(theme: AppTheme): void;
  connectNative(): Promise<NativeThemeSource | null>;
}

/**
 * Keeps the page theme, the native window appearance and the saved preference
 * in step. Only an explicit choice is saved. `system` uses the native window's
 * reading when it gives one, otherwise `prefers-color-scheme`, and follows
 * change events from both.
 */
export function createThemeController(environment: ThemeEnvironment) {
  let preference = environment.readPreference();
  let native: NativeThemeSource | null = null;
  let disposed = false;
  // Bumped by every preference change so queued work for an older one is dropped.
  let generation = 0;
  // Bumped by every newer observation so a slow read cannot overwrite it.
  let observation = 0;
  // True while our own native write is in flight, so its echo is not mistaken for an OS change.
  let configuring = false;
  // Last appearance the native window reported or was given; null means "follows the OS".
  let nativeAppearance: AppTheme | null | undefined;
  // Native writes and reads run one at a time, in order.
  let queue = Promise.resolve();
  const subscribers = new Set<Unlisten>();
  const cleanup: Unlisten[] = [];
  const current = (version: number) => !disposed && version === generation;
  const apply = (theme: AppTheme) => environment.applyTheme(theme);

  function enqueue(work: () => Promise<void>) {
    queue = queue.then(work).catch(() => {
      // A failed native call must not stall the calls queued behind it.
    });
  }

  async function background(theme: AppTheme, version: number) {
    if (current(version) && native) await native.setBackground(theme);
  }

  async function readSystem(version: number) {
    if (!current(version) || preference !== 'system' || !native) return;
    const reading = ++observation;
    const theme = await native.readTheme().catch(() => null);
    if (!current(version) || reading !== observation) return;
    const resolved = theme ?? environment.readMediaTheme();
    apply(resolved);
    await background(resolved, version);
  }

  function refreshSystem() {
    if (disposed || preference !== 'system') return;
    if (!native) {
      apply(environment.readMediaTheme());
      return;
    }
    const version = generation;
    enqueue(() => readSystem(version));
  }

  function configureNative() {
    const version = generation;
    enqueue(async () => {
      if (!current(version) || !native) return;
      configuring = true;
      try {
        nativeAppearance = preference === 'system' ? null : preference;
        await native.setTheme(nativeAppearance);
      } catch {
        nativeAppearance = undefined;
      } finally {
        configuring = false;
      }
      if (!current(version)) return;
      if (preference === 'system') await readSystem(version);
      else {
        // The OS changed the window during our write; pin the manual choice again.
        if (nativeAppearance && nativeAppearance !== preference) configureNative();
        await background(preference, version);
      }
    });
  }

  function nativeChanged(theme: AppTheme) {
    if (disposed || !native) return;
    nativeAppearance = theme;
    if (configuring) return;
    if (preference !== 'system') {
      if (theme !== preference) configureNative();
      return;
    }
    ++observation;
    apply(theme);
    const version = generation;
    enqueue(() => background(theme, version));
  }

  apply(preference === 'system' ? environment.readMediaTheme() : preference);
  cleanup.push(environment.listenMedia(refreshSystem), environment.listenResume(refreshSystem));
  void environment.connectNative().then(async (source) => {
    if (disposed || !source) return;
    native = source;
    try {
      const unlisten = await source.listen(nativeChanged);
      if (disposed) unlisten();
      else cleanup.push(unlisten);
    } catch {
      // Without change events, media and resume refreshes still keep system mode current.
    }
    if (!disposed) configureNative();
  }).catch(() => {
    // No native window (or it failed to connect): the media query drives the theme.
  });

  return {
    getPreference: () => preference,
    subscribe(listener: Unlisten) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    setPreference(next: ThemePreference) {
      if (disposed || preference === next) return;
      preference = next;
      ++generation;
      ++observation;
      environment.savePreference(next);
      if (next !== 'system') apply(next);
      else if (!native) apply(environment.readMediaTheme());
      configureNative();
      subscribers.forEach((listener) => listener());
    },
    dispose() {
      disposed = true;
      ++generation;
      cleanup.forEach((unlisten) => unlisten());
      subscribers.clear();
    },
  };
}
