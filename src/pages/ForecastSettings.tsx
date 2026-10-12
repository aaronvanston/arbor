import { setAppPreference, useAppPreferences } from '../appPreferences';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { NumberField } from '../components/ui/number-field';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import { FORECAST_LOOKBACK_OPTIONS, type ForecastModel } from '../services/limitForecast';
import { onOffLabel, preferenceReset } from '../services/settingDefaults';

const MODELS: ForecastModel[] = ['weekly', 'recent'];

/** Settings › Appearance's rows for the limit forecast on Accounts › Limits. */
export function ForecastSettingsSection() {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const onOff = onOffLabel(t);
  const modelLabel = (model: ForecastModel) => t(model === 'recent' ? 'appearance.forecastModel.recent' : 'appearance.forecastModel.weekly');
  const daysLabel = (days: number) => (days === 1 ? t('appearance.forecastLookback.days.one') : t('appearance.forecastLookback.days.other', { days }));
  const rateLabel = (rate: number) => (rate > 0 ? `${rate}%` : t('appearance.forecastRate.automatic'));
  return (
    <SettingsSection title={t('appearance.forecast.title')} description={t('appearance.forecast.description')}>
      <SettingsRow
        settingId="appearance.forecast-model"
        reset={preferenceReset(preferences, 'forecastModel', modelLabel)}
        title={t('appearance.forecastModel.title')}
        description={t('appearance.forecastModel.description')}
        control={
          <Select value={preferences.forecastModel} onValueChange={(value) => setAppPreference('forecastModel', value === 'recent' ? 'recent' : 'weekly')}>
            <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={t('appearance.forecastModel.title')}>
              <SelectValue>{modelLabel(preferences.forecastModel)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {MODELS.map((model) => <SelectItem key={model} value={model}>{modelLabel(model)}</SelectItem>)}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        settingId="appearance.forecast-lookback"
        reset={preferenceReset(preferences, 'forecastLookbackDays', daysLabel)}
        title={t('appearance.forecastLookback.title')}
        description={t('appearance.forecastLookback.description')}
        control={
          <Select value={String(preferences.forecastLookbackDays)} onValueChange={(value) => setAppPreference('forecastLookbackDays', Number(value ?? 7))}>
            <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={t('appearance.forecastLookback.title')}>
              <SelectValue>{daysLabel(preferences.forecastLookbackDays)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {FORECAST_LOOKBACK_OPTIONS.map((days) => <SelectItem key={days} value={String(days)}>{daysLabel(days)}</SelectItem>)}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        settingId="appearance.forecast-rate"
        reset={preferenceReset(preferences, 'forecastRatePerHour', rateLabel)}
        title={t('appearance.forecastRate.title')}
        description={t('appearance.forecastRate.description')}
        control={
          <NumberField
            wrapperClassName="w-28"
            min={0}
            max={100}
            step={0.1}
            value={preferences.forecastRatePerHour}
            onValueChange={(next) => setAppPreference('forecastRatePerHour', next !== null && Number.isFinite(next) && next > 0 ? next : 0)}
            unit="%"
            aria-label={t('appearance.forecastRate.title')}
          />
        }
      />
      <SettingsRow
        settingId="appearance.forecast-resets"
        reset={preferenceReset(preferences, 'forecastResets', onOff)}
        title={t('appearance.forecastResets.title')}
        description={t('appearance.forecastResets.description')}
        control={
          <Switch
            checked={preferences.forecastResets}
            aria-label={t('appearance.forecastResets.title')}
            onCheckedChange={(checked) => setAppPreference('forecastResets', checked)}
          />
        }
      />
    </SettingsSection>
  );
}
