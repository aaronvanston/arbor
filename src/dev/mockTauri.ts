/**
 * Browser-only Tauri IPC mock so the UI can be developed and screenshotted in
 * a plain browser: start Vite with `bunx vite --host 127.0.0.1 --port 1420 --strictPort`
 * and open http://127.0.0.1:1420 outside the Tauri shell. Never loaded in
 * production builds or inside the desktop app. Each command's answer sits in its
 * domain's map in `./mock/`, typed against the command list.
 *
 * Scenario switches via query string: `?core=stopped`, `?core=missing`,
 * `?core=unready` (process up, management port not answering yet), `?core=unreadable` (its status can't be read, so
 * pages that need it say so and offer Check again), `?core=stops` (running, then stopping eight seconds after load, so
 * a page that needs it, like Accounts or Settings › Auth Files, locks in place; Start core brings it back there);
 * `?accounts=none` for a core with no credentials, so Accounts, Home's limits card and the sidebar offer Add account;
 * `?accounts=fleet` for one person's accounts named with their email in the file name (Accounts › Sign-ins, and
 * Settings › Appearance's Hide email addresses); Add account's sign-in finishes after two checks, unless
 * `?signin=wait` keeps it waiting, `?signin=link` has the browser not open (only the link shows) or `?signin=fail`
 * has the provider refuse it;
 * `?accounts=off` for every credential turned off, so Accounts and Home's limits card say so and point to Auth Files
 * (the sidebar offers nothing); `?accounts=fail` for the core failing to list its credentials, so they say why and
 * offer Try again (Auth Files can't list them either);
 * `?page=accounts` or `?page=settings:auth-files` (any page id, `settings:` for a Settings page) to start on that page,
 * with Home one step back; with `?core=stopped` or `?core=missing` too, it shows locked with Start core or Install core;
 * `&tab=` with it starts on one of the page's views, by the id the view keeps: `?page=setup&tab=skills` (Sync's
 * `overview` is its Checks and `history` Arbor's changes; also `agents`, `repo`, `plugins`, `toolchain` and `cost`), `?page=sessions&tab=projects&lens=checkouts` for Projects' Checkouts (without `lens`, its Activity),
 * `?page=accounts&tab=limits` or `value` (Value opens with `?core=stopped` too, its Limits locked beside it in the
 * sidebar), `?page=usage&tab=events` or `?page=sessions&tab=live` (a view a page doesn't have opens it on the view it
 * last had, and one that moved opens where it is now: `?page=usage&tab=capacity` opens Accounts › Value, `analysis`
 * Usage's Overview, whose Breakdown it was, `failures` Usage's Requests with Failed on, which lists the failed
 * requests with their statuses and what went wrong, and `telemetry` Sync › Cost); `?page=machine:ci-01` starts on
 * ci-01's own page, as its leaf in the sidebar opens it (`machine:lab-box` for one with no host, only its checklist);
 * `?failures=none` for no request failing, so Requests with Failed on says there's nothing to list;
 * `?oldviews=seed` saves what an older Arbor left behind naming views that have since moved: the palette's
 * Recent section has Usage › Capacity, Analysis and Failures (listed as Accounts › Value, Usage › Overview and
 * Usage › Failed requests), and Usage was last left on Failures (it opens on Requests with Failed on);
 * `?oldviews=sync` does the same for Sync's and Usage's other moved views: Recent has Sync's
 * Context and Projects and Usage's Claude Code (listed as Sync › Cost, which both Context and Claude Code are part of,
 * and Sessions › Project checkouts), then Checks and Arbor's changes, which kept their ids, and Sync was last left on
 * Context (it opens on Cost); `?page=setup&tab=projects` opens Sessions › Projects' Checkouts, `&tab=context` Cost and
 * `&tab=checklist` Machines;
 * `?usagedata=new` for a new install's first launch, so the usage data note shows (`off` for it turned off, `env` for
 * DO_NOT_TRACK set, `source` for a build from source, which never sends);
 * `?status=incident` or `?status=maintenance` for the provider status pages;
 * `?limit=claude` or `?limit=codex` to put accounts at a limit a reset can refill;
 * `?quota=fail-after-first` to have each account's first limit check work and every later one fail to reach the provider,
 * or `?quota=error` to have one Claude and one Codex account fail to read their limits;
 * `?caps=new` to have Claude report caps Arbor has no fixed label for (a 7-day Omelette window, a Haiku weekly limit);
 * `?pace=ahead` to have the Claude Fable and Codex weekly limits spent well ahead of an even pace;
 * `?reserves=eased` for caps on two accounts: codex-backup up to 50% easing toward each reset (its bars' ticks sit
 * further along than half) and codex-casey up to 80% held flat; `?reserves=paused` also caps claude-max at 50% easing,
 * which Arbor pauses as the page loads (its Sonnet week is past the 71% the cap has eased to), back in under three days
 * rather than at that week's reset;
 * `?codexreset=already`, `nothing` or `none` to have Codex answer a reset as already redeemed, nothing to
 * reset or no credit left; `?codexreset=lost` to lose the first reset's reply after it went through;
 * `?codexreset=clear-fails` to have the core refuse to clear an account's cooldown after a reset;
 * `?model=<id>` for casey-mbp reporting that model identifier and no product name: `Mac16,11` a Mac mini,
 * `Mac15,14` a Mac Studio, `iMac21,1`, `MacPro7,1`, `VirtualMac2,1`, or `Mac99,1` for one Arbor doesn't know (a Mac);
 * `?discover=none` for an Add machine dialog (Settings › Machines, the sidebar's +) that finds nothing in ~/.ssh or on
 * the tailnet, `many` for thirty machines to pick from, or `fail` for the search failing (Try again searches again); by
 * default it offers a few, leaving out ci-01 and cedar-02, which are already added, and lab-box's fills in its host;
 * `?health=down` (ci-01 unreachable for 90s), `?health=down-long` (for 12 minutes; the alert still waits for
 * five minutes of failed checks), `?health=hostkey` or `?health=auth` (ci-01's host key changed, or its login is
 * turned down: alerts once the first minute is up); `?health=pending` for every machine but this Mac not checked yet,
 * as in the first seconds after Arbor starts (a gray dot beside each in the sidebar); `?health=fail` for every read of the machines' health failing
 * (Machines and Sync › Agents say why, and the sidebar lists no machines), `failafter` for reads failing from ten
 * seconds after load (Sync › Agents keeps its table and, at its next read half a minute in, says it may be out of
 * date), or `slow` for each read taking four seconds (Sync › Agents says it's reading);
 * `?machines=unhosted` for no machine with a host yet, so Machines lists them waiting for one and Sync › Agents has
 * no agents to list and offers Add hosts;
 * `?homes=fresh` for no machine looked at for agent homes yet (Settings › Agent homes lists only the standard homes
 * until Look again fills each machine's list), `?homes=fail` for cedar-02's last look failing, and `?homes=none` for
 * looks that found nothing more to suggest;
 * `?phone=fail` to have phone alerts refused, `?phone=unreadable` for a damaged phone alert secrets file;
 * `?proxy=usage-off`, `no-keys`, `default-key`, `refused`, `network` or `not-loaded` (several joined by commas) for the
 * proxy checks finding usage statistics off, no authentication keys, the old default key 123456 still in use, the
 * management API answering 404, the proxy listening on 0.0.0.0, or the proxy not having loaded config.yaml (it
 * couldn't read line 153);
 * `?save=not-loaded` for a settings save that the running proxy doesn't pick up, which then shows in the proxy checks;
 * `?agents=fail` to have agent updates fail;
 * `?duplicate=claude` or `?duplicate=codex` for an older copy of that agent further along casey-mbp's PATH, which
 * Machines lists under it with the one the shell finds first;
 * `?t3compat=broken` for T3 Code's model manifest listing ci-01's Codex as known not to work with it and its Claude
 * Code as unsupported (T3 Code is on ci-01 too, its version unread), so Machines warns about both, or `?t3compat=fail`
 * for the manifest failing to load, which shows no T3 Code warning at all (by default T3 Code is on casey-mbp only, and
 * fine with its agents);
 * `?npm=fail` for npm not answering when the Mac asks for Claude Code's and Codex's latest releases, so Machines and
 * Sync compare each machine's agents with the newest in the fleet instead (by default npm's latest is what an update
 * brings, so ci-01 is behind it; with `?rollout=even` it's newer than every machine);
 * `?install=native`, `brew`, `npm`, `bun`, `pnpm`, `mise` or `unknown` to have every machine's Claude Code and Codex
 * installed that way, so Machines names it and an update shows and runs its command (by default Claude Code is from
 * its own installer and Codex from npm);
 * `?setup=fail` to have ci-01's setup scan fail; `?setup=overrides` for skills Claude Code's skillOverrides turn off or
 * list by name only on this Mac and ci-01, and a T3 Code home whose overrides Claude Code ignores; `?setup=policy` for
 * a managed-settings policy that sets settings, env, a hook and a plugin and turns a skill off on this Mac, one ci-01
 * can't read, and one on cedar-02 whose skill overrides Claude Code ignores; `?setup=shadow` for a T3 Code shadow
 * Codex home on this Mac whose config.toml, AGENTS.md and skills are links into ~/.codex;
 * `?repo=fail` or `?repo=dirty` for a setup repo Arbor can't read, or with changes not committed;
 * `?sync=changed` or `?sync=fail` to have bringing a machine in step refused, or a file fail to write;
 * for the file viewers in Sync's comparisons and the setup sync review (open a differing CLAUDE.md or skill):
 * `?markdown=rich` for casey-mbp's CLAUDE.md with tables, task lists, links, an image, prompt tags and HTML that must
 * never run, and its release-notes SKILL.md with front matter to show as keys and values (Preview); `?diff=far` for
 * casey-mbp's and ci-01's CLAUDE.md too far apart to line up, so the middle shows removed and added whole;
 * `?diff=folded` for those two 260 lines long, a word apart at lines 3, 36 and 250, so the unchanged stretches
 * between fold (26 lines, 207 that open a hundred at a time, and 7 at the end); `?markdown=empty` for ci-01's CLAUDE.md
 * empty, so its Preview says so; `?chunks=slow` to have the viewers take four seconds to load the first time, showing
 * their placeholder, or `?chunks=fail` to have them fail to load, so the viewer says it couldn't show the file;
 * `?skills=changed` or `?skills=fail` to have a change to skills refused, or its last skill fail to change;
 * `?keep=fail` to have keeping a Claude Code home's sessions refused because its settings changed;
 * Sync › Arbor’s changes lists casey-mbp's changes, two settings edits to start with (`?changes=none` for none, which says
 * Arbor hasn't changed anything there, or `?changes=fail` for the list failing to load); the reporter, keeping
 * sessions, telemetry and Codex's MCP servers each add one when they change a file;
 * `?archive=off` (no session archive yet: `/Volumes/Archive/…` is empty, `/Users/…` is empty on this Mac's own disk, a path with
 * `existing` holds another archive, one with `photos` isn't empty), `empty` (just made, nothing kept yet),
 * `catching-up`, `ok` (the default), `missing` (its drive unplugged since yesterday), `foreign` (another archive
 * where it was, for 3 hours), `noowners` (a drive that doesn't enforce permissions), `own-disk` (kept on this Mac's own
 * disk), `error` (failing for 2 hours) or
 * `paused`; `missing`, `foreign` and `error` show the Sessions page's archive banner and, two minutes in, its alert;
 * its Old backups section has one backup imported and one partway, or `?imports=none` for none, `starting` for the
 * second not listed yet, `away` for its drive unplugged, or `failed` for the first finished with 3 files it couldn't
 * read; the other machines' homes are kept too,
 * cedar-02's up to date and casey-mbp's last check failing since yesterday, or `?archiveMachines=none` for no
 * other machines, `new` for ci-01 tried but never reached, or `off` for keeping other machines turned off, or `own` for ci-01 left out on its own;
 * `?archiveProjects=sample` leaves casey/billing out everywhere and casey/arbor out on ci-01 (pick them with `?project=`);
 * Import a backup… finds five homes in
 * `/Volumes/Archive/Codex Backups`, or with `?importPreview=none` nothing, `kept` only homes kept already, `partial` stops
 * looking partway, `fail` has the folder gone, `slow` takes 4s, and `others` OpenClaw and Claude desktop sessions;
 * Usage › All time (`?page=usage&tab=lifetime`) counts a year of the archive's sessions; `?tokens=counting` has files
 * still to count, `?tokens=failed` one that couldn't be read, and `?tokens=waiting` nothing counted yet (as do
 * `?archive=empty`, and `?archive=off`, which has no archive to count from); Claude Code's own count fills in
 * cedar-02's and casey-mbp's days whose transcripts are gone, with mac-mini's older days holding sessions only,
 * or with `?recovered=none` every day has its transcripts;
 * for Settings › Diagnostics (`?page=settings:diagnostics`), `?diagnostics=` picks Arbor's recorded calls to machines
 * and the core: by default a few slow ci-01 health checks, one that couldn't connect and one slow Auth Files read;
 * `ok` for calls with no problems, `empty` for none recorded yet, `slow` for ci-01's health checks mostly slow, a
 * minute-long transcript scan and slow provider calls, `fail` for ci-01 unreachable for the last quarter hour (exit
 * 255 and timeouts), 502s from the core, a failed agent update and a setup scan that ran out of time, or `error` for
 * the calls failing to read. Clear and Undo work on what's shown;
 * `?sources=fail` to have GitHub's limit on checking skills' sources used up;
 * for Sessions › Projects' Checkouts (`?page=sessions&tab=projects&lens=checkouts`):
 * `?projects=fresh` for machines whose projects haven't been scanned (the view scans them), `?projects=none` for scans
 * that found no repos, `?projects=fail` to have cedar-02's projects scan fail, `?projects=partial` for a scan of
 * the Mac that ran out of time; `?worktrees=changed` to have every worktree but the first come back changed when
 * removed, or `?worktrees=fail` to have removing them fail outright;
 * `?nodechange=fail` to have every Node install from a machine's Node cell on the Toolchain tab fail to download;
 * `?toolchain=fresh` for machines whose tools haven't been scanned (the tab scans them), `?toolchain=none` for scans
 * that found no projects, `?toolchain=fail` to have cedar-02's toolchain scan fail, `?toolchain=partial` for a
 * scan of the Mac that ran out of time;
 * `?registry=none`, `?registry=bad`, `?registry=fail` or `?registry=dirty` for a setup repo with no MCP servers file,
 * one Arbor can't read, a repo it can't read, or changes not committed; `?mcpapply=fail` to have Claude Code fail to
 * set a replaced MCP server up again, and Codex's config.toml change fail before it's written;
 * `?skillmachines=sample` for a setup repo keeping pdf off ci-01 and leaving cedar-02 its own frontend-design;
 * `?skillprojects=sample` for skills turned on or off in casey/arbor's checkouts (pdf off, frontend-design on, which
 * only casey-mbp has), or `?skillprojects=seen` for that with cedar-02's worktrees where Git would see a new
 * settings.local.json;
 * `?pluginrepo=sample` for a setup repo listing plugins: agency removed everywhere (ci-01 has it, from its own
 * marketplace), superpowers off on cedar-02, ci-01 keeping its own context7, pr-review-toolkit off everywhere, and a
 * removed plugin cedar-02's settings still name, and Codex plugins: sketch on everywhere (the Mac has it off) and
 * review, which no machine has yet;
 * `?mcpprojects=sample` for MCP servers turned on or off in casey/arbor's checkouts: linear off everywhere, sentry on,
 * which ci-01 has no definition for, cedar-02's checked-in settings deny and one of its worktrees turned off with /mcp;
 * `?projectinstructions=sample` for casey/arbor's own instructions (Sync › Repo): text for every machine and ci-01's own,
 * the Mac's main checkout holding an older text, a Mac worktree with a CLAUDE.local.md of someone's own, and an cedar-02
 * worktree where Git would see a new one;
 * `?machine=new` for cedar-03, a machine just set up that its page's checklist can bring in line (adding one opens
 * its page, and it answers a few seconds after it's saved);
 * `?live=none` for no agent sessions running (updates start without asking), or `?live=ends` for sessions that stop
 * a minute after the page loads, so an update waiting for idle agents goes ahead two minutes after that;
 * `?install=fail` to have core installs fail, `?appupdate=fail` to have Arbor's download fail after it starts, or
 *   `?appupdate=gone` for the update gone from the feed by the time Install runs its fresh check;
 * `?appnotes=none` for an Arbor update whose feed carries no release notes (the pill keeps its plain tooltip), or
 *   `?appnotes=long` for eight releases on offer (0.2.88), more than the pill's card shows, one with a very long line;
 * `?corenotes=none` for a core update without release notes, or `?corenotes=long` for four core releases (v6.8.25),
 *   more than Settings › Updates shows;
 * `?software=fail` to have Settings › Software refuse each change (the switch goes back and says why);
 * `?coresave=fail` to have the core refuse to save its logging, retry and TLS settings (the folded groups on General
 * and Network open by themselves to show why, even when saved from their header while folded);
 * `?coreconfig=defaults` for a core config with every logging, retry and routing setting at its default (no reset
 * buttons, and the folded groups on General and Network show no changes), and `?tls=on` for TLS turned on with a
 * certificate and key (the folded TLS group counts one change);
 * `?collector=error` to have the usage collector report an error (on Settings › Data, and as a banner on Usage, Sessions and Machines).
 * For pull requests (Sessions › Projects, and a session's page): the open ones show every way their checks, reviews
 * and merging can stand (see `mockPullRequestStates`); `?gh=missing`, `?gh=signedOut` or `?gh=failed` for the GitHub
 * CLI not installed, signed out, or failing to ask, so none show a state; `?gh=detailfail` for GitHub turning down the
 * part of the query about checks, reviews and merging, so only whether they merged comes back, with a note saying so.
 * A session's Checks end with Antiburn, installed on casey-mbp: it lists "Add a token bucket" (in ~/.claude) but not the
 * login-loop session (another agent home) or Cedar 01's; `?antiburn=missing` for a Mac without it, which shows no row.
 * `?session=<id>` starts on that session's page, with the Sessions list one step back.
 * `?alerts=sample` to start with a few alerts in the history when it's empty (it's kept in the browser's storage);
 * Sync › Cost (`?page=setup&tab=cost`) has the starting context, then Claude Code's spend over the span picked (a
 * week at first; the pick is kept in the browser's storage): `?context=none` for no sessions to measure, `unplaced`
 * for sessions waiting for a transcript scan to say their home, `grew` for cedar-02's Claude Code starting 9K tokens
 * bigger this week, or `fail` for the measure failing; `?costspend=fail` for Claude Code's spend failing to read;
 * `?telemetry=off` for Claude Code's telemetry receiver turned off, `none` for it on with no machine set up, `quiet`
 * for machines set up that sent nothing in any period (cedar-02 last sent two days ago), `local` for a proxy that
 * only listens on this Mac (setting up another machine is refused), `busy` for a receiver whose port is taken,
 * `cumulative` for cedar-02 sending running totals, `stale` for cedar-02 set up for a port Arbor no longer
 * listens on, or `fail` to have setting a machine up fail to write its first file.
 * `?fileremove=fail` to have taking a rule, subagent or command off every machine fail on changes not committed;
 * `?skillremove=fail` to have taking a skill off every machine in the repo fail on changes not committed;
 * `?leftovers=fail` to have cleaning up plugin leftovers fail as if a settings file changed since the scan;
 * `?hooks=sample` for a setup repo keeping two hooks and their scripts (Sync › Hooks): this Mac's notify differs,
 *   ci-01 keeps notify off and runs an old script the repo hasn't got, and cedar-02 lacks the scripts; `broken`
 *   gives notify a problem, `bad` makes .agents/hooks.json unreadable;
 * `?hookapply=fail` to have bringing a machine's hooks in step fail as if a settings file changed since the scan;
 * `?hooktake=secret` to have taking a machine's hook into the repo refused for a secret in its command;
 * `?codexplugins=fail` to have Codex refuse installing or removing a plugin;
 * `?plugincost=fail` to have measuring cedar-02's plugins fail, or `old` for ci-01's Claude Code too old to say;
 * `?setupchange=1` for a change to ci-01's MCP servers found five seconds after the page loads (an alert), or `many`
 * for five changes at once;
 * Sync › Agents (`?page=setup&tab=agents`) has Agent updates and each machine's versions under it:
 * `?rollout=worse` for Claude Code 2.1.281 failing more than 2.1.270 on its Agent updates, `limits` for it rate
 * limited more, `quiet` for ci-01 sending nothing since 2.1.281 arrived (compared with the hours before), `even` for
 * every machine on the same versions (an update brings 2.1.283 and 0.157.0), or `fail` for the proxy's records failing
 * to read;
 * `?alerts=fire` to send test alerts through notify() two seconds after load: an agent that needs you, a machine
 * down, then that machine alert again, which folds into it (×2) without going out again; `window.__fireAlerts()` sends
 * them again. The history outlives a reload, so within ten minutes of the last send the machine alert only counts up
 * (Clear on the Alerts page empties it); needs-you alerts are never folded, so that one shows every time. With
 * `?window=focused` the app sees its window in front, so they show as toasts; with `?window=unfocused` it sees it in
 * the background, so they go to the Mac as notifications (in `window.__mockLog`). Without either, it's whatever the
 * browser says, and a driven browser often has no focus. The unread count the tray icon would show is logged as
 * `tray_unread`;
 * `?clipboard=fail` to have the clipboard refuse every copy, so copy buttons and the palette's copy actions say they
 * couldn't.
 * For the live fleet board (`get_fleet_sources`): by default T3 Code on casey-mbp has a thread asking for approval
 * (the Claude Code session a3f1…, merged with its reporter wait), one asking a question, a Codex plan ready and one
 * filed away, and a Codex thread is working on cedar-02; the reporters add a Codex session done with its turn and
 * one on cedar-02 not through Arbor, and the proxy a failed Codex run on ci-runner and idle sessions.
 * `?fleet=empty` for nothing on the board, `t3down` for T3 Code's server not running on either machine (its database
 * still says running, so the work reads "last active" and the requests "can't be answered now", and Home's card has
 * more than it lists), `quiet` for cedar-02 not answering for three minutes, `queued` for a message on casey-mbp
 * T3 Code hasn't started a turn for yet ("starting"), `schema` for casey-mbp's database skipped at migration 57,
 * `older` for it at migration 30, `unrecognized` for a database whose migrations don't carry the names Arbor knows,
 * `unreadable` for one that couldn't be read, `nosqlite` for cedar-02 with T3 Code but no sqlite3, `snoozed` for
 * the question and the working Codex thread snoozed on the board (so the tray counts one) and the plan snoozed in T3
 * Code itself, `many` for 40 T3 Code threads across four machines, `fail` for every read failing (the board says so
 * with Retry), or `failafter` for reads failing after the first (the board keeps the last read and says so).
 * `?fleet=not3` for no machine with T3 Code, which hides T3 Code's switch in Settings › Machines and its notice here.
 * Turning T3 Code threads off in Settings › Machines takes T3 Code's threads off the board and shows the notice whose
 * Turn on switches them back; it's logged as `t3_threads_enabled`, and the waiting count the tray icon would show as
 * `tray_waiting`.
 * The Mac's region reads as English (Australia) on a 12-hour clock; `?locale=en-US` (or any BCP 47 tag) changes the
 * region and `?hour=24` (or `?hour=12`) the clock; `?prices=none` leaves every request unpriced, so costs read "unpriced".
 * `?scope=<machine>` opens Settings scoped to that machine, and `?overrides=sample` gives two machines alert values of
 * their own, for Settings' machine scope (src/services/machineSettings.ts); `?project=<owner/name>` (like casey/arbor)
 * scopes it to a project too, and `?overrides=sample` also gives casey/arbor a heavy-session threshold of its own and
 * turns waiting alerts off for acme/proxy on casey-mbp.
 * ⌘Q acts like the app's Quit menu item (a quit is logged, not done); `?quit=armed` shows its warning for 10 seconds.
 * `?chrome=mac` draws the Mac window's title bar (room for the window buttons, top rows drag, and three drawn window
 * buttons at x 16–68, so screenshots show what the sidebar button and the wordmark clear), and
 * `?chrome=mac-fullscreen` starts that window in full screen; `window.__mockFullscreen(true | false)` moves it in or out.
 * ⌘=, ⌘− and ⌘0 act like the app's View menu (Zoom In, Zoom Out, Actual Size), from 83% to 144%, logged as `zoom`;
 * `?zoom=1.2` (any factor) starts at that zoom for this load without saving it, as a level the app saved would. The
 * mock can't zoom its own tab the way WKWebView does: in a same-origin frame of a set size (how screenshots are taken)
 * it scales the frame so the page's CSS width, `vh` and media queries follow, and in a plain tab it uses CSS zoom,
 * where they don't. Nothing is kept across reloads. `?zoomsave=fail` has the settings file refuse every zoom change:
 * Settings › Appearance › Zoom says why under its row, the palette's zoom actions in an error toast, and the menu's keys
 * change nothing (logged as `zoom_failed`), as the app's would.
 * `?art=aurora` or `off` shows that sidebar artwork (or none) for this load without saving it, as Settings ›
 * Appearance › Sidebar artwork does and saves; the canopy is the default. `?color=early-autumn` or `autumn` does the
 * same for Arbor's color (Appearance › Color); Summer is the default.
 * For the sidebar (⌘B, the button fixed at x 90, the drag handle on its edge):
 * `?sidebar=hidden` to start with it hidden, and `?sidebar=wide` or `?sidebar=narrow` to start it at its widest (the
 * window less 640px) or narrowest (208px); it starts at 256px otherwise. They aren't saved themselves, but a change made
 * after is saved along with them. A window under 848px wide hides the sidebar by itself (resize the browser), keeping
 * what's saved, and a narrower window narrows a wide sidebar until it's widened again. There ⌘B opens it over the page,
 * behind a backdrop, and `?sidebar=over` starts it that way in a window loaded under 848px wide.
 * The sidebar's tree badges what needs you from the mock's own data: Accounts an amber dot for codex-casey.json
 * needing a sign-in (signing it in again clears it; `?accounts=none` has none), Machines an amber dot for the degraded
 * machine in the default health readings (red with `?health=down`), and Sync the default scan's problem count. Under
 * Machines it lists the four machines, or with `?machines=many` eighteen, so in a short window (640px tall) the other
 * open groups close from the bottom up and the list scrolls. Which groups are open is kept in the browser's storage
 * (`cpa-gui.sidebar.tree.v1`). Its footer's Core button follows `?core=`, with a Core stopped row and Start for
 * `stopped` or Install for `missing`.
 * For the search palette's actions: `?corecmd=fail` to have starting, stopping and restarting the core fail (Start
 * core on a locked page too);
 * `?pause=fail` to have the core refuse to turn an account off or on (Pause account… and Resume account…, and the
 * Auth Files page's Enable and Disable; a cap Arbor then can't act on is marked on the row and its Usage cap item);
 * the Auth Files rows each show one action for their state and the rest in ⋯, with runtime-gemini's and
 * grok-paid.json's menus saying why items can't be used; `?scan=fail` to have a setup scan fail to start; `?coreconfig=fail` to have the
 * core's settings fail to read, so Copy API key can't read the key (Settings › General can't load them either);
 * `?apikey=none` for a core with no API key (Copy API key has nothing to copy); `?recent=seed` to fill the palette's
 * Recent section with a few picks (a settings page, Pause account…, Sync and the dark appearance) as if they'd been
 * made before; `?account=runtime` to add a Claude sign-in the core holds only in memory, which Pause account… lists
 * grayed out.
 * For Back and Forward (⌘[ and ⌘], the mouse's side buttons, Go back and Go forward in the palette): `?history=back` to
 * start on Machines with steps to go back through (Home, Accounts, Usage's Requests with Failed on, the Sessions list
 * for arbor, the login-loop session, Settings › OAuth), or `?history=both` to start on that session with Settings ›
 * OAuth and Machines still ahead. With `?core=stopped` too, Back and Forward pass over Accounts and OAuth.
 * For the filter bar (the Filters button, its popover, and a chip for each filter that's set): `?filters=usage` to
 * start on Usage's Requests narrowed to casey-mbp and the login-loop session, or `?filters=sessions` to start on the
 * Sessions list narrowed to casey-mbp and the arbor project (so the popover offers arbor's branches). The other
 * filters are the page's own; pick them in the popover to see their chips.
 * For Settings › Extra models (`?page=settings:extra-models`): by default Claude's Haiku 5 is added and served,
 * Anthropic offers Sonnet 5.5 and ChatGPT offers GPT-6-Nova (and a hidden GPT-Reserve), which the proxy doesn't know;
 * `?extraModels=empty` for nothing added and nothing new, `builtIn` for Opus 5.5 added though the proxy has it built
 * in, `notLoaded` for the proxy not having loaded Arbor's model plugin, `checkFails` for Anthropic turning the check
 * down, `codexFails` for ChatGPT doing the same, or `saveFails` for the proxy not loading the plugin after an add (the
 * change is taken back out). With `?core=stopped` the list is only saved, and there's nothing to check with.
 */
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockWindows } from '@tauri-apps/api/mocks';
import { QUIT_GUARD_ARMED_EVENT } from '../services/quitGuard';
import { getAlertHistory, recordAlerts } from '../services/alertHistory';
import { notify, type SystemNotification } from '../services/notify';
import { previewMacTitleBar } from '../services/windowChrome';
import { previewSidebarLayout, SIDEBAR_MIN_WIDTH, sidebarMaxWidth } from '../services/sidebarLayout';
import { isSidebarArt } from '../services/sidebarArt';
import { isAppColor } from '../services/appColor';
import { previewAppPreference } from '../appPreferences';
import { resetViewHistory } from '../services/viewHistory';
import { failedRequestsView, machinesView, mainPageView, sessionsView, settingsPageView, usageView, type AppView } from '../navigation';
import type { Commands } from '../native/commands';
import { mockCommands, type CommandAnswers } from './mock/answers';
import { appAnswers, pressMockQuit, pressMockZoom, startMockZoom } from './mock/app';
import { archiveAnswers } from './mock/archive';
import { coreAnswers, coreScenario, stopCoreLater } from './mock/core';
import { machinesAnswers } from './mock/machines';
import { iso, mockLog, now, params, type Json } from './mock/scenario';
import { MOCK_REPO, setupAnswers } from './mock/setup';
import { setMachineOverride, setScopedOverride, setSettingsProject, setSettingsScope } from '../services/machineSettings';
import { fleetScenario, usageAnswers } from './mock/usage';

