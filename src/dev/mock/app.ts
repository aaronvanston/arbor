/** The browser mock's answers for the app itself: its settings, window, updates, phone alerts and saved pages. */
import { emit } from '@tauri-apps/api/event';
import { PHONE_ALERT_SECRETS } from '../../services/phoneAlerts';
import { QUIT_GUARD_ARMED_EVENT, QUIT_GUARD_WINDOW_MS, pressQuit } from '../../services/quitGuard';
import { nearestZoomStep, ZOOM_CHANGED_EVENT, zoomLevelAt } from '../../services/zoom';
import type { AppCommands } from '../../native/app';
import type { AppIconChoice, AppIconSetting, DevBuildStatus, PhoneAlertSecret, ProductAnalyticsSettings, ReleaseNotes, SoftwareSettings, UpdateChannel, ZoomLevel } from '../../native/types';
import type { CommandAnswers } from './answers';
import { configSettings, coreStatus } from './core';
import { freshInstall, mockLog, params } from './scenario';

const softwareSettings: SoftwareSettings = {
  closeBehavior: 'ask',
  autostartEnabled: true,
  startCoreOnLaunch: true,
  silentStartEnabled: false,
};

/**
 * Settings › Software's usage data: `?usagedata=new` for a new install's first launch (the note shows), `off`, `env`
 * (DO_NOT_TRACK set), or `source` for a build from source, which never sends.
 */
let productAnalytics: ProductAnalyticsSettings = {
  usage: params.get('usagedata') !== 'off',
  crashReports: params.get('usagedata') !== 'off',
  noticeShown: params.has('usagedata') ? params.get('usagedata') !== 'new' : !freshInstall,
  blockedByEnv: params.get('usagedata') === 'env',
  available: params.get('usagedata') !== 'source',
};

/** The version each kind of build reports, for `?build=`; a stable build, the default, has no prerelease. */
const MOCK_BUILD_VERSIONS: Record<string, string> = { nightly: '0.3.200-nightly.20261002.1', dev: '0.3.200-dev.20261002.1' };
export const mockAppVersion = MOCK_BUILD_VERSIONS[params.get('build') ?? ''] ?? '0.3.200';

/** The Dock icon the build shows on Auto, as `?build=` makes it (app_icon.rs's `build_icon`). */
const mockBuildIcon: AppIconChoice = params.get('build') === 'nightly' ? 'amber' : params.get('build') === 'dev' ? 'signal' : 'forest';
let appIcon: AppIconSetting = { choice: 'auto', shown: mockBuildIcon };

let quitGuard: { enabled: boolean; armedAt: number | null } = { enabled: true, armedAt: null };

/**
 * The zoom the View menu keeps (src-tauri/src/zoom.rs). Nothing is kept across reloads here, so `?zoom=1.25` (any
 * factor) previews a level for this load without saving anything; the menu's keys step on from the nearest step.
 */
let zoomLevel: ZoomLevel = (() => {
  const factor = Number(params.get('zoom'));
  return Number.isFinite(factor) && factor > 0 ? { step: nearestZoomStep(factor), factor } : zoomLevelAt(0);
})();

/**
 * WKWebView's page zoom, which a page can't turn on in its own browser. In a same-origin frame, which is how
 * screenshots at an exact size are taken, the frame is made the window's size divided by the zoom and scaled back up
 * by it, so the page's CSS width, `vh` and media queries shrink the way the app's do. In a tab of its own it falls back
 * to CSS zoom on the root, which grows everything alike but leaves `vh` and media queries at the tab's size.
 */
function emulatePageZoom(factor: number) {
  // The parent's element, from another realm, so not an `instanceof HTMLElement` here; null across origins.
  const frame = window.frameElement as HTMLElement | null;
  if (!frame) {
    document.documentElement.style.zoom = factor === 1 ? '' : String(factor);
    return;
  }
  // The window's own size, from before the first zoom, since the frame keeps it on screen whatever the zoom.
  let windowSize = frame.dataset.mockWindow;
  if (!windowSize) {
    if (factor === 1) return;
    const { width, height } = frame.getBoundingClientRect();
    windowSize = frame.dataset.mockWindow = `${width}x${height}`;
  }
  const [width = 0, height = 0] = windowSize.split('x').map(Number);
  Object.assign(frame.style, { width: `${width / factor}px`, height: `${height / factor}px`, transformOrigin: '0 0', transform: `scale(${factor})` });
}

