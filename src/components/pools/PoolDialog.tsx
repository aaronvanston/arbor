import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { MachinePill } from '../identity/Identity';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../ui/dialog';
import { Trash2 } from '../ui/icons';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { NumberField } from '../ui/number-field';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { toast } from '../ui/toast';
import { useFleetHealth } from '../../services/fleetHealth';
import { machineName } from '../../services/machineNames';
import {
  POOL_WEIGHT_LABEL,
  POOL_WEIGHTS,
  POOL_WHEN_FULL,
  POOL_WHEN_FULL_LABEL,
  machinesToAdd,
  newPool,
  poolDraftProblem,
  savePool,
  spillTargets,
} from '../../services/pools';
import type { MachinePool, PoolWeight, PoolWhenFull } from '../../native/types';

/** Adds a pool or changes one: its name, members and their weights, limits, and what a run does when it's full. */
export function PoolDialog({ pool, pools, onClose }: { pool: MachinePool | null; pools: MachinePool[]; onClose: () => void }) {
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
                <LimitField id="pool-agents" label={t('pools.dialog.maxAgents')} value={draft.maxAgents} min={1} max={64} optional onChange={(maxAgents) => change({ maxAgents })} />
                <LimitField id="pool-cpu" label={t('pools.dialog.cpuCeiling')} value={draft.cpuCeiling} min={10} max={100} unit="%" optional onChange={(cpuCeiling) => change({ cpuCeiling })} />
                <LimitField id="pool-mem" label={t('pools.dialog.memFloor')} value={draft.memFloor} min={1} max={90} unit="%" optional onChange={(memFloor) => change({ memFloor })} />
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
                <LimitField id="pool-wait" label={t('pools.dialog.queueTimeout')} value={draft.queueTimeoutMin} min={1} max={1440} unit={t('pools.dialog.minutes')} onChange={(queueTimeoutMin) => { if (queueTimeoutMin !== null) change({ queueTimeoutMin }); }} />
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

/** A number a pool is limited by. An optional one can be emptied, which turns the limit off. */
function LimitField({ id, label, value, min, max, unit, optional = false, onChange }: {
  id: string; label: string; value: number | null; min: number; max: number; unit?: string; optional?: boolean; onChange: (value: number | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <NumberField
        id={id}
        size="sm"
        min={min}
        max={max}
        value={value}
        unit={value === null ? undefined : unit}
        placeholder={optional ? t('pools.dialog.noLimit') : undefined}
        allowOutOfRange={false}
        onValueChange={(next) => {
          if (next !== null) onChange(Math.round(next));
          else if (optional) onChange(null);
        }}
        aria-label={label}
      />
    </div>
  );
}
