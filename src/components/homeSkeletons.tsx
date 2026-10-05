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

/** A line of text's box (its line height), with a bar standing in for the text. */
function Line({ box, bar, className }: { box: string; bar: string; className?: string }) {
  return <span className={cn('flex items-center', box, className)}><Skeleton className={cn(bar, BAR)} /></span>;
}

/** One provider's pooled accounts, as HomeAccounts' ProviderAccounts lays them out. */
export function ProviderSkeleton({ accounts }: { accounts: number }) {
  return (
    // SettingsBlock's own box, with the mark the first screen's script copies it by.
    <div className="flex flex-col gap-3 px-4 py-3.5" data-slot="settings-block" data-boot-provider>
      <div className="flex items-center gap-3">
        <Skeleton className={cn('size-8 shrink-0 rounded-md', BAR)} />
        <div className="min-w-0 flex-1">
          <Line box="h-5" bar="h-3 w-20" />
          <Line box="h-4" bar="h-2.5 w-56 max-w-full" />
        </div>
        <span className="flex h-6 w-24 shrink-0" />
        <Line box="h-6" bar="h-5 w-16" className="shrink-0" />
      </div>
      <ul className="grid grid-cols-[auto_minmax(5rem,1fr)_minmax(4rem,10rem)_2.75rem_minmax(0,12.5rem)] items-center gap-x-3 gap-y-2 ps-11">
        {Array.from({ length: accounts }, (_, index) => (
          <li key={index} className="contents" data-boot-account>
            <Skeleton className={cn('size-5 rounded-md', BAR)} />
            <Line box="h-5" bar="h-3 w-28" />
            <Skeleton className={cn('h-1.5 rounded-full', BAR)} />
            <Line box="h-4" bar="ms-auto h-2.5 w-7" />
            <Line box="h-4" bar="ms-auto h-2.5 w-20" />
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
        <span className="block min-w-0 flex-1">
          <Line box="h-5" bar="h-3 w-48 max-w-full" />
          {/* The meta line holds a small machine pill, a little taller than its text. */}
          <Line box="h-4.5" bar="h-2.5 w-64 max-w-full" className="mt-0.5" />
        </span>
        <Line box="h-5" bar="h-3 w-20" className="shrink-0" />
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
      {more ? <div className="px-4 py-2" data-slot="settings-block" data-boot-attention-more><Line box="h-4" bar="h-2.5 w-28" /></div> : null}
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
          <Line box="h-5" bar="h-5 w-24 rounded-md" />
          <Line box="h-4" bar="h-2.5 w-32" />
        </span>
        <Line box="h-4" bar="h-2.5 w-14" className="shrink-0" />
      </span>
      <span className="grid grid-cols-2 gap-3 border-t border-border/50 pt-3">
        {[0, 1].map((column) => (
          <span key={column} className="min-w-0">
            <Line box="h-4" bar="h-2.5 w-10" />
            <Line box="h-5" bar="h-3 w-16" />
            <span className="block h-4" />
          </span>
        ))}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 border-t border-border/50 pt-3">
        <Line box="h-4" bar="h-2.5 w-40 max-w-full" />
        <Line box="h-4" bar="h-2.5 w-28" />
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
        <div key={index} className="min-w-0 px-4 py-4" aria-hidden="true">
          <Line box="h-4" bar="h-2.5 w-16" />
          <Line box="h-7" bar="h-5 w-20" className="mt-1" />
          <Line box="h-4" bar="h-2.5 w-28" className="mt-1" />
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
      <span className="min-w-0 flex-1">
        <Line box="h-5" bar="h-3 w-24" />
        <Line box="h-4" bar="h-2.5 w-32" />
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
          <span className="min-w-0 flex-1">
            <Line box="h-5" bar="h-3 w-20" />
            <Line box="h-4" bar="h-2.5 w-28" />
          </span>
        </div>
        <span className="size-4" />
        {end}
      </SettingsBlock>
      <SettingsBlock className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        {[0, 1].map((field) => (
          <span key={field} className="flex items-center gap-2">
            <Line box="h-7" bar="h-2.5 w-10" />
            <Skeleton className={cn('h-7 w-44 rounded-md', BAR)} />
          </span>
        ))}
        <Skeleton className={cn('ms-auto h-7 w-36 rounded-md', BAR)} />
      </SettingsBlock>
      <div className="flex min-h-9 items-center px-4"><Skeleton className={cn('h-2.5 w-14', BAR)} /></div>
    </>
  );
}
