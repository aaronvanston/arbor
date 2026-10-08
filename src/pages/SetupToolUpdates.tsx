import { useMemo, useRef, useState } from 'react';
import { Check, TriangleAlert } from '../components/ui/icons';
import { SectionAbout } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { FixMenu } from '../components/FixMenu';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MachinePill } from '../components/identity/Identity';
import { useAgo } from '../hooks/useNow';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { toolUpdateProblem } from '../services/fixPrompt';
import { tickRows } from '../services/skillRuns';
import { scanToolchain } from '../services/setupToolchain';
import { applyTools } from '../services/applyEngine';
import { useSyncStanding, standingOf } from '../services/syncStanding';
import {
  changesByMachine,
  changeTools,
  checkToolUpdates,
  MOST_TOOL_CHANGES,
  resultsByTool,
  sortUpdates,
  toolUpdates,
  trialMachine,
  updateVerdict,
  type ToolUpdate,
  type UpdateState,
} from '../services/toolUpdates';
import type { MachineToolchain, OwnerKind, ToolOwner } from '../native/types';

type Translate = ReturnType<typeof useI18n>['t'];

const OWNER_LABEL: Record<OwnerKind, MessageKey> = {
  brew: 'setup.toolchain.owner.brew',
  mise: 'setup.toolchain.owner.mise',
  npm: 'setup.toolchain.owner.npm',
  corepack: 'setup.toolchain.owner.corepack',
  bun: 'setup.toolchain.owner.bun',
  deno: 'setup.toolchain.owner.deno',
  uv: 'setup.toolchain.owner.uv',
  rustup: 'setup.toolchain.owner.rustup',
  nvm: 'setup.toolchain.owner.nvm',
  fnm: 'setup.toolchain.owner.fnm',
  asdf: 'setup.toolchain.owner.asdf',
  volta: 'setup.toolchain.owner.volta',
  system: 'setup.toolchain.owner.system',
};

/** Who installed a tool, as the page names it: `Homebrew`, `mise`, `System packages (apt-get)`. */
export const ownerLabel = (owner: ToolOwner, t: Translate) => t(OWNER_LABEL[owner.kind], { manager: owner.name ?? '' });

/**
 * Mole's way of updating, for the tools on every machine: one list of what each tool's installer says is newer, each
 * row naming the installer that updates it. Update one, the ones ticked, or all; each row says how it went on its own,
 * and is checked again after, so an update that didn't take says so.
 */
