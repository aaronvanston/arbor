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
(`lens`: the list, each kind's grid per home for rare per-home fixes, Cost, or the directory), and Repo opens on History with `lens: 'changes'`. A view that can be narrowed to one machine (`hasMachineScope`, plus Checkouts and the Library's Cost) ends its breadcrumb with the machine picker
(`components/layout/MachineCrumb.tsx`), and the page's other views keep that pick (`keepMachineScope`).

## Views that moved

An old view id can still turn up in links, the palette's saved picks and the view a page was left on, so it has to
land somewhere. `movedUsageView` sends Usage's old Capacity, Analysis, Failures and Claude Code (`telemetry`) to
Accounts › Value, Overview, Requests with Failed on, and the Library's Cost. `movedSetupView` sends Sync's old Agents and
Toolchain to Software; Skills, MCP & plugins and Hooks to their Library kind per home (`libraryView(kind, 'machines')`);
Cost and Context to the Library's Cost; Arbor's changes (`history`) to the Repo's History (`lens: 'changes'`); and
Checklist to Machines. Projects is a Sync view again under its own id; Sessions' Checkouts (`checkoutsView()`) is a
separate view of the checkouts sessions ran in. `savedUsageView` and `savedSetupView`
read a page's saved last view through them. Overview kept Checks' id, `overview`. `tests/movedViews.test.ts` covers all of it; extend these maps when you move a view.

## Machines and pools

Machines is the fleet at a glance. `machinesView(name)` opens one machine's page (`pages/MachinePage.tsx`, rendered
inside `UsageRecordsPage` for its range picker): health, live sessions, agents, usage, sessions, setup standing and
checkouts, with the "Bring … in line" checklist on top when it's behind (`services/machinePage.ts` decides). One
machine's things go on its page; comparing machines is Sync's.

## Sync

Sync has five views: Overview, Library, Projects, Software and Repo. Overview (`pages/SetupOverview.tsx` atop the
checks and the machine comparison) says which machines are in step with the repo, what each is behind on, and brings one
or all in line, confirmed first, with `bringInLine`: each Library row behind there, files and hook scripts first, then
plugins and MCP servers, the machine's hooks, and skills. A project behind opens Projects, which has its own fixes.

There's one way to change a machine to match the repo: `services/applyEngine.ts`. Every path calls it: Overview's and
the Repo review's Bring in line (`bringInLine`, files and hook scripts, then plugins, MCP servers, hooks and skills),
the Library's switches, the Per home grids' buttons, skill runs, decisions on an edit made on a machine, and `arbor sync
apply`. Each step goes through the kind's guarded command, which checks, backs up and lands on History. Rust rescans
the machine and records its bases, and the standing is read again. Runs by themselves (`setup_autoline.rs`) call the
same guarded commands in the same order from Rust. `tests/applyEngine.test.ts` keeps those commands out of every other
file. The Repo review only shows what's different, with diffs on demand and each file's own decisions; it applies
nothing of its own.

Whether a machine is in step is decided in one place, `setup_standing.rs`, from the machines' last scans and the repo's
HEAD, over every kind and the projects. Overview, the Repo strip, the Library's behind, the sidebar badge (machines
behind or with problems, each once) and `arbor sync` read it through `services/syncStanding.ts`, one read shared by the
window. Don't count "behind" anywhere else, even for one kind: that's how they disagreed before.
`setupSync.nothingToApply` only says whether the file review has changes.

