import { cn } from '../lib/utils';
import { SettingsBlock } from './layout/settings';
import { StatsGrid } from './layout/stats';
import { Skeleton } from './ui/skeleton';

/**
 * Home's sections while they wait, each laid out as its loaded content is, line for line, so nothing moves when the
 * data lands. index.html's first screen draws the same ones (src/boot/BootShell.tsx), so the window can open on them,
 * React's first frame keeps them, and the content replaces them in place. How many providers, accounts and machines
 * to draw comes from the last time Home loaded (src/boot/bootState.ts). Still rather than pulsing: they're on screen
 * for a moment, and a pulse would restart when React takes over from the first screen.
 *
 * Nothing here may read the window or a store: the build renders these before either exists.
 */

const BAR = 'motion-safe:animate-none';

/** The machines section's cards stand on their own in a grid rather than in one card. */
export const MACHINES_GRID_CLASS = 'grid gap-3 overflow-visible rounded-none border-0 bg-transparent shadow-none sm:grid-cols-2 xl:grid-cols-3 dark:bg-transparent [&>*+*]:border-t-0';
/** Today's figures bring their own card (StatsGrid), so the section's is left bare. */
export const TODAY_CARD_CLASS = 'border-0 bg-transparent shadow-none dark:bg-transparent [&>*+*]:border-t-0';

/**
 * A bar standing in for a line of text: `bar` px tall, centered in the text's `line` height by its margins, so it
 * takes the line's room as one element (the first screen lays out hundreds of these before the window shows).
 * `above` adds space over it, as the text's own top margin would.
 */
function Line({ line, bar, above = 0, className }: { line: number; bar: number; above?: number; className?: string }) {
  const margin = (line - bar) / 2;
  return <div className={cn('shrink-0 rounded-sm bg-muted-foreground/15', className)} style={{ height: bar, marginTop: margin + above, marginBottom: margin }} />;
}

