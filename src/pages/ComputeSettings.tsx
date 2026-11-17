import { useEffect, useRef, useState } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsRow, SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Check, Copy, TriangleAlert } from '../components/ui/icons';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { toast } from '../components/ui/toast';
import { useAgo, useNow } from '../hooks/useNow';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import { formatDate } from '../lib/format';
import type { AppView } from '../navigation';
import type { ComputeProviderId, ComputeProviderSnapshot, ComputeSnapshot } from '../native/types';
import { readCommandError } from '../services/commandError';
import {
  activeSandboxes,
  allSandboxes,
  connectComputeProvider,
  disconnectComputeProvider,
  loadCompute,
  refreshCompute,
  useCompute,
} from '../services/compute';
import { COMPUTE_PROVIDER_IDS, COMPUTE_PROVIDERS } from '../services/computeHint';

/**
 * The command an agent runs right after it creates a sandbox, so Arbor knows what started it. Spelled as `arbor
 * commands` lists it, the way the CLI's skill and docs/internals/compute.md write it too.
 */
export const linkCommand = (provider: ComputeProviderId) =>
  `arbor call link-compute-sandbox provider=${provider} sandboxId=<sandbox id> machine=<machine name> session=<session id>`;

/** The command that drops a link made with `linkCommand`; labels at the provider are the provider's to change. */
export const unlinkCommand = (provider: ComputeProviderId) =>
  `arbor call unlink-compute-sandbox provider=${provider} sandboxId=<sandbox id>`;

/** The labels that link a sandbox where its provider lets them be set as it's created. Any provider, so not one's own. */
export const LINK_LABELS = 'arbor.machine=<machine name>  arbor.session=<session id>';

/** How many of the user's sandboxes running now are linked to a machine; null before anything is read. */
export function linkedCount(snapshot: ComputeSnapshot | null): number | null {
  if (!snapshot?.providers.length) return null;
  return activeSandboxes(allSandboxes(snapshot.providers)).filter((sandbox) => sandbox.mine && sandbox.machine !== null).length;
}

export type KeyOutcome = { ok: true } | { ok: false; kind: 'refused' | 'unreachable' | 'failed'; message: string };

/**
 * Hands a pasted key to the app, which checks it with a live read and keeps it only if it works. The key is taken out
 * of the field before anything else happens and lives only in this call, so it's never in React state, the saved
 * store, a log or a later render, and a failed key has to be pasted again rather than sitting in the field.
 */
export async function submitComputeKey(provider: ComputeProviderId, field: { value: string }): Promise<KeyOutcome> {
  const key = field.value.trim();
  field.value = '';
  if (!key) return { ok: false, kind: 'refused', message: '' };
  try {
    await connectComputeProvider(provider, key);
    return { ok: true };
  } catch (error) {
    const failure = readCommandError(error);
    return { ok: false, kind: failure.kind === 'refused' || failure.kind === 'unreachable' ? failure.kind : 'failed', message: failure.message };
  }
}

/**
 * Settings › Compute: connect a provider with an API key, see that it's read, check now or disconnect, and how to
 * link sandboxes to the machine and session that started them. The only part of Compute shown before a provider is
 * connected. Only providers Arbor has built are listed.
 */
export function ComputeSettingsPage(_props: { onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { snapshot } = useCompute();
  // Asks Rust once, whatever the saved hint says: a hint that was lost while a key is still saved would otherwise
  // offer Connect for a connected provider and keep its alerts quiet. Opening this page isn't launch, so the rule that
  // an install with nothing connected makes no Compute call at launch or idle still holds.
  useEffect(() => {
    void loadCompute();
  }, []);
  const linked = linkedCount(snapshot);
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.compute')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        <SettingsSection settingId="compute.providers" title={t('compute.settings.providers.title')} description={t('compute.settings.providers.description')}>
          {COMPUTE_PROVIDER_IDS.map((id) => {
            const connected = snapshot?.providers.find((provider) => provider.id === id);
            return connected ? <ConnectedProvider key={id} provider={connected} /> : <ConnectProvider key={id} provider={id} />;
          })}
        </SettingsSection>
        <SettingsSection settingId="compute.linking" title={t('compute.settings.linking.title')}>
          <SettingsRow title={t('compute.settings.linking.tell')} description={t('compute.settings.linking.description')} />
          {COMPUTE_PROVIDER_IDS.map((id) => <CommandRow key={id} caption={t('compute.settings.linking.command')} command={linkCommand(id)} />)}
          {COMPUTE_PROVIDER_IDS.map((id) => <CommandRow key={id} caption={t('compute.settings.linking.unlink')} command={unlinkCommand(id)} />)}
          <CommandRow caption={t('compute.settings.linking.labels')} command={LINK_LABELS} />
          {linked === null ? null : (
            <SettingsRow
              title={t('compute.settings.linking.count.title')}
              description={linked === 0
                ? t('compute.settings.linking.count.none')
                : t(linked === 1 ? 'compute.settings.linking.count.one' : 'compute.settings.linking.count.other', { count: linked })}
            />
          )}
        </SettingsSection>
      </PageBody>
    </Page>
  );
}

