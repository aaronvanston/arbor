import type { MessageKey, MessageVariables } from '../i18n/resources';
import { settingsPageIds, type SettingsPageId } from '../navigation';

/** A group of advanced settings that starts folded, so search knows to open it. */
export type SettingsFold = 'logging' | 'retry' | 'tls';

/**
 * One row (or a section with no rows of its own) on a Settings page, as search finds it. The page renders the same
 * `id` as the row's `settingId`, which becomes its `data-setting-id`; tests/settingsIndex.test.ts keeps the two in step.
 */
export type SettingEntry = {
  /** Stable across copy changes: `<page>.<name>`. */
  id: string;
  page: SettingsPageId;
  section: MessageKey;
  title: MessageKey;
  description?: MessageKey;
  /** Other words it can be found by, in the same language as the rest. */
  keywords?: MessageKey;
  /** The folded group that holds it. */
  fold?: SettingsFold;
  /** Where search lands instead while the row isn't shown (TLS off, no phone service chosen). */
  fallback?: string;
};

/** Each Settings page's name, as the sidebar lists it. */
export const SETTINGS_PAGE_LABEL: Record<SettingsPageId, MessageKey> = {
  general: 'settings.nav.general',
  routing: 'settings.nav.routing',
  overrides: 'settings.nav.overrides',
  aliases: 'settings.nav.aliases',
  'extra-models': 'settings.nav.extraModels',
  machines: 'settings.nav.machines',
  'session-archive': 'settings.nav.sessionArchive',
  data: 'settings.nav.data',
  diagnostics: 'settings.nav.diagnostics',
  appearance: 'settings.nav.appearance',
  notifications: 'settings.nav.notifications',
  software: 'settings.nav.software',
  updates: 'settings.nav.updates',
  about: 'settings.nav.about',
};

const row = (
  page: SettingsPageId,
  name: string,
  section: MessageKey,
  title: MessageKey,
  more: Omit<SettingEntry, 'id' | 'page' | 'section' | 'title'> = {},
): SettingEntry => ({ id: `${page}.${name}`, page, section, title, ...more });

/** A section indexed as a whole: a list or table rather than rows of settings. */
const section = (page: SettingsPageId, name: string, title: MessageKey, more: Omit<SettingEntry, 'id' | 'page' | 'section' | 'title'> = {}) =>
  row(page, name, title, title, more);