/** One provider's pooled accounts, as HomeAccounts' ProviderAccounts lays them out. */
export function ProviderSkeleton({ accounts }: { accounts: number }) {
  return (
    // SettingsBlock's own box, with the mark the first screen's script copies it by.
    <div className="flex flex-col gap-3 px-4 py-3.5" data-slot="settings-block" data-boot-provider>
      <div className="flex items-center gap-3">
        <Skeleton className={cn('size-8 shrink-0 rounded-md', BAR)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Line line={20} bar={12} className="w-20" />
          <Line line={16} bar={10} className="w-56 max-w-full" />
        </div>
        <span className="flex h-6 w-24 shrink-0" />
        <Line line={24} bar={20} className="w-16" />
      </div>
      <ul className="grid grid-cols-[auto_minmax(5rem,1fr)_minmax(4rem,10rem)_2.75rem_minmax(0,12.5rem)] items-center gap-x-3 gap-y-2 ps-11">
        {Array.from({ length: accounts }, (_, index) => (
          <li key={index} className="contents" data-boot-account>
            <Skeleton className={cn('size-5 rounded-md', BAR)} />
            <Line line={20} bar={12} className="w-28" />
            <Skeleton className={cn('h-1.5 rounded-full', BAR)} />
            <Line line={16} bar={10} className="ms-auto w-7" />
            <Line line={16} bar={10} className="ms-auto w-20" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The accounts card's contents: a block per provider, with as many rows as it had accounts. */
export function AccountsSkeleton({ providers }: { providers: readonly number[] }) {
  return <>{providers.map((accounts, index) => <ProviderSkeleton key={index} accounts={accounts} />)}</>;
}

/** One session row, as FleetBoard's FleetRow lays it out in Needs you. */
function NeedsYouRowSkeleton() {
  return (
    <div className="flex items-center gap-1 pe-2" data-boot-attention-row>
      <div className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 ps-4">
        <Skeleton className={cn('size-8 shrink-0 rounded-md', BAR)} />
        <span className="flex min-w-0 flex-1 flex-col">
          <Line line={20} bar={12} className="w-48 max-w-full" />
          {/* The meta line holds a small machine pill, a little taller than its text. */}
          <Line line={18} bar={10} above={2} className="w-64 max-w-full" />
        </span>
        <Line line={20} bar={12} className="w-20" />
      </div>
      <span className="size-7 shrink-0" />
    </div>
  );
}

/** Needs you's card contents: its rows, and the line saying how many more the board has. */
export function NeedsYouSkeleton({ rows, more }: { rows: number; more: boolean }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => <NeedsYouRowSkeleton key={index} />)}
      {more ? <div className="flex flex-col px-4 py-2" data-slot="settings-block" data-boot-attention-more><Line line={16} bar={10} className="w-28" /></div> : null}
    </>
  );
}

/** Needs you's line of counts, beside its title. */
export const NeedsYouSummarySkeleton = () => <span className="inline-block h-2.5 w-52 rounded-sm bg-muted-foreground/15 align-middle" />;

/** One machine's card, as HomeMachines' MachineCard lays it out. */
export function MachineSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs/5" data-boot-machine>
      <span className="flex min-w-0 items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Line line={20} bar={20} className="w-24 rounded-md" />
          <Line line={16} bar={10} className="w-32" />
        </span>
        <Line line={16} bar={10} className="w-14" />
      </span>
      <span className="grid grid-cols-2 gap-3 border-t border-border/50 pt-3">
        {[0, 1].map((column) => (
          <span key={column} className="flex min-w-0 flex-col">
            <Line line={16} bar={10} className="w-10" />
            <Line line={20} bar={12} className="w-16" />
            <span className="block h-4" />
          </span>
        ))}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 border-t border-border/50 pt-3">
        <Line line={16} bar={10} className="w-40 max-w-full" />
        <Line line={16} bar={10} className="w-28" />
      </span>
    </div>
  );
}

export function MachinesSkeleton({ count }: { count: number }) {
  return <>{Array.from({ length: count }, (_, index) => <MachineSkeleton key={index} />)}</>;
}

/** Today's four figures, as StatBlock lays each out: label, value, a line of detail. */
export function TodaySkeleton() {
  return (
    <StatsGrid columns={4}>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex min-w-0 flex-col px-4 py-4" aria-hidden="true">
          <Line line={16} bar={10} className="w-16" />
          <Line line={28} bar={20} above={4} className="w-20" />
          <Line line={16} bar={10} above={4} className="w-28" />
        </div>
      ))}
    </StatsGrid>
  );
}

/** The proxy card's contents (machines → proxy → accounts, then how to reach it, then its details), for the first screen. */
export function ProxySkeleton() {
  const end = (
    <span className="flex min-w-0 items-center gap-3">
      <Skeleton className={cn('size-8 shrink-0 rounded-lg', BAR)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <Line line={20} bar={12} className="w-24" />
        <Line line={16} bar={10} className="w-32" />
      </span>
    </span>
  );
  return (
    <>
      <SettingsBlock className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)_auto_minmax(0,1fr)] items-center gap-3 py-4">
        {end}
        <span className="size-4" />
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2 dark:bg-input/20">
          <Skeleton className={cn('size-8 shrink-0 rounded-lg', BAR)} />
          <span className="flex min-w-0 flex-1 flex-col">
            <Line line={20} bar={12} className="w-20" />
            <Line line={16} bar={10} className="w-28" />
          </span>
        </div>
        <span className="size-4" />
        {end}
      </SettingsBlock>
      <SettingsBlock className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        {[0, 1].map((field) => (
          <span key={field} className="flex items-center gap-2">
            <Line line={28} bar={10} className="w-10" />
            <Skeleton className={cn('h-7 w-44 rounded-md', BAR)} />
          </span>
        ))}
        <Skeleton className={cn('ms-auto h-7 w-36 rounded-md', BAR)} />
      </SettingsBlock>
      {/* The details fold: its divider sits on the fold, outside the 36px row, as Collapsible's does. */}
      <div><div className="flex min-h-9 items-center px-4"><Skeleton className={cn('h-2.5 w-14', BAR)} /></div></div>
    </>
  );
}