/** A provider with no key yet: the key field, and how to make a key that can only read. */
function ConnectProvider({ provider }: { provider: ComputeProviderId }) {
  const { t } = useI18n();
  const info = COMPUTE_PROVIDERS[provider];
  return (
    <>
      <SettingsRow title={info.name} description={t('compute.settings.provider.about')} />
      <KeyField
        provider={provider}
        title={t('compute.settings.key.title')}
        description={t('compute.settings.key.paste', { provider: info.name })}
        done={t('compute.settings.connectedToast', { provider: info.name })}
      />
      <CommandRow caption={t('compute.settings.key.makeReadOnly', { provider: info.name })} command={info.readOnlyKeyCommand} />
    </>
  );
}

/**
 * The key field. Uncontrolled on purpose: what's typed stays in the input element until Connect, which empties it, so
 * React never holds the key; only whether there's anything in it.
 */
function KeyField({
  provider,
  title,
  description,
  done,
  onCancel,
}: {
  provider: ComputeProviderId;
  title: string;
  description: string;
  done: string;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const info = COMPUTE_PROVIDERS[provider];
  const input = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Exclude<KeyOutcome, { ok: true }> | null>(null);
  const connect = async () => {
    const field = input.current;
    if (!field || busy || !field.value.trim()) return;
    setBusy(true);
    setProblem(null);
    const outcome = await submitComputeKey(provider, field);
    setFilled(false);
    setBusy(false);
    if (outcome.ok) toast({ title: done, kind: 'success' });
    else setProblem(outcome);
  };
  const problemText = problem === null ? null
    : problem.kind === 'refused' ? t('compute.settings.connectRefused', { provider: info.name })
      : problem.kind === 'unreachable' ? t('compute.settings.connectUnreachable', { provider: info.name })
        : t('compute.settings.connectFailed', { provider: info.name, error: problem.message });
  return (
    <SettingsRow
      title={title}
      description={description}
      status={problemText ? <span className="text-error-foreground">{problemText}</span> : null}
      control={(
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <Input
            ref={input}
            wrapperClassName="w-56"
            font="mono"
            className="text-sm placeholder:font-sans"
            type="password"
            autoComplete="off"
            spellCheck={false}
            defaultValue=""
            placeholder={info.keyPlaceholder}
            aria-label={t('compute.settings.key.label', { provider: info.name })}
            aria-invalid={problem ? true : undefined}
            disabled={busy}
            onChange={(event) => setFilled(event.currentTarget.value.trim() !== '')}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && onCancel) onCancel();
            }}
          />
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            disabled={!filled}
            disabledReason={busy ? t('compute.settings.connecting') : undefined}
          >
            {busy ? <Spinner /> : null}
            {t('compute.settings.connect')}
          </Button>
        </form>
      )}
    />
  );
}

/** What the status line says: read how long ago, not answering, asked to slow down, or the key turned down. */
function StatusLine({ provider }: { provider: ComputeProviderSnapshot }) {
  const { t } = useI18n();
  const ago = useAgo(provider.checkedAtMs);
  if (provider.status === 'refused') return <span className="text-error-foreground">{t('compute.settings.connectedRefused')}</span>;
  if (provider.status === 'unreachable') return <span className="text-warning-foreground">{t('compute.settings.connectedNotAnswering')}</span>;
  if (provider.status === 'rateLimited') return <span className="text-warning-foreground">{t('compute.settings.connectedRateLimited')}</span>;
  return <>{ago ? t('compute.settings.connected', { ago }) : t('compute.settings.connectedNotRead')}</>;
}