/** What zoom.rs hands back when the settings file can't take the new level (`?zoomsave=fail`). */
const ZOOM_UNSAVED = 'Failed to write configuration directly /Users/cam/Library/Application Support/onl.arbor.app/config.toml: Permission denied (os error 13)';

function setMockZoom(step: number): ZoomLevel {
  // As in zoom.rs, the level is saved first and only then put on the window, so a refused save leaves it where it was.
  if (params.get('zoomsave') === 'fail') throw ZOOM_UNSAVED;
  zoomLevel = zoomLevelAt(step);
  emulatePageZoom(zoomLevel.factor);
  mockLog('zoom', zoomLevel);
  void emit(ZOOM_CHANGED_EVENT, zoomLevel);
  return zoomLevel;
}

/** Zooms to a `?zoom=` level before the first paint, as the app does with its saved one. */
export function startMockZoom() {
  if (zoomLevel.factor !== 1) emulatePageZoom(zoomLevel.factor);
}

/** ⌘=, ⌘− or ⌘0, run as the View menu's Zoom In, Zoom Out and Actual Size would, which have nowhere to say a failure. */
export function pressMockZoom(key: '=' | '-' | '0') {
  try {
    setMockZoom(key === '0' ? 0 : zoomLevel.step + (key === '=' ? 1 : -1));
  } catch (error) {
    mockLog('zoom_failed', String(error));
  }
}

/** The phone alert secrets the app would keep in its own file. Only whether each is set goes back to the window. */
const phoneSecrets: Record<PhoneAlertSecret, string> = { ntfyToken: '', pushoverUserKey: '', pushoverAppToken: '', telegramBotToken: '', webhookUrl: '' };

const PHONE_SECRETS_UNREADABLE =
  'The saved alert secrets in /Users/cam/Library/Application Support/onl.arbor.app/phone-alert-secrets.json can’t be read. Delete the file and enter them again.';
const phoneSecretStatus = () =>
  Object.fromEntries(PHONE_ALERT_SECRETS.map((secret) => [secret, Boolean(phoneSecrets[secret])])) as Record<PhoneAlertSecret, boolean>;

const channelParam = params.get('channel');
let updateChannel: UpdateChannel = channelParam === 'nightly' || channelParam === 'dev' ? channelParam : 'stable';

const DEV_COMMIT = '7c41e2a9d03b5f68a1e4c2b7d9f0e3a6b5c8d1f2';
const DEV_NEXT_COMMIT = 'e93b07d4a1c6f2e85b0d7a3c9e1f4b6a8d2c5e70';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** This Mac's dev builder: set up and idle with a build of main ready, unless the scenario says otherwise. */
function mockDevBuildStatus(): DevBuildStatus {
  const scenario = params.get('devbuild');
  const built = { builtVersion: '1.0.27-dev.4123', builtCommit: DEV_COMMIT, builtAt: minutesAgo(12) };
  const base: DevBuildStatus = {
    installed: true, repository: '/Users/cam/src/arbor', state: 'idle', commit: DEV_COMMIT, step: null, startedAt: minutesAgo(21), finishedAt: minutesAgo(12),
    error: null, hasLog: true, requested: false, settlesAt: null, ...built,
  };
  if (scenario === 'none') {
    return { ...base, installed: false, repository: null, commit: null, startedAt: null, finishedAt: null, hasLog: false, builtVersion: null, builtCommit: null, builtAt: null };
  }
  if (scenario === 'building') return { ...base, state: 'building', step: 'building', commit: DEV_NEXT_COMMIT, startedAt: minutesAgo(3), finishedAt: null };
  if (scenario === 'waiting') return { ...base, state: 'waiting', commit: DEV_NEXT_COMMIT, startedAt: null, finishedAt: null, settlesAt: new Date(Date.now() + 3 * 60_000).toISOString() };
  if (scenario === 'failed') {
    return { ...base, state: 'failed', commit: DEV_NEXT_COMMIT, startedAt: minutesAgo(9), finishedAt: minutesAgo(2), error: 'bun run verify failed: 2 tests failed in tests/sidebarTree.test.ts' };
  }
  return base;
}
let devBuildRequested = false;
/** Set by the Dev builds switch; null until it's used, so the scenario decides. */
let devBuildsOn: { installed: boolean; repository: string | null } | null = null;
const currentDevBuildStatus = (): DevBuildStatus => ({ ...mockDevBuildStatus(), ...devBuildsOn, requested: devBuildRequested });