/** Every setting in Settings, page by page in sidebar order. */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  section('general', 'api-keys', 'config.keys.title', { description: 'config.keys.add', keywords: 'settingsSearch.keywords.apiKeys' }),
  row('general', 'port', 'config.network.networkSection', 'config.network.port', { description: 'config.network.portHint', keywords: 'settingsSearch.keywords.listen' }),
  row('general', 'host', 'config.network.networkSection', 'config.network.listenHost', { description: 'config.network.listenHostHint', keywords: 'settingsSearch.keywords.listen' }),
  row('general', 'proxy-url', 'config.network.networkSection', 'config.network.proxyUrl', { description: 'config.network.proxyHint', keywords: 'settingsSearch.keywords.proxy' }),
  row('general', 'webui-key', 'config.webuiKey.title', 'config.webuiKey.heading', { description: 'config.webuiKey.description', keywords: 'settingsSearch.keywords.webuiKey' }),
  ...([
    ['disable-cooling', 'config.network.disableCooling', 'config.network.disableCoolingHint'],
    ['request-retry', 'config.network.requestRetry', 'config.network.requestRetryHint'],
    ['max-retry-credentials', 'config.network.maxRetryCredentials', 'config.network.maxRetryCredentialsHint'],
    ['max-retry-interval', 'config.network.maxRetryInterval', 'config.network.maxRetryIntervalHint'],
    ['streaming-bootstrap-retries', 'config.network.streamingBootstrapRetries', 'config.network.streamingBootstrapRetriesHint'],
  ] as const).map(([name, title, description]) =>
    row('general', name, 'config.network.retrySection', title, { description, keywords: 'settingsSearch.keywords.retry', fold: 'retry' })),
  row('general', 'tls', 'config.tls.title', 'config.tls.enable', { description: 'config.tls.enableDescription', keywords: 'settingsSearch.keywords.tls', fold: 'tls' }),
  row('general', 'tls-cert', 'config.tls.title', 'config.tls.cert', { description: 'config.tls.certHint', keywords: 'settingsSearch.keywords.tls', fold: 'tls', fallback: 'general.tls' }),
  row('general', 'tls-key', 'config.tls.title', 'config.tls.key', { description: 'config.tls.keyHint', keywords: 'settingsSearch.keywords.tls', fold: 'tls', fallback: 'general.tls' }),
  ...([
    ['debug', 'config.diagnostics.debug.title', 'config.diagnostics.debug.description'],
    ['commercial-mode', 'config.diagnostics.commercial.title', 'config.diagnostics.commercial.description'],
    ['file-logging', 'config.diagnostics.fileLogging.title', 'config.diagnostics.fileLogging.description'],
    ['usage-statistics', 'config.diagnostics.usage.title', 'config.diagnostics.usage.description'],
    ['logs-max-size', 'config.diagnostics.maxSize.title', 'config.diagnostics.maxSize.hint'],
    ['error-log-files', 'config.diagnostics.errorFiles.title', 'config.diagnostics.errorFiles.hint'],
    ['redis-retention', 'config.diagnostics.redisRetention.title', 'config.diagnostics.redisRetention.hint'],
  ] as const).map(([name, title, description]) =>
    row('general', name, 'config.diagnostics.title', title, { description, keywords: 'settingsSearch.keywords.logging', fold: 'logging' })),

  row('routing', 'session-affinity', 'config.network.routingSection', 'config.network.sessionAffinity', { description: 'config.network.sessionAffinityHint' }),
  row('routing', 'session-ttl', 'config.network.routingSection', 'config.network.sessionTtl', { description: 'config.network.sessionTtlHint' }),
  row('routing', 'strategy', 'config.routing.title', 'config.routing.rowTitle', { description: 'config.routing.description', keywords: 'settingsSearch.keywords.strategy' }),
  section('routing', 'accounts', 'accounts.routing.title', { description: 'accounts.routing.description', keywords: 'settingsSearch.keywords.accountOrder' }),

  section('overrides', 'quick', 'overrides.quick.title', { description: 'overrides.quick.description', fallback: 'overrides.create' }),
  section('overrides', 'create', 'overrides.create.title', { description: 'overrides.create.description' }),
  section('overrides', 'list', 'overrides.list.title', { description: 'overrides.list.description' }),

  section('aliases', 'create', 'aliases.create.title', { description: 'aliases.create.description' }),
  section('aliases', 'list', 'aliases.createdList.title', { description: 'aliases.createdList.description' }),

  section('extra-models', 'suggestions', 'extraModels.suggestions.title', { description: 'extraModels.suggestions.description' }),
  section('extra-models', 'list', 'extraModels.list.title', { description: 'extraModels.list.description' }),
  section('extra-models', 'add', 'extraModels.add.title', { description: 'extraModels.add.description' }),

  section('machines', 'assignments', 'usage.assignments.title', { description: 'usage.assignments.description' }),
  section('machines', 'hosts', 'machines.hosts.title', { description: 'machines.hosts.description', keywords: 'settingsSearch.keywords.ssh' }),
  row('machines', 't3Threads', 'fleet.settings.title', 'fleet.settings.t3Threads', { description: 'fleet.settings.t3ThreadsHint', keywords: 'fleet.palette.keywords' }),
  row('machines', 'telemetry', 'telemetry.settings.title', 'telemetry.settings.receive', { description: 'telemetry.settings.receiveHint' }),
  row('machines', 'telemetry-port', 'telemetry.settings.title', 'telemetry.settings.port', { description: 'telemetry.settings.portHint' }),
  row('machines', 'telemetry-machines', 'telemetry.settings.title', 'telemetry.settings.machines'),

  row('session-archive', 'folder', 'sessionArchive.title', 'sessionArchive.folder.title', { description: 'sessionArchive.setup.folderDescription' }),
  row('session-archive', 'status', 'sessionArchive.title', 'sessionArchive.status.title', { fallback: 'session-archive.folder' }),
  row('session-archive', 'pause', 'sessionArchive.title', 'sessionArchive.pause.title', { description: 'sessionArchive.pause.description', fallback: 'session-archive.folder' }),
  row('session-archive', 'gentle', 'sessionArchive.title', 'sessionArchive.gentle.title', { description: 'sessionArchive.gentle.description', fallback: 'session-archive.folder' }),
  row('session-archive', 'other-machines', 'sessionArchive.title', 'sessionArchive.otherMachines.title', { description: 'sessionArchive.otherMachines.description', fallback: 'session-archive.folder' }),
  section('session-archive', 'kept', 'sessionArchive.kept.title', { description: 'sessionArchive.kept.description', fallback: 'session-archive.folder' }),
  section('session-archive', 'imports', 'sessionArchive.imports.title', { description: 'sessionArchive.imports.description', fallback: 'session-archive.folder' }),

  row('data', 'collector', 'usage.collector.title', 'usage.collector.status', { description: 'usage.collector.description' }),
  row('data', 'retention', 'usage.storage.title', 'usage.storage.retention.title', { description: 'usage.storage.retention.description' }),
  row('data', 'compact', 'usage.storage.title', 'usage.storage.compact.title', { description: 'usage.storage.compact.description' }),
  row('data', 'repair', 'usage.dataManagement.title', 'usage.dataManagement.actionTitle', { description: 'usage.dataManagement.actionDescription' }),

  section('diagnostics', 'calls', 'diagnostics.calls.title', { description: 'diagnostics.calls.description', keywords: 'settingsSearch.keywords.calls' }),
  section('diagnostics', 'problems', 'diagnostics.problems.title', { description: 'diagnostics.problems.description', keywords: 'settingsSearch.keywords.calls' }),

  row('appearance', 'theme', 'appearance.window.title', 'appearance.theme.title', { description: 'appearance.theme.description', keywords: 'settingsSearch.keywords.theme' }),
  row('appearance', 'color', 'appearance.window.title', 'appearance.color.title', { description: 'appearance.color.description', keywords: 'settingsSearch.keywords.color' }),
  row('appearance', 'sidebar-art', 'appearance.window.title', 'appearance.sidebarArt.title', { description: 'appearance.sidebarArt.description', keywords: 'settingsSearch.keywords.sidebarArt' }),
  row('appearance', 'sidebar-art-motion', 'appearance.window.title', 'appearance.sidebarArtMotion.title', { description: 'appearance.sidebarArtMotion.description', keywords: 'settingsSearch.keywords.sidebarArtMotion' }),
  row('appearance', 'zoom', 'appearance.window.title', 'appearance.zoom.title', { description: 'appearance.zoom.description', keywords: 'settingsSearch.keywords.zoom' }),
  row('appearance', 'sidebar-limits', 'appearance.sidebarTray.title', 'interface.sidebarLimits.title', { description: 'interface.sidebarLimits.description' }),
  row('appearance', 'tray-limits', 'appearance.sidebarTray.title', 'interface.trayLimits.title', { description: 'interface.trayLimits.description', keywords: 'settingsSearch.keywords.tray' }),
  row('appearance', 'tray-sessions', 'appearance.sidebarTray.title', 'interface.traySessions.title', { description: 'interface.traySessions.description', keywords: 'settingsSearch.keywords.tray' }),
  row('appearance', 'hide-emails', 'appearance.privacy.title', 'appearance.hideEmails.title', { description: 'appearance.hideEmails.description', keywords: 'settingsSearch.keywords.hideEmails' }),
  row('appearance', 'refresh-interval', 'appearance.limits.title', 'interface.refreshInterval.title', { description: 'interface.refreshInterval.description', keywords: 'settingsSearch.keywords.refresh' }),

  ...([
    ['limit-pace', 'interface.limits.title', 'interface.limitNotifications.title', 'interface.limitNotifications.description'],
    ['reset-ready', 'interface.limits.title', 'interface.resetNotifications.title', 'interface.resetNotifications.description'],
    ['reserve', 'interface.limits.title', 'interface.reserveAlerts.title', 'interface.reserveAlerts.description'],
    ['expiring', 'interface.limits.title', 'interface.expiringNotifications.title', 'interface.expiringNotifications.description'],
    ['heavy-sessions', 'interface.sessions.title', 'interface.heavySessions.title', 'interface.heavySessions.description'],
    ['archive-alerts', 'interface.sessions.title', 'interface.archiveAlerts.title', 'interface.archiveAlerts.description'],
    ['provider-status', 'interface.status.title', 'interface.providerStatus.title', 'interface.providerStatus.description'],
    ['outages', 'interface.status.title', 'interface.outageNotifications.title', 'interface.outageNotifications.description'],
    ['machines', 'interface.machines.title', 'interface.machineNotifications.title', 'interface.machineNotifications.description'],
    ['setup-changes', 'interface.machines.title', 'interface.setupChangeAlerts.title', 'interface.setupChangeAlerts.description'],
    ['agent-permission', 'interface.attention.title', 'interface.agentPermissionAlerts.title', 'interface.agentPermissionAlerts.description'],
    ['agent-waiting', 'interface.attention.title', 'interface.agentWaitingAlerts.title', 'interface.agentWaitingAlerts.description'],
    ['weekly-digest', 'interface.digest.title', 'interface.weeklyDigest.title', 'interface.weeklyDigest.description'],
  ] as const).map(([name, sectionTitle, title, description]) =>
    row('notifications', name, sectionTitle, title, { description, keywords: 'settingsSearch.keywords.alerts' })),
  row('notifications', 'phone-service', 'phoneAlerts.title', 'phoneAlerts.service.title', { description: 'phoneAlerts.description', keywords: 'settingsSearch.keywords.phone' }),
  row('notifications', 'phone-test', 'phoneAlerts.title', 'phoneAlerts.test.title', { description: 'phoneAlerts.test.description', keywords: 'settingsSearch.keywords.phone', fallback: 'notifications.phone-service' }),
  section('notifications', 'phone-topics', 'phoneAlerts.topics.title', { description: 'phoneAlerts.topics.description', keywords: 'settingsSearch.keywords.phone', fallback: 'notifications.phone-service' }),

  row('software', 'autostart', 'config.software.title', 'config.software.autostart', { description: 'config.software.autostartDescription', keywords: 'settingsSearch.keywords.startup' }),
  row('software', 'start-core', 'config.software.title', 'config.software.startCoreOnLaunch', { description: 'config.software.startCoreOnLaunchDescription', keywords: 'settingsSearch.keywords.startup' }),
  row('software', 'silent-start', 'config.software.title', 'config.software.silentStart', { description: 'config.software.silentStartDescription', keywords: 'settingsSearch.keywords.startup' }),
  row('software', 'close-behavior', 'config.software.title', 'config.software.closeBehavior', { description: 'config.software.closeBehaviorDescription' }),
  row('software', 'quit-guard', 'config.quit.title', 'config.quit.guard', { description: 'config.quit.guardDescription', keywords: 'settingsSearch.keywords.quit' }),
  row('software', 'usage-data', 'usageData.title', 'usageData.usage', { description: 'usageData.usageDescription', keywords: 'settingsSearch.keywords.usageData' }),
  row('software', 'crash-reports', 'usageData.title', 'usageData.crashes', { description: 'usageData.crashesDescription', keywords: 'settingsSearch.keywords.usageData' }),

  row('updates', 'app', 'kernel.versions.appCardTitle', 'appUpdate.status', { description: 'appUpdate.feed', keywords: 'settingsSearch.keywords.updates' }),
  row('updates', 'core', 'kernel.versions.coreCardTitle', 'kernel.versions.updateStatus', { description: 'kernel.versions.coreSourceHint', keywords: 'settingsSearch.keywords.updates' }),

  section('about', 'built-on', 'about.builtOn.title', { description: 'about.builtOn.description', keywords: 'settingsSearch.keywords.about' }),
  section('about', 'ideas', 'about.ideas.title', { description: 'about.ideas.description', keywords: 'settingsSearch.keywords.about' }),
  section('about', 'parts', 'about.parts.title', { description: 'about.parts.description', keywords: 'settingsSearch.keywords.about' }),
  section('about', 'sources', 'about.sources.title', { description: 'about.sources.description', keywords: 'settingsSearch.keywords.about' }),
  section('about', 'licenses', 'about.licenses.title', { description: 'about.licenses.description', keywords: 'settingsSearch.keywords.about' }),
  section('about', 'privacy', 'about.privacy.title', { description: 'about.privacy.description', keywords: 'settingsSearch.keywords.usageData' }),
];

