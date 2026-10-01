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
| Sessions | `arbor sessions` (recent), `arbor sessions --live` (running now, with cost per hour) |
| Usage and cost | `arbor usage today`, `arbor usage 7d`, `arbor usage 30d` |
| Accounts and limits | `arbor accounts`, or `arbor accounts refresh` to read the limits again |
| Automatic account order | `arbor routing` |
| Alerts | `arbor alerts` |
| How far machines are from the setup repo | `arbor sync`, then `arbor sync <machine>` for what would change there |
| Proxy core | `arbor core` |
| Session archive | `arbor archive` |
| Saved settings | `arbor settings`, `arbor settings get <name>` |

Machines can be named by their name or their SSH host, in any case (`eden-dev-01` finds "Eden dev 01"). Accounts
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
| Bring a machine in line with the setup repo | `arbor sync apply <machine>` (backed up first; undo it in Sync › Arbor's changes) |
| Proxy core | `arbor core start`, `arbor core stop`, `arbor core restart`, `arbor core install [version]` |
| Mark every alert seen | `arbor alerts seen` |

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
