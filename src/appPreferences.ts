import { savedStore, sharedStore, storedRecord } from './services/savedStore';
import { DEFAULT_APP_COLOR, type AppColor } from './services/appColor';
import { DEFAULT_SIDEBAR_ART, DEFAULT_SIDEBAR_ART_MOTION, type SidebarArt, type SidebarArtMotion } from './services/sidebarArt';

export type AppPreferences = {
  sidebarLimits: boolean;
  /** Arbor's color: its buttons, highlights and sidebar artwork. Read it through appColorChoice, which turns anything unknown into green. */
  appColor: AppColor;
  /** The artwork behind the sidebar's title row. Read it through sidebarArtChoice, which turns anything unknown into the default. */
  sidebarArt: SidebarArt;
  /** How the artwork moves. Read it through sidebarArtMotionChoice. */
  sidebarArtMotion: SidebarArtMotion;
  /** Minutes between background limit refreshes; 0 disables polling. */
  refreshIntervalMinutes: number;
  trayLimits: boolean;
  /** Show the sessions running now in the tray menu. */
  traySessions: boolean;
  limitNotifications: boolean;
  /** Notify when an account reaches a limit that a banked or manual reset can refill. */
  resetNotifications: boolean;
  /** Notify when an account is about to reset with a good share of its headline limit unused. */
  expiringNotifications: boolean;
  /** Check the providers' public status pages for incidents. */
  providerStatus: boolean;
  /** Notify when a status page reports a new incident. Needs `providerStatus`. */
  outageNotifications: boolean;
  /** Notify when a machine stops answering its health checks, and when it's back. */
  machineNotifications: boolean;
  /** Read each machine's setup every half hour, and notify when a hook, MCP server, marketplace or plugin changes. */
  setupChangeAlerts: boolean;
  /** Tokens one session, subagents included, can use in an hour before it's flagged as heavy; 0 turns that off. */
  heavySessionTokens: number;
  /** Notify when the session archive's drive has been away, or the archive failing, for an hour, and daily after. */
  archiveAlerts: boolean;
  /** Send the week before's digest every Monday morning. */
  weeklyDigest: boolean;
  /** Notify when an agent has waited a while for permission or an answer. Needs Arbor's reporter on its machine. */
  agentPermissionAlerts: boolean;
  /** Notify when an agent has finished its turn and waited a while for the next prompt. */
  agentWaitingAlerts: boolean;
  /** Notify when Arbor pauses an account at its cap, and when it's back in use after the limit resets. */
  reserveAlerts: boolean;
  /** On macOS, hold back the first ⌘Q while the proxy runs, since quitting stops it for every machine. */
  quitGuard: boolean;
  /** Read T3 Code's threads (ids, statuses and times only) on this Mac and the machines, for the live board and the tray. */
  fleetT3Threads: boolean;
  /** Show accounts' email addresses with most of the name hidden, and the same part of any file name that repeats it. */
  hideEmails: boolean;
};

export const REFRESH_INTERVAL_OPTIONS = [0, 5, 15, 30, 60] as const;
/**
 * Hourly thresholds for heavy sessions. Most agent tokens are cache reads, so busy sessions reach tens of
 * millions an hour; 100M flagged about the busiest 1% of sessions in real use.
 */
export const HEAVY_SESSION_TOKEN_OPTIONS = [0, 50_000_000, 100_000_000, 200_000_000, 500_000_000] as const;

/** What each preference is until it's changed, and what Reset to default puts back. */
export const APP_PREFERENCE_DEFAULTS: Readonly<AppPreferences> = {
  sidebarLimits: true,
  appColor: DEFAULT_APP_COLOR,
  sidebarArt: DEFAULT_SIDEBAR_ART,
  sidebarArtMotion: DEFAULT_SIDEBAR_ART_MOTION,
  refreshIntervalMinutes: 15,
  trayLimits: true,
  traySessions: true,
  limitNotifications: true,
  resetNotifications: true,
  expiringNotifications: true,
  providerStatus: true,
  outageNotifications: true,
  machineNotifications: true,
  setupChangeAlerts: true,
  heavySessionTokens: 100_000_000,
  archiveAlerts: true,
  weeklyDigest: false,
  agentPermissionAlerts: true,
  agentWaitingAlerts: true,
  reserveAlerts: true,
  quitGuard: true,
  fleetT3Threads: true,
  hideEmails: false,
};

/** What's saved, over the defaults, so a preference added since keeps its default. */
const parsePreferences = (raw: string | null): AppPreferences =>
  raw ? { ...APP_PREFERENCE_DEFAULTS, ...(storedRecord(raw) as Partial<AppPreferences>) } : APP_PREFERENCE_DEFAULTS;

/** What's saved: each change writes this, and only this. */
const saved = savedStore<AppPreferences>({ key: 'arbor.preferences.v1', parse: parsePreferences, fallback: APP_PREFERENCE_DEFAULTS });
/** Set for this page load over what's saved (the browser mock's scenarios), and never written. */
let previews: Partial<AppPreferences> = {};
const shown = sharedStore<AppPreferences>(saved.get());

export const useAppPreferences = shown.useValue;
/** The preferences now, for code that runs outside a render. */
export const getAppPreferences = shown.get;

const publish = () => shown.set({ ...saved.get(), ...previews });

export function setAppPreference<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
  saved.set({ ...saved.get(), [key]: value });
  // Choosing a preference replaces a preview of it; the other previews stay, still unsaved.
  const rest = { ...previews };
  delete rest[key];
  previews = rest;
  publish();
}

/**
 * Sets a preference for this page load only: the browser mock's scenarios (`?art=`). It's kept apart from what's
 * saved, so changing another preference afterward doesn't save it along with that one.
 */
export function previewAppPreference<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
  previews = { ...previews, [key]: value };
  publish();
}