export function ToolUpdatesCard({ toolchains, reachable, toolName }: {
  /** The machines' toolchains, in the order the page lists machines. */
  toolchains: MachineToolchain[];
  reachable: ReadonlySet<string>;
  toolName: (tool: string) => string;
}) {
  const { t, tRich } = useI18n();
  const { askChoice } = useConfirmation();
  const updates = useMemo(() => toolUpdates(toolchains), [toolchains]);
  // Rows a run has touched stay listed with how they went, after the update takes them off the list.
  const [ran, setRan] = useState<Record<string, ToolUpdate>>({});
  const [states, setStates] = useState<Record<string, UpdateState>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [checkFailures, setCheckFailures] = useState<Record<string, string>>({});
  const anchor = useRef<string | null>(null);
  const rows = useMemo(() => {
    const listed = new Set(updates.map((update) => update.key));
    return sortUpdates([...updates, ...Object.values(ran).filter((update) => !listed.has(update.key))], toolchains.map((entry) => entry.machine));
  }, [updates, ran, toolchains]);
  const order = rows.map((row) => row.key);
  const busy = Object.values(states).some((state) => state.kind === 'running');
  const checking = toolchains.some((entry) => entry.checking);
  const scanned = toolchains.filter((entry) => entry.scannedAt !== null);
  const checkedAt = scanned.reduce<number | null>((oldest, entry) => (entry.updates && (oldest === null || entry.updates.checkedAt < oldest) ? entry.updates.checkedAt : oldest), null);
  const checkedAgo = useAgo(checkedAt);
  const pending = rows.filter((row) => row.native && updates.some((update) => update.key === row.key) && states[row.key]?.kind !== 'running');
  const chosen = pending.filter((row) => selected.has(row.key));
  const problems = scanned.flatMap((entry) => {
    const failure = checkFailures[entry.machine] ?? entry.checkError;
    if (failure) return [{ machine: entry.machine, text: failure }];
    return (entry.updates?.problems ?? []).map((text) => ({ machine: entry.machine, text }));
  });

  const check = async () => {
    setRan({});
    setStates({});
    setCheckFailures({});
    await Promise.all(scanned.filter((entry) => reachable.has(entry.machine) && !entry.checking).map((entry) =>
      checkToolUpdates(entry.machine, true).catch((error) => setCheckFailures((current) => ({ ...current, [entry.machine]: String(error) })))));
  };

  /** Runs one machine's updates, then looks at it again to see which took. */
  const runOn = async (machine: string, batch: ToolUpdate[]) => {
    const said = new Map<string, { ok: boolean; message: string | null }>();
    for (let start = 0; start < batch.length; start += MOST_TOOL_CHANGES) {
      const chunk = batch.slice(start, start + MOST_TOOL_CHANGES);
      const changes = chunk.map((update) => update.change);
      try {
        for (const [tool, result] of resultsByTool(changes, await changeTools(machine, changes))) said.set(tool, { ok: result.ok, message: result.message });
      } catch (error) {
        for (const update of chunk) said.set(update.tool, { ok: false, message: String(error) });
      }
    }
    let after: MachineToolchain | null = null;
    if ([...said.values()].some((result) => result.ok)) {
      after = await scanToolchain(machine).catch(() => null);
      // The installers are asked again too, so the list shows what's still newer.
      if (after) after = await checkToolUpdates(machine, false).catch(() => after);
    }
    const next: Record<string, UpdateState> = {};
    for (const update of batch) {
      const result = said.get(update.tool);
      if (!result?.ok) next[update.key] = { kind: 'failed', message: result?.message ?? t('setup.toolchain.updates.noAnswer') };
      else next[update.key] = after ? updateVerdict(update, after) : { kind: 'unchecked' };
    }
    setStates((current) => ({ ...current, ...next }));
    return Object.values(next);
  };

  const run = async (batch: ToolUpdate[]) => {
    if (!batch.length) return;
    setRan((current) => ({ ...current, ...Object.fromEntries(batch.map((update) => [update.key, update])) }));
    setStates((current) => ({ ...current, ...Object.fromEntries(batch.map((update) => [update.key, { kind: 'running' } as const])) }));
    setSelected((current) => new Set([...current].filter((key) => !batch.some((update) => update.key === key))));
    // Machines go side by side; a machine's own changes run one after another, each whatever the last did.
    const outcomes = (await Promise.all([...changesByMachine(batch)].map(([machine, list]) => runOn(machine, list)))).flat();
    const updated = outcomes.filter((state) => state.kind === 'updated' || state.kind === 'unchecked').length;
    if (updated) toast({ kind: 'success', title: t(updated === 1 ? 'setup.toolchain.updates.done.one' : 'setup.toolchain.updates.done.other', { count: updated }) });
  };

  const updateMany = async (batch: ToolUpdate[]) => {
    const trial = trialMachine(batch);
    const choice = await askChoice({
      title: t(batch.length === 1 ? 'setup.toolchain.updates.confirm.title.one' : 'setup.toolchain.updates.confirm.title.other', { count: batch.length }),
      message: t('setup.toolchain.updates.confirm.message'),
      details: batch.map((update) => ({
        label: <span className="flex items-center gap-1.5">{toolName(update.tool)}<MachinePill name={update.machine} size="sm" /></span>,
        value: `${update.have} → ${update.latest} · ${ownerLabel(update.owner, t)}`,
      })),
      confirmText: t(batch.length === 1 ? 'setup.toolchain.updates.confirm.go.one' : 'setup.toolchain.updates.confirm.go.other', { count: batch.length }),
      secondaryText: trial ? t('setup.toolchain.updates.tryFirst', { machine: trial }) : undefined,
    });
    if (choice === 'confirm') await run(batch);
    else if (choice === 'secondary' && trial) await run(batch.filter((update) => update.machine === trial));
  };

  const tick = (key: string, on: boolean, range: boolean) => {
    setSelected((current) => tickRows(order, current, anchor.current, key, on, range));
    anchor.current = key;
  };

  return (
    <TableCard
      title={(
        <span className="flex items-center gap-1.5">
          {t('setup.toolchain.updates.title')}
          <SectionAbout title={t('setup.toolchain.updates.title')} description={t('setup.toolchain.updates.description')} />
        </span>
      )}
      count={updates.length ? t(updates.length === 1 ? 'setup.toolchain.updates.count.one' : 'setup.toolchain.updates.count.other', { count: updates.length }) : undefined}
      toolbar={(
        <>
          <span className="text-xs text-muted-foreground">
            {checking ? t('setup.toolchain.updates.checking') : checkedAt !== null ? t('setup.toolchain.updates.checked', { time: checkedAgo }) : t('setup.toolchain.updates.notChecked')}
          </span>
          <Button variant="outline" size="sm" disabledReason={checking ? t('setup.toolchain.updates.checking') : busy ? t('setup.toolchain.updates.busy') : undefined} onClick={() => void check()}>
            <RefreshIcon refreshing={checking} />
            {t('setup.toolchain.updates.check')}
          </Button>
          {pending.length > 1 ? (
            <Button size="sm" disabledReason={busy ? t('setup.toolchain.updates.busy') : undefined} onClick={() => void updateMany(pending)}>
              {t('setup.toolchain.updates.all', { count: pending.length })}
            </Button>
          ) : null}
        </>
      )}
    >
      {rows.length ? (
        <Table containerClassName="overflow-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={chosen.length > 0 && chosen.length === pending.length}
                  indeterminate={chosen.length > 0 && chosen.length < pending.length}
                  disabled={!pending.length}
                  onCheckedChange={(on) => setSelected(on ? new Set(pending.map((row) => row.key)) : new Set())}
                  aria-label={t('setup.toolchain.updates.pickAll')}
                />
              </TableHead>
              <TableHead className="min-w-32">{t('setup.toolchain.column.tool')}</TableHead>
              <TableHead>{t('setup.toolchain.updates.column.machine')}</TableHead>
              <TableHead>{t('setup.toolchain.updates.column.version')}</TableHead>
              <TableHead>{t('setup.toolchain.updates.column.installer')}</TableHead>
              <TableHead className="min-w-48 text-end">{t('setup.toolchain.updates.column.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <UpdateRow
                key={row.key}
                row={row}
                toolName={toolName}
                state={states[row.key] ?? null}
                open={updates.some((update) => update.key === row.key)}
                picked={selected.has(row.key)}
                busy={busy}
                onTick={tick}
                onUpdate={() => void run([row])}
              />
            ))}
          </TableBody>
        </Table>
      ) : (
        <TableEmpty>
          {checking ? t('setup.toolchain.updates.checking') : checkedAt !== null ? t('setup.toolchain.updates.none') : t('setup.toolchain.updates.notCheckedHint')}
        </TableEmpty>
      )}
      {chosen.length ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 bg-muted/40 px-4 py-2" role="region" aria-label={t('setup.toolchain.updates.bulk')}>
          <span className="me-auto text-xs text-muted-foreground">{t(chosen.length === 1 ? 'setup.toolchain.updates.chosen.one' : 'setup.toolchain.updates.chosen.other', { count: chosen.length })}</span>
          <Button variant="ghost-muted" size="xs" onClick={() => setSelected(new Set())}>{t('setup.toolchain.updates.clear')}</Button>
          <Button size="xs" disabledReason={busy ? t('setup.toolchain.updates.busy') : undefined} onClick={() => void updateMany(chosen)}>
            {t(chosen.length === 1 ? 'setup.toolchain.updates.confirm.go.one' : 'setup.toolchain.updates.confirm.go.other', { count: chosen.length })}
          </Button>
        </div>
      ) : null}
      {problems.length ? (
        <ul className="flex flex-col gap-1 border-t border-border/50 px-4 py-2 text-2xs text-muted-foreground">
          {problems.map((problem) => (
            <li key={`${problem.machine}\u0000${problem.text}`} className="flex min-w-0 items-center gap-1.5">
              <TriangleAlert className="size-3 shrink-0 text-warning" aria-hidden="true" />
              <span className="truncate" title={problem.text}>{tRich('setup.toolchain.updates.checkFailed', { machine: <MachinePill name={problem.machine} size="sm" />, error: problem.text })}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </TableCard>
  );
}

/**
 * What the setup repo's tools.json asks of one machine that it isn't in step on, from Sync's standing, and a way to
 * bring its tools in line with the repo: each installed, updated or removed with its installer, on its own.
 */
export function RepoToolsLine({ repo, machine, reachable }: { repo: string; machine: string; reachable: boolean }) {
  const { t } = useI18n();
  const { standing } = useSyncStanding();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const items = standingOf(standing, machine)?.behind.filter((item) => item.kind === 'tool') ?? [];
  const bring = async () => {
    setBusy(true);
    setFailures([]);
    try {
      const results = await applyTools(repo, machine);
      const done = results.filter((result) => result.ok).length;
      setFailures(results.filter((result) => !result.ok).map((result) => `${result.tool}: ${result.message ?? ''}`));
      if (done) toast({ kind: 'success', title: t(done === 1 ? 'setup.toolchain.repo.done.one' : 'setup.toolchain.repo.done.other', { count: done, machine }) });
    } catch (error) {
      setFailures([String(error)]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">
        {items.length
          ? t('setup.toolchain.repo.behind', { tools: items.map((item) => t(REPO_DRIFT[item.drift], { tool: item.name })).join(', ') })
          : t('setup.toolchain.repo.inStep')}
      </p>
      {items.length ? (
        <span>
          <Button variant="outline" size="xs" disabledReason={!reachable ? t('setup.toolchain.repo.away') : undefined} disabled={busy} onClick={() => void bring()}>
            {busy ? <Spinner /> : null}
            {t('setup.toolchain.repo.bring')}
          </Button>
        </span>
      ) : null}
      {failures.map((text) => <p key={text} className="text-xs text-error-foreground" role="alert">{text}</p>)}
    </div>
  );
}

const REPO_DRIFT: Record<'add' | 'update' | 'remove', MessageKey> = {
  add: 'setup.toolchain.repo.add',
  update: 'setup.toolchain.repo.update',
  remove: 'setup.toolchain.repo.remove',
};

function UpdateRow({ row, toolName, state, open, picked, busy, onTick, onUpdate }: {
  row: ToolUpdate;
  toolName: (tool: string) => string;
  state: UpdateState | null;
  /** The installer still has something newer, so it can be updated (again). */
  open: boolean;
  picked: boolean;
  busy: boolean;
  onTick: (key: string, on: boolean, range: boolean) => void;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  const running = state?.kind === 'running';
  const problem = (output: string | null) => toolUpdateProblem({
    tool: toolName(row.tool),
    version: row.have,
    latest: row.latest,
    installer: ownerLabel(row.owner, t),
    path: row.path,
    output,
  }, t);
  return (
    <TableRow>
      <TableCell>
        {row.native && open ? (
          <Checkbox
            checked={picked}
            disabled={running}
            onCheckedChange={(on, details) => onTick(row.key, on, 'shiftKey' in details.event && details.event.shiftKey === true)}
            aria-label={t('setup.toolchain.updates.pick', { tool: toolName(row.tool), machine: row.machine })}
          />
        ) : null}
      </TableCell>
      <TableCell className="text-sm text-foreground">{toolName(row.tool)}</TableCell>
      <TableCell><MachinePill name={row.machine} size="sm" /></TableCell>
      <TableCell className="font-mono text-xs">
        <span className="text-muted-foreground">{row.have}</span>
        <span className="mx-1 text-muted-foreground" aria-hidden="true">→</span>
        <span className="text-foreground">{row.latest}</span>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{ownerLabel(row.owner, t)}</TableCell>
      <TableCell className="text-end text-xs">
        <span className="inline-flex max-w-80 items-center justify-end gap-1.5">
          {running ? (
            <span className="flex items-center gap-1.5 text-muted-foreground"><Spinner className="size-3.5" />{t('setup.toolchain.updates.running')}</span>
          ) : state?.kind === 'updated' ? (
            <span className="flex items-center gap-1 text-success-foreground"><Check className="size-3.5" />{t('setup.toolchain.updates.updated', { version: state.version })}</span>
          ) : state?.kind === 'unchecked' ? (
            <span className="flex items-center gap-1 text-muted-foreground"><Check className="size-3.5" />{t('setup.toolchain.updates.unchecked')}</span>
          ) : state?.kind === 'stillBehind' ? (
            <>
              <Badge variant="warning" size="sm" title={state.version ? t('setup.toolchain.updates.stillBehindHint', { version: state.version, latest: row.latest }) : undefined}>
                {t('setup.toolchain.updates.stillBehind')}
              </Badge>
              <FixMenu compact machine={row.machine} problem={problem(null)} />
            </>
          ) : state?.kind === 'failed' ? (
            <>
              <span className="truncate text-error-foreground" title={state.message}>{state.message}</span>
              <FixMenu compact machine={row.machine} problem={problem(state.message)} />
            </>
          ) : null}
          {!running && open && row.native && state?.kind !== 'updated' ? (
            <Button variant="outline" size="xs" disabledReason={busy ? t('setup.toolchain.updates.busy') : undefined} onClick={onUpdate}>
              {state?.kind === 'failed' || state?.kind === 'stillBehind' ? t('setup.toolchain.updates.retry') : t('setup.toolchain.updates.update')}
            </Button>
          ) : null}
          {!row.native ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              {t('setup.toolchain.updates.needsSudo')}
              <FixMenu compact machine={row.machine} problem={problem(null)} />
            </span>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}
