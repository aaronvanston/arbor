import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Pencil, Plus, Trash2 } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatPercent } from '../lib/format';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { MachinePill } from '../components/identity/Identity';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { NumberField } from '../components/ui/number-field';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { TableEmpty } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { useFleetHealth } from '../services/fleetHealth';
import { machineName } from '../services/machineNames';
import {
  POOL_WEIGHT_LABEL,
  POOL_WEIGHTS,
  POOL_WHEN_FULL,
  POOL_WHEN_FULL_LABEL,
  leftOut,
  machinesToAdd,
  newPool,
  poolDraftProblem,
  poolSummary,
  removePool,
  savePool,
  spillTargets,
  usePools,
  verdictMessage,
} from '../services/pools';
import { cn } from '../lib/utils';
import type { MachinePool, PoolPreview, PoolWeight, PoolWhenFull } from '../native/types';

/**
 * Settings › Pools: named sets of machines that harness runs are balanced across. Each pool shows who would take its
 * next run from the machines' latest health, and why each other member wouldn't.
 */
export function PoolsSettingsPage() {
  const { t } = useI18n();
  const { pools, previews, error } = usePools();
  // The pool being edited ('' id for a new one), while the dialog is open.
  const [editing, setEditing] = useState<MachinePool | null>(null);
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.pools')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        <SettingsSection settingId="pools.list" title={t('pools.list.title')} description={t('pools.list.description')}>
          <SettingsRow
            title={t('pools.list.rowTitle')}
            description={t('pools.list.rowDescription')}
            control={<Button variant="outline" size="sm" onClick={() => setEditing(newPool())} disabled={!pools}><Plus />{t('pools.new')}</Button>}
          />
        </SettingsSection>
        {!pools ? (
          error ? null : <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground" role="status"><Spinner />{t('pools.loading')}</p>
        ) : pools.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground" data-slot="pools-empty">{t('pools.empty')}</p>
        ) : (
          pools.map((pool) => (
            <PoolSection key={pool.id} pool={pool} pools={pools} preview={previews.find((entry) => entry.pool === pool.id)} onEdit={() => setEditing(pool)} />
          ))
        )}
        <PoolDialog pool={editing} pools={pools ?? []} onClose={() => setEditing(null)} />
      </PageBody>
    </Page>
  );
}