const statusScenario = params.get('status') ?? 'ok';
const chromeScenario = params.get('chrome');
let windowFullscreen = chromeScenario === 'mac-fullscreen';
/**
 * The view `?page=` names: a main page's id (with `&tab=` for one of its views), `machine:` and a machine's name for
 * Machines with it opened out, or `settings:` and a Settings page's id.
 */
function mockStartView(page: string | null): AppView | null {
  if (!page) return null;
  const settingsView = page.startsWith('settings:') ? settingsPageView(page.slice('settings:'.length)) : null;
  if (settingsView) return settingsView;
  if (page.startsWith('machine:')) return machinesView(page.slice('machine:'.length));
  return mainPageView(page, params.get('tab'), { lens: params.get('lens') });
}

/**
 * The Mac window's three buttons, drawn where macOS puts them (trafficLightPosition), for `?chrome=mac` screenshots.
 * In points whatever the zoom, as the real ones don't zoom: each size is divided by `--zoom`.
 */
function drawTrafficLights() {
  const lights = document.createElement('div');
  lights.setAttribute('aria-hidden', 'true');
  lights.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;';
  const points = (value: number) => `calc(${value}px / var(--zoom, 1))`;
  ['#ff5f57', '#febc2e', '#28c840'].forEach((color, index) => {
    const light = document.createElement('span');
    light.style.cssText = `position:absolute;top:${points(20)};left:${points(16 + index * 20)};width:${points(12)};height:${points(12)};border-radius:50%;background:${color};box-shadow:inset 0 0 0 0.5px rgb(0 0 0 / 18%)`;
    lights.append(light);
  });
  document.body.append(lights);
}