const byId = new Map(SETTINGS_INDEX.map((entry) => [entry.id, entry]));

/**
 * Rows that moved page, by the start of the ids they had, for picks saved before: Network's are on Proxy (`general`),
 * and Auth files' account order is on Routing.
 */
const MOVED_SETTING_IDS: readonly (readonly [string, string])[] = [['network.', 'general.'], ['auth-files.routing', 'routing.accounts']];

/** A setting's id today, for one saved under the page it used to be on. */
export function currentSettingId(id: string) {
  const moved = MOVED_SETTING_IDS.find(([from]) => id.startsWith(from));
  return moved ? `${moved[1]}${id.slice(moved[0].length)}` : id;
}

export const settingEntry = (id: string | null | undefined) => (id ? byId.get(currentSettingId(id)) : undefined);

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** A setting with its words read out, ready to search. */
export type IndexedSetting = {
  entry: SettingEntry;
  title: string;
  section: string;
  page: string;
  /** The other words it can be found by, besides its title, section, page and description. */
  aliases: string;
  /** Everything it can be found by, lowercase. */
  words: string;
};

// A description that takes a value ({minutes}, {percent}) is searched without the placeholder.
const readable = (text: string) => text.replace(/\{\w+\}/g, ' ');

/** The index in the words of the language the app is in. */
export function indexSettings(t: Translate, entries: readonly SettingEntry[] = SETTINGS_INDEX): IndexedSetting[] {
  return entries.map((entry) => {
    const title = t(entry.title);
    const section = t(entry.section);
    const page = t(SETTINGS_PAGE_LABEL[entry.page]);
    const description = entry.description ? readable(t(entry.description)) : '';
    const aliases = entry.keywords ? t(entry.keywords) : '';
    return { entry, title, section, page, aliases, words: [title, section, page, description, aliases].join(' ').toLowerCase() };
  });
}

