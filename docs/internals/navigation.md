# Navigation

There's no URL routing. A view is state: it names its page and carries that page's params (`usageView`,
`sessionsView`, `setupView`, `accountsView`, `machinesView`, `poolsView`), so Back returns to the same filters.
`src/services/viewHistory.ts` keeps ⌘[ / ⌘] history and `src/services/shortcuts.ts` registers shortcuts.

## The sidebar tree

`src/services/sidebarTree.ts` lays the tree out and `components/sidebar/SidebarTree.tsx` draws it: Home alone at the
top, Fleet (Machines with one leaf per machine, Pools with one leaf per pool, Sessions, Automations, Sync) and Spend
(Accounts, Usage). Alerts is the footer bell; everything else is the Settings area. Page ids are in
`src/navigation.ts`, in the tree's order that ⌘1–⌘8 follow (Alerts is ⌘9), and `ViewContent` in `App.tsx` maps each view
to its page. Sync is still `setup` in ids and storage keys.

Pages have no tabs: the tree picks the view and the breadcrumb reads "Page / View". A view that can be narrowed to one
machine (`hasMachineScope`, plus Checkouts and Sync › Cost) ends its breadcrumb with the machine picker
(`components/layout/MachineCrumb.tsx`), and the page's other views keep that pick (`keepMachineScope`).

## Views that moved

An old view id can still turn up in links, the palette's saved picks and the view a page was left on, so it has to
land somewhere. `movedUsageView` sends Usage's old Capacity, Analysis, Failures and Claude Code (`telemetry`) to
Accounts › Value, Overview, Requests with Failed on, and Sync › Cost. `movedSetupView` sends Sync's old Context to Cost,
Projects to `checkoutsView()` (Sessions with `lens: 'checkouts'`) and Checklist to Machines. `savedUsageView` and
`savedSetupView` read a page's saved last view through them. Sync's Checks and Arbor's changes kept their old ids,
`overview` and `history`. `tests/movedViews.test.ts` covers all of it; extend these maps when you move a view.

## Machines and pools

Machines is the fleet at a glance. `machinesView(name)` opens one machine's page (`pages/MachinePage.tsx`, rendered
inside `UsageRecordsPage` for its range picker): health, live sessions, agents, usage, sessions, setup standing and
checkouts, with the "Bring … in line" checklist on top when it's behind (`services/machinePage.ts` decides). One
machine's things go on its page; comparing machines is Sync's. Sync › Agents has the agent rollout and every machine's
versions.

Pools (`pages/PoolsPage.tsx`) shows every pool's health, and `poolsView(id)` one pool's page: members' load against the
limits, the next run's chances, where a burst would go. Settings › Pools only edits them.

Every machine name renders as `MachinePill` (`components/identity/Identity.tsx`), colored by the look picked in
`MachineLookPicker`.
