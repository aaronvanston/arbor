import { translate } from '../i18n';

/**
 * A length someone picks or reads back as a setting, in the words its picker uses: "15 s", "5 min", "1 h",
 * "1 h 30 min", "24 h". A setting and the page showing it say the same thing this way, where formatDuration's
 * "1h 0m" is for how long something took or has left.
 */
export function durationWords(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (whole < 60) return translate('duration.seconds', { count: whole });
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return translate('duration.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? translate('duration.hoursMinutes', { hours, minutes: rest }) : translate('duration.hours', { count: hours });
}