/** When the key expires, if the provider says; "Expired" once that's passed. */
function KeyExpiry({ atMs }: { atMs: number }) {
  const { t } = useI18n();
  const expired = useNow((nowMs) => nowMs >= atMs);
  const when = formatDate(atMs);
  return expired
    ? <span className="text-error-foreground">{t('compute.settings.key.expired', { when })}</span>
    : <span className="text-muted-foreground">{t('compute.settings.key.expires', { when })}</span>;
}

function ConnectedProvider({ provider }: { provider: ComputeProviderSnapshot }) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const info = COMPUTE_PROVIDERS[provider.id];
  const refused = provider.status === 'refused';
  const [replacing, setReplacing] = useState(false);
  const [checking, setChecking] = useState(false);
  const disconnect = async () => {
    // The key is gone for good once this goes through, so it's asked first rather than offered as Undo.
    const confirmed = await askConfirmation({
      title: t('compute.settings.disconnect.confirmTitle', { provider: info.name }),
      message: t('compute.settings.disconnect.confirmBody', { provider: info.name }),
      confirmText: t('compute.settings.disconnect.button'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await disconnectComputeProvider(provider.id);
      toast({ title: t('compute.settings.disconnected', { provider: info.name }), kind: 'success' });
    } catch (error) {
      toast({ title: readCommandError(error).message, kind: 'error' });
    }
  };
  const check = async () => {
    setChecking(true);
    try {
      await refreshCompute();
      toast({ title: t('compute.checked', { provider: info.name }), kind: 'success' });
    } catch (error) {
      toast({ title: readCommandError(error).message, kind: 'error' });
    } finally {
      setChecking(false);
    }
  };
  const badge = provider.keyAccess === 'readOnly'
    ? <Badge variant="success"><Check />{t('compute.readOnlyKey')}</Badge>
    : null;
  return (
    <>
      <SettingsRow
        title={info.name}
        description={<StatusLine provider={provider} />}
        status={provider.keyAccess === 'canWrite' ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <TriangleAlert className="size-3.5 shrink-0 text-warning-foreground" aria-hidden />
            {t('compute.canWriteKey', { provider: info.name })}
          </span>
        ) : null}
        control={badge}
      />
      {/* A refused key can only be fixed with a new one, so the field is open from the start. */}
      {replacing || refused ? (
        <KeyField
          provider={provider.id}
          title={t('compute.settings.key.title')}
          description={refused ? t('compute.settings.key.refused', { provider: info.name }) : t('compute.settings.key.paste', { provider: info.name })}
          done={t('compute.settings.key.replaced', { provider: info.name })}
          onCancel={refused ? undefined : () => setReplacing(false)}
        />
      ) : (
        <SettingsRow
          settingId="compute.key"
          title={t('compute.settings.key.title')}
          description={t('compute.settings.key.saved')}
          status={provider.keyExpiresAtMs === null ? null : <KeyExpiry atMs={provider.keyExpiresAtMs} />}
          control={<Button variant="outline" size="sm" onClick={() => setReplacing(true)}>{t('compute.settings.key.replace')}</Button>}
        />
      )}
      <SettingsRow
        settingId="compute.check"
        title={t('compute.settings.check.title')}
        description={t('compute.settings.check.description')}
        control={(
          <Button variant="outline" size="sm" onClick={() => void check()} disabledReason={checking ? t('compute.settings.check.busy') : undefined}>
            {checking ? <Spinner /> : null}
            {t('compute.checkNow')}
          </Button>
        )}
      />
      <SettingsRow
        settingId="compute.disconnect"
        title={t('compute.settings.disconnect.title')}
        description={t('compute.settings.disconnect.description', { provider: info.name })}
        control={<Button variant="outline" size="sm" onClick={() => void disconnect()}>{t('compute.settings.disconnect.button')}</Button>}
      />
    </>
  );
}

/**
 * A command to copy, in the code block the rest of the app uses: it scrolls sideways rather than wrap, so a command is
 * never broken in the middle of a word or an `=`.
 */
function CommandRow({ caption, command }: { caption: string; command: string }) {
  const { t } = useI18n();
  const { copy } = useCopyToClipboard();
  return (
    <SettingsRow
      title={caption}
      control={<Button variant="outline" size="sm" onClick={() => void copy(command, { label: t('compute.settings.copied') })}><Copy />{t('compute.settings.copy')}</Button>}
    >
      <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/60 px-3 py-2 font-mono text-xs leading-5 text-foreground dark:bg-input/16">{command}</pre>
    </SettingsRow>
  );
}
