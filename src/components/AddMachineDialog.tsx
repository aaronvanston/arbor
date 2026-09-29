import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Plus } from './ui/icons';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { fetchMachineHosts, parsePort, saveMachineHosts } from '../services/machineHealth';
import {
  discoverMachineHosts,
  newSuggestions,
  SOURCE_LABEL,
  suggestionFields,
  suggestionKind,
  suggestionTarget,
} from '../services/machineDiscovery';
import { shellWord } from '../services/setupChecklist';
import { CommandLine } from './CommandLine';
import { MachinePill } from './identity/Identity';
import { MachineIcon } from './MachineIcon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { draftFromNumber, NumberField, numberFromDraft } from './ui/number-field';
import { Spinner } from './ui/spinner';
import type { DiscoveredHost, MachineHost } from '../native/types';

type Discovery = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; found: DiscoveredHost[] };

/**
 * Adds a machine to the machine list, which the Machines page and every Sync view read from. It offers the machines
 * this Mac already reaches, from its SSH config, its known hosts and its tailnet; picking one only fills the fields in.
 */
export function AddMachineDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (machine: string) => void }) {
  const { t, tRich } = useI18n();
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [port, setPort] = useState('22');
  const [hosts, setHosts] = useState<MachineHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>({ state: 'loading' });
  const nameRef = useRef<HTMLInputElement>(null);
  const discoveryRun = useRef(0);
  const foundId = useId();

  const discover = useCallback(() => {
    // A read that finishes after a newer one started, or after the dialog closed, is dropped.
    const run = ++discoveryRun.current;
    setDiscovery({ state: 'loading' });
    discoverMachineHosts()
      .then((found) => { if (run === discoveryRun.current) setDiscovery({ state: 'ready', found }); })
      .catch((failure) => { if (run === discoveryRun.current) setDiscovery({ state: 'failed', error: String(failure) }); });
  }, []);

  useEffect(() => {
    if (!open) {
      discoveryRun.current += 1;
      return;
    }
    setName('');
    setEndpoint('');
    setPort('22');
    setError(null);
    setHosts(null);
    fetchMachineHosts().then(setHosts).catch(() => setHosts([]));
    discover();
  }, [open, discover]);

  const machine = name.trim();
  const host = endpoint.trim();
  const parsedPort = parsePort(port);
  // A machine the list has without a host yet, like one seeded from an API key, gets its host filled in.
  const taken = machine ? hosts?.some((entry) => entry.machine === machine && entry.endpoint.trim()) ?? false : false;
  const hostProblem = /\s/.test(host) ? t('setup.checklist.addDialog.badHost') : host.startsWith('-') ? t('setup.checklist.addDialog.dash') : null;
  const problem: ReactNode = taken
    ? tRich('setup.checklist.addDialog.taken', { machine: <MachinePill name={machine} size="md" /> })
    : hostProblem ?? (port.trim() && parsedPort === null ? t('machines.hosts.portInvalid') : null);
  const ready = Boolean(machine && host && parsedPort !== null && !problem && hosts !== null);
  const suggestions = discovery.state === 'ready' && hosts ? newSuggestions(discovery.found, hosts) : [];

  const fieldsFor = (suggestion: DiscoveredHost) => suggestionFields(suggestion, hosts ?? []);
  const isPicked = (suggestion: DiscoveredHost) => {
    const fields = fieldsFor(suggestion);
    return fields.endpoint === host && fields.port === parsedPort && (!fields.name || fields.name === machine);
  };
  const pick = (suggestion: DiscoveredHost) => {
    const fields = fieldsFor(suggestion);
    setEndpoint(fields.endpoint);
    setPort(String(fields.port));
    if (fields.name) {
      setName(fields.name);
      return;
    }
    // One known only by its address has no name to offer, so the name is left for the user to give, clearing one
    // an earlier pick put there.
    if (suggestions.some((other) => fieldsFor(other).name === machine)) setName('');
    nameRef.current?.focus();
  };

  const save = async () => {
    if (!ready || parsedPort === null) return;
    setSaving(true);
    setError(null);
    try {
      await saveMachineHosts([{ machine, endpoint: host, port: parsedPort, enabled: true, source: '' }]);
      onAdded(machine);
    } catch (failure) {
      setError(t('setup.checklist.addDialog.failed', { error: String(failure) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen && !saving) onClose(); }}>
      {/* The name field takes the focus through the dialog rather than autoFocus, so the dialog notes what opened it
          first and hands the focus back there as it closes. */}
      <DialogPopup className="max-w-lg" initialFocus={nameRef}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('setup.checklist.addDialog.title')}</DialogTitle>
            <DialogDescription>{t('setup.checklist.addDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <section className="flex flex-col gap-1.5" aria-labelledby={foundId} data-slot="machine-suggestions">
              <p id={foundId} className="text-sm font-medium text-foreground">{t('machines.discovery.title')}</p>
              {discovery.state === 'loading' ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner />{t('machines.discovery.loading')}</p>
              ) : discovery.state === 'failed' ? (
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-error-foreground" role="alert">{t('machines.discovery.failed', { error: discovery.error })}</p>
                  <Button type="button" variant="outline" size="xs" onClick={discover}>{t('machines.discovery.retry')}</Button>
                </div>
              ) : suggestions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t(discovery.found.length ? 'machines.discovery.allAdded' : 'machines.discovery.none')}</p>
              ) : (
                <ul className="flex max-h-48 flex-col overflow-y-auto rounded-lg border border-border/60 bg-muted/20 py-1 dark:bg-input/10">
                  {suggestions.map((suggestion) => {
                    const picked = isPicked(suggestion);
                    const label = suggestion.name || suggestion.endpoint;
                    const target = suggestionTarget(suggestion);
                    return (
                      <li key={`${suggestion.endpoint}:${suggestion.port}`}>
                        <button
                          type="button"
                          aria-pressed={picked}
                          onClick={() => pick(suggestion)}
                          className={cn(
                            'flex w-full items-center gap-3 px-3 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-input/24',
                            picked && 'bg-accent dark:bg-input/32',
                          )}
                        >
                          <MachineIcon kind={suggestionKind(suggestion)} className="size-4 shrink-0 text-icon-muted" />
                          <span className="min-w-0 flex-1">
                            <span className={cn('block truncate text-sm text-foreground', !suggestion.name && 'font-mono')}>{label}</span>
                            {target !== label ? <span className="block truncate font-mono text-xs text-muted-foreground" title={target}>{target}</span> : null}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {suggestion.online === false ? <Badge variant="muted" size="sm">{t('machines.discovery.offline')}</Badge> : null}
                            {suggestion.sources.map((source) => (
                              <Badge key={source} variant="outline" size="sm">{t(SOURCE_LABEL[source])}</Badge>
                            ))}
                          </span>
                          <Check className={cn('size-4 shrink-0 text-primary', !picked && 'invisible')} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {suggestions.length ? <p className="text-xs text-muted-foreground">{t('machines.discovery.hint')}</p> : null}
            </section>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-machine-name">{t('setup.checklist.addDialog.name')}</Label>
              <Input id="add-machine-name" ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('setup.checklist.addDialog.namePlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('setup.checklist.addDialog.nameHint')}</p>
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-machine-host">{t('setup.checklist.addDialog.host')}</Label>
                <Input id="add-machine-host" font="mono" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={t('setup.checklist.addDialog.hostPlaceholder')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-machine-port">{t('setup.checklist.addDialog.port')}</Label>
                <NumberField id="add-machine-port" font="mono" min={1} max={65535} value={numberFromDraft(port)} onValueChange={(next) => setPort(draftFromNumber(next))} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">{t('setup.checklist.addDialog.hostHint')}</p>
              <CommandLine command={`ssh${parsedPort && parsedPort !== 22 ? ` -p ${parsedPort}` : ''} ${host && !hostProblem ? shellWord(host) : t('setup.checklist.addDialog.hostWord')} true`} />
            </div>
            {problem ? <p className="text-sm text-error-foreground" role="alert">{problem}</p> : null}
            {error ? <p className="text-sm text-error-foreground" role="alert">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!ready || saving}>
              {saving ? <Spinner /> : <Plus />}
              {t('setup.checklist.addDialog.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
