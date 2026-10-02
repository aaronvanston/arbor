import { useState } from 'react';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import type { AppIconChoice } from '../native/types';
import { APP_ICON_CHOICES, APP_ICON_LABEL, setAppIcon, useAppIcon } from '../services/appIcon';
import { resetOffer } from '../services/settingDefaults';
import { SettingsRow } from './layout/settings';
import forest from '../assets/app-icons/forest.png';
import amber from '../assets/app-icons/amber.png';
import sky from '../assets/app-icons/sky.png';
import ember from '../assets/app-icons/ember.png';
import signal from '../assets/app-icons/signal.png';
import paper from '../assets/app-icons/paper.png';
import mono from '../assets/app-icons/mono.png';

/** Each color's icon, drawn from the same source as the Dock's (src-tauri/icons/variants). */
const ICON_IMAGE: Record<Exclude<AppIconChoice, 'auto'>, string> = { forest, amber, sky, ember, signal, paper, mono };

/** The picture of an icon as it shows in the Dock; auto never reaches the Dock, so it reads as Forest. */
export function appIconImage(icon: AppIconChoice): string {
  return icon === 'auto' ? forest : ICON_IMAGE[icon];
}

/** Settings › Appearance: the Dock icon's color, a row of icons like the Dock's, Auto first showing the build's own. */
export function AppIconRow() {
  const { t } = useI18n();
  const { choice, shown } = useAppIcon();
  const [error, setError] = useState<string | null>(null);
  const pick = (next: AppIconChoice) => {
    setError(null);
    setAppIcon(next).catch((failure: unknown) => setError(String(failure)));
  };
  const autoIcon = choice === 'auto' ? shown : null;
  return (
    <SettingsRow
      settingId="appearance.app-icon"
      reset={resetOffer(choice, 'auto', t('appIcon.auto'), () => pick('auto'))}
      title={t('appearance.appIcon.title')}
      description={t('appearance.appIcon.description')}
      status={error ? <span className="text-error-foreground">{t('appearance.appIcon.failed', { error })}</span> : null}
      control={null}
    >
      <div role="radiogroup" aria-label={t('appearance.appIcon.title')} className="flex flex-wrap gap-3">
        {APP_ICON_CHOICES.map((option) => {
          const selected = option === choice;
          // Auto shows what it stands for on this build: the icon in the Dock while it's picked, or Forest otherwise.
          const image = option === 'auto' ? appIconImage(autoIcon ?? 'forest') : appIconImage(option);
          const label = option === 'auto' && autoIcon ? t('appIcon.autoShowing', { icon: t(APP_ICON_LABEL[autoIcon]) }) : t(APP_ICON_LABEL[option]);
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              onClick={() => { if (!selected) pick(option); }}
              className="group flex w-14 cursor-pointer flex-col items-center gap-1 rounded-lg outline-none"
            >
              <span
                className={cn(
                  'rounded-[14px] p-0.5 ring-2 ring-transparent transition-shadow group-focus-visible:ring-ring',
                  selected ? 'ring-primary' : 'group-hover:ring-border',
                )}
              >
                <img src={image} alt="" className="block size-12" draggable={false} />
              </span>
              <span className={cn('text-xs', selected ? 'text-foreground' : 'text-muted-foreground')}>{t(APP_ICON_LABEL[option])}</span>
            </button>
          );
        })}
      </div>
    </SettingsRow>
  );
}