Each difference also says who moved since the two sides last matched, from a base per machine and item kept on this Mac
(`setup-bases.json`, written by `get_sync_standing` whenever it finds an item in step, so a rescan after any apply
records one). Without it an edit made on a machine looked like the repo moving on and was overwritten by default. An
edit made there (`editedHere`, `bothChanged`) is never brought in line, ticked in the review or applied by `arbor sync
apply`; the item page's Take into repo, Keep this machine's or Use the repo's (`services/editedHere.ts`) settles it.
The bases compare fingerprints like for like, each side with itself, so a `cksum` machine or a salted MCP definition
never has to match the repo's form; a new salt drops the salted bases rather than make them all look edited. Library (`pages/SetupLibrary.tsx` over `services/library.ts`) lists every
plugin, MCP server, skill, hook and instruction file the setup repo gives the agents, one row each, with the repo's word
for every machine and the machines behind it; a row's switch (`services/libraryToggle.ts`) commits the new word and
brings each answering machine in line straight away, with Undo. Undo puts each machine back as it was rather than
applying the repo's old word again, which would land on homes the change never touched: files, skills and hooks from
the guarded-write backups the change took, plugins by turning around only the changes it made. A toast says done only
when every machine it tried changed; otherwise it names the machines that didn't. Each row opens its own page (`libraryItemView(kind, key)`, `pages/SetupLibraryItem.tsx`): every machine with its
own switch (a value of that machine's own in the repo, applied there at once, `switchMachine`), use and a plugin's
measured cost, Update everywhere for a Claude Code plugin some homes have older (`updatePlugin`), Check connections for an MCP server, its values in a project (the Per home cards narrowed to it), Add to the repo for what only machines have (`takeIntoRepo`), and Remove from every machine (`removeEverywhere`), confirmed first and undone with Undo. Per home (`lens: 'machines'`) keeps the old grids for rare per-home fixes. Browse directory (`lens: 'directory'`, `pages/SetupDirectory.tsx` over `services/directory.ts`) lists what each
marketplace offers, read from its GitHub repository by `get_marketplace_catalog` (no account, 15 minutes' cache): the
marketplaces machines and the repo use, Anthropic's official one as a suggestion, and any `owner/repo` typed in. Adding
one (`addPlugin`) lists it on for every machine with its marketplace's repository and installs it, with Undo (one no
machine installs is taken back out of the repo at once); a
marketplace the machines have can be refreshed or removed on all of them (`marketplaceEverywhere`). Software has the agent rollout, every machine's
versions and the toolchain. Repo is the setup repo's files, changes and History, one timeline of its commits with the changes Arbor made on each machine from them (and on its own, from features that edit settings), each with Undo (`pages/SetupRepoHistory.tsx` over `services/repoTimeline.ts`).

The repo keeps itself in step with the remote branch it follows (`setup_repo_keeper.rs`, switched off on Settings ›
Machines › Sync). It fetches a minute after launch, every 15 minutes, and when the window comes back to the front after
five minutes. It fast-forwards when the repo is only behind and no synced file has uncommitted changes. It pushes when
the repo is only ahead, and straight after any commit Arbor makes (`setup_sync::git` wakes it). Nothing else is ever
done: diverged, dirty, sign-in and network trouble are left as they are. Each shows on Sync › Repo beside the Pull and
Push buttons and raises one `setupRepo` alert, folded by the repo it's about. A pull re-reads the standing, so machines
show behind at once.

Machines are then brought in line by themselves (`setup_autoline.rs`, the machine-scoped preference `autoLineUp`, paused
per machine from Overview's machine menu). A run starts after a pull, after a scan lands, and when a machine answers
again. It only applies what the repo moved on (`Change::Update`) and Arbor backs up: files, skills in the store, and a
machine's hooks with their scripts, and an MCP server only Codex homes differ on (a guarded config.toml edit). An item
with no base waits quietly. Edits made on the machine, removals, plugins and MCP servers a Claude Code home differs on
wait for the user and are said once per machine. A run is a normal guarded apply, marked automatic in History
by this Mac's list of its backups. It runs at most once every five minutes per machine. A failure stops runs on that
machine, kept across restarts in `setup-auto.json`, until a person's apply works there or it's found in step.

Sync also says when something's wrong that nobody would otherwise see, each once, as an alert with its subject. A
machine behind the repo for a day opens Overview, and is said again only after it's been in step; the time it first fell
behind is kept in `setup-auto.json`. A setup scan that fails three times in a row on a machine that answers its health
checks opens the machine's page. The repo's MCP servers or hooks file Arbor can't read or use is said on Overview, not
counted as nothing. The setup repo's own trouble is the keeper's.

Pools (`pages/PoolsPage.tsx`) shows every pool's health, and `poolsView(id)` one pool's page: members' load against the
limits, the next run's chances, where a burst would go. Settings › Pools only edits them.

Settings › Harnesses (`pages/HarnessesSettings.tsx`, with `services/harnessApps.ts` deciding what shows) has a card for
each app that runs agents (T3 Code, Orca, Superset, the Codex app, Claude) once it's found on a machine, with the
switches for what Arbor reads from it and hands it, and the agents' table below. An app's own switch goes there, never
on Settings › Machines.

Every machine name renders as `MachinePill` (`components/identity/Identity.tsx`), colored by the look picked in
`MachineLookPicker`.