/** Commands of Tauri's own plugins, which the webview reaches through their APIs. */
const pluginAnswers: Record<string, (args: Json) => unknown> = {
  // The app's own version, the same one the update check reports.
  'plugin:app|version': () => '0.2.80',
  'plugin:dialog|open': (args) => {
    const title = String((args.options as Json | undefined)?.title ?? '');
    if (title.includes('backup')) return '/Volumes/Archive/Codex Backups';
    if (title.includes('archive')) return title.includes('folder for') ? '/Volumes/Archive/arbor-session-archive.noindex' : '/Volumes/Archive/arbor-session-archive-moved.noindex';
    return title.includes('new') ? '/Users/casey/src/new-setup' : MOCK_REPO;
  },
  'plugin:window|is_fullscreen': () => windowFullscreen,
  'plugin:notification|is_permission_granted': () => true,
  'plugin:notification|request_permission': () => 'granted',
  'plugin:notification|notify': (args) => { mockLog('notification', args); return null; },
};

const answers: CommandAnswers<Commands> = { ...appAnswers, ...coreAnswers, ...usageAnswers, ...machinesAnswers, ...setupAnswers, ...archiveAnswers };

// Status page replies, shaped like status.claude.com (Statuspage) and status.openai.com (incident.io's own feed).
const claudeStatusFeed = () => {
  const incident = statusScenario === 'incident';
  const maintenance = statusScenario === 'maintenance';
  const component = (id: string, name: string, status: string) => ({ id, name, status, group: false });
  return {
    status: { indicator: incident ? 'major' : maintenance ? 'maintenance' : 'none', description: incident ? 'Partial System Outage' : 'All Systems Operational' },
    components: [
      component('c-web', 'claude.ai', incident ? 'degraded_performance' : 'operational'),
      component('c-console', 'Claude Console (platform.claude.com)', 'operational'),
      component('c-api', 'Claude API (api.anthropic.com)', incident ? 'partial_outage' : maintenance ? 'under_maintenance' : 'operational'),
      component('c-code', 'Claude Code', incident ? 'degraded_performance' : 'operational'),
    ],
    incidents: incident ? [
      {
        id: 'inc-claude-1', name: 'Elevated errors for multiple models', status: 'investigating', impact: 'major',
        shortlink: 'https://stspg.io/mock-claude', updated_at: iso(-12 * 60_000), components: [{ id: 'c-api' }, { id: 'c-code' }, { id: 'c-web' }],
      },
      { id: 'inc-claude-2', name: 'Issues with Google Play subscriptions', status: 'identified', impact: 'none', updated_at: iso(-3_600_000), components: [] },
    ] : [],
    scheduled_maintenances: maintenance ? [
      { id: 'maint-claude-1', name: 'Scheduled database maintenance', status: 'in_progress', impact: 'maintenance', updated_at: iso(-20 * 60_000), components: [{ id: 'c-api' }] },
    ] : [],
  };
};
const openaiStatusFeed = () => {
  const incident = statusScenario === 'incident';
  const leaf = (id: string, name: string) => ({ component_id: id, name, hidden: false });
  return {
    summary: {
      affected_components: incident ? [{ component_id: 'oai-cli', status: 'degraded_performance' }, { component_id: 'oai-sora', status: 'full_outage' }] : [],
      ongoing_incidents: incident ? [
        {
          id: 'oai-inc-1', name: 'Increased latency in Codex CLI', status: 'identified', current_worst_impact: 'degraded_performance',
          last_update_at: iso(-30 * 60_000), affected_components: [{ component_id: 'oai-cli' }],
        },
        { id: 'oai-inc-2', name: 'Sora video generation unavailable', status: 'investigating', current_worst_impact: 'full_outage', affected_components: [{ component_id: 'oai-sora' }] },
      ] : [],
      scheduled_maintenances: [],
      structure: {
        items: [
          { group: { id: 'g-apis', name: 'APIs', hidden: false, components: [leaf('oai-responses', 'Responses'), leaf('oai-sora', 'Sora')] } },
          { group: { id: 'g-codex', name: 'Codex', hidden: false, components: [leaf('oai-web', 'Codex Web'), leaf('oai-codex-api', 'Codex API'), leaf('oai-cli', 'CLI'), leaf('oai-vscode', 'VS Code extension')] } },
        ],
      },
    },
  };
};
const statusFeeds: Record<string, () => unknown> = {
  'https://status.claude.com/api/v2/summary.json': claudeStatusFeed,
  'https://status.openai.com/proxy/status.openai.com': openaiStatusFeed,
};

class MockNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission() {
    return Promise.resolve<NotificationPermission>('granted');
  }
  constructor(title: string, options?: NotificationOptions) {
    mockLog('notification', { title, body: options?.body });
  }
}

/** Two alerts that open something, then the machine one again: it folds into its entry as ×2 and doesn't go out twice. */
async function fireTestAlerts() {
  const down: SystemNotification = { title: 'ci-01 is unreachable', body: 'No answer to its health checks for 6m.', kind: 'machineDown', urgent: true, subject: { machine: 'ci-01' } };
  await notify([
    {
      title: 'Claude Code needs your permission',
      body: 'arbor · main on casey-mbp',
      kind: 'agentPermission',
      urgent: true,
      subject: { session: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', machine: 'casey-mbp' },
    },
    down,
  ]);
  await notify([down]);
}

/** A morning's worth of alerts, oldest first, so the Alerts page has something to show and clear. */
function seedAlerts() {
  const minutes = 60_000;
  recordAlerts([{
    title: 'Claude is running out early',
    body: '38% of the Claude headline limit is left and usage is ahead of the reset clock.',
    kind: 'limitWarning',
    subject: { provider: 'claude' },
  }], now - 190 * minutes);
  recordAlerts([{ title: 'ci-01 is unreachable', body: 'No answer to its health checks for 6m.', kind: 'machineDown', urgent: true, subject: { machine: 'ci-01' } }], now - 95 * minutes);
  recordAlerts([{ title: 'ci-01 is back', body: 'It answered its health checks again.', kind: 'machineUp', subject: { machine: 'ci-01' } }], now - 80 * minutes);
  recordAlerts([{ title: 'Claude account paused', body: 'work reached its cap of 90% and stays paused until it resets.', kind: 'accountPaused', subject: { account: 'claude-work.json' } }], now - 12 * minutes);
}

export function installTauriMock() {
  // The notification plugin falls back to the Web Notification API outside Tauri; capture it so tests can see it.
  Object.defineProperty(window, 'Notification', { value: MockNotification, configurable: true, writable: true });
  // Answer the status pages locally so the dev shell works offline and can show incidents on demand.
  const realFetch = window.fetch.bind(window);
  // Cast because Bun's types, loaded when tests are type-checked, give `fetch` extras the webview's doesn't have.
  window.fetch = ((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const feed = statusFeeds[url];
    if (!feed) return realFetch(input, init);
    mockLog('status_fetch', url);
    return Promise.resolve(new Response(JSON.stringify(feed()), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof window.fetch;
  // The browser never sees ⌘Q, but a driven one does: run the app's Quit menu item's rule on it.
  window.addEventListener('keydown', (event) => {
    if (!event.metaKey || event.key.toLowerCase() !== 'q') return;
    event.preventDefault();
    pressMockQuit();
  });
  // The View menu's zoom keys, which the app's menu takes before the page sees them. Held from the browser, which
  // would zoom the tab instead.
  window.addEventListener('keydown', (event) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key !== '=' && event.key !== '-' && event.key !== '0') return;
    event.preventDefault();
    pressMockZoom(event.key);
  });
  startMockZoom();
  if (params.get('quit') === 'armed') window.setTimeout(() => void emit(QUIT_GUARD_ARMED_EVENT, { windowMs: 10_000 }), 1_000);
  if (chromeScenario === 'mac' || chromeScenario === 'mac-fullscreen') previewMacTitleBar();
  if (chromeScenario === 'mac') drawTrafficLights();
  const artScenario = params.get('art');
  if (isSidebarArt(artScenario)) previewAppPreference('sidebarArt', artScenario);
  const colorScenario = params.get('color');
  if (isAppColor(colorScenario)) previewAppPreference('appColor', colorScenario);
  // Full screen changes end with a resize, the way macOS reports them.
  (window as Window & { __mockFullscreen?: (fullscreen: boolean) => void }).__mockFullscreen = (fullscreen) => {
    windowFullscreen = fullscreen;
    void emit('tauri://resize', { width: window.innerWidth, height: window.innerHeight });
  };
  const sidebarScenario = params.get('sidebar');
  if (sidebarScenario === 'hidden') previewSidebarLayout({ hidden: true });
  else if (sidebarScenario === 'wide') previewSidebarLayout({ width: sidebarMaxWidth(window.innerWidth) });
  else if (sidebarScenario === 'narrow') previewSidebarLayout({ width: SIDEBAR_MIN_WIDTH });
  else if (sidebarScenario === 'over') previewSidebarLayout({ hidden: false, revealed: true });
  if (params.get('alerts') === 'sample' && !getAlertHistory().entries.length) seedAlerts();
  const windowScenario = params.get('window');
  if (windowScenario === 'focused' || windowScenario === 'unfocused') document.hasFocus = () => windowScenario === 'focused';
  if (params.get('alerts') === 'fire') {
    const fire = () => void fireTestAlerts();
    (window as Window & { __fireAlerts?: () => void }).__fireAlerts = fire;
    window.setTimeout(fire, 2_000);
  }
  if (params.get('clipboard') === 'fail') {
    // Both kinds of write the Clipboard API has, and the copy command copies fall back to.
    const refuse = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: refuse, write: refuse }, configurable: true });
    document.execCommand = () => false;
  }
  if (fleetScenario === 'snoozed') {
    // Snoozed after each began, so neither wakes early: the question for an hour, the Codex work until tonight.
    const snoozedAt = Date.now() - 60_000;
    window.localStorage.setItem('cpa-gui.fleet-snoozes.v1', JSON.stringify({
      't3:casey-mbp:userdata:2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d': { untilMs: Date.now() + 3_600_000, atMs: snoozedAt },
      't3:cedar-02:userdata:6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e': { untilMs: Date.now() + 5 * 3_600_000, atMs: snoozedAt },
    }));
  }
  if (params.get('oldviews') === 'seed') {
    const oldPicks = ['page:main:usage:capacity', 'page:main:usage:analysis', 'page:main:usage:failures', 'page:main:home'];
    window.localStorage.setItem('cpa-gui.palette.recent.v1', JSON.stringify(oldPicks));
    window.localStorage.setItem('cpa-gui.usage-records-tab.v1', 'failures');
  }
  if (params.get('oldviews') === 'sync') {
    const oldPicks = ['page:main:setup:context', 'page:main:setup:projects', 'page:main:usage:telemetry', 'page:main:setup:overview', 'page:main:setup:history'];
    window.localStorage.setItem('cpa-gui.palette.recent.v1', JSON.stringify(oldPicks));
    window.localStorage.setItem('cpa-gui.setup.tab.v1', 'context');
  }
  const reservesScenario = params.get('reserves');
  if (reservesScenario === 'eased' || reservesScenario === 'paused') {
    window.localStorage.setItem('cpa-gui.account-reserves.v1', JSON.stringify({
      caps: { 'codex-backup.json::codex-3': 50, 'codex-casey.json::codex-1': 80, ...(reservesScenario === 'paused' ? { 'claude-max.json::claude-1': 50 } : {}) },
      easing: { 'codex-backup.json::codex-3': true, ...(reservesScenario === 'paused' ? { 'claude-max.json::claude-1': true } : {}) },
      paused: {},
      skipUntil: {},
    }));
  }
  if (params.get('recent') === 'seed') {
    window.localStorage.setItem('cpa-gui.palette.recent.v1', JSON.stringify(['page:settings:auth-files', 'action:pause-account', 'page:main:setup', 'action:theme-dark']));
  }
  const historyScenario = params.get('history');
  if (historyScenario === 'back' || historyScenario === 'both') {
    const steps: AppView[] = [
      { kind: 'main', page: 'home' },
      { kind: 'main', page: 'accounts' },
      failedRequestsView(),
      sessionsView({ tab: 'sessions', project: 'arbor' }),
      sessionsView({ tab: 'sessions', project: 'arbor', session: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7' }),
      { kind: 'settings', page: 'appearance' },
      { kind: 'main', page: 'machines' },
    ];
    resetViewHistory({ entries: steps, index: historyScenario === 'both' ? 4 : steps.length - 1 });
  }
  const sessionScenario = params.get('session');
  if (sessionScenario) resetViewHistory({ entries: [sessionsView({ tab: 'sessions' }), sessionsView({ tab: 'sessions', session: sessionScenario })], index: 1 });
  const filtersScenario = params.get('filters');
  if (filtersScenario === 'usage' || filtersScenario === 'sessions') {
    const view = filtersScenario === 'usage'
      ? usageView({ tab: 'events', machine: 'casey-mbp', session: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7' })
      : sessionsView({ tab: 'sessions', machine: 'casey-mbp', project: 'arbor' });
    resetViewHistory({ entries: [view], index: 0 });
  }
  if (coreScenario === 'stops') stopCoreLater();
  const scopeScenario = params.get('scope');
  if (scopeScenario) setSettingsScope(scopeScenario);
  const projectScenario = params.get('project');
  if (projectScenario) setSettingsProject(projectScenario);
  if (params.get('overrides') === 'sample') {
    setMachineOverride('cedar-02', 'heavySessionTokens', 500_000_000);
    setMachineOverride('cedar-02', 'agentWaitingAlerts', false);
    setMachineOverride('ci-01', 'agentWaitingAlerts', false);
    setMachineOverride('ci-01', 'machineNotifications', false);
    setScopedOverride({ project: 'casey/arbor', machine: null }, 'heavySessionTokens', 250_000_000);
    setScopedOverride({ project: 'acme/proxy', machine: 'casey-mbp' }, 'agentWaitingAlerts', false);
  }
  const startPage = mockStartView(params.get('page'));
  if (startPage) resetViewHistory({ entries: [{ kind: 'main', page: 'home' }, startPage], index: 1 });
  clearMocks();
  mockWindows('main');
  mockCommands(answers, { plugins: (command, args) => pluginAnswers[command]?.(args) ?? null, delayMs: 60, events: true });
}
