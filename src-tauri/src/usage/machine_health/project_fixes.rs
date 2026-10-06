//! Putting a project where the setup repo wants it on a machine (project_places): a link at the place to the
//! checkout the machine has, a clone, a move of the checkout itself, and bringing it up to date.
//!
//! Each is checked again on the machine just before it's made, against what the plan expected, and skipped with
//! `changed` when that's moved on. Each that changes anything is noted in a backup's manifest (`G` lines, beside
//! guarded_writes' own), so Repo › History lists it and undoing it puts the place back:
//!
//! ```text
//! G link  <place> <checkout> <emptied>          undone while the place is still that link
//! G clone <place> <head> <emptied>              undone (deleted) only while the clone is untouched
//! G move  <from> <to> <relinked>                undone while both are as the move left them
//! G ff    <checkout> <branch> <old> <new>       undone with `git reset --keep` while HEAD is still <new>
//! ```
//!
//! `emptied` says the place was an empty folder, put back with the undo; `relinked` that the place was a link to
//! the checkout, made again. A fetch only changes remote-tracking refs, so it's never noted.
//!
//! Moving is the risky one: worktrees, other apps' projects and open shells remember a checkout's path. So it's only
//! made for a clean checkout with no linked worktrees and nothing running in it, and leaves a link at the old path.

use super::project_places::{drift, PlaceState, ProjectCell};
use super::guarded_writes::{new_stamp, prune_backups, run_on, ChangeKind};
use super::setup::covered_machine;
use super::setup_layers::arbor_machines;
use super::setup_projects::{CheckoutStatus, CHECKS, GIT_ENV, ORIGIN_URL};
use super::shell::{run_checked, shell_quote, Machine};
use super::*;
use ts_rs::TS;

/// A clone can take a while on a big repo.
const CLONE_TIMEOUT: Duration = Duration::from_secs(900);

/// A way to bring a project in line on a machine.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlaceFix {
    /// A link at the place to the checkout the machine has elsewhere.
    Link,
    /// A clone at the place, from the project's remote.
    Clone,
    /// The checkout itself moved to the place, with a link left where it was.
    Move,
    /// The checkout's default branch fast-forwarded to its upstream.
    FastForward,
    /// The checkout's remote fetched.
    Fetch,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFixRequest {
    project: String,
    fix: PlaceFix,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FixOutcome {
    Done,
    /// It wasn't as the last scan found, or can't be done as it stands, so nothing was changed.
    Skipped,
    Failed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFixResult {
    project: String,
    fix: PlaceFix,
    outcome: FixOutcome,
    /// Why, for one skipped or failed.
    detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectFixes {
    /// The backups the changes went into, oldest first, which Repo › History undoes.
    backups: Vec<String>,
    results: Vec<ProjectFixResult>,
}

/// A fix ready to run, every path whole or from the home folder.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Link { place: String, checkout: String, remote: String },
    Clone { place: String, url: String, branch: Option<String> },
    Move { from: String, to: String, relink: bool },
    /// `onto` is the upstream (`@{u}`), or for a local project the hub's copy, `refs/remotes/arbor/<branch>`.
    FastForward { checkout: String, branch: String, onto: String },
    Fetch { checkout: String },
    /// A local project's place made a repo, filled from the hub on this Mac, then `branch` checked out there.
    CloneFromHub { place: String, branch: Option<String> },
}

/// The upstream branch's name without its remote: `origin/main` is `main`.
fn branch_name(upstream: &str) -> &str {
    upstream.split_once('/').map_or(upstream, |(_, branch)| branch)
}

fn clean(status: &CheckoutStatus) -> bool {
    status.changed == Some(0) && status.untracked == Some(0)
}

/// What `fix` would do for a project on one machine, as its last scan has it, or why it can't.
fn plan(cell: &ProjectCell, remote: Option<&str>, branch: Option<&str>, local: bool, fix: PlaceFix) -> Result<Step, String> {
    let status = cell.status();
    let checkout = cell.checkout();
    match fix {
        PlaceFix::Link => match (cell.state(), checkout, remote) {
            (PlaceState::Elsewhere, Some(checkout), Some(remote)) => Ok(Step::Link { place: cell.path().into(), checkout: checkout.into(), remote: remote.into() }),
            (PlaceState::Elsewhere, Some(_), None) => Err("A local project's checkout can't be told apart from other folders yet".into()),
            _ => Err("There's no checkout elsewhere to link to, or the place isn't free".into()),
        },
        PlaceFix::Clone => match (cell.state(), remote) {
            (PlaceState::Missing, Some(remote)) if !local => Ok(Step::Clone { place: cell.path().into(), url: remote.into(), branch: branch.map(str::to_string) }),
            (PlaceState::Missing, _) if local => Ok(Step::CloneFromHub { place: cell.path().into(), branch: branch.map(str::to_string) }),
            (PlaceState::Missing, _) => Err("The project has no remote to clone".into()),
            _ => Err("The machine has a checkout already, or the place isn't free".into()),
        },
        PlaceFix::Move => {
            let (Some(checkout), Some(status)) = (checkout, status) else {
                return Err("There's no checkout to move".into());
            };
            if !matches!(cell.state(), PlaceState::Elsewhere | PlaceState::Linked) {
                return Err("The checkout is at its place already".into());
            }
            if !clean(status) {
                return Err("The checkout has changes, which a move would carry somewhere other tools don't expect".into());
            }
            if status.worktrees > 0 {
                return Err("The checkout has linked worktrees, which a move would break; link it instead".into());
            }
            Ok(Step::Move { from: checkout.into(), to: cell.path().into(), relink: cell.state() == PlaceState::Linked })
        }
        PlaceFix::FastForward => {
            let (Some(checkout), Some(status)) = (checkout, status) else {
                return Err("There's no checkout to bring up to date".into());
            };
            let (Some(branch), Some(upstream)) = (status.branch.as_deref(), status.upstream.as_deref()) else {
                return Err("The checkout has no branch with an upstream".into());
            };
            if status.default_branch.as_deref().is_some_and(|default| default != upstream) || branch_name(upstream) != branch {
                return Err(format!("{branch} isn't the remote's default branch; only that one is kept up to date"));
            }
            if status.changed != Some(0) {
                return Err("The checkout has changes".into());
            }
            if status.behind.unwrap_or(0) == 0 {
                return Err("It's up to date already".into());
            }
            let onto = if local && upstream.starts_with("arbor/") { format!("refs/remotes/{upstream}") } else { "@{u}".into() };
            Ok(Step::FastForward { checkout: checkout.into(), branch: branch.into(), onto })
        }
        PlaceFix::Fetch => match checkout {
            Some(checkout) if remote.is_some() => Ok(Step::Fetch { checkout: checkout.into() }),
            _ => Err("There's no checkout with a remote to fetch".into()),
        },
    }
}

/// A path for the script: whole, or from the home folder for `~/…`.
fn at(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rel) => format!("\"$HOME/\"{}", shell_quote(rel)),
        None if path == "~" => "\"$HOME\"".into(),
        None => shell_quote(path),
    }
}

