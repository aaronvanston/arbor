/**
 * Everything that decides which usage rows a view shows; a loaded snapshot is only shown under the scope it was loaded for.
 * Paging stays out: the next page comes from the same filters, so the current rows stay up (with their own page
 * number and size) until it arrives, instead of flashing the skeleton and dropping focus from the pager.
 */
export type UsageViewScope = {
  tab: string;
  range: string;
  customStart: string;
  customEnd: string;
  machine: string;
  model: string;
  provider: string;
  source: string;
  apiKeyHash: string;
  result: string;
  /** A session picked from the Sessions tab, with its subagents. */
  session?: string;
  /**
   * The Sessions page's menus. Its search stays out, like paging: the rows for the last words stay up while the
   * next ones load, instead of the skeleton flashing on every pause in typing.
   */
  project?: string;
  branch?: string;
  client?: string;
  pullRequests?: string;
};

export function usageViewScopeKey(scope: UsageViewScope): string {
  return JSON.stringify([
    scope.tab,
    scope.range,
    scope.customStart,
    scope.customEnd,
    scope.machine,
    scope.model,
    scope.provider,
    scope.source,
    scope.apiKeyHash,
    scope.result,
    scope.session ?? '',
    scope.project ?? '',
    scope.branch ?? '',
    scope.client ?? '',
    scope.pullRequests ?? '',
  ]);
}

/**
 * Where the names in the request filters' menus come from. They're always every name in the range, unfiltered: a
 * menu listing only what's already filtered would empty out, and drop the pick it holds.
 * - `none`: the view has none of those menus.
 * - `overview`: Usage's Overview reads them with its Breakdown, which is unfiltered while nothing is filtered.
 * - `kept`: names read a moment ago for the same range.
 * - `query`: read them now.
 */
export type FilterOptionsSource = 'none' | 'overview' | 'kept' | 'query';

export function filterOptionsSource(input: {
  variant: string;
  /** Usage's Overview, whose Breakdown is the same analysis. */
  breakdown: boolean;
  filtered: boolean;
  quiet: boolean;
  /** Names read earlier are for this range and still fresh. */
  keptFresh: boolean;
}): FilterOptionsSource {
  if (input.variant === 'machines' || input.variant === 'value') return 'none';
  if (input.breakdown && !input.filtered) return 'overview';
  // Once something is filtered the Breakdown narrows too, so the Overview keeps the names it read before, even on a
  // load the user asked for.
  if (input.keptFresh && (input.quiet || input.breakdown)) return 'kept';
  return 'query';
}
