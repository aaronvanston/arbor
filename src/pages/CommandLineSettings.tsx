import { useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { useI18n } from '../i18n';
import { formatAgo } from '../lib/format';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Check, Copy } from '../components/ui/icons';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { toast } from '../components/ui/toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { CLI_ACTIVITY_SHOWN, cliInstallNote, CLI_MCP_COMMAND, cliActivityRows, type CliActivityRow } from '../services/commandLine';
import type { CliOverview, CliSettings } from '../native/types';

/** How often the open log reads the activity again, so requests show up while someone watches. */
const LOG_REFRESH_MS = 3000;

/** Settings › Software › Command line: putting `arbor` on the PATH, what it may do, and what has asked lately. */
export function CommandLineSettings() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<CliOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skillBusy, setSkillBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
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
    // Mount-only: the activity is read again after each change made here, and while the log is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!logOpen) return undefined;
    void load();
    const timer = setInterval(() => void load(), LOG_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logOpen]);

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

  const addSkill = async () => {
    setSkillBusy(true);
    try {
      const result = await invokeCommand('install_cli_skill');
      setOverview((current) => (current ? { ...current, skill: 'current' } : current));
      setError(result.failed.length ? t('cli.skill.partial', { paths: result.failed.join(', ') }) : null);
      if (result.written.length) toast({ kind: 'success', title: t('cli.skill.done'), description: t('cli.skill.doneDescription') });
    } catch (skillError) {
      setError(t('cli.skill.failed', { error: String(skillError) }));
    } finally {
      setSkillBusy(false);
    }
  };

  const settings = overview?.settings ?? null;
  const skill = overview?.skill ?? null;
  const note = overview ? cliInstallNote(overview.install) : null;
  const rows = overview ? cliActivityRows(overview.activity) : [];
  const allRows = overview ? cliActivityRows(overview.activity, overview.activity.length) : [];
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
          <Button size="sm" variant={overview?.install.state === 'missing' ? 'default' : 'outline'} disabled={busy} onClick={() => void install()}>
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
        settingId="software.cli-skill"
        title={t('cli.skill.title')}
        description={t(skill === 'current' ? 'cli.skill.current' : skill === 'outdated' ? 'cli.skill.outdated' : 'cli.skill.description')}
        control={skill === 'current' ? <Badge variant="success">{t('cli.skill.added')}</Badge> : (
          <Button size="sm" variant="outline" disabled={!skill || skillBusy} onClick={() => void addSkill()}>
            {skillBusy ? <Spinner /> : null}
            {t(skill === 'outdated' ? 'cli.skill.update' : 'cli.skill.add')}
          </Button>
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
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-muted-foreground">{t('cli.activity.title')}</p>
          {allRows.length > CLI_ACTIVITY_SHOWN ? (
            <Button size="sm" variant="link" className="text-xs" onClick={() => setLogOpen(true)}>
              {t('cli.activity.showAll', { count: allRows.length })}
            </Button>
          ) : null}
        </div>
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
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('cli.activity.dialog.title')}</DialogTitle>
            <DialogDescription>{t('cli.activity.dialog.description', { count: allRows.length })}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ActivityTable rows={allRows} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {error ? (
        <SettingsBlock>
          <p className="text-xs text-destructive-foreground">{error}</p>
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
}

function ActivityTable({ rows }: { rows: CliActivityRow[] }) {
  const { t } = useI18n();
  return (
    <Table density="compact" stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHead>{t('cli.activity.column.when')}</TableHead>
          <TableHead>{t('cli.activity.column.from')}</TableHead>
          <TableHead className="w-full">{t('cli.activity.column.command')}</TableHead>
          <TableHead>{t('cli.activity.column.does')}</TableHead>
          <TableHead>{t('cli.activity.column.outcome')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('cli.activity.column.took')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{formatAgo(row.at)}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{t(row.client)}</TableCell>
            <TableCell className="max-w-0 truncate font-mono" title={row.method}>{row.method}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{row.access ? t(row.access) : '–'}</TableCell>
            <TableCell><Badge variant={row.tone} size="sm">{t(row.outcome)}</Badge></TableCell>
            <TableCell className={TABLE_NUMERIC_CLASS}>{t('cli.activity.took', { ms: row.ms })}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
