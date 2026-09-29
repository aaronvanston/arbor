import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { Check, Eye, EyeOff, Send, Sparkles } from '../components/ui/icons';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { useConfirmation } from '../components/ConfirmationDialog';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';
import { NO_PHONE_ALERT_SECRETS, PHONE_ALERT_TOPICS, PHONE_SERVICES, phoneAlertSendRoute, preparePhoneAlerts, randomNtfyTopic, recordPhoneAlertDelivery, savePhoneAlertSecret, sendPhoneAlert, setPhoneAlertSetting, topicRaisedHere, usePhoneAlertDelivery, usePhoneAlertSecrets, usePhoneAlertSettings, withPhoneTopic, type PhoneService } from '../services/phoneAlerts';
import { useMachineOverrides, useProjectOverrides } from '../services/machineSettings';
import { useQuotaClock } from '../services/quotaTime';
import { formatAgo } from '../lib/format';
import type { PhoneAlertSecret } from '../native/types';

type TestResult = { state: 'idle' | 'sending' | 'sent' } | { state: 'failed'; error: string };

/**
 * Where Arbor's alerts go besides this Mac: ntfy, Pushover, Telegram or a webhook, with a test send, and which kinds
 * go there. Sections of Settings › Notifications, under the switches that turn each kind on or off everywhere.
 */