// Release notes as the update feed gives them, newest first.
function mockAppReleases(): { latestVersion: string; releases: ReleaseNotes[]; releaseUrl?: string } {
  if (updateChannel === 'dev') {
    return {
      latestVersion: '1.0.27-dev.4123',
      releaseUrl: `https://github.com/aaronvanston/arbor/commit/${DEV_COMMIT}`,
      releases: [{ version: '1.0.27-dev.4123', summary: 'Main at 7c41e2a.', changes: ['Show each account’s extra-usage credits on Sign-ins', 'Fix a machine’s warnings with an agent, from the warning itself'] }],
    };
  }
  if (updateChannel === 'nightly') {
    return { latestVersion: '0.3.202-nightly.20260930.4', releases: [{ version: '0.3.202-nightly.20260930.4', summary: 'A nightly build of what’s next.', changes: [] }] };
  }
  const scenario = params.get('appnotes');
  if (scenario === 'none') return { latestVersion: '0.3.201', releases: [] };
  if (scenario === 'long') {
    return {
      latestVersion: '0.3.208',
      releases: Array.from({ length: 9 }, (_, index) => {
        const version = `0.3.${208 - index}`;
        const changes = Array.from({ length: 3 }, (__, change) => `Change ${change + 1} in ${version}`);
        if (index === 1) changes.splice(0, 1, `Keep every account’s limits readable when a provider sends a reset time far in the future, a window Arbor hasn’t seen before and a plan name it doesn’t recognize, so the Accounts page, the sidebar limits and the capacity report all agree instead of showing three different answers for the same account`);
        return { version, changes };
      }),
    };
  }
  return {
    latestVersion: '0.3.201',
    releases: [
      {
        version: '0.3.201',
        summary: 'Updates now show what they change.',
        // Release notes are a summary and at most three changes, as release-notes.mjs allows.
        changes: [
          'See what an update brings before you install it.',
          'See what a core update changes before it installs.',
          'An Arbor update brings the newer core with it.',
        ],
      },
      { version: '0.3.200', changes: ['Already installed, so not shown'] },
      { version: '0.3.199', changes: ['Older still'] },
    ],
  };
}

