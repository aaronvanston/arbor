# Machines

Arbor reaches every machine other than this Mac over SSH, using the hosts in the user's own `~/.ssh` config. It never
reads keys. Linux machines count as much as Macs.

## Running a script

Every script on a machine goes through `usage/machine_health/shell.rs`: `find_machine`, then `run_checked` (or
`run_on_machine` for a script that reports each item itself, or `run_streaming`, with slots of its own, for output too
big to hold). It caps how many run at once and notes each run in Diagnostics, so never build SSH commands or take its
slots anywhere else.

## Health readings

Machine health comes from Grove (`usage/machine_health/grove.rs`), which Arbor carries pinned in `grove-version.txt`
and runs on this Mac with its own `GROVE_HOME` in Arbor's data folder. Arbor's machine list is the source of truth:
each hosts reload reconciles Grove's registry to it under slug names (`normalize_machine_name`), and the names people
see stay in Arbor. A machine that keeps a probe in Grove's registry is never removed from it, so a removal that's
undone keeps its probe. A machine with a probe is followed by a long-lived `grove stream <slug> --jsonl`, up to
`MAX_STREAMS`, an allowance of their own: they never take a script slot. Every other machine gets one `grove sample` a
round, which does hold a slot (`shell::run_in_slot`) and lands in Diagnostics. Grove's SSH runs ride Arbor's control
sockets through `GROVE_SSH_COMMAND`. The round itself, pings, Tailscale paths, discovery and agent versions stay in
Arbor; a machine read by `grove sample` takes its round trip and address from Grove's ping instead. When Grove is
missing or answers as another version, the sampler falls back to its own script (`SAMPLE_SCRIPT`) for one release,
then to a reachability check (`LEGACY_SAMPLER`).

## Changing a file

Every change to a file on a machine goes through `usage/machine_health/guarded_writes.rs` (`edit_start`, `edit_call`
for each file, `edit_finish`). It writes only while the file is still as Arbor read it, backs it up first in
`~/.arbor/setup-backups`, and lands on Sync › Repo › History, the one list where any of them can be undone.

## Taking things off a machine

The machine page's Clean up (`usage/machine_health/cleanup.rs`) never deletes what it removes: it moves it into
`~/.arbor/set-aside/<stamp>/`, or into `.arbor-set-aside/<stamp>/` at the top of the item's own drive so the move is a
rename and never a copy. That area is apart from `setup-backups` on purpose: backups are pruned to the newest 20, and
nothing set aside may ever go except by the user's Delete for good. A pointer with the same stamp in `setup-backups`
lists the removal on Sync › Repo › History, and Delete for good notes each item there so Undo stops offering it; pruning the pointer only drops it from that list. Which harness folders count as
clearable is `harnesses::CLEARABLE`, each with the reason it's safe. A home Arbor reads sessions from is asked of the
archive (`archive/standing.rs`, counts only) at the look and again at Remove, which needs `allowUnarchived` when not
every session file is safely in a store. Agents come off only the way their install's layout proves they were made
(`agent_install::uninstall_plan`), proven again on the machine before the package manager runs, and never through a
package manager found some other way: their own installer's copy is set aside like a folder. Removing from Settings › Agent homes or Sync's Other agents runs
the same flow (`pages/cleanupActions.tsx`), looking at the machine first when its last look is over ten minutes old.

## Agent homes

Which folders are a machine's agent homes comes only from `usage/machine_health/agent_homes.rs`: the standard Claude
Code, Codex and Pi homes, the ones a scan found and the ones added in Settings › Agent homes, each with a Sessions and a
Sync switch. Every script that looks in an agent home loops over its generated `agent_homes` shell function
(`shell_function`) instead of naming folders of its own. `harnesses.rs` knows each coding agent's homes, files and how
to start it.

A harness besides Claude Code and Codex stays out of sight until some machine has it: it counts as found once a
machine's last setup scan saw its command or its home (`setup::harnesses_found`, `harnesses::is_found`). Scans are held
in memory, so after a restart only Claude Code and Codex count until they land. Its standard homes stay on the list so
the scans keep looking, but Settings › Agent homes hides them, and the automation pickers and the drafting model don't
offer it; only Settings › Harnesses' reference table lists the whole catalog. A new list of harnesses filters the same
way.

## Automations

`usage/machine_health/automations/`:

- `discover.rs` finds other apps' automations on each machine, held in memory and never saved, through one module per
  app in `apps/` (the Codex app, Claude's scheduled tasks, Orca, Superset): its part of the scan, how its lines read,
  what it can be asked to do. A new app is a module there plus an entry in `AUTOMATION_APPS`
  (`src/services/automations.ts`).
- `runner.rs` runs Arbor's own while the app is open: a precheck over SSH, then the agent detached, its output never
  kept. `draft.rs` drafts one from a sentence through the local proxy.
- One aimed at a pool gets its machine from `runs::pick_for_automation` when it's due.
- One set to run on its machine goes to `udian.rs`: Arbor installs the ultradian runner it carries (pinned in
  `udian-version.txt`, fetched into `bundled-udian/` with the release's `SKILL.md` by the release build), writes the
  schedule and scripts there and reads the runs back, so it runs with Arbor closed. Installing it also puts that
  skill in the machine's agent homes, through the same guarded write as Arbor's own CLI skill (`cli_skill.rs`).
- Schedules someone made in ultradian themselves are the `ultradian` app (`apps/ultradian.rs`); Arbor's own are told
  apart by their `arbor-` name or `arbor` group. They run a command, not a prompt, so a run links to a session only
  by the `agent_session_id` ultradian (0.4 on) records when the command used its id or reported one; Arbor never
  guesses. Their runs are asked of the machine when their page opens (`udian logs <name>` without `--run`) and never
  stored. A newer runner on a machine is never replaced by the one Arbor carries: 0.4 moves the database on one way.
- ultradian's run logs stay on the machine and Arbor never reads them. "Terminal" on a run opens a window on this Mac
  that resumes a run's session over SSH, or shows the log (`udian logs --run`) of one without (`fix_session.rs`): the user
  reads it there, and nothing of it comes back to Arbor.

## Pools

`pools.rs` holds a pool's members, weights, limits and what a full pool does (refuse, queue or spill). `runs.rs` starts
a run on one and `runs_handoff.rs` hands it to T3 Code or Orca on the member picked, with the agent's own command line
as the last resort. Arbor keeps where a run went, never its prompt.

`pool_ssh.rs` makes each pool an SSH host, `ssh arbor-<pool>`. Arbor's `~/.arbor/ssh/pools.conf` runs
`arbor pools connect` as the host's ProxyCommand, which asks the app for a member over the socket (`pools.connect`) and
carries the bytes.

- A host name stays pinned (in usage.db) to the member its first connection went to, until that member is off, removed
  or not answering, or the name is forgotten on the pool's page.
- This Mac is never picked: the ProxyCommand runs here and would connect an app to itself.
- Host keys come only from the user's known_hosts, never a scan.
- `~/.ssh/config` gets its one Include line only through a guarded write.