// Follows GIT_ENV, CHECKS and ORIGIN_URL. Each fix says `R n how detail`: done, skipped or failed. The backup is
// started with the first change, and `finish` says `K stamp` when it holds any.
const FIX_FUNCTIONS: &str = r##"cwds > "$work/cwds"
dir=
GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2'
export GIT_SSH_COMMAND GCM_INTERACTIVE=never GIT_ASKPASS=false SSH_ASKPASS_REQUIRE=never
said() { printf 'R\t%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\n' '  ' | cut -c 1-300)"; }
open_backup() {
  [ -z "$dir" ] || return 0
  root="$HOME/.arbor/setup-backups"
  dir="$root/$stamp"
  if ! (umask 077 && mkdir -p "$dir") || ! chmod 700 "$root" || ! printf 'what\t%s\n' "$what" > "$dir/manifest"; then
    rm -rf "$dir"
    echo "Arbor couldn't make a folder for backups in ~/.arbor, so it changed nothing" >&2
    exit 5
  fi
}
# Writes down a fix in the backup's manifest: G and its fields, tab-separated.
note() {
  open_backup
  line=G; for field in "$@"; do line="$line$tab$field"; done
  printf '%s\n' "$line" >> "$dir/manifest"
}
# A remote as compared: host/owner/name, lowercase, without scheme, user, port or .git.
norm() {
  printf '%s' "$1" | sed -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' -e 's#^[^@/]*@##' -e 's#^\([^/:]*\):[0-9][0-9]*/#\1/#' \
    -e 's#^\([^/:]*\):#\1/#' -e 's#/*$##' -e 's#\.git$##' | tr 'A-Z' 'a-z'
}
# 0 when $1 is the top of a checkout.
top() { [ -d "$1" ] && [ "$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$1" 2>/dev/null && pwd -P)" ]; }
# 0 when nothing is at $1, or an empty folder that isn't a link.
free() { [ ! -e "$1" ] && [ ! -L "$1" ] || { [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(ls -A "$1" 2>/dev/null)" ]; }; }
# 0 when checkout $1 has no changes; with `all`, untracked files count too.
tidy() {
  if [ "${2:-}" = all ]; then u=all; else u=no; fi
  s=$(git -C "$1" status --porcelain --untracked-files=$u 2>/dev/null) && [ -z "$s" ]
}
worktrees() { git -C "$1" worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true; }
# Readies place $1 for something new: its folders, and an empty folder there taken out. Prints 1 for that.
ready() {
  mkdir -p "$(dirname "$1")" || return 1
  if [ -d "$1" ]; then rmdir "$1" || return 1; printf 1; else printf 0; fi
}
fix_link() {
  n=$1; place=$2; checkout=$3; want=$4
  free "$place" || { said "$n" skipped "Something is at the place now"; return 0; }
  { top "$checkout" && [ "$(norm "$(origin_url "$checkout")")" = "$want" ]; } || { said "$n" skipped "The checkout isn't there as the scan found it"; return 0; }
  open_backup
  emptied=$(ready "$place") || { said "$n" failed "Arbor couldn't make the folders for the place"; return 0; }
  if ln -s "$checkout" "$place"; then note link "$place" "$checkout" "$emptied"; said "$n" done ""
  else [ "$emptied" = 1 ] && mkdir "$place"; said "$n" failed "Arbor couldn't make the link"; fi
}
fix_clone() {
  n=$1; place=$2; url=$3; branch=$4
  free "$place" || { said "$n" skipped "Something is at the place now"; return 0; }
  open_backup
  emptied=$(ready "$place") || { said "$n" failed "Arbor couldn't make the folders for the place"; return 0; }
  if [ "$branch" = - ]; then set -- ; else set -- --branch "$branch"; fi
  if git -c gc.auto=0 clone --quiet "$@" -- "$url" "$place" < /dev/null > /dev/null 2> "$work/err"; then
    head=$(git -C "$place" rev-parse HEAD 2>/dev/null || echo -)
    note clone "$place" "$head" "$emptied"; said "$n" done ""
  else
    rm -rf "$place"; [ "$emptied" = 1 ] && mkdir "$place"
    said "$n" failed "$(tail -n 2 "$work/err")"
  fi
}
fix_move() {
  n=$1; from=$2; to=$3; relink=$4
  top "$from" || { said "$n" skipped "The checkout isn't there as the scan found it"; return 0; }
  tidy "$from" all || { said "$n" skipped "The checkout has changes now"; return 0; }
  [ "$(worktrees "$from")" -le 1 ] || { said "$n" skipped "The checkout has linked worktrees now"; return 0; }
  if A="$from" B="$(cd "$from" && pwd -P)" open_in; then said "$n" skipped "Something is running in the checkout"; return 0; fi
  if [ "$relink" = 1 ]; then
    { [ -L "$to" ] && [ "$(readlink "$to")" = "$from" ]; } || { said "$n" skipped "The place isn't the link the scan found"; return 0; }
  else
    free "$to" || { said "$n" skipped "Something is at the place now"; return 0; }
  fi
  open_backup
  if [ "$relink" = 1 ]; then rm -f "$to" || { said "$n" failed "Arbor couldn't take the link away"; return 0; }; emptied=0
  else emptied=$(ready "$to") || { said "$n" failed "Arbor couldn't make the folders for the place"; return 0; }; fi
  if mv "$from" "$to"; then
    ln -s "$to" "$from"
    git -C "$to" worktree repair > /dev/null 2>&1
    note move "$from" "$to" "$relink"; said "$n" done ""
  else
    if [ "$relink" = 1 ]; then ln -s "$from" "$to"; elif [ "$emptied" = 1 ]; then mkdir "$to"; fi
    said "$n" failed "Arbor couldn't move the checkout"
  fi
}
fix_ff() {
  n=$1; checkout=$2; branch=$3; onto=$4
  top "$checkout" || { said "$n" skipped "The checkout isn't there as the scan found it"; return 0; }
  [ "$(git -C "$checkout" symbolic-ref --quiet --short HEAD 2>/dev/null)" = "$branch" ] || { said "$n" skipped "The checkout isn't on $branch now"; return 0; }
  tidy "$checkout" || { said "$n" skipped "The checkout has changes now"; return 0; }
  old=$(git -C "$checkout" rev-parse HEAD)
  if git -C "$checkout" -c gc.auto=0 merge --ff-only --quiet "$onto" < /dev/null > /dev/null 2> "$work/err"; then
    new=$(git -C "$checkout" rev-parse HEAD)
    [ "$new" = "$old" ] || note ff "$checkout" "$branch" "$old" "$new"
    said "$n" done ""
  else said "$n" failed "$(tail -n 2 "$work/err")"; fi
}
# A local project's place made an empty repo for the hub to fill: `R n ready <folder> <emptied>`, said done only once
# hub_checkout has checked a branch out there.
hub_init() {
  n=$1; place=$2
  free "$place" || { said "$n" skipped "Something is at the place now"; return 0; }
  emptied=$(ready "$place") || { said "$n" failed "Arbor couldn't make the folders for the place"; return 0; }
  if git init --quiet "$place" > /dev/null 2>&1; then printf 'R\t%s\tready\t%s\t%s\n' "$n" "$(cd "$place" && pwd -P)" "$emptied"
  else rm -rf "$place"; [ "$emptied" = 1 ] && mkdir "$place"; said "$n" failed "git init didn't work there"; fi
}
# Checks branch $3 out of the hub's copy in the repo hub_init made at $2, or takes that repo away again.
hub_checkout() {
  n=$1; place=$2; branch=$3; emptied=$4
  if git -C "$place" checkout --quiet -b "$branch" "refs/remotes/arbor/$branch" > /dev/null 2> "$work/err"; then
    head=$(git -C "$place" rev-parse HEAD)
    note clone "$place" "$head" "$emptied"; said "$n" done ""
  else
    rm -rf "$place"; [ "$emptied" = 1 ] && mkdir "$place"
    said "$n" failed "$(tail -n 2 "$work/err")"
  fi
}
fix_fetch() {
  n=$1; checkout=$2
  top "$checkout" || { said "$n" skipped "The checkout isn't there as the scan found it"; return 0; }
  if git -C "$checkout" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 -c gc.auto=0 -c maintenance.auto=false \
    fetch --quiet --prune --no-tags --no-recurse-submodules origin < /dev/null > /dev/null 2> "$work/err"; then said "$n" done ""
  else said "$n" failed "$(tail -n 2 "$work/err")"; fi
}
"##;

fn fix_script(stamp: &str, steps: &[(usize, Step)]) -> String {
    let mut script = format!("{GIT_ENV}{CHECKS}{ORIGIN_URL}stamp={}\nwhat={}\n{FIX_FUNCTIONS}", shell_quote(stamp), ChangeKind::Projects.name());
    for (n, step) in steps {
        let line = match step {
            // The script's `norm` lowercases, so the remote it's compared with is lowercased too.
            Step::Link { place, checkout, remote } => format!("fix_link {n} {} {} {}", at(place), at(checkout), shell_quote(&remote_norm(remote).to_ascii_lowercase())),
            Step::Clone { place, url, branch } => format!("fix_clone {n} {} {} {}", at(place), shell_quote(url), shell_quote(branch.as_deref().unwrap_or("-"))),
            Step::Move { from, to, relink } => format!("fix_move {n} {} {} {}", at(from), at(to), u8::from(*relink)),
            Step::FastForward { checkout, branch, onto } => format!("fix_ff {n} {} {} {}", at(checkout), shell_quote(branch), shell_quote(onto)),
            Step::CloneFromHub { place, .. } => format!("hub_init {n} {}", at(place)),
            Step::Fetch { checkout } => format!("fix_fetch {n} {}", at(checkout)),
        };
        script.push_str(&line);
        script.push('\n');
    }
    script.push_str(&format!(
        "if [ -n \"$dir\" ]; then\n\
         \x20 if grep -q '^G\t' \"$dir/manifest\"; then printf 'K\\t%s\\n' \"$stamp\"; else rm -rf \"$dir\"; fi\n\
         {}fi\n",
        prune_backups()
    ));
    script
}

/// A remote as the script's `norm` gives it, and project_places compares: lowercase `host/owner/name`.
fn remote_norm(remote: &str) -> String {
    super::setup_projects::normalize_remote(remote).unwrap_or_default()
}

/// The repos hub_init made ready: each fix's number, the folder, and whether it was an empty folder before.
fn parse_ready(stdout: &str) -> Vec<(usize, String, bool)> {
    stdout
        .lines()
        .filter_map(|line| match line.split('\t').collect::<Vec<_>>().as_slice() {
            ["R", n, "ready", real, emptied] if real.starts_with('/') => Some((n.parse().ok()?, real.to_string(), *emptied == "1")),
            _ => None,
        })
        .collect()
}

/// Fills the empty repo at `real` on `machine` from local project `name`'s hub, and says which branch to check out:
/// `branch`, else the hub's own, else its first.
async fn fill_from_hub(machine: &Machine, name: &str, real: &str, branch: Option<&str>) -> Result<String, String> {
    let hub = super::project_hub::hub_dir(name)?;
    let branches = super::project_hub::hub_git(&hub, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]).await.unwrap_or_default();
    let branches: Vec<&str> = branches.lines().filter(|line| !line.is_empty()).collect();
    let head = super::project_hub::hub_git(&hub, &["symbolic-ref", "--short", "HEAD"]).await.unwrap_or_default();
    let chosen = branch
        .filter(|branch| branches.contains(branch))
        .or_else(|| branches.iter().copied().find(|found| *found == head.trim()))
        .or_else(|| branches.first().copied())
        .ok_or("The hub on this Mac has nothing of this project yet. Bring it through the hub from a machine that has it first")?
        .to_string();
    super::project_hub::hand_out(&hub, &super::project_hub::git_url(machine, real)).await?;
    Ok(chosen)
}

/// How each fix went, by its number, and the backup made.
fn parse_fixes(stdout: &str) -> (Option<String>, BTreeMap<usize, (FixOutcome, Option<String>)>) {
    let mut backup = None;
    let mut outcomes = BTreeMap::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["K", stamp] => backup = Some(stamp.to_string()),
            ["R", _, "ready", ..] => {}
            ["R", n, how, detail] => {
                let Ok(n) = n.parse::<usize>() else { continue };
                let outcome = match *how {
                    "done" => FixOutcome::Done,
                    "skipped" => FixOutcome::Skipped,
                    _ => FixOutcome::Failed,
                };
                outcomes.insert(n, (outcome, Some(detail.trim().to_string()).filter(|detail| !detail.is_empty())));
            }
            _ => {}
        }
    }
    (backup, outcomes)
}

/// Brings the setup repo's projects in line on `machine`, each fix as the machine's last project scan has it, then
/// scans its places again. Every change is backed up first, and undone from Repo › History.
#[tauri::command]
pub(crate) async fn apply_project_fixes(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    fixes: Vec<ProjectFixRequest>,
) -> Result<ProjectFixes, String> {
    if fixes.is_empty() {
        return Err("Nothing to fix".into());
    }
    let found = super::setup_sync::read_repo(Path::new(&repo)).await?;
    let (target, cells) = {
        let mut inner = state.lock();
        inner.setup_repo = Some(repo.clone());
        let (target, _) = covered_machine(&inner, &machine)?;
        let drift = drift(found.layers(), &arbor_machines(&inner), &inner.projects);
        (target, drift.on_machine(&machine))
    };
    let mut results: Vec<ProjectFixResult> = Vec::new();
    let mut steps: Vec<(usize, Step)> = Vec::new();
    for (n, request) in fixes.iter().enumerate() {
        let planned = cells
            .iter()
            .find(|(project, ..)| *project == request.project)
            .ok_or_else(|| format!("{} isn't on {machine} in the setup repo", request.project))
            .and_then(|(_, cell, remote, branch, local)| plan(cell, remote.as_deref(), branch.as_deref(), *local, request.fix));
        results.push(ProjectFixResult { project: request.project.clone(), fix: request.fix, outcome: FixOutcome::Skipped, detail: None });
        match planned {
            Ok(step) => steps.push((n, step)),
            Err(why) => results[n].detail = Some(why),
        }
    }
    let mut backups = Vec::new();
    if !steps.is_empty() {
        let script = fix_script(&new_stamp(), &steps);
        let slow = steps.iter().any(|(_, step)| matches!(step, Step::Clone { .. } | Step::Fetch { .. }));
        let stdout = if slow { run_checked(&target, MachineOp::ProjectFixes, &script, CLONE_TIMEOUT).await? } else { run_on(&target, MachineOp::ProjectFixes, &script).await? };
        let (made, mut outcomes) = parse_fixes(&stdout);
        backups.extend(made);
        // A local project's clone: the empty repo is ready, so the hub fills it, and a second script checks out.
        for (n, real, emptied) in parse_ready(&stdout) {
            let Some((_, Step::CloneFromHub { branch, .. })) = steps.iter().find(|(at, _)| *at == n) else { continue };
            let name = fixes[n].project.strip_prefix("_local/").unwrap_or(&fixes[n].project);
            let filled = fill_from_hub(&target, name, &real, branch.as_deref()).await;
            let stdout = match filled {
                Ok(branch) => {
                    let script = format!("{GIT_ENV}{CHECKS}{ORIGIN_URL}stamp={}\nwhat={}\n{FIX_FUNCTIONS}hub_checkout {n} {} {} {}\nif [ -n \"$dir\" ]; then printf 'K\\t%s\\n' \"$stamp\"; fi\n", shell_quote(&new_stamp()), ChangeKind::Projects.name(), shell_quote(&real), shell_quote(&branch), u8::from(emptied));
                    run_on(&target, MachineOp::ProjectFixes, &script).await.unwrap_or_else(|error| format!("R\t{n}\tfailed\t{error}\n"))
                }
                Err(error) => {
                    let script = format!("set -u\nrm -rf {}{}\n", shell_quote(&real), if emptied { format!(" && mkdir {}", shell_quote(&real)) } else { String::new() });
                    let _ = run_on(&target, MachineOp::ProjectFixes, &script).await;
                    format!("R\t{n}\tfailed\t{error}\n")
                }
            };
            let (made, more) = parse_fixes(&stdout);
            backups.extend(made);
            outcomes.extend(more);
        }
        for (n, _) in &steps {
            let (outcome, detail) = outcomes.get(n).cloned().unwrap_or((FixOutcome::Failed, Some("The machine didn't say how it went".into())));
            results[*n].outcome = outcome;
            results[*n].detail = detail;
        }
    }
    let _ = super::setup_projects::scan_projects(app.clone(), state, machine, None, Some(repo)).await;
    Ok(ProjectFixes { backups, results })
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/// A fix as its backup's manifest has it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum BackupPlace {
    Link { place: String, checkout: String, emptied: bool },
    Clone { place: String, head: String, emptied: bool },
    Move { from: String, to: String, relinked: bool },
    FastForward { checkout: String, branch: String, old: String, new: String },
    /// A project's skill folder written (`after`) over what was there (`before`, - for nothing), or taken out (`after`
    /// -); what it replaced is in the backup's folders/<n>.
    Skill { path: String, before: String, after: String, n: String },
}

fn whole(path: &str) -> bool {
    path.starts_with('/') && path.len() > 1 && !path.split('/').any(|part| part == "." || part == "..") && !path.chars().any(char::is_control)
}

/// A skill folder's fingerprint as `place` gives one, or - for nothing there.
fn is_folder_print(value: &str) -> bool {
    value == "-" || value.strip_prefix('D').is_some_and(|sum| (sum.len() == 64 && sum.bytes().all(|byte| byte.is_ascii_hexdigit())) || sum.strip_prefix('c').and_then(|rest| rest.split_once('-')).is_some_and(|(crc, len)| !crc.is_empty() && !len.is_empty() && format!("{crc}{len}").bytes().all(|byte| byte.is_ascii_digit())))
}

fn is_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl BackupPlace {
    /// From a manifest's `G` line. Paths have to be whole, with nothing that could lead out of where they say.
    pub(super) fn parse(fields: &[&str]) -> Option<Self> {
        let flag = |value: &str| match value {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        };
        match fields {
            ["G", "link", place, checkout, emptied] if whole(place) && whole(checkout) => Some(Self::Link { place: place.to_string(), checkout: checkout.to_string(), emptied: flag(emptied)? }),
            ["G", "clone", place, head, emptied] if whole(place) && is_sha(head) => Some(Self::Clone { place: place.to_string(), head: head.to_string(), emptied: flag(emptied)? }),
            ["G", "move", from, to, relinked] if whole(from) && whole(to) => Some(Self::Move { from: from.to_string(), to: to.to_string(), relinked: flag(relinked)? }),
            ["G", "skill", path, before, after, n] if whole(path) && is_folder_print(before) && is_folder_print(after) && !n.is_empty() && n.bytes().all(|byte| byte.is_ascii_digit()) => {
                Some(Self::Skill { path: path.to_string(), before: before.to_string(), after: after.to_string(), n: n.to_string() })
            }
            ["G", "ff", checkout, branch, old, new] if whole(checkout) && is_sha(old) && is_sha(new) && !branch.is_empty() && !branch.starts_with('-') => {
                Some(Self::FastForward { checkout: checkout.to_string(), branch: branch.to_string(), old: old.to_string(), new: new.to_string() })
            }
            _ => None,
        }
    }

    /// Where the change was, as History shows it, and whether it added something or changed what was there.
    pub(super) fn shown(&self) -> (&str, &'static str) {
        match self {
            Self::Link { place, .. } | Self::Clone { place, .. } => (place, "added"),
            Self::Move { to, .. } => (to, "changed"),
            Self::FastForward { checkout, .. } => (checkout, "changed"),
            Self::Skill { path, before, after, .. } => (path, if before == "-" { "added" } else if after == "-" { "removed" } else { "changed" }),
        }
    }
}

// Follows GIT_ENV's settings (no `$work`): what undoing the fixes needs.
const UNDO_FUNCTIONS: &str = r##"export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0
top() { [ -d "$1" ] && [ "$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$1" 2>/dev/null && pwd -P)" ]; }
untouched() {
  top "$1" && [ "$(git -C "$1" rev-parse HEAD 2>/dev/null)" = "$2" ] \
    && [ -z "$(git -C "$1" status --porcelain --untracked-files=all 2>/dev/null)" ] \
    && [ "$(git -C "$1" worktree list --porcelain 2>/dev/null | grep -c '^worktree ')" -le 1 ] \
    && [ "$(git -C "$1" for-each-ref refs/heads 2>/dev/null | grep -c .)" -le 1 ] \
    && ! git -C "$1" rev-parse -q --verify refs/stash > /dev/null 2>&1
}
"##;

/// For undoing a backup's fixes: each place must be as its fix left it. Sets `changed` for any that isn't.
pub(super) fn undo_place_checks(places: &[BackupPlace]) -> String {
    if places.is_empty() {
        return String::new();
    }
    let mut script = String::from(UNDO_FUNCTIONS);
    for place in places {
        let (shown, _) = place.shown();
        let check = match place {
            BackupPlace::Link { place, checkout, .. } => format!("[ -L {p} ] && [ \"$(readlink {p})\" = {c} ]", p = shell_quote(place), c = shell_quote(checkout)),
            BackupPlace::Clone { place, head, .. } => format!("untouched {} {}", shell_quote(place), shell_quote(head)),
            BackupPlace::Move { from, to, .. } => format!(
                "[ -L {f} ] && [ \"$(readlink {f})\" = {t} ] && top {t} && [ -z \"$(git -C {t} status --porcelain --untracked-files=all 2>/dev/null)\" ]",
                f = shell_quote(from),
                t = shell_quote(to)
            ),
            BackupPlace::Skill { path, after, .. } => format!("[ \"$(place {})\" = {} ]", shell_quote(path), shell_quote(after)),
            BackupPlace::FastForward { checkout, branch, new, .. } => format!(
                "top {c} && [ \"$(git -C {c} symbolic-ref --quiet --short HEAD 2>/dev/null)\" = {b} ] && [ \"$(git -C {c} rev-parse HEAD)\" = {n} ] && [ -z \"$(git -C {c} status --porcelain --untracked-files=no 2>/dev/null)\" ]",
                c = shell_quote(checkout),
                b = shell_quote(branch),
                n = shell_quote(new)
            ),
        };
        script.push_str(&format!("{check} || {{ printf 'X\\t%s\\tchanged\\n' {}; changed=1; }}\n", shell_quote(shown)));
    }
    script
}

/// Puts each place back, once every check passed.
pub(super) fn undo_place_actions(places: &[BackupPlace]) -> String {
    let mut script = String::new();
    for place in places {
        let (shown, _) = place.shown();
        let action = match place {
            BackupPlace::Link { place, emptied, .. } => format!("rm -f {p}{}", if *emptied { format!(" && mkdir {}", shell_quote(place)) } else { String::new() }, p = shell_quote(place)),
            BackupPlace::Clone { place, emptied, .. } => format!("rm -rf {p}{}", if *emptied { format!(" && mkdir {}", shell_quote(place)) } else { String::new() }, p = shell_quote(place)),
            BackupPlace::Move { from, to, relinked } => format!(
                "rm -f {f} && mv {t} {f} && {{ git -C {f} worktree repair > /dev/null 2>&1; true; }}{}",
                if *relinked { format!(" && ln -s {} {}", shell_quote(from), shell_quote(to)) } else { String::new() },
                f = shell_quote(from),
                t = shell_quote(to)
            ),
            BackupPlace::FastForward { checkout, old, .. } => format!("git -C {} reset --quiet --keep {} < /dev/null > /dev/null 2>&1", shell_quote(checkout), shell_quote(old)),
            BackupPlace::Skill { path, before, n, .. } => format!(
                "rm -rf {p}{}",
                if before == "-" { String::new() } else { format!(" && mv \"$dir/folders/\"{} {}", shell_quote(n), shell_quote(path)) },
                p = shell_quote(path)
            ),
        };
        script.push_str(&format!("if {action}; then printf 'W\\t%s\\n' {s}; else printf 'X\\t%s\\tfailed\\n' {s}; failed=1; fi\n", s = shell_quote(shown)));
    }
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(extra: impl FnOnce(&mut CheckoutStatus)) -> CheckoutStatus {
        let mut status = CheckoutStatus {
            branch: Some("main".into()),
            changed: Some(0),
            untracked: Some(0),
            upstream: Some("origin/main".into()),
            ahead: Some(0),
            behind: Some(3),
            default_branch: Some("origin/main".into()),
            fetched_at: Some(1),
            fetch_failed: false,
            worktrees: 0,
        };
        extra(&mut status);
        status
    }

    const REMOTE: Option<&str> = Some("git@github.com:cam/arbor.git");
    const PLACE: &str = "~/code/cam/arbor";

    fn cell(state: PlaceState, checkout: Option<&str>, status: Option<CheckoutStatus>) -> ProjectCell {
        ProjectCell::for_test(state, PLACE, checkout, status)
    }

    #[test]
    fn each_fix_is_planned_only_where_it_fits() {
        let elsewhere = cell(PlaceState::Elsewhere, Some("/home/cam/src/arbor"), Some(status(|_| {})));
        assert_eq!(plan(&elsewhere, REMOTE, None, false, PlaceFix::Link), Ok(Step::Link { place: PLACE.into(), checkout: "/home/cam/src/arbor".into(), remote: REMOTE.unwrap().into() }));
        assert_eq!(plan(&elsewhere, REMOTE, None, false, PlaceFix::Move), Ok(Step::Move { from: "/home/cam/src/arbor".into(), to: PLACE.into(), relink: false }));
        assert_eq!(plan(&elsewhere, REMOTE, None, false, PlaceFix::FastForward), Ok(Step::FastForward { checkout: "/home/cam/src/arbor".into(), branch: "main".into(), onto: "@{u}".into() }));
        assert!(plan(&elsewhere, REMOTE, None, false, PlaceFix::Clone).is_err());
        let linked = cell(PlaceState::Linked, Some("/home/cam/src/arbor"), Some(status(|_| {})));
        assert_eq!(plan(&linked, REMOTE, None, false, PlaceFix::Move), Ok(Step::Move { from: "/home/cam/src/arbor".into(), to: PLACE.into(), relink: true }));
        assert!(plan(&linked, REMOTE, None, false, PlaceFix::Link).is_err());
        let missing = cell(PlaceState::Missing, None, None);
        assert_eq!(plan(&missing, REMOTE, Some("dev"), false, PlaceFix::Clone), Ok(Step::Clone { place: PLACE.into(), url: REMOTE.unwrap().into(), branch: Some("dev".into()) }));
        // A local project is filled from the hub on this Mac.
        assert_eq!(plan(&missing, None, None, true, PlaceFix::Clone), Ok(Step::CloneFromHub { place: PLACE.into(), branch: None }));
        for fix in [PlaceFix::Link, PlaceFix::Clone, PlaceFix::Move, PlaceFix::FastForward, PlaceFix::Fetch] {
            assert!(plan(&cell(PlaceState::Blocked, None, None), REMOTE, None, false, fix).is_err(), "{fix:?}");
        }
    }

    #[test]
    fn a_move_or_fast_forward_that_could_lose_work_or_break_something_isnt_planned() {
        let with = |extra: fn(&mut CheckoutStatus)| cell(PlaceState::Elsewhere, Some("/home/cam/src/arbor"), Some(status(extra)));
        assert!(plan(&with(|status| status.untracked = Some(1)), REMOTE, None, false, PlaceFix::Move).unwrap_err().contains("changes"));
        assert!(plan(&with(|status| status.worktrees = 2), REMOTE, None, false, PlaceFix::Move).unwrap_err().contains("worktrees"));
        assert!(plan(&with(|status| status.changed = Some(2)), REMOTE, None, false, PlaceFix::FastForward).is_err());
        assert!(plan(&with(|status| status.behind = Some(0)), REMOTE, None, false, PlaceFix::FastForward).is_err());
        let feature = with(|status| {
            status.branch = Some("feature".into());
            status.upstream = Some("origin/feature".into());
        });
        assert!(plan(&feature, REMOTE, None, false, PlaceFix::FastForward).unwrap_err().contains("default branch"));
        // Untracked files don't stop a fast-forward; git refuses one that would overwrite them.
        assert!(plan(&with(|status| status.untracked = Some(4)), REMOTE, None, false, PlaceFix::FastForward).is_ok());
    }

    #[test]
    fn manifest_lines_are_read_only_when_whole_and_well_formed() {
        let sha = "a".repeat(40);
        assert_eq!(BackupPlace::parse(&["G", "link", "/h/code/x", "/h/src/x", "0"]), Some(BackupPlace::Link { place: "/h/code/x".into(), checkout: "/h/src/x".into(), emptied: false }));
        assert!(BackupPlace::parse(&["G", "clone", "/h/code/x", &sha, "1"]).is_some());
        assert!(BackupPlace::parse(&["G", "ff", "/h/x", "main", &sha, &sha]).is_some());
        for bad in [
            vec!["G", "link", "code/x", "/h/src/x", "0"],
            vec!["G", "link", "/h/../etc", "/h/src/x", "0"],
            vec!["G", "clone", "/h/code/x", "nope", "0"],
            vec!["G", "move", "/h/a", "/h/b", "2"],
            vec!["G", "ff", "/h/x", "--hard", &sha, &sha],
            vec!["G", "rm", "/h/x"],
        ] {
            assert_eq!(BackupPlace::parse(&bad), None, "{bad:?}");
        }
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;
        use crate::usage::machine_health::setup_sync::{parse_backups, undo_script};
        use crate::usage::machine_health::guarded_writes::BACKUPS_SCRIPT;
        use crate::usage::machine_health::shell::{run_script, shells};
        use std::fs;
        use std::path::PathBuf;
        use std::process::Stdio;

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-fixes-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            dir.canonicalize().unwrap()
        }

        fn git(home: &Path, dir: &Path, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(["-c", "user.name=Arbor", "-c", "user.email=arbor@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(dir)
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn run(shell: &str, home: &Path, script: &str) -> String {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let output = tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(60))).unwrap();
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        /// An upstream with one commit, and a clean checkout of it at `name` under src.
        fn fixture(root: &Path) -> (PathBuf, String) {
            let home = root.join("home");
            fs::create_dir_all(home.join("src")).unwrap();
            let upstream = root.join("Up.git");
            git(&home, root, &["init", "--bare", "-q", upstream.to_str().unwrap()]);
            let seed = root.join("seed");
            fs::create_dir_all(&seed).unwrap();
            git(&home, &seed, &["init", "-q"]);
            fs::write(seed.join("README.md"), "one\n").unwrap();
            git(&home, &seed, &["add", "."]);
            git(&home, &seed, &["commit", "-qm", "one"]);
            let url = format!("file://{}", upstream.display());
            git(&home, &seed, &["remote", "add", "origin", &url]);
            git(&home, &seed, &["push", "-q", "-u", "origin", "main"]);
            (home, url)
        }

        fn clone(home: &Path, url: &str, name: &str) -> PathBuf {
            git(home, &home.join("src"), &["clone", "-q", url, name]);
            home.join("src").join(name)
        }

        #[test]
        fn each_fix_is_made_noted_and_undone_from_its_backup() {
            for shell in shells() {
                let root = temp_dir("round");
                let (home, url) = fixture(&root);
                let app = clone(&home, &url, "app");
                let mv = clone(&home, &url, "mv");
                // app falls a commit behind its upstream.
                let seed = root.join("seed");
                fs::write(seed.join("README.md"), "two\n").unwrap();
                git(&home, &seed, &["commit", "-qam", "two"]);
                git(&home, &seed, &["push", "-q", "origin", "main"]);
                git(&home, &app, &["fetch", "-q"]);
                let old = git(&home, &app, &["rev-parse", "HEAD"]);
                fs::create_dir_all(home.join("code/cam/other")).unwrap();
                let steps = vec![
                    (0, Step::Link { place: "~/code/cam/app".into(), checkout: app.display().to_string(), remote: url.clone() }),
                    (1, Step::Clone { place: "~/code/cam/other".into(), url: url.clone(), branch: None }),
                    (2, Step::FastForward { checkout: app.display().to_string(), branch: "main".into(), onto: "@{u}".into() }),
                    (3, Step::Move { from: mv.display().to_string(), to: "~/code/cam/mv".into(), relink: false }),
                    (4, Step::Fetch { checkout: app.display().to_string() }),
                ];
                let stdout = run(shell, &home, &fix_script(&new_stamp(), &steps));
                let (backup, outcomes) = parse_fixes(&stdout);
                for n in 0..5 {
                    assert_eq!(outcomes.get(&n).map(|(outcome, _)| *outcome), Some(FixOutcome::Done), "{shell} {n}: {stdout}");
                }
                assert!(backup.is_some(), "{shell}: {stdout}");
                assert_eq!(fs::read_link(home.join("code/cam/app")).unwrap(), app);
                assert!(home.join("code/cam/other/.git").is_dir());
                assert_ne!(git(&home, &app, &["rev-parse", "HEAD"]), old);
                assert!(home.join("code/cam/mv/.git").is_dir() && fs::read_link(&mv).unwrap() == home.join("code/cam/mv"));

                let backups = parse_backups(&run(shell, &home, BACKUPS_SCRIPT));
                let [made] = backups.as_slice() else { panic!("{shell}: {backups:?}") };
                assert_eq!(made.places.len(), 4, "{shell}");
                let undone = run(shell, &home, &undo_script(made));
                assert!(!undone.contains("\tchanged") && !undone.contains("\tfailed"), "{shell}: {undone}");
                // Each place is as it was: no link, the empty folder back, the old commit, the checkout where it was.
                assert!(fs::symlink_metadata(home.join("code/cam/app")).is_err(), "{shell}");
                assert!(home.join("code/cam/other").is_dir() && fs::read_dir(home.join("code/cam/other")).unwrap().next().is_none(), "{shell}");
                assert_eq!(git(&home, &app, &["rev-parse", "HEAD"]), old, "{shell}");
                assert!(mv.join(".git").is_dir() && !home.join("code/cam/mv").exists(), "{shell}");
                let _ = fs::remove_dir_all(&root);
            }
        }

        #[test]
        fn a_local_project_is_cloned_from_the_hub_and_undone_like_any_clone() {
            for shell in shells() {
                let root = temp_dir("hub-clone");
                let (home, _) = fixture(&root);
                let hub = root.join("hub.git");
                git(&home, &root, &["clone", "-q", "--bare", root.join("seed").to_str().unwrap(), hub.to_str().unwrap()]);
                fs::create_dir_all(home.join("code/_local/notes")).unwrap();
                let steps = vec![(0, Step::CloneFromHub { place: "~/code/_local/notes".into(), branch: None })];
                let stdout = run(shell, &home, &fix_script(&new_stamp(), &steps));
                let ready = parse_ready(&stdout);
                let [(0, real, true)] = ready.as_slice() else { panic!("{shell}: {stdout}") };
                let real = real.clone();
                tokio::runtime::Runtime::new().unwrap().block_on(crate::usage::machine_health::project_hub::hand_out(&hub, &real)).unwrap();
                let script = format!("{GIT_ENV}{CHECKS}{ORIGIN_URL}stamp={}\nwhat=projects\n{FIX_FUNCTIONS}hub_checkout 0 {} main 1\n", shell_quote(&new_stamp()), shell_quote(&real));
                let (_, outcomes) = parse_fixes(&run(shell, &home, &script));
                assert_eq!(outcomes[&0].0, FixOutcome::Done, "{shell}");
                assert_eq!(git(&home, Path::new(&real), &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
                assert!(Path::new(&real).join("README.md").is_file());

                let backups = parse_backups(&run(shell, &home, BACKUPS_SCRIPT));
                let undone = run(shell, &home, &undo_script(&backups[0]));
                assert!(!undone.contains("\tchanged") && !undone.contains("\tfailed"), "{shell}: {undone}");
                // The empty folder that was there is back.
                assert!(home.join("code/_local/notes").is_dir() && fs::read_dir(home.join("code/_local/notes")).unwrap().next().is_none(), "{shell}");
                let _ = fs::remove_dir_all(&root);
            }
        }

        #[test]
        fn nothing_is_undone_once_any_place_has_moved_on() {
            for shell in shells() {
                let root = temp_dir("moved-on");
                let (home, url) = fixture(&root);
                let steps = vec![(0, Step::Clone { place: "~/code/cam/app".into(), url: url.clone(), branch: None })];
                run(shell, &home, &fix_script(&new_stamp(), &steps));
                // Work started in the clone: deleting it now would lose that.
                fs::write(home.join("code/cam/app/notes.txt"), "mine\n").unwrap();
                let backups = parse_backups(&run(shell, &home, BACKUPS_SCRIPT));
                let undone = run(shell, &home, &undo_script(&backups[0]));
                assert!(undone.contains("\tchanged"), "{shell}: {undone}");
                assert!(home.join("code/cam/app/notes.txt").is_file(), "{shell}");
                let _ = fs::remove_dir_all(&root);
            }
        }

        #[test]
        fn a_place_taken_since_the_scan_is_skipped_and_nothing_is_kept() {
            for shell in shells() {
                let root = temp_dir("taken");
                let (home, url) = fixture(&root);
                let app = clone(&home, &url, "app");
                fs::create_dir_all(home.join("code/cam/app")).unwrap();
                fs::write(home.join("code/cam/app/x"), "x").unwrap();
                let steps = vec![(0, Step::Link { place: "~/code/cam/app".into(), checkout: app.display().to_string(), remote: url.clone() })];
                let (backup, outcomes) = parse_fixes(&run(shell, &home, &fix_script(&new_stamp(), &steps)));
                assert_eq!(outcomes[&0].0, FixOutcome::Skipped, "{shell}");
                assert_eq!(backup, None, "{shell}");
                assert!(parse_backups(&run(shell, &home, BACKUPS_SCRIPT)).is_empty(), "{shell}");
                let _ = fs::remove_dir_all(&root);
            }
        }
    }
}
