import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invokeCommand } from '../native/commands';
import { ExternalLink } from '../components/ui/icons';
import { appIconImage } from '../components/AppIconPicker';
import { useAppIcon } from '../services/appIcon';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import { buildChannelLabel, useBuildChannel } from '../services/buildChannel';
import { Badge } from '../components/ui/badge';
import { requestFocus } from '../focusRequests';
import type { AppView } from '../navigation';
import type { ProductAnalyticsSettings } from '../native/types';

/** Each one's name and description are `about.credit.<id>.name` and `.description` in en.ts. */
type CreditId = 'cliproxyapi' | 'easycliproxyapi' | 't3code' | 'antiburn' | 'codexbar' | 'cossui' | 'lobeicons' | 'hugeicons' | 'modelsdev' | 'macmon';
type Credit = { id: CreditId; url: string };

/**
 * The projects Arbor runs, is forked from, borrows designs from, includes or reads data with, all MIT licensed. Only
 * ones the code actually draws on are listed; a project that was only looked at isn't. THIRD_PARTY_NOTICES.md
 * (bun run notices) has every package's license, and ships in the app.
 */
export const CREDITS = {
  builtOn: [
    { id: 'cliproxyapi', url: 'https://github.com/router-for-me/CLIProxyAPI' },
    { id: 'easycliproxyapi', url: 'https://github.com/router-for-me/EasyCLIProxyAPI' },
  ],
  ideas: [
    { id: 't3code', url: 'https://github.com/pingdotgg/t3code' },
    { id: 'antiburn', url: 'https://github.com/antiburn/antiburn' },
    { id: 'codexbar', url: 'https://github.com/steipete/CodexBar' },
  ],
  parts: [
    { id: 'cossui', url: 'https://github.com/cosscom/coss' },
    { id: 'lobeicons', url: 'https://github.com/lobehub/lobe-icons' },
    { id: 'hugeicons', url: 'https://github.com/hugeicons/hugeicons-react' },
  ],
  sources: [
    { id: 'modelsdev', url: 'https://models.dev' },
    { id: 'macmon', url: 'https://github.com/vladkens/macmon' },
  ],
} satisfies Record<string, readonly Credit[]>;

/** Every package's license, from the source of the version you're running. */
const NOTICES_URL = 'https://github.com/aaronvanston/arbor/blob/main/THIRD_PARTY_NOTICES.md';

/** Settings › About: Arbor's version and the projects it's built on. */
export function AboutSettingsPage({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    getVersion()
      .then((current) => {
        if (!disposed) setVersion(current);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.about')]} />
      </PageTopbar>
      <PageBody>
        <AboutHeader version={version} />
        <SettingsSection settingId="about.built-on" title={t('about.builtOn.title')} description={t('about.builtOn.description')}>
          <CreditRows credits={CREDITS.builtOn} />
        </SettingsSection>
        <SettingsSection settingId="about.ideas" title={t('about.ideas.title')} description={t('about.ideas.description')}>
          <CreditRows credits={CREDITS.ideas} />
        </SettingsSection>
        <SettingsSection settingId="about.parts" title={t('about.parts.title')} description={t('about.parts.description')}>
          <CreditRows credits={CREDITS.parts} />
        </SettingsSection>
        <SettingsSection settingId="about.sources" title={t('about.sources.title')} description={t('about.sources.description')}>
          <CreditRows credits={CREDITS.sources} />
        </SettingsSection>
        <SettingsSection settingId="about.licenses" title={t('about.licenses.title')}>
          <LinkRow title={t('about.licenses.row')} description={t('about.licenses.description')} url={NOTICES_URL} />
        </SettingsSection>
        <PrivacySection onNavigate={onNavigate} />
      </PageBody>
    </Page>
  );
}

/** What Arbor sends about itself, and the way to its switches in Settings › Software. */
function PrivacySection({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ProductAnalyticsSettings | null>(null);
  useEffect(() => {
    let disposed = false;
    invokeCommand('get_product_analytics')
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);
  const on = Boolean(settings && settings.available && !settings.blockedByEnv && (settings.usage || settings.crashReports));
  const off = settings?.available === false ? 'about.privacy.unavailable' : 'about.privacy.off';
  return (
    <SettingsSection settingId="about.privacy" title={t('about.privacy.title')} description={t('about.privacy.description')}>
      <SettingsRow
        title={t('about.privacy.row')}
        description={settings ? t(on ? 'about.privacy.on' : off) : t('common.loading')}
        status={settings ? t(on ? 'about.privacy.statusOn' : 'about.privacy.statusOff') : undefined}
        control={
          onNavigate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                requestFocus('setting', 'software.usage-data');
                onNavigate({ kind: 'settings', page: 'software' });
              }}
            >
              {t('about.privacy.change')}
            </Button>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}

/** The app's name and icon, its version once it's read, and where it comes from. */
export function AboutHeader({ version }: { version: string | null }) {
  const { t } = useI18n();
  const build = useBuildChannel();
  const buildLabel = buildChannelLabel(build);
  // The icon in the Dock, so a nightly's About shows its Amber one.
  const { shown } = useAppIcon();
  return (
    <div className="flex items-center gap-3 px-4">
      <img src={appIconImage(shown)} alt="" className="size-10 shrink-0 rounded-[9px] shadow-xs/10" />
      <div className="min-w-0">
        <h1 className="flex items-baseline gap-2 text-sm font-medium tracking-title text-foreground">
          {t('app.brandName')}
          {version ? <span className="font-normal text-muted-foreground tabular-nums">{t('about.version', { version })}</span> : null}
          {buildLabel ? <Badge variant={build === 'dev' ? 'info' : 'warning'} className="self-center">{t(buildLabel)}</Badge> : null}
        </h1>
        <p className="text-xs leading-[1.45] text-muted-foreground">{t('about.tagline')}</p>
      </div>
    </div>
  );
}

/** One row per project: what Arbor takes from it, its license, and a button to its page. */
export function CreditRows({ credits }: { credits: readonly Credit[] }) {
  const { t } = useI18n();
  return (
    <>
      {credits.map((item) => (
        <LinkRow
          key={item.id}
          title={t(`about.credit.${item.id}.name`)}
          description={t(`about.credit.${item.id}.description`)}
          status={t('about.license')}
          url={item.url}
        />
      ))}
    </>
  );
}

/** A row with a button that opens `url` in the browser. */
function LinkRow({ title, description, status, url }: { title: string; description: string; status?: string; url: string }) {
  const { t } = useI18n();
  // Like a copy, opening a link leaves nothing on the page to show a failure beside, so it's a toast.
  const open = () => {
    invokeCommand('open_external_url', { url }).catch((error: unknown) =>
      toast({ kind: 'error', title: t('about.openFailed', { name: title }), description: String(error) }),
    );
  };
  return (
    <SettingsRow
      title={title}
      description={description}
      status={status}
      control={
        <Button variant="outline" size="sm" aria-label={t('about.openLabel', { name: title })} onClick={open}>
          {t('about.open')}
          <ExternalLink />
        </Button>
      }
    />
  );
}