export function PhoneAlertsSettings() {
  const { t } = useI18n();
  const settings = usePhoneAlertSettings();
  const preferences = useAppPreferences();
  const overrides = useMachineOverrides();
  const projects = useProjectOverrides();
  const secrets = usePhoneAlertSecrets();
  const saved = secrets ?? NO_PHONE_ALERT_SECRETS;
  const delivery = usePhoneAlertDelivery();
  const now = useQuotaClock();
  const [test, setTest] = useState<TestResult>({ state: 'idle' });
  // As alerts go: while the app can't say what it holds, a test still goes out so it can say why it fails.
  const route = phoneAlertSendRoute(settings, secrets);
  const serviceLabel = (service: PhoneService) => t(`phoneAlerts.service.${service}`);
  const savedKey = JSON.stringify(saved);

  // Startup does this too; asked again in case the app couldn't answer then.
  useEffect(() => void preparePhoneAlerts(), []);
  // A result is about the settings it was sent with.
  useEffect(() => setTest({ state: 'idle' }), [settings, savedKey]);

  const sendTest = async () => {
    if (!route) return;
    setTest({ state: 'sending' });
    try {
      await sendPhoneAlert(route, { title: t('phoneAlerts.test.alertTitle'), body: t('phoneAlerts.test.alertBody'), kind: 'test', urgent: false });
      recordPhoneAlertDelivery({ atMs: Date.now(), error: null });
      setTest({ state: 'sent' });
    } catch (error) {
      recordPhoneAlertDelivery({ atMs: Date.now(), error: String(error) });
      setTest({ state: 'failed', error: String(error) });
    }
  };

  const deliveryLine = settings.service === 'off' || !delivery ? null : delivery.error
    ? <span className="text-error-foreground">{t('phoneAlerts.delivery.failed', { time: formatAgo(delivery.atMs, now), error: delivery.error })}</span>
    : t('phoneAlerts.delivery.sent', { time: formatAgo(delivery.atMs, now) });
  const testLine = test.state === 'sent'
    ? <span className="text-success-foreground">{t('phoneAlerts.test.sent')}</span>
    : test.state === 'failed' ? <span className="text-error-foreground">{test.error}</span> : null;

  return (
    <>
      <SettingsSection title={t('phoneAlerts.title')} description={t('phoneAlerts.description')}>
        <SettingsRow
          settingId="notifications.phone-service"
          title={t('phoneAlerts.service.title')}
          description={t('phoneAlerts.service.description')}
          status={deliveryLine}
          control={
            <Select value={settings.service} onValueChange={(value) => setPhoneAlertSetting('service', (value ?? 'off') as PhoneService)}>
              <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('phoneAlerts.service.title')}>
                <SelectValue>{serviceLabel(settings.service)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {PHONE_SERVICES.map((service) => (
                  <SelectItem key={service} value={service}>{serviceLabel(service)}</SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {settings.service === 'ntfy' ? (
          <>
            <SettingField
              title={t('phoneAlerts.ntfy.server.title')}
              description={t('phoneAlerts.ntfy.server.description')}
              value={settings.ntfyServer}
              placeholder={t('phoneAlerts.ntfy.server.placeholder')}
              onChange={(value) => setPhoneAlertSetting('ntfyServer', value)}
            />
            <SettingField
              title={t('phoneAlerts.ntfy.topic.title')}
              description={t('phoneAlerts.ntfy.topic.description')}
              value={settings.ntfyTopic}
              onChange={(value) => setPhoneAlertSetting('ntfyTopic', value)}
              action={
                <Button variant="outline" size="sm" onClick={() => setPhoneAlertSetting('ntfyTopic', randomNtfyTopic())}>
                  <Sparkles />
                  {t('phoneAlerts.ntfy.topic.generate')}
                </Button>
              }
            />
            <SecretField
              title={t('phoneAlerts.ntfy.token.title')}
              description={t('phoneAlerts.ntfy.token.description')}
              secret="ntfyToken"
              saved={saved.ntfyToken}
              placeholder={t('phoneAlerts.optional')}
            />
          </>
        ) : null}
        {settings.service === 'pushover' ? (
          <>
            <SecretField
              title={t('phoneAlerts.pushover.user.title')}
              description={t('phoneAlerts.pushover.user.description')}
              secret="pushoverUserKey"
              saved={saved.pushoverUserKey}
            />
            <SecretField
              title={t('phoneAlerts.pushover.token.title')}
              description={t('phoneAlerts.pushover.token.description')}
              secret="pushoverAppToken"
              saved={saved.pushoverAppToken}
            />
          </>
        ) : null}
        {settings.service === 'telegram' ? (
          <>
            <SecretField
              title={t('phoneAlerts.telegram.token.title')}
              description={t('phoneAlerts.telegram.token.description')}
              secret="telegramBotToken"
              saved={saved.telegramBotToken}
            />
            <SettingField
              title={t('phoneAlerts.telegram.chat.title')}
              description={t('phoneAlerts.telegram.chat.description')}
              value={settings.telegramChatId}
              onChange={(value) => setPhoneAlertSetting('telegramChatId', value)}
            />
          </>
        ) : null}
        {settings.service === 'webhook' ? (
          <SecretField
            title={t('phoneAlerts.webhook.url.title')}
            description={t('phoneAlerts.webhook.url.description')}
            secret="webhookUrl"
            saved={saved.webhookUrl}
            placeholder={t('phoneAlerts.webhook.url.placeholder')}
          />
        ) : null}
        {settings.service !== 'off' ? (
          <SettingsRow
            settingId="notifications.phone-test"
            title={t('phoneAlerts.test.title')}
            description={route ? t('phoneAlerts.test.description') : t('phoneAlerts.test.incomplete')}
            status={testLine}
            control={
              <Button variant="outline" size="sm" disabled={!route || test.state === 'sending'} onClick={() => void sendTest()}>
                {test.state === 'sending' ? <Spinner /> : <Send />}
                {t('phoneAlerts.test.button')}
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      {settings.service !== 'off' ? (
        <SettingsSection settingId="notifications.phone-topics" title={t('phoneAlerts.topics.title')} description={t('phoneAlerts.topics.description')}>
          {PHONE_ALERT_TOPICS.map((topic) => (
            <SettingsRow
              key={topic}
              title={t(`phoneAlerts.topic.${topic}.title`)}
              description={t(`phoneAlerts.topic.${topic}.description`)}
              status={topicRaisedHere(topic, preferences, overrides, projects) ? null : t('phoneAlerts.topics.offHere')}
              control={
                <Switch
                  checked={!settings.mutedTopics.includes(topic)}
                  aria-label={t(`phoneAlerts.topic.${topic}.title`)}
                  onCheckedChange={(on) => setPhoneAlertSetting('mutedTopics', withPhoneTopic(settings.mutedTopics, topic, on))}
                />
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

/** A text setting that isn't secret. */
function SettingField({
  title,
  description,
  value,
  onChange,
  placeholder,
  action,
}: {
  title: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  action?: ReactNode;
}) {
  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <>
          <Input
            wrapperClassName="w-72"
            font="mono"
            className="text-sm"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            aria-label={title}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {action}
        </>
      }
    />
  );
}

/**
 * A secret setting; webhook URLs count, since they usually carry a token. The app keeps it and never
 * hands it back, so a saved one only reads as saved. A new one replaces it on Return or on leaving the field
 * and its buttons, which sit inside it so it doesn't move as they come and go.
 */
function SecretField({
  title,
  description,
  secret,
  saved,
  placeholder,
}: {
  title: string;
  description: string;
  secret: PhoneAlertSecret;
  saved: boolean;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [draft, setDraft] = useState('');
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      await savePhoneAlertSecret(secret, value);
      // Save, Clear and the eye go with the draft or the saved one, so focus on one of them moves to the field.
      const focused = document.activeElement;
      const onButton = focused !== input.current && field.current?.contains(focused);
      // Emptied once it's in, unless something else was typed meanwhile.
      setDraft((current) => (current === value ? '' : current));
      setShown(false);
      if (!value || onButton) input.current?.focus();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const commit = () => {
    if (draft.trim() && !saving) void save(draft);
  };
  // Moving between the field and its buttons isn't leaving it.
  const leave = (event: FocusEvent) => {
    if (!field.current?.contains(event.relatedTarget as Node | null)) commit();
  };
  const clear = async () => {
    // "User key" reads as "user key" mid-sentence; "API token" and "URL" stay as they are.
    const name = /^\p{Lu}\p{Ll}/u.test(title) ? title.charAt(0).toLocaleLowerCase() + title.slice(1) : title;
    const confirmed = await askConfirmation({
      title: t('phoneAlerts.secret.clearTitle', { name }),
      message: t('phoneAlerts.secret.clearMessage'),
      confirmText: t('common.clear'),
      variant: 'danger',
    });
    if (confirmed) await save('');
  };

  // Keeps the field focused when clicked, so pressing one doesn't leave it and save as well.
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  const actions = draft ? (
    <>
      {/* Only what's being typed can be shown; a saved one never comes back. */}
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-xs"
        onMouseDown={keepFocus}
        onClick={() => setShown((current) => !current)}
        aria-label={shown ? t('config.keys.hide') : t('config.keys.show')}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
      {draft.trim() ? (
        <Button variant="ghost" size="xs" disabled={saving} focusableWhenDisabled onMouseDown={keepFocus} onClick={commit}>
          {saving ? <Spinner /> : null}
          {t('common.save')}
        </Button>
      ) : null}
    </>
  ) : saved ? (
    <Button variant="ghost-muted" size="xs" disabled={saving} focusableWhenDisabled onClick={() => void clear()}>
      {saving ? <Spinner /> : null}
      {t('common.clear')}
    </Button>
  ) : null;

  return (
    <SettingsRow
      title={title}
      description={description}
      status={error ? (
        <span className="text-error-foreground">{error}</span>
      ) : saved ? (
        <Badge variant="success"><Check />{t('phoneAlerts.secret.saved')}</Badge>
      ) : null}
      control={
        <>
          <div ref={field} onBlur={leave}>
            <Input
              ref={input}
              wrapperClassName="w-72"
              font="mono"
              // Room for the buttons inside the field; the placeholder is prose, so it isn't monospaced.
              className={cn('text-sm placeholder:font-sans', draft ? 'pe-24' : saved ? 'pe-18' : undefined)}
              type={shown ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder={saved ? t('phoneAlerts.secret.replace') : placeholder}
              aria-label={title}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit();
                if (event.key === 'Escape') setDraft('');
              }}
              endAddon={actions ? <span className="flex items-center gap-0.5">{actions}</span> : undefined}
            />
          </div>
        </>
      }
    />
  );
}