/** One pool: its limits, each member with its weight and how it stands now, and where the next run would go. */
function PoolSection({ pool, pools, preview, onEdit }: { pool: MachinePool; pools: MachinePool[]; preview: PoolPreview | undefined; onEdit: () => void }) {
  const { t, tRich } = useI18n();
  const [removing, setRemoving] = useState(false);
  const shaped = poolSummary(pool);
  const remove = async () => {
    setRemoving(true);
    try {
      const unhooked = pools.filter((other) => other.spillPool === pool.id).length;
      await removePool(pool.id);
      toast({
        kind: 'success',
        title: t('pools.removed', { name: pool.name }),
        description: unhooked ? t(unhooked === 1 ? 'pools.removedUnhooked.one' : 'pools.removedUnhooked.other', { count: unhooked }) : undefined,
        action: { label: t('common.undo'), onClick: () => { savePool(pool).catch((failure: unknown) => toast({ kind: 'error', title: String(failure) })); } },
        focusAction: true,
      });
    } catch (failure) {
      toast({ kind: 'error', title: String(failure) });
      setRemoving(false);
    }
  };
  const spillName = pools.find((other) => other.id === pool.spillPool)?.name ?? '';
  const whenFull = pool.whenFull === 'spill'
    ? t('pools.next.spill', { pool: spillName })
    : pool.whenFull === 'queue'
      ? t('pools.next.queue', { minutes: pool.queueTimeoutMin })
      : t('pools.next.refuse');
  return (
    <SettingsSection
      settingId={`pools.pool.${pool.id}`}
      title={pool.name}
      summary={
        shaped.length ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            {shaped.map((member) => (
              <span key={member.machine} className="inline-flex items-center gap-1">
                <MachinePill name={member.machine} size="sm" />
                <span>{t(POOL_WEIGHT_LABEL[member.weight]).toLowerCase()}</span>
              </span>
            ))}
          </span>
        ) : t('pools.summary.allNormal')
      }
      headerAction={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}><Pencil />{t('pools.edit')}</Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void remove()} disabled={removing} aria-label={t('pools.remove', { name: pool.name })} title={t('pools.remove', { name: pool.name })}>
            <Trash2 />
          </Button>
        </div>
      }
    >
      <SettingsBlock className="py-2 text-xs text-muted-foreground">
        {t('pools.limits', { agents: pool.maxAgents, cpu: pool.cpuCeiling, mem: pool.memFloor })}
      </SettingsBlock>
      {pool.members.length === 0 ? (
        <TableEmpty>{t('pools.noMembers')}</TableEmpty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('pools.column.machine')}</TableHead>
              <TableHead className="w-32">{t('pools.column.weight')}</TableHead>
              <TableHead>{t('pools.column.now')}</TableHead>
              <TableHead className="w-28 text-end">{t('pools.column.chance')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pool.members.map((member) => {
              const verdict = preview?.members.find((entry) => entry.machine === member.machine);
              const message = verdict ? verdictMessage(verdict, pool) : null;
              return (
                <TableRow key={member.machine} data-verdict={verdict?.kind}>
                  <TableCell><MachinePill name={member.machine} /></TableCell>
                  <TableCell className="text-muted-foreground">{t(POOL_WEIGHT_LABEL[member.weight])}</TableCell>
                  <TableCell className={cn('text-xs', verdict && leftOut(verdict.kind) ? 'text-warning-foreground' : 'text-muted-foreground')}>
                    {message ? t(message.key, message.values) : t('pools.verdict.checking')}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{verdict && verdict.share > 0 ? formatPercent(verdict.share) : <span className="text-muted-foreground">{t('pools.chance.none')}</span>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <SettingsBlock className="py-2.5 text-sm">
        {preview?.likely
          ? tRich('pools.next.likely', { machine: <MachinePill name={preview.likely} size="sm" /> })
          : preview
            ? <span className="text-muted-foreground">{t('pools.next.nobody', { action: whenFull })}</span>
            : <span className="text-muted-foreground">{t('pools.verdict.checking')}</span>}
      </SettingsBlock>
    </SettingsSection>
  );
}

/** Adds a pool or changes one: its name, members and their weights, limits, and what a run does when it's full. */
function PoolDialog({ pool, pools, onClose }: { pool: MachinePool | null; pools: MachinePool[]; onClose: () => void }) {
  const { t } = useI18n();
  const health = useFleetHealth();
  const [draft, setDraft] = useState<MachinePool>(newPool);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const open = pool !== null;
  useEffect(() => {
    if (!pool) return;
    setDraft({ ...pool, members: pool.members.map((member) => ({ ...member })) });
    setError(null);
    setTried(false);
  }, [pool]);
  const change = (patch: Partial<MachinePool>) => setDraft((current) => ({ ...current, ...patch }));
  const setWeight = (machine: string, weight: PoolWeight) =>
    change({ members: draft.members.map((member) => (member.machine === machine ? { ...member, weight } : member)) });
  const machines = machinesToAdd(draft, (health ?? []).map((entry) => entry.machine));
  const targets = spillTargets(draft, pools);
  const problem = poolDraftProblem(draft, pools);
  const save = async () => {
    setTried(true);
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      await savePool(draft);
      toast({ kind: 'success', title: t(draft.id ? 'pools.saved' : 'pools.added', { name: draft.name.trim() }) });
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen && !saving) onClose(); }}>
      <DialogPopup className="max-w-xl" initialFocus={nameRef}>
        <form className="contents" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <DialogHeader>
            <DialogTitle>{t(pool?.id ? 'pools.dialog.editTitle' : 'pools.dialog.newTitle')}</DialogTitle>
            <DialogDescription>{t('pools.dialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pool-name">{t('pools.dialog.name')}</Label>
              <Input id="pool-name" ref={nameRef} value={draft.name} onChange={(event) => change({ name: event.target.value })} placeholder={t('pools.dialog.namePlaceholder')} />
            </div>
            <div className="flex flex-col gap-2" data-slot="pool-members">
              <div className="flex items-center justify-between gap-3">
                <Label>{t('pools.dialog.members')}</Label>
                <Select value="" onValueChange={(next) => { if (next) change({ members: [...draft.members, { machine: String(next), weight: 'normal' }] }); }} disabled={machines.length === 0}>
                  <SelectTrigger size="sm" className="w-auto" aria-label={t('pools.dialog.addMachine')}>
                    <SelectValue>{t('pools.dialog.addMachine')}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {machines.map((name) => <SelectItem key={name} value={name}><MachinePill name={name} /></SelectItem>)}
                  </SelectPopup>
                </Select>
              </div>
              {draft.members.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">{t('pools.dialog.noMembers')}</p>
              ) : (
                <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
                  {draft.members.map((member) => (
                    <li key={member.machine} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="min-w-0 flex-1"><MachinePill name={member.machine} /></span>
                      <Select value={member.weight} onValueChange={(next) => { if (next) setWeight(member.machine, next as PoolWeight); }}>
                        <SelectTrigger size="sm" className="w-36" aria-label={t('pools.dialog.weightFor', { machine: machineName(member.machine) })}>
                          <SelectValue>{t(POOL_WEIGHT_LABEL[member.weight])}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {POOL_WEIGHTS.map((weight) => <SelectItem key={weight} value={weight}>{t(POOL_WEIGHT_LABEL[weight])}</SelectItem>)}
                        </SelectPopup>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => change({ members: draft.members.filter((entry) => entry.machine !== member.machine) })}
                        aria-label={t('pools.dialog.removeMember', { machine: machineName(member.machine) })}
                        title={t('pools.dialog.removeMember', { machine: machineName(member.machine) })}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">{t('pools.dialog.weightHint')}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('pools.dialog.full')}</Label>
              <div className="grid grid-cols-3 gap-3">
                <LimitField id="pool-agents" label={t('pools.dialog.maxAgents')} value={draft.maxAgents} min={1} max={64} onChange={(maxAgents) => change({ maxAgents })} />
                <LimitField id="pool-cpu" label={t('pools.dialog.cpuCeiling')} value={draft.cpuCeiling} min={10} max={100} unit="%" onChange={(cpuCeiling) => change({ cpuCeiling })} />
                <LimitField id="pool-mem" label={t('pools.dialog.memFloor')} value={draft.memFloor} min={0} max={90} unit="%" onChange={(memFloor) => change({ memFloor })} />
              </div>
              <p className="text-xs text-muted-foreground">{t('pools.dialog.fullHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t('pools.dialog.whenFull')}</Label>
                <Select value={draft.whenFull} onValueChange={(next) => { if (next) change({ whenFull: next as PoolWhenFull }); }}>
                  <SelectTrigger size="sm" aria-label={t('pools.dialog.whenFull')}>
                    <SelectValue>{t(POOL_WHEN_FULL_LABEL[draft.whenFull])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {POOL_WHEN_FULL.map((choice) => (
                      <SelectItem key={choice} value={choice} disabled={choice === 'spill' && targets.length === 0}>{t(POOL_WHEN_FULL_LABEL[choice])}</SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {draft.whenFull === 'spill' ? (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('pools.dialog.spillPool')}</Label>
                  <Select value={draft.spillPool ?? ''} onValueChange={(next) => change({ spillPool: next ? String(next) : null })}>
                    <SelectTrigger size="sm" aria-label={t('pools.dialog.spillPool')}>
                      <SelectValue>{targets.find((target) => target.id === draft.spillPool)?.name ?? t('pools.dialog.spillPick')}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((target) => <SelectItem key={target.id} value={target.id}>{target.name}</SelectItem>)}
                    </SelectPopup>
                  </Select>
                </div>
              ) : draft.whenFull === 'queue' ? (
                <LimitField id="pool-wait" label={t('pools.dialog.queueTimeout')} value={draft.queueTimeoutMin} min={1} max={1440} unit={t('pools.dialog.minutes')} onChange={(queueTimeoutMin) => change({ queueTimeoutMin })} />
              ) : null}
            </div>
            {tried && problem ? <p className="text-sm text-error-foreground" role="alert">{t(problem)}</p> : null}
            {error ? <p className="text-sm text-error-foreground" role="alert">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner /> : null}
              {t(pool?.id ? 'pools.dialog.save' : 'pools.dialog.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function LimitField({ id, label, value, min, max, unit, onChange }: {
  id: string; label: string; value: number; min: number; max: number; unit?: string; onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <NumberField
        id={id}
        size="sm"
        min={min}
        max={max}
        value={value}
        unit={unit}
        allowOutOfRange={false}
        onValueChange={(next) => { if (next !== null) onChange(Math.round(next)); }}
        aria-label={label}
      />
    </div>
  );
}