const terms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * How well a setting matches, lower first, or null when a word typed isn't anywhere in it: the title starting with
 * what's typed, then a word of the title starting with it, then the title holding every word, then its section or
 * page, then only its description or other words.
 */
export function settingScore(setting: IndexedSetting, query: string): number | null {
  const words = terms(query);
  const [first] = words;
  if (!first) return null;
  if (!words.every((word) => setting.words.includes(word))) return null;
  const title = setting.title.toLowerCase();
  if (title.startsWith(words.join(' '))) return 0;
  if (title.split(/[\s/·._:-]+/).some((part) => part.startsWith(first))) return 1;
  if (words.every((word) => title.includes(word))) return 2;
  const place = `${setting.section} ${setting.page}`.toLowerCase();
  return words.every((word) => title.includes(word) || place.includes(word)) ? 3 : 4;
}

export type SettingsSearchGroup = { page: SettingsPageId; label: string; settings: IndexedSetting[] };

/**
 * The settings that match, grouped by page: the page with the best match first (sidebar order between equals), and
 * within a page the best first, then in page order. Nothing typed matches nothing.
 */
export function searchSettings(index: readonly IndexedSetting[], query: string): SettingsSearchGroup[] {
  const scored = index.flatMap((setting, order) => {
    const score = settingScore(setting, query);
    return score === null ? [] : [{ setting, score, order }];
  });
  const groups = settingsPageIds.flatMap((page) => {
    const members = scored.filter((item) => item.setting.entry.page === page).sort((a, b) => a.score - b.score || a.order - b.order);
    const [best] = members;
    return best ? [{ page, label: best.setting.page, best: best.score, settings: members.map((item) => item.setting) }] : [];
  });
  return groups
    .map((group, order) => ({ group, order }))
    .sort((a, b) => a.group.best - b.group.best || a.order - b.order)
    .map(({ group: { page, label, settings } }) => ({ page, label, settings }));
}

