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