/** The app: its window, settings, updates, alerts and the pages it saves. */
export const appAnswers: CommandAnswers<AppCommands> = {
  get_gui_settings: () => ({ host: configSettings.host, port: configSettings.port, allowLan: configSettings.allowLan, runOnStartup: true, closeBehavior: 'ask' }),
  system_locale: () => ({ locale: params.get('locale') ?? 'en-AU', hourCycle: params.get('hour') === '24' ? 'h23' : 'h12' }),
  get_software_settings: () => softwareSettings,
  save_software_settings: (args) => {
    if (params.get('software') === 'fail') throw 'Couldn’t turn on opening at login: the system refused the change';
    Object.assign(softwareSettings, args.settings);
    return softwareSettings;
  },
  open_external_url: (args) => {
    mockLog('open_external_url', args.url);
    return null;
  },
  check_app_update: () => { mockLog('check_app_update', null); return { currentVersion: mockAppVersion, updateAvailable: true, releaseUrl: 'https://github.com/aaronvanston/arbor/releases/tag/arbor-v0.3.201', autoUpdateSupported: true, downloadSizeBytes: 48_120_000, unsupportedReason: null, bundledCoreVersion: '8.0.4', ...mockAppReleases() }; },
  get_update_channel: () => updateChannel,
  set_update_channel: ({ channel }) => { mockLog('set_update_channel', channel); updateChannel = channel; return updateChannel; },
  get_app_update_task: () => ({ running: false, cancelable: false, phase: 'idle', targetVersion: null, downloadedBytes: 0, totalBytes: null, percent: null, message: null, fromThisMac: false }),
  start_app_update: () => {
    mockLog('start_app_update', null);
    // Starting only spawns the install, as in the app: it checks the feed again first, and a failure comes later
    // as progress.
    const checking = { running: true, cancelable: true, phase: 'checking', targetVersion: null, downloadedBytes: 0, totalBytes: null, percent: null, message: null, fromThisMac: false };
    if (params.get('appupdate') === 'gone') {
      window.setTimeout(() => void emit('app-update-progress', checking), 100);
      window.setTimeout(() => void emit('app-update-progress', { ...checking, running: false, cancelable: false, phase: 'failed', message: 'There’s no update to install anymore; check for updates again' }), 1_200);
    } else if (params.get('appupdate') === 'fail') {
      const task = (phase: string, message: string | null = null) => ({
        running: phase !== 'failed', cancelable: phase === 'downloading', phase, targetVersion: '0.3.201',
        downloadedBytes: 12_000_000, totalBytes: 48_120_000, percent: 25, message, fromThisMac: false,
      });
      window.setTimeout(() => void emit('app-update-progress', checking), 100);
      window.setTimeout(() => void emit('app-update-progress', task('downloading')), 700);
      window.setTimeout(() => void emit('app-update-progress', task('failed', 'Download failed: the release asset’s signature didn’t match.')), 2_000);
    } else {
      // Every step to Restarting, where the real app quits; on the dev channel the build is copied, with no percent.
      const fromThisMac = updateChannel === 'dev';
      const total = 48_120_000;
      const at = (phase: string, downloaded = 0) => ({
        running: true, cancelable: phase === 'checking' || phase === 'downloading', phase, targetVersion: '0.3.201', fromThisMac,
        downloadedBytes: downloaded, totalBytes: total, percent: fromThisMac ? null : (downloaded / total) * 100,
        message: fromThisMac || phase !== 'downloading' ? null : `${(downloaded / 1_000_000).toFixed(1)} MB / ${(total / 1_000_000).toFixed(1)} MB`,
      });
      const frames = [checking, ...(fromThisMac ? [at('downloading')] : [0.1, 0.35, 0.6, 0.85, 1].map((part) => at('downloading', Math.round(total * part)))), at('verifying', total), at('staging', total), at('restarting', total)];
      frames.forEach((frame, index) => window.setTimeout(() => void emit('app-update-progress', frame), 100 + index * 900));
    }
    return null;
  },
  cancel_app_update: () => null,
  get_dev_build_status: () => currentDevBuildStatus(),
  set_dev_builds: async ({ enabled, repository }) => {
    mockLog('set_dev_builds', { enabled, repository });
    if (!enabled) {
      devBuildsOn = { installed: false, repository: currentDevBuildStatus().repository };
      return currentDevBuildStatus();
    }
    const folder = repository ?? currentDevBuildStatus().repository;
    if (!folder) throw 'Choose the folder you cloned Arbor into first.';
    if (params.get('devbuild') === 'nosign') throw 'This Mac can’t sign Arbor’s update lists, so the app wouldn’t take its builds. Set up dev builds on the Mac that publishes releases.';
    // Setting up clones Arbor and starts the first build.
    await new Promise((done) => window.setTimeout(done, 1_200));
    devBuildsOn = { installed: true, repository: folder };
    devBuildRequested = true;
    return currentDevBuildStatus();
  },
  request_dev_build: () => {
    mockLog('request_dev_build', null);
    if (!currentDevBuildStatus().installed) throw 'Dev builds aren’t set up on this Mac. Run scripts/install-dev-builds.sh from Arbor’s repository.';
    devBuildRequested = true;
    return currentDevBuildStatus();
  },
  open_dev_build_log: () => { mockLog('open_dev_build_log', null); return null; },
  set_tray_rows: (args) => { mockLog('tray', { section: args.section, rows: args.rows }); return null; },
  set_tray_status: (args) => { mockLog('tray_status', args.indicator); return null; },
  frontend_ready: (args) => { mockLog('frontend_ready', args); return null; },
  set_tray_unread: (args) => { mockLog('tray_unread', args.count); return null; },
  set_tray_waiting: (args) => { mockLog('tray_waiting', args.count); return null; },
  set_quit_guard: (args) => { quitGuard = { enabled: args.enabled !== false, armedAt: null }; mockLog('quit_guard', quitGuard.enabled); return null; },
  get_zoom_level: () => zoomLevel,
  get_product_analytics: () => productAnalytics,
  set_product_analytics: (args) => { productAnalytics = { ...productAnalytics, ...args.settings }; mockLog('product_analytics', args.settings); return productAnalytics; },
  mark_product_analytics_notice_shown: () => { productAnalytics = { ...productAnalytics, noticeShown: true }; return productAnalytics; },
  track_event: (args) => { mockLog('track_event', args.event); return null; },
  report_exception: (args) => { mockLog('report_exception', args.report); return null; },
  set_zoom_level: (args) => setMockZoom(args.step),
  get_app_icon: () => appIcon,
  set_app_icon: (args) => {
    appIcon = { choice: args.choice, shown: args.choice === 'auto' ? mockBuildIcon : args.choice };
    mockLog('app_icon', appIcon);
    return appIcon;
  },
  get_phone_alert_secrets: () => {
    if (params.get('phone') === 'unreadable') throw PHONE_SECRETS_UNREADABLE;
    return phoneSecretStatus();
  },
  set_phone_alert_secret: (args) => {
    if (params.get('phone') === 'unreadable') throw PHONE_SECRETS_UNREADABLE;
    const secret = args.secret;
    if (!PHONE_ALERT_SECRETS.includes(secret)) throw `Unknown phone alert secret: ${secret}`;
    phoneSecrets[secret] = args.value.trim();
    // Which one and whether it's set, never the value, like the app.
    mockLog('set_phone_alert_secret', { secret, saved: Boolean(phoneSecrets[secret]) });
    return phoneSecretStatus();
  },
  send_phone_alert: (args) => {
    const { route, alert } = args;
    mockLog('send_phone_alert', { service: route.service, ...alert });
    if (params.get('phone') === 'unreadable') throw PHONE_SECRETS_UNREADABLE;
    if (route.service === 'pushover' && !(phoneSecrets.pushoverUserKey && phoneSecrets.pushoverAppToken)) throw 'Pushover needs your user key and an application’s API token';
    if (route.service === 'telegram' && !phoneSecrets.telegramBotToken) throw 'Telegram needs a bot token from @BotFather';
    if (route.service === 'webhook' && !phoneSecrets.webhookUrl) throw 'The webhook needs a URL';
    if (params.get('phone') === 'fail') throw 'ntfy refused the alert (HTTP 403): forbidden';
    return null;
  },
  save_digest_page: (args) => {
    // Kept for browser checks instead of a save dialog and a file.
    const { fileName, html } = args;
    (window as Window & { __digestPage?: string }).__digestPage = html;
    mockLog('save_digest_page', { fileName, bytes: html.length });
    if (params.get('save') === 'cancel') return null;
    return `/Users/mock/Downloads/${fileName}`;
  },
  open_saved_page: (args) => { mockLog('open_saved_page', args); return null; },
};

/** ⌘Q, run through the app's Quit menu item's rule: it quits (logged, not done) or arms the warning. */
export function pressMockQuit() {
  const press = pressQuit(quitGuard.armedAt, Date.now(), quitGuard.enabled, coreStatus.running);
  quitGuard = { ...quitGuard, armedAt: press.armedAt };
  if (press.action === 'quit') mockLog('quit', null);
  else void emit(QUIT_GUARD_ARMED_EVENT, { windowMs: QUIT_GUARD_WINDOW_MS });
}