/**
 * Where a key pressed on one of the `count` results (the one at `at`) moves focus: the arrows step through them, and
 * up from the first goes back to the field. So does Escape, which the field then uses to clear what's typed, so it
 * never leaves Settings straight from a result. Null for a key the results leave alone.
 */
export function resultKeyStep(key: string, at: number, count: number): number | 'field' | null {
  if (key === 'Escape') return 'field';
  if (key === 'ArrowUp') return at <= 0 ? 'field' : at - 1;
  if (key === 'ArrowDown') return count ? Math.min(at + 1, count - 1) : null;
  return null;
}

/** How long search waits for a row to show (a page still loading) before landing on its fallback. */
const FALLBACK_AFTER_MS = 800;
/** How long it waits for either before giving up, leaving the page open at the top. */
const GIVE_UP_AFTER_MS = 4_000;

export type RevealStep = { reveal: string } | 'wait' | 'give-up';

/**
 * What to do about a setting asked for, given which rows are on screen now and how long it has waited: bring it into
 * view once it's there, its fallback once it has had a moment to show and hasn't, and give up after a while.
 */
export function revealStep(entry: SettingEntry, shown: (id: string) => boolean, waitedMs: number): RevealStep {
  if (shown(entry.id)) return { reveal: entry.id };
  if (entry.fallback && waitedMs >= FALLBACK_AFTER_MS && shown(entry.fallback)) return { reveal: entry.fallback };
  return waitedMs >= GIVE_UP_AFTER_MS ? 'give-up' : 'wait';
}
