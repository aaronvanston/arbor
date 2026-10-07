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
| Machine pools and who would take each one's next run | `arbor pools` |
| Sessions started on pools, and how each went | `arbor pools recent`, or `arbor pools recent <pool>` |
| Connect to a pool over SSH | `ssh arbor-<pool>`, once its page in Arbor says it's ready; `arbor pools connect` is that host's ProxyCommand, not something to run yourself. Each host name stays on its first machine; `arbor call forget_pool_ssh_name --args '{"poolId":"<id>","name":"<host>"}'` lets it pick again |
| Sessions | `arbor sessions` (recent), `arbor sessions --live` (running now, with cost per hour) |
| Sessions that used a lot of tokens lately, as Arbor's heavy-session alert sees them | `arbor call get_heavy_sessions start=<ISO time> minTokens=<tokens>` |
| Usage and cost | `arbor usage today`, `arbor usage 7d`, `arbor usage 30d` |
| Accounts and limits | `arbor accounts`, or `arbor accounts refresh` to read the limits again |
| Automatic account order | `arbor routing` |
| Alerts | `arbor alerts` |
| How far machines are from the setup repo | `arbor sync`, then `arbor sync <machine>` for what would change there |
| Where the setup repo's projects are on each machine (its projects/ folder): in place, linked, elsewhere, missing or blocked | `arbor call get_project_drift repo=<setup repo folder>`; `arbor call scan_projects machine=<name> repo=<folder>` looks again |
| Proxy core | `arbor core` |
| Session archive | `arbor archive` |
| Scheduled automations, Arbor's, other apps' and schedules made in ultradian by hand (`ultradian:<machine>:<name>`) | `arbor call list_automations`, then `arbor call get_automation id=<id>` and `arbor call list_automation_runs id=<id>` (an ultradian schedule's runs are read from its machine) |
| Saved settings | `arbor settings`, `arbor settings get <name>` |

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
| Set up or update the background runner on a machine, so its automations run with Arbor closed; also puts ultradian's skill in that machine's agent homes | `arbor call install_background_runner machine=<name>` (needs `--yes`) |
| Give automations their proxy key (Claude and Codex automations reach the proxy with it, whatever a machine is signed in to) | `arbor call add_automations_key` (needs `--yes`) |
| Set the address machines try first to reach the proxy, or clear it | `arbor call set_automation_proxy_address address=<url>` (`address=` clears it) |
| Put kept sessions back together from the session archive, one folder per session with its transcripts and a session.json naming its machine, project and branch | `arbor archive export --project <name> --since 30d --out <new or empty folder>` (also `--machine <name>`, `--since 2026-09-01`, `--all-versions`). The folder holds whole transcripts, unencrypted: only export when asked, to where they asked |
| Start a session on whichever pool member has room and the repository | `arbor pools start <pool> --repo <owner/name> --agent claude --prompt "…"` (asks first). It works in its own worktree off the default branch, in Orca there, or add `--cli` for the agent's own command line (and `--model`). `--folder <path>` instead of `--repo`; `--prompt -` reads stdin. Over MCP it's the `start_pool_run` tool |

Stopping or restarting the proxy cuts off every agent using it for a moment, on every machine. Say so when you show
the plan.

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

It can't claim or spend resets, reach the proxy's raw management API, or show secrets: keys and tokens come back as
`[hidden]`. Don't try to work around any of that.
