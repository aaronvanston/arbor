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

Pages have no tabs: the tree picks the view and the breadcrumb reads "Page / View". Sync › Library is the exception: a
bar over it picks the kind it lists (`kind`: plugins, MCP servers, skills, hooks, instructions) and how it's shown
(`lens`: the list, each kind's grid by machine, or Cost), and Repo has Files and Arbor's changes (`lens: 'changes'`) the
same way. A view that can be narrowed to one machine (`hasMachineScope`, plus Checkouts and the Library's Cost) ends its breadcrumb with the machine picker
(`components/layout/MachineCrumb.tsx`), and the page's other views keep that pick (`keepMachineScope`).

## Views that moved

An old view id can still turn up in links, the palette's saved picks and the view a page was left on, so it has to
land somewhere. `movedUsageView` sends Usage's old Capacity, Analysis, Failures and Claude Code (`telemetry`) to
Accounts › Value, Overview, Requests with Failed on, and the Library's Cost. `movedSetupView` sends Sync's old Agents and
Toolchain to Software; Skills, MCP & plugins and Hooks to their Library kind by machine (`libraryView(kind, 'machines')`);
Cost and Context to the Library's Cost; Arbor's changes (`history`) to Repo with `lens: 'changes'`; Projects to
`checkoutsView()` (Sessions with `lens: 'checkouts'`); and Checklist to Machines. `savedUsageView` and `savedSetupView`
read a page's saved last view through them. Overview kept Checks' id, `overview`. `tests/movedViews.test.ts` covers all of it; extend these maps when you move a view.

## Machines and pools

Machines is the fleet at a glance. `machinesView(name)` opens one machine's page (`pages/MachinePage.tsx`, rendered
inside `UsageRecordsPage` for its range picker): health, live sessions, agents, usage, sessions, setup standing and
checkouts, with the "Bring … in line" checklist on top when it's behind (`services/machinePage.ts` decides). One
machine's things go on its page; comparing machines is Sync's.

## Sync

Sync has four views. Overview is the checks. Library (`pages/SetupLibrary.tsx` over `services/library.ts`) lists every
plugin, MCP server, skill, hook and instruction file the setup repo gives the agents, one row each, with the repo's word
for every machine and the machines behind it; a row's switch (`services/libraryToggle.ts`) commits the new word and
brings each answering machine in line straight away, with Undo. Each row opens its own page (`libraryItemView(kind, key)`, `pages/SetupLibraryItem.tsx`): every machine with its
own switch (a value of that machine's own in the repo, applied there at once, `switchMachine`), use and a plugin's
measured cost, and Remove from every machine (`removeEverywhere`), confirmed first and undone with Undo. Software has the agent rollout, every machine's
versions and the toolchain. Repo is the setup repo's files, with Arbor's changes on each machine beside them.

Pools (`pages/PoolsPage.tsx`) shows every pool's health, and `poolsView(id)` one pool's page: members' load against the
limits, the next run's chances, where a burst would go. Settings › Pools only edits them.

Settings › Harnesses (`pages/HarnessesSettings.tsx`, with `services/harnessApps.ts` deciding what shows) has a card for
each app that runs agents (T3 Code, Orca, Superset, the Codex app, Claude) once it's found on a machine, with the
switches for what Arbor reads from it and hands it, and the agents' table below. An app's own switch goes there, never
on Settings › Machines.

Every machine name renders as `MachinePill` (`components/identity/Identity.tsx`), colored by the look picked in
`MachineLookPicker`.
