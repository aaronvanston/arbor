import { useEffect, useState } from 'react';
import type { AppPreferences } from '../appPreferences';
import { invokeCommand } from '../native/commands';
import type { LimitTrendAccount } from '../native/types';
import {
  FORECAST_HISTORY_MS, FORECAST_HORIZON_OPTIONS, FORECAST_LOOKBACK_OPTIONS, type ForecastModel, type ForecastSettings,
} from './limitForecast';
import { savedStore, storedRecord } from './savedStore';

const DAY = 86_400_000;

/** How the forecast panel is laid out in this window: how far ahead it looks, which tab, and which are folded. */
export type ForecastView = { horizonDays: number; tab: 'remaining' | 'drain'; folded: Record<string, true> };
const DEFAULT_VIEW: ForecastView = { horizonDays: 7, tab: 'remaining', folded: {} };

function parseView(raw: string | null): ForecastView {
  const record = storedRecord(raw);
  const horizon = Number(record.horizonDays);
  const folded = typeof record.folded === 'object' && record.folded !== null && !Array.isArray(record.folded) ? record.folded as Record<string, unknown> : {};
  return {
    horizonDays: (FORECAST_HORIZON_OPTIONS as readonly number[]).includes(horizon) ? horizon : DEFAULT_VIEW.horizonDays,
    tab: record.tab === 'drain' ? 'drain' : 'remaining',
    folded: Object.fromEntries(Object.keys(folded).filter((key) => folded[key] === true).map((key) => [key, true as const])),
  };
}

const view = savedStore<ForecastView>({ key: 'arbor.limit-forecast.v1', parse: parseView, fallback: DEFAULT_VIEW, place: 'window' });
export const useForecastView = view.useValue;
export const setForecastView = (change: Partial<ForecastView>) => view.set({ ...view.get(), ...change });
export function setForecastFolded(provider: string, folded: boolean) {
  const next = { ...view.get().folded };
  if (folded) next[provider] = true;
  else delete next[provider];
  setForecastView({ folded: next });
}

/** The forecast's settings from the app's preferences, with anything unknown (set by hand, or by the CLI) as its default. */
export function forecastSettingsFrom(preferences: Pick<AppPreferences, 'forecastModel' | 'forecastLookbackDays' | 'forecastRatePerHour' | 'forecastResets'>): ForecastSettings {
  const model: ForecastModel = preferences.forecastModel === 'recent' ? 'recent' : 'weekly';
  const lookback = (FORECAST_LOOKBACK_OPTIONS as readonly number[]).includes(preferences.forecastLookbackDays) ? preferences.forecastLookbackDays : 7;
  const rate = Number(preferences.forecastRatePerHour);
  return { model, lookbackDays: lookback, ratePerHour: Number.isFinite(rate) && rate > 0 ? rate : null, countResets: preferences.forecastResets === true };
}

/** How far back the chart draws for a horizon: a quarter of it, a day to a week. */
export const forecastHistoryMs = (horizonDays: number) => Math.min(7 * DAY, Math.max(DAY, (horizonDays * DAY) / 4));

export const loadLimitTrend = (provider: string, window: string, nowMs = Date.now()) =>
  invokeCommand('get_limit_trend', { provider, window, sinceMs: nowMs - FORECAST_HISTORY_MS });

/**
 * A provider window's readings over the last four weeks, read again whenever `version` changes (the accounts' latest
 * refresh), so the chart follows the limits without polling. Null until the first read lands.
 */
export function useLimitTrend(provider: string, window: string | null, version: number) {
  const [state, setState] = useState<{ key: string; readings: LimitTrendAccount[] | null; failed: boolean }>({ key: '', readings: null, failed: false });
  const key = `${provider}\u0000${window ?? ''}`;
  useEffect(() => {
    if (!window) return;
    let current = true;
    loadLimitTrend(provider, window)
      .then((readings) => { if (current) setState({ key, readings, failed: false }); })
      .catch((error: unknown) => {
        console.warn('Failed to read limit history', error);
        if (current) setState((previous) => ({ key, readings: previous.key === key ? previous.readings : [], failed: true }));
      });
    return () => { current = false; };
  }, [key, provider, window, version]);
  return state.key === key ? state : { key, readings: null, failed: false };
}
