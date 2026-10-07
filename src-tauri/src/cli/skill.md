---
name: arbor
description: Read and manage Arbor, the app that shares this person's agent accounts through a local proxy, from the command line. Use when asked about the proxy, account limits, caps or routing, machine health, live or recent agent sessions, usage and cost, alerts, keeping machines in line with the setup repo (Sync), the session archive, or Arbor's settings.
---

# Arbor from the command line

`arbor` talks to the Arbor app running on this Mac over a private socket. Every change goes through the app the
same way its window makes it, so the window shows it straight away. It only works on the Mac where Arbor runs; on
any other machine, say so instead of trying.

## Start here

- `arbor doctor` checks that Arbor is reachable. Exit 69 means Arbor isn't running or isn't answering.
- `arbor status` gives the proxy, machines, live sessions, unread alerts and accounts that are off or nearly out.
- `arbor help` lists every command; `arbor help <command>` explains one with examples.
- Add `--json` to any command to get Arbor's answer as JSON. Use it whenever you need to read values rather than
  show them.

## Reading

| Ask | Command |
| --- | --- |
| Machine health | `arbor machines`, or `arbor machines <name>` for one in full |
| A machine's readings over more than the last hour (CPU, memory, disk, swap, load, temperatures, network, agent sessions), one value a bucket, null where nothing was read | `arbor call get_machine_history machine=<name> windowMs=86400000` (up to 90 days) |
| Machine pools and who would take each one's next run | `arbor pools` |
| Sessions started on pools, and how each went | `arbor pools recent`, or `arbor pools recent <pool>` |
| Connect to a pool over SSH | `ssh arbor-<pool>`, once its page in Arbor says it's ready; `arbor pools connect` is that host's ProxyCommand, not something to run yourself. Each host name stays on its first machine; `arbor call forget_pool_ssh_name --args '{"poolId":"<id>","name":"<host>"}'` lets it pick again |
| Sessions | `arbor sessions` (recent), `arbor sessions --live` (running now, with cost per hour) |
| Sessions that used a lot of tokens lately, as Arbor's heavy-session alert sees them | `arbor call get_heavy_sessions start=<ISO time> minTokens=<tokens>` |
| Usage and cost | `arbor usage today`, `arbor usage 7d`, `arbor usage 30d` |
| Accounts and limits | `arbor accounts`, or `arbor accounts refresh` to read the limits again |
| Automatic account order | `arbor routing` |
| The models one sign-in keeps from its account, or an Antigravity sign-in's project id (by its file name in Accounts › Sign-ins; the file itself is never shown) | `arbor call get_auth_file_excluded_models name=<file>.json`, `arbor call get_auth_file_project_id name=<file>.json` |
| Alerts | `arbor alerts` |
| Where each machine stands against the setup repo: in step, or behind on files, skills, MCP servers, hooks, plugins or projects (the same count as Sync › Overview and the sidebar) | `arbor sync`, then `arbor sync <machine>` for the files and skills that would change there; `arbor call get_sync_standing repo=<setup repo folder>` lists each item behind |
| Where the setup repo's projects are on each machine (its projects/ folder): in place, linked, elsewhere, missing or blocked | `arbor call get_project_drift repo=<setup repo folder>`; `arbor call scan_projects machine=<name> repo=<folder>` looks again |
| Proxy core | `arbor core` |
| Session archive | `arbor archive` |
| Scheduled automations, Arbor's, other apps' and schedules made in ultradian by hand (`ultradian:<machine>:<name>`) | `arbor call list_automations`, then `arbor call get_automation id=<id>` and `arbor call list_automation_runs id=<id>` (an ultradian schedule's runs are read from its machine) |
| Saved settings | `arbor settings`, `arbor settings get <name>` |
| What could come off a machine: agent homes, agents and how each was installed, startup items whose program is gone, the agents' logs and caches, with sizes; how many of each home's session files the session archive holds (`archive`); and what's set aside there | `arbor call check_machine_cleanup machine=<name>` (looks again, read-only); `arbor call get_machine_cleanup machine=<name>` gives the last look without one |

Machines can be named by their name or their SSH host, in any case (`cedar-dev-01` finds "Cedar dev 01"). Accounts
are named by the short id in the first column of `arbor accounts` (like `a6bd830`), since their names are partly
hidden.

## Changing things

Changes Arbor would confirm in its window (stopping or restarting the proxy, pausing an account, applying Sync,
installing a core, marking alerts seen, removing things) don't happen on the first try. The command prints what it
would do and exits 10. Then:

1. Show the person that plan, in plain words.
2. Run the same command again with `--yes` only once they've agreed to it. Never add `--yes` on your own.

Other changes (a cap, routing on or off, a saved setting) happen straight away; still only make them when asked.

| Change | Command |
| --- | --- |
| Pause or resume an account | `arbor accounts pause <id>`, `arbor accounts resume <id>` |
| Cap an account at a percent of its limits, or clear it | `arbor accounts cap <id> 50`, `arbor accounts cap <id> off` |
| Automatic account order for a provider | `arbor routing claude on`, `arbor routing codex off` |
| Bring a machine in line with the setup repo | `arbor sync apply <machine>` (backed up first; undo it in Sync › Repo › History) |
| Keep a project with no remote (projects/_local/<name>) in step across machines through the hub on this Mac | `arbor call sync_local_project repo=<setup repo folder> project=_local/<name>`; then each checkout can fast-forward to `arbor/<branch>` |
| Put the schemas for machine and project files in the setup repo, each as a commit | `arbor call add_setup_schemas repo=<setup repo folder>` |
| Put a project where the setup repo wants it on a machine: link, clone, move, fast-forward or fetch | `arbor call apply_project_fixes repo=<folder> machine=<name> --args '{"fixes":[{"project":"owner/name","fix":"link"}]}'` (needs `--yes`; backed up, undo it in Sync › Repo › History) |
| Proxy core | `arbor core start`, `arbor core stop`, `arbor core restart`, `arbor core install [version]` |
| Mark every alert seen | `arbor alerts seen` |
| Pause or resume an automation | `arbor call set_automation_enabled id=<id> enabled=false` (or `true`) |
| Run an automation now, precheck first | `arbor call run_automation_now id=<id>` |
| Copy another app's automation into Arbor, paused | `arbor call copy_automation_into_arbor id=<id> pauseOriginal=false` (`true` pauses the original too). One whose schedule Arbor can't read, as a Claude scheduled task's, is refused rather than given a made-up one: ask the person for a schedule and make it with `save_automation` |
| Set up or update the background runner on a machine, so its automations run with Arbor closed; also puts ultradian's skill in that machine's agent homes | `arbor call install_background_runner machine=<name>` (needs `--yes`) |
| Put Grove's health probe on a machine, or update it, so its readings stream every two seconds instead of one SSH read a round; started under launchd or a systemd user unit there | `arbor call install_machine_probe machine=<name>` (needs `--yes`); `arbor call get_machine_probes` says which machines have one and are streaming |
| Take a machine's health probe off it, with its folder (the history Arbor kept stays) | `arbor call uninstall_machine_probe machine=<name>` (needs `--yes`) |
| Give automations their proxy key (Claude and Codex automations reach the proxy with it, whatever a machine is signed in to) | `arbor call add_automations_key` (needs `--yes`) |
| Clear Settings › Diagnostics' list of Arbor's calls to machines and the core, or only one machine's | `arbor call clear_call_diagnostics` (add `machine=<name>` for one; needs `--yes`). `undo_clear_call_diagnostics` with the `clearedAtMs`, `previousClearedAtMs` and `machine` it returned brings them back |
| Set the address machines try first to reach the proxy, or clear it | `arbor call set_automation_proxy_address address=<url>` (`address=` clears it) |
| Put kept sessions back together from the session archive, one folder per session with its transcripts and a session.json naming its machine, project and branch | `arbor archive export --project <name> --since 30d --out <new or empty folder>` (also `--machine <name>`, `--since 2026-09-01`, `--all-versions`). The folder holds whole transcripts, unencrypted: only export when asked, to where they asked |
| Set things on a machine aside, from its last clean-up look: an agent home, a log or cache folder, or a leftover startup item | `arbor call remove_cleanup_items machine=<name> --args '{"items":[{"group":"cache","path":"~/.claude/debug"}]}'` (needs `--yes`; moved into a set-aside folder on that machine, not deleted, and refused when anything changed since the look; undo it with `restore_set_aside` or in Sync › Repo › History). A home whose session files aren't all archived is refused unless the args add `"allowUnarchived":true`: tell the person how many aren't archived first, and that an agent still running from an active home makes a new one |
| Take an agent's install off a machine, from its last clean-up look (`agents`, by `path`) | `arbor call uninstall_cleanup_agent machine=<name> path=<path as listed>` (needs `--yes`). Its own installer's copy (`removal` native) is set aside with Undo; a package manager's (`packageManager`) runs the `command` listed, which can't be undone, so show the person that exact command first, and say when it's the machine's only Claude Code or Codex and the machine is in a pool (`routed`). An `unknown` one is refused: the person removes it the way they installed it |
| Put something set aside back, or delete it for good | `arbor call restore_set_aside machine=<name> stamp=<stamp>` (add `item=<n>` for one); `arbor call delete_set_aside machine=<name> --args '{"items":[{"stamp":"<stamp>","item":0}]}'` (both need `--yes`; deleting can't be undone, so only when the person asks for it) |
| Start a session on whichever pool member has room and the repository | `arbor pools start <pool> --repo <owner/name> --agent claude --prompt "…"` (asks first). It works in its own worktree off the default branch, in Orca there, or add `--cli` for the agent's own command line (and `--model`). `--folder <path>` instead of `--repo`; `--prompt -` reads stdin. Over MCP it's the `start_pool_run` tool |

Stopping or restarting the proxy cuts off every agent using it for a moment, on every machine. Say so when you show
the plan.

## Cleaning up a machine

What could come off a machine, and taking it off, are the same flow as its page's Clean up section. Nothing is deleted:
things are set aside on the machine and can be put back, apart from a package manager's uninstall and Delete for good.

1. Look: `arbor call check_machine_cleanup machine=cam-mbp --json`. It lists `homes` (with `archive`: how many session
   files the session archive holds), `agents` (with `removal` and `command`), `leftovers`, `caches` and `aside`.
2. Set something aside: `arbor call remove_cleanup_items machine=cam-mbp --args '{"items":[{"group":"cache","path":"~/.claude/debug"}]}' --yes`.
   A home whose session files aren't all archived also needs `"allowUnarchived":true`; say how many first.
3. Take an agent off: `arbor call uninstall_cleanup_agent machine=cam-mbp path=/opt/homebrew/bin/codex --yes`, after
   showing the person the `command` it runs.
4. Put it back: `arbor call restore_set_aside machine=cam-mbp stamp=<stamp> --yes`, or delete it for good with
   `delete_set_aside` only when asked.

## Anything else

`arbor commands [filter]` lists every command the app has, with its arguments and whether it reads, changes or asks
first. Call one with `arbor call <command> name=value …` (values are read as JSON when they can be, or pass
`--args '{…}'`). The same `--yes` rule applies.

`arbor watch [event…]` prints the app's events as they happen, until stopped.

## Exit codes

0 done, 1 failed (the message says why, including when changes from the command line are turned off in Arbor's
Settings › App › Command line), 2 the command was used wrongly, 10 needs `--yes`, 69 Arbor isn't running or
answering (or the command line is turned off there), 76 `arbor` and the app are different versions, 77 the socket
belongs to another user.

## What arbor never does

It can't claim or spend resets, reach the proxy's raw management API, read an account's credential file, or show
secrets: keys and tokens come back as `[hidden]`. Don't try to work around any of that.
