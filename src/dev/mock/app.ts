/** The browser mock's answers for the app itself: its settings, window, updates, phone alerts and saved pages. */
import { emit } from '@tauri-apps/api/event';
import { PHONE_ALERT_SECRETS } from '../../services/phoneAlerts';
import { QUIT_GUARD_ARMED_EVENT, QUIT_GUARD_WINDOW_MS, pressQuit } from '../../services/quitGuard';
import { nearestZoomStep, ZOOM_CHANGED_EVENT, zoomLevelAt } from '../../services/zoom';
import type { AppCommands } from '../../native/app';
import type { PhoneAlertSecret, ProductAnalyticsSettings, ReleaseNotes, SoftwareSettings, ZoomLevel } from '../../native/types';
import type { CommandAnswers } from './answers';
import { configSettings, coreStatus } from './core';
import { mockLog, params } from './scenario';

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
  noticeShown: params.get('usagedata') !== 'new',
  blockedByEnv: params.get('usagedata') === 'env',
  available: params.get('usagedata') !== 'source',
};

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
const ZOOM_UNSAVED = 'Failed to write configuration directly /Users/casey/Library/Application Support/onl.arbor.app/config.toml: Permission denied (os error 13)';

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
  "The saved alert secrets in /Users/casey/Library/Application Support/EasyCLIProxyAPI/phone-alert-secrets.json can't be read. Delete the file and enter them again.";
const phoneSecretStatus = () =>
  Object.fromEntries(PHONE_ALERT_SECRETS.map((secret) => [secret, Boolean(phoneSecrets[secret])])) as Record<PhoneAlertSecret, boolean>;

// Release notes as the update feed gives them, newest first.
function mockAppReleases(): { latestVersion: string; releases: ReleaseNotes[] } {
  const scenario = params.get('appnotes');
  if (scenario === 'none') return { latestVersion: '0.2.81', releases: [] };
  if (scenario === 'long') {
    return {
      latestVersion: '0.2.88',
      releases: Array.from({ length: 9 }, (_, index) => {
        const version = `0.2.${88 - index}`;
        const changes = Array.from({ length: index === 0 ? 11 : 3 }, (__, change) => `Change ${change + 1} in ${version}`);
        if (index === 1) changes.unshift(`Keep every account’s limits readable when a provider sends a reset time far in the future, a window Arbor hasn’t seen before and a plan name it doesn’t recognize, so the Accounts page, the sidebar limits and the capacity report all agree instead of showing three different answers for the same account`);
        return { version, changes };
      }),
    };
  }
  return {
    latestVersion: '0.2.81',
    releases: [
      {
        version: '0.2.81',
        summary: 'Updates now show what they change.',
        changes: [
          'Show what an update changes beside the update pill',
          'Show the core’s changes on Settings › Updates',
          'Record each release on GitHub with its DMG',
          'Install the update the feed has now, not the one from the last check',
          'Install the newer core an Arbor update brings',
          'Bundle core 7.3.17',
          'Name a session’s state the same way everywhere on Home and Sessions',
          'Keep a plan ready on the board until it’s acted on',
          'Wake a snoozed thread when it asks for another approval',
          'Say when a stopped thread was last active',
        ],
      },
      { version: '0.2.80', changes: ['Already installed, so not shown'] },
      { version: '0.2.79', changes: ['Older still'] },
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
  check_app_update: () => { mockLog('check_app_update', null); return { currentVersion: '0.2.80', updateAvailable: true, releaseUrl: 'https://github.com/aaronvanston/arbor/releases/tag/arbor-v0.2.80', autoUpdateSupported: true, downloadSizeBytes: 48_120_000, unsupportedReason: null, bundledCoreVersion: '6.8.21', ...mockAppReleases() }; },
  get_app_update_task: () => ({ running: false, cancelable: false, phase: 'idle', targetVersion: null, downloadedBytes: 0, totalBytes: null, percent: null, message: null }),
  start_app_update: () => {
    mockLog('start_app_update', null);
    // Starting only spawns the install, as in the app: it checks the feed again first, and a failure comes later
    // as progress.
    const checking = { running: true, cancelable: true, phase: 'checking', targetVersion: null, downloadedBytes: 0, totalBytes: null, percent: null, message: null };
    if (params.get('appupdate') === 'gone') {
      window.setTimeout(() => void emit('app-update-progress', checking), 100);
      window.setTimeout(() => void emit('app-update-progress', { ...checking, running: false, cancelable: false, phase: 'failed', message: 'There’s no update to install anymore; check for updates again' }), 1_200);
    } else if (params.get('appupdate') === 'fail') {
      const task = (phase: string, message: string | null = null) => ({
        running: phase !== 'failed', cancelable: phase === 'downloading', phase, targetVersion: '0.2.81',
        downloadedBytes: 12_000_000, totalBytes: 48_120_000, percent: 25, message,
      });
      window.setTimeout(() => void emit('app-update-progress', checking), 100);
      window.setTimeout(() => void emit('app-update-progress', task('downloading')), 700);
      window.setTimeout(() => void emit('app-update-progress', task('failed', 'Download failed: the release asset’s signature didn’t match.')), 2_000);
    }
    return null;
  },
  cancel_app_update: () => null,
  set_tray_lines: (args) => { mockLog('tray', { section: args.section, lines: args.lines }); return null; },
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
