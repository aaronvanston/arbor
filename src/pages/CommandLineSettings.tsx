import { useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { useI18n } from '../i18n';
import { formatAgo } from '../lib/format';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Check, Copy } from '../components/ui/icons';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { toast } from '../components/ui/toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { cliInstallNote, CLI_MCP_COMMAND, cliActivityRows } from '../services/commandLine';
import type { CliOverview, CliSettings } from '../native/types';

/** Settings › Software › Command line: putting `arbor` on the PATH, what it may do, and what has asked lately. */
export function CommandLineSettings() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<CliOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copy, copied } = useCopyToClipboard({ inline: true });

  const load = () =>
    invokeCommand('get_cli_overview')
      .then((next) => {
        setOverview(next);
        setError(null);
      })
      .catch((loadError: unknown) => setError(t('cli.loadFailed', { error: String(loadError) })));

  useEffect(() => {
    void load();
    // Mount-only: the activity is read again after each change made here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (next: CliSettings) => {
    if (!overview) return;
    setOverview({ ...overview, settings: next });
    try {
      await invokeCommand('save_cli_settings', { settings: next });
      setError(null);
    } catch (saveError) {
      setError(t('cli.saveFailed', { error: String(saveError) }));
      void load();
    }
  };

  const install = async () => {
    setBusy(true);
    try {
      const { install: installed } = await invokeCommand('install_cli_link');
      setOverview((current) => (current ? { ...current, install: installed } : current));
      setError(null);
      toast({ kind: 'success', title: t('cli.install.done') });
    } catch (installError) {
      setError(t('cli.install.failed', { error: String(installError) }));
    } finally {
      setBusy(false);
    }
  };

  const settings = overview?.settings ?? null;
  const note = overview ? cliInstallNote(overview.install) : null;
  const rows = overview ? cliActivityRows(overview.activity) : [];
  const latest = overview?.activity[0];

  return (
    <SettingsSection
      title={t('cli.title')}
      description={t('cli.description')}
      summary={latest ? t('cli.summary.recent', { time: formatAgo(latest.at) }) : undefined}
      headerAction={overview === null && error === null ? <Spinner className="text-muted-foreground" /> : null}
    >
      <SettingsRow
        settingId="software.cli-install"
        title={t('cli.install.title')}
        description={note ? (
          <>
            {t(note.message, { path: overview?.install.linkPath ?? '' })}
            {note.pathHint ? <> {t('cli.install.pathHint')}</> : null}
          </>
        ) : undefined}
        control={note?.action ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void install()}>
            {busy ? <Spinner /> : null}
            {t(note.action)}
          </Button>
        ) : overview?.install.state === 'installed' ? <Badge variant="success">{t('cli.install.linked')}</Badge> : null}
      />
      <SettingsRow
        settingId="software.cli-enabled"
        title={t('cli.enabled.title')}
        description={t('cli.enabled.description')}
        control={(
          <Switch
            checked={settings?.enabled ?? false}
            disabled={!settings}
            aria-label={t('cli.enabled.title')}
            onCheckedChange={(enabled) => settings && void save({ ...settings, enabled })}
          />
        )}
      />
      <SettingsRow
        settingId="software.cli-changes"
        title={t('cli.changes.title')}
        description={t('cli.changes.description')}
        held={settings && !settings.enabled ? t('cli.enabled.title') : undefined}
        control={(
          <Switch
            checked={settings?.changes ?? false}
            disabled={!settings}
            aria-label={t('cli.changes.title')}
            onCheckedChange={(changes) => settings && void save({ ...settings, changes })}
          />
        )}
      />
      <SettingsRow
        settingId="software.cli-agents"
        title={t('cli.agents.title')}
        description={(
          <>
            {t('cli.agents.description')}
            <code className="mt-1.5 block w-fit rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{CLI_MCP_COMMAND}</code>
          </>
        )}
        control={(
          <Button
            size="sm"
            variant="outline"
            aria-label={copied === 'mcp' ? t('cli.agents.copied') : t('cli.agents.copy')}
            onClick={() => void copy(CLI_MCP_COMMAND, { id: 'mcp' })}
          >
            {copied === 'mcp' ? <Check className="text-success" /> : <Copy />}
            {copied === 'mcp' ? t('cli.agents.copied') : t('cli.agents.copy')}
          </Button>
        )}
      />
      <SettingsBlock>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('cli.activity.title')}</p>
        {rows.length ? (
          <ul className="space-y-1 text-xs">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{formatAgo(row.at)}</span>
                <span className="w-12 shrink-0 text-muted-foreground">{t(row.client)}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{row.method}</span>
                <Badge variant={row.tone} size="sm">{t(row.outcome)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('cli.activity.empty')}</p>
        )}
      </SettingsBlock>
      {error ? (
        <SettingsBlock>
          <p className="text-xs text-destructive-foreground">{error}</p>
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
}
