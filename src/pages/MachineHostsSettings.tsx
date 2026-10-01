import { useCallback, useEffect, useId, useState } from 'react';
import { AlertCircle, Plus, RotateCcw, Server, Trash2 } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { fetchMachineHosts, parsePort, saveMachineHosts } from '../services/machineHealth';
import { useUnsavedChanges } from '../services/unsavedChanges';
import { AddMachineDialog } from '../components/AddMachineDialog';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MachinePill, MachinePills } from '../components/identity/Identity';
import { MachineLookPicker } from '../components/identity/MachineLookPicker';
import { toast } from '../components/ui/toast';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { draftFromNumber, NumberField, numberFromDraft } from '../components/ui/number-field';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { TableEmpty } from '../components/ui/data-table';
import { FirstMachineActions } from '../components/FirstMachineActions';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import type { MachineHost } from '../native/types';
import { machineName } from '../services/machineNames';
import { cn } from '../lib/utils';

/**
 * Where each machine is sampled from. Rows are seeded from API-key
 * assignments; edits here take precedence and survive re-seeding, and a
 * removed machine stays off until it's added again. Machines are removed
 * only from Edit hosts, and only once the save is confirmed, so viewing the list can't.
 */
export function MachineHostsSettings() {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [hosts, setHosts] = useState<MachineHost[]>([]);
  const [draft, setDraft] = useState<MachineHost[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Ports as typed, by draft row, so clearing the field to retype it doesn't snap back to 22. `checked` once
  // the field was left or a save tried, so it only turns red after the user is done with it.
  const [ports, setPorts] = useState<Record<number, { text: string; checked: boolean }>>({});
  const portErrorId = useId();
  const [adding, setAdding] = useState(false);
  // Machines marked in Edit hosts to come off the list when it's saved.
  const [removed, setRemoved] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setHosts(await fetchMachineHosts());
      setError('');
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const added = (machine: string) => {
    setAdding(false);
    toast({ kind: 'success', title: tRich('machines.hosts.added', { machine: <MachinePill name={machine} size="md" /> }) });
    void load();
  };
  const change = (index: number, patch: Partial<MachineHost>) => {
    setDraft((rows) => rows?.map((row, i) => (i === index ? { ...row, ...patch } : row)) ?? null);
  };
  const marked = (index: number) => removed.includes(draft?.[index]?.machine ?? '');
  // A row being removed isn't saved, so its port can't hold the save up.
  const badPorts = Object.keys(ports).map(Number).filter((index) => parsePort(ports[index]!.text) === null && !marked(index));
  const typePort = (index: number, text: string) => {
    setPorts((current) => ({ ...current, [index]: { text, checked: current[index]?.checked ?? false } }));
    const port = parsePort(text);
    if (port !== null) change(index, { port });
  };
  const checkPort = (index: number) => {
    setPorts((current) => {
      const entry = current[index];
      if (!entry) return current;
      if (parsePort(entry.text) === null) return { ...current, [index]: { ...entry, checked: true } };
      const { [index]: _valid, ...rest } = current;
      return rest;
    });
  };
  const edit = (rows: MachineHost[] | null) => {
    setDraft(rows);
    setPorts({});
    setRemoved([]);
  };
  const toggleRemoved = (machine: string) =>
    setRemoved((current) => (current.includes(machine) ? current.filter((name) => name !== machine) : [...current, machine]));
  const save = async () => {
    if (!draft) return;
    if (badPorts.length) {
      setPorts((current) => Object.fromEntries(Object.entries(current).map(([index, entry]) => [index, { ...entry, checked: true }])));
      return;
    }
    // Asked on top of the Undo the toast offers, since a save can quietly carry a removal marked earlier in the edit.
    const one = removed.length === 1;
    if (removed.length && !await askConfirmation({
      title: t(one ? 'machines.hosts.confirmRemove.title.one' : 'machines.hosts.confirmRemove.title.other', { count: removed.length }),
      message: tRich(one ? 'machines.hosts.confirmRemove.message.one' : 'machines.hosts.confirmRemove.message.other', { machines: <MachinePills names={removed} /> }),
      confirmText: t('machines.hosts.confirmRemove.confirm'),
      variant: 'danger',
    })) return;
    setSaving(true);
    setError('');
    try {
      const cleaned = draft
        .filter((row) => !removed.includes(row.machine))
        .map((row) => ({ ...row, machine: row.machine.trim(), endpoint: row.endpoint.trim() }))
        .filter((row) => row.machine);
      // As they were before this edit, for the Undo.
      const gone = hosts.filter((host) => removed.includes(host.machine));
      setHosts(await saveMachineHosts(cleaned, removed));
      edit(null);
      if (gone.length) {
        toast({
          kind: 'success',
          title: tRich('machines.hosts.removed', { machines: <MachinePills names={gone.map((host) => host.machine)} /> }),
          description: t(gone.length === 1 ? 'machines.hosts.removedDescription.one' : 'machines.hosts.removedDescription.other'),
          action: {
            label: t('common.undo'),
            onClick: () => {
              saveMachineHosts(gone)
                .then(setHosts)
                .catch((requestError: unknown) => setError(String(requestError)));
            },
          },
          focusAction: true,
        });
      }
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setSaving(false);
    }
  };
  const rows = draft ?? hosts;
  useUnsavedChanges(draft !== null && (Object.keys(ports).length > 0 || removed.length > 0 || JSON.stringify(draft) !== JSON.stringify(hosts)));
  const shownBadPorts = badPorts.filter((index) => ports[index]!.checked);
  // Names the rows, since every port field is labeled the same.
  const badPortNames = shownBadPorts.map((index) => rows[index]?.machine.trim()).filter((name): name is string => Boolean(name)).map(machineName);
  const portError = badPortNames.length
    ? tRich('machines.hosts.portInvalidFor', { machines: <MachinePills names={badPortNames} /> })
    : t('machines.hosts.portInvalid');
  const machineCell = (machine: string) => (
    <span className="flex min-w-0 items-center gap-2">
      {draft ? <MachinePill name={machine} /> : <MachineLookPicker name={machine} />}
    </span>
  );

  return (
    <SettingsSection
      settingId="machines.hosts"
      title={t('machines.hosts.title')}
      description={t('machines.hosts.description')}
      headerAction={
        !draft ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { edit(hosts.map((host) => ({ ...host }))); setError(''); }} disabled={loading || hosts.length === 0}>
              <Server />
              {t('machines.hosts.edit')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)} disabled={loading}>
              <Plus />
              {t('machines.hosts.add')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => edit(null)} disabled={saving}>{t('machines.hosts.cancel')}</Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner /> : null}
              {t('machines.hosts.save')}
            </Button>
          </div>
        )
      }
    >
      {error ? (
        <SettingsBlock>
          <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert>
        </SettingsBlock>
      ) : null}
      {loading ? (
        <TableEmpty>
          <span className="inline-flex items-center gap-2"><Spinner />{t('machines.hosts.loading')}</span>
        </TableEmpty>
      ) : rows.length === 0 ? (
        <TableEmpty>
          <span className="flex flex-col items-center gap-3">
            {t('machines.hosts.empty')}
            <FirstMachineActions onAdded={() => void load()} />
          </span>
        </TableEmpty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('machines.hosts.column.machine')}</TableHead>
              <TableHead>{t('machines.hosts.column.endpoint')}</TableHead>
              <TableHead className="w-24">{t('machines.hosts.column.port')}</TableHead>
              <TableHead className="w-24 text-end">{t('machines.hosts.column.enabled')}</TableHead>
              {draft ? <TableHead className="w-12"><span className="sr-only">{t('machines.hosts.column.actions')}</span></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={draft ? index : row.machine}>
                <TableCell className={cn('font-medium', marked(index) && 'opacity-50')}>{machineCell(row.machine)}</TableCell>
                <TableCell>
                  {marked(index) ? (
                    <span className="text-xs text-muted-foreground">{t('machines.hosts.removing')}</span>
                  ) : draft ? (
                    <Input size="sm" value={row.endpoint} placeholder={t('machines.hosts.endpointPlaceholder')} onChange={(event) => change(index, { endpoint: event.target.value })} aria-label={t('machines.hosts.column.endpoint')} font="mono" />
                  ) : (
                    <span className="font-mono">{row.endpoint || <span className="text-muted-foreground">{t('machines.hosts.unset')}</span>}</span>
                  )}
                </TableCell>
                <TableCell className={cn(marked(index) && 'opacity-50')}>
                  {draft && !marked(index) ? (
                    <NumberField
                      size="sm"
                      min={1}
                      max={65535}
                      value={numberFromDraft(ports[index]?.text ?? String(row.port))}
                      onValueChange={(next) => typePort(index, draftFromNumber(next))}
                      onBlur={() => checkPort(index)}
                      aria-label={t('machines.hosts.column.port')}
                      aria-invalid={shownBadPorts.includes(index) || undefined}
                      aria-describedby={shownBadPorts.includes(index) ? portErrorId : undefined}
                      font="mono"
                    />
                  ) : (
                    <span className="tabular-nums">{row.port}</span>
                  )}
                </TableCell>
                <TableCell className="text-end">
                  <Switch size="sm" checked={row.enabled} disabled={!draft || marked(index)} onCheckedChange={(checked) => change(index, { enabled: checked })} aria-label={t('machines.hosts.column.enabled')} />
                </TableCell>
                {draft ? (
                  <TableCell className="text-end">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => toggleRemoved(row.machine)}
                      aria-label={t(marked(index) ? 'machines.hosts.keep' : 'machines.hosts.remove', { machine: machineName(row.machine) })}
                      title={t(marked(index) ? 'machines.hosts.keep' : 'machines.hosts.remove', { machine: machineName(row.machine) })}
                    >
                      {marked(index) ? <RotateCcw /> : <Trash2 />}
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {draft ? (
        shownBadPorts.length ? (
          <SettingsBlock className="py-2">
            <span id={portErrorId} className="text-xs text-error-foreground" role="alert">{portError}</span>
          </SettingsBlock>
        ) : null
      ) : (
        <SettingsBlock className="py-2 text-xs text-muted-foreground">{t('machines.hosts.note')}</SettingsBlock>
      )}
      <AddMachineDialog open={adding} onClose={() => setAdding(false)} onAdded={added} />
    </SettingsSection>
  );
}
