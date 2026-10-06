# Projects and machines in the setup repo

The setup repo has three layers on top of its global `.claude/ .codex/ .agents/` files: a file per machine, a folder
per project, and a project's settings on one machine. Arbor reads them straight from the repo's HEAD, the same way it
reads everything else there. No script compiles them into anything. Sync compares them with each machine's scan and
fixes the differences through the usual plan, backup, apply and Undo.

The aim is that a project sits at the same path on every machine it's on, set up the same way. That way the user can
move to another machine for a project and find it where they left it.

## Layout

```
machines/<machine>.json               one machine: SSH host, role, code root, its own skill/plugin/MCP values
machines/_archive/<machine>.json
projects/<owner>/<name>/project.json  remote, path, branch, which machines, the project's skill/plugin/MCP values
projects/<owner>/<name>/instructions.md        instructions every checkout gets (CLAUDE.local.md, AGENTS.override.md)
projects/<owner>/<name>/machines/<machine>.md  instructions for that project on one machine instead
projects/<owner>/<name>/skills/<skill>/        skills only that project's checkouts get
projects/_local/<name>/…              a project with no remote
projects/_archive/<owner>/<name>/…    an archived project; _archive/_local/<name> for a local one
schema/machine.schema.json, schema/project.schema.json
```

**Why the layout is shaped this way**

- **`<owner>/<name>` folders.** The folder path is the project's identity, the same lowercase `owner/name` key the rest
  of Sync already uses. It mirrors the default checkout path, so two repos with the same name can't collide. GitHub
  owners can't start with `_`, so `_local` and `_archive` can never clash with a real owner.
- **Machine file names.** A machine file is matched to Arbor's machine name the loose way
  (`normalize_machine_name`), so `eden-dev-01.json` is "Eden dev 01".
- **`.agents/projects/<owner>/<name>/`.** It held project instructions before. It's still read, and the new folder wins
  wherever both exist.
- **`schema/`.** The schemas are Arbor's, embedded in the app. Arbor writes them into the repo when it creates the
  first machine or project file, and again whenever a newer app ships a newer schema. They exist for editors; Arbor
  validates with its own parser and reports problems on Sync rather than refusing the repo.

## Files

```jsonc
// machines/eden-dev-01.json
{
  "$schema": "../schema/machine.schema.json",
  "name": "Eden dev 01",          // display name; the file name is the key
  "host": "eden-dev-01",          // SSH host. Arbor offers to add it when it has no host by that name
  "role": "devbox",               // free label; projects can be assigned to "@devbox"
  "codeRoot": "~/code",           // where projects go on this machine (default ~/code)
  "skills":  { "pdf": "off" },    // this machine's own values: on | off | own | removed, as in .agents/*.json
  "plugins": { "codex@openai-codex": "off" },
  "mcp":     { "linear": "off" }
}

// projects/buildpass-au/ledger/project.json
{
  "$schema": "../../../schema/project.schema.json",
  "remote": "git@github.com:buildpass-au/ledger.git",   // cloned as written; identity is host/owner/name
  "path": "~/code/buildpass-au/ledger",                 // optional; default <codeRoot>/<owner>/<name>
  "branch": "main",                                     // optional; default origin/HEAD
  "machines": {                                         // or "all"
    "@devbox": {},
    "mac-mini": { "path": "~/src/ledger", "skills": { "pdf": "off" } }
  },
  "skills":  { "grill-me": "off" },
  "mcp":     { "linear": "on" },
  "plugins": {}
}

// projects/_local/idler/project.json
{ "local": true, "machines": { "mac-mini": {} } }       // path default <codeRoot>/_local/<name>
```

- **The repo describes and Arbor connects.** Arbor's own host list (usage.db) is still what it connects with. The
  repo's `host` only seeds that list, and only with the user's yes. A repo shouldn't be able to point Arbor at a new
  SSH target by itself.
- **Assignment lives on the project.** `machines` holds assignment and project-on-machine values in one object, because
  the user thinks project first ("where is Ledger?"). A key is a machine name, `@role` or `all`. `all` means every
  machine Arbor watches that isn't archived in the repo. Where a machine is named both directly and through a role, the
  direct entry wins.
- **Layer order: global → machine → project → project-on-machine.** The later layer wins. Global values stay in
  `.agents/machines.json`, `plugins.json` and `mcp-servers.json` as `all`.
- **Old project and machine values are still read.** Values in `skills.X.machines`, `skills.X.projects`,
  `plugins.X.projects` and `mcp.X.projects` count as the machine and project layers, but a value in a machine or
  project file wins over them. Arbor's writers put values in the new files, and move a value across (in the same
  commit) the first time they touch it.
- **Paths.** A path is `~/…` or absolute, never with `..`. `~` is the machine's home from its scan. A project-on-machine
  path beats the project's path, which beats `<codeRoot>/<owner>/<name>`.

## On each machine

For each machine and each project assigned to it, Arbor works out the wanted path and compares it with what's there.
The scan reads the wanted paths as well as the ones sessions point at, and for each one records whether it's a link,
where it leads, and which repo it is.

