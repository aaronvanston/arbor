import { invokeCommand } from '../native/commands';

/** Why a T3 Code database wasn't read, and the newest migration it had when that's known. */
export type T3SkipReason = 'noSqlite3' | 'migrationRange' | 'schema' | 'unreadable';

/** Event sent when a T3 Code snapshot changes. */
export const T3_THREADS_UPDATED_EVENT = 't3-threads-updated';

export const getFleetSources = () => invokeCommand('get_fleet_sources');

/** Turns reading T3 Code's threads on or off. Nothing is read until this is sent, and off drops what was read. */
export const setT3ThreadsEnabled = (enabled: boolean) => invokeCommand('set_t3_threads_enabled', { enabled });

/** Puts the number of sessions waiting on their user beside the tray icon, ahead of the unread alerts. */
export const setTrayWaiting = (count: number) => invokeCommand('set_tray_waiting', { count });