| State | Meaning | Fixes |
|---|---|---|
| in place | the wanted path is a checkout of this project | — |
| linked | the wanted path is a link to a checkout of this project | — (Move when safe) |
| elsewhere | a checkout exists, but not at the wanted path, and the path is free | **Link**, Move when safe |
| missing | no checkout on the machine | **Clone** (from the hub for a local one) |
| blocked | something else is at the wanted path | none; say what's there |
| behind | main checkout on the default branch, behind its upstream | **Fast-forward** when clean |
| stale | the last fetch failed (a day without one is only shown) | Fetch |
| not assigned | a checkout on a machine the project doesn't list | Assign here (a repo change) |

**Decisions about fixing**

- **Link first, move only when it's safe.** Moving a checkout breaks everything that remembers its path: linked
  worktrees, T3 Code and Orca projects, editors, dirty work.
  - A link at the wanted path costs nothing and makes the path work today.
  - Move is offered only when the checkout is clean, has no linked worktrees and isn't open. It runs
    `git worktree repair` and leaves a link at the old path.
  - Neither is ever automatic.
- **One checkout per machine counts.** Which one counts:
  - the one the wanted path resolves to;
  - otherwise the one Arbor would link, the most recently used.

  The others are listed as other checkouts. They're never moved, removed or counted as drift, but project skills and
  instructions still go to them, so an agent behaves the same in any copy.
- **Fresh without risk.** Arbor fetches assigned checkouts in the background (only `refs/remotes` change). Fast-forward
  is a plan step:
  - only for the main checkout;
  - only on the default branch;
  - only when it's clean;
  - only with `--ff-only`.

  Other branches and worktrees are never touched.
- **Clone** runs on the machine itself with the machine's own git credentials, non-interactive (`BatchMode=yes`,
  `GIT_TERMINAL_PROMPT=0`). A machine that can't reach the remote reports why. Nothing is copied from this Mac.
- **Archive means off the record, not off the disk.** An archived machine or project gets no plans, fetches, skills or
  drift. Its checkouts stay where they are, and it's listed under Archived with where it was last seen. Removing a
  checkout stays the explicit worktree-removal flow on Sessions › Projects › Checkouts.
- **Every fix is undoable from Repo › History.** Each one is backed up on the machine like any other change
  (`ChangeKind::Projects`):

  | Fix | Undo |
  |---|---|
  | Link | removes the link, if it's still the one Arbor made |
  | Move | moves the checkout back, if it's still clean, and repairs the worktrees |
  | Clone | deletes the clone only while it's untouched since Arbor made it (same HEAD, clean, no new branches or worktrees) |
  | Fast-forward | resets to the old commit only while the branch is still where Arbor left it and the tree is clean |

## Project skills

`projects/<owner>/<name>/skills/<skill>/` is copied into each checkout and worktree of the project, as
`.claude/skills/<skill>` (Claude Code) and `.agents/skills/<skill>` (Codex and the harnesses that read the shared
store).

- **Kept out of git.** The copies are listed in `.git/info/exclude`, which every worktree of the repo shares.
- **New worktrees.** Files git doesn't track don't follow a checkout into a new worktree, so a worktree made after the
  last sync shows as missing the skill until the next one. That's the trade for not touching the project's own repo.
- **A clash.** A skill folder the project commits itself is the project's own. Arbor never overwrites it and reports
  the clash.

## Local projects and the hub

A project with no remote is mirrored through a bare repo on this Mac, the hub, at `~/.arbor/git/_local/<name>.git`.
Every transfer starts on this Mac over the SSH Arbor already uses, so the other machines never need SSH back.

- **Collect.** Each machine's branches are fetched into `refs/arbor/<machine>/*` in the hub.
- **Advance.** A hub branch moves forward to whichever machine's copy is ahead of all the others. When two machines
  have each moved on, that branch is marked diverged and left alone: Arbor shows it and never merges.
- **Hand out.** The hub's branches are pushed into each checkout's `refs/remotes/arbor/*`, never its own branches, so
  the checkout reads as "behind arbor/main" and fast-forwards like any other.
- **Clone.** A missing checkout of a local project is `git init`, filled from the hub, then checked out.
- **Limits.** It only works while this Mac is awake and Arbor is open. A local project that gets a remote stops using
  the hub; its folder moves from `_local/<name>` to `<owner>/<name>`.

## Where it shows

- **Sync › Projects** (a fifth leaf):
  - a grid of projects by machines, one cell per state above;
  - a page per project with the wanted path on each machine, other checkouts, skills, instructions and the fixes;
  - an Archived list.
- **A machine's page** gets a Projects card and its machine file's role and code root.
- **Sync › Overview** counts project drift in each machine's "behind".

## Build order

1. Schemas, parsing and layer resolution: machine and project files into `get_setup_repo`, with old values merged.
2. Drift: the scan reads wanted paths, and Sync › Projects shows the states.
3. Fixes: link, clone, fetch, fast-forward, move, each with its backup and Undo.
4. Project skills into checkouts.
5. Writers: the existing project and machine value commands write the new files.
6. The hub for local projects.
