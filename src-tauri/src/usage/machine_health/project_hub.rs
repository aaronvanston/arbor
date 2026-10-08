//! A project with no remote (`projects/_local/<name>`) is kept in step through a bare repo on this Mac, the hub:
//! `~/.arbor/git/_local/<name>.git`. Every transfer starts here, over the SSH Arbor already uses to reach each
//! machine, so the other machines never need to reach this Mac.
//!
//! - Collect: each machine's checkout's branches are fetched into the hub's `refs/arbor/<machine>/*`.
//! - Advance: a hub branch moves to whichever machine's copy has all the others in its history. When two have moved
//!   on apart, the branch is left where it was and said to have diverged; Arbor never merges.
//! - Hand out: the hub's branches are pushed into each checkout's `refs/remotes/arbor/*`, never its own branches, so
//!   the place scan reads it as behind `arbor/<branch>` and Fast-forward brings it up to date.
//! - Clone: a machine assigned the project with nothing at its place gets `git init` there, filled from the hub, then
//!   the branch checked out (project_fixes).
//!
//! Only while this Mac is awake and Arbor is open. A project given a remote moves to `projects/<owner>/<name>` and
//! stops using the hub.

use super::project_places::{drift, PlaceState};
use super::setup::covered_machine;
use super::setup_layers::arbor_machines;
use super::shell::Machine;
use super::*;
use std::collections::BTreeSet;
use ts_rs::TS;

const HUB_TIMEOUT: Duration = Duration::from_secs(300);

/// How a hub branch came out of a round.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HubBranchState {
    /// Every machine's copy is where the hub has it, or behind.
    Same,
    /// Moved forward to a machine's copy.
    Advanced,
    /// New to the hub.
    New,
    /// Two machines have each moved on, so it was left alone.
    Diverged,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubBranch {
    branch: String,
    state: HubBranchState,
    /// The machines whose copies have moved on apart, for a diverged branch.
    apart: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubMachine {
    machine: String,
    collected: bool,
    handed_out: bool,
    error: Option<String>,
}

/// How a round through the hub went.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubSync {
    project: String,
    branches: Vec<HubBranch>,
    machines: Vec<HubMachine>,
}

/// What a hub branch should become, from where it is (`current`) and each machine's copy: the copy every other one,
/// and the hub's, are in the history of; None when two have moved on apart.
pub(super) fn choose_tip<'a>(current: Option<&'a str>, tips: &[&'a str], is_ancestor: impl Fn(&str, &str) -> bool) -> Option<&'a str> {
    let mut candidates: Vec<&str> = tips.to_vec();
    candidates.extend(current);
    candidates.sort_unstable();
    candidates.dedup();
    candidates.iter().copied().find(|tip| candidates.iter().all(|other| other == tip || is_ancestor(other, tip)))
}

/// The hub for local project `name` on this Mac. A name that would lead out of the hubs' folder has none.
pub(super) fn hub_dir(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("{name} can't be a local project's hub"));
    }
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from).ok_or("Arbor can't find your home folder")?;
    Ok(home.join(".arbor/git/_local").join(format!("{name}.git")))
}

/// The hub of each local project a round goes through. A project whose hub can't be found is skipped, never the
/// end of the round, so one bad name doesn't keep every project after it out of step.
fn hubs(projects: Vec<String>, hub_dir: impl Fn(&str) -> Result<PathBuf, String>) -> Vec<(String, PathBuf)> {
    projects
        .into_iter()
        .filter_map(|project| {
            let hub = hub_dir(project.strip_prefix("_local/")?);
            match hub {
                Ok(hub) => Some((project, hub)),
                Err(error) => {
                    eprintln!("Skipped {project} in the hub round: {error}");
                    None
                }
            }
        })
        .collect()
}

/// Where git reaches a checkout on `machine`: its folder on this Mac, else over SSH the way Arbor reaches the machine.
pub(super) fn git_url(machine: &Machine, path: &str) -> String {
    if machine.is_local() {
        return path.to_string();
    }
    let host = machine.host();
    let endpoint = host.endpoint.trim();
    // An IPv6 address needs brackets before a port; a user in front of it stays outside them.
    let (user, address) = endpoint.rsplit_once('@').map_or(("", endpoint), |(user, address)| (user, address));
    let address = if address.contains(':') && !address.starts_with('[') { format!("[{address}]") } else { address.to_string() };
    let user = if user.is_empty() { String::new() } else { format!("{user}@") };
    format!("ssh://{user}{address}:{}{path}", host.port)
}

/// Runs git on this Mac for the hub, never prompting: over SSH only with keys, as Arbor's own scripts are.
pub(super) async fn hub_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", super::host_keys::git_ssh_command())
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "false")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_helper_command(&mut command);
    let child = command.spawn().map_err(|error| format!("Could not run git: {error}"))?;
    let output = tokio::time::timeout(HUB_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("git timed out after {}s", HUB_TIMEOUT.as_secs()))?
        .map_err(|error| format!("git failed: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.lines().map(str::trim).filter(|line| !line.is_empty()).last().unwrap_or("git failed").to_string())
    }
}

/// Makes the hub when it isn't there yet.
pub(super) async fn ensure_hub(hub: &Path) -> Result<(), String> {
    if hub.join("HEAD").is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(hub).map_err(|error| format!("Arbor couldn't make {}: {error}", hub.display()))?;
    hub_git(hub, &["init", "--quiet", "--bare"]).await.map(|_| ())
}

/// The ref namespace a machine's branches are collected under: its normalized name.
fn collected(machine: &str) -> String {
    format!("refs/arbor/{}", normalize_machine_name(machine))
}

/// Pushes the hub's branches into the checkout at `url`'s `refs/remotes/arbor/*`.
pub(super) async fn hand_out(hub: &Path, url: &str) -> Result<(), String> {
    hub_git(hub, &["push", "--quiet", "--prune", "--no-verify", url, "+refs/heads/*:refs/remotes/arbor/*"]).await.map(|_| ())
}

/// One round through the hub for each machine's checkout (`machine`, how to reach it, its path).
async fn round(project: &str, hub: &Path, checkouts: &[(Machine, String)]) -> HubSync {
    let mut machines: Vec<HubMachine> = Vec::new();
    for (machine, path) in checkouts {
        let spec = format!("+refs/heads/*:{}/*", collected(machine.name()));
        let fetched = hub_git(hub, &["fetch", "--quiet", "--prune", "--no-tags", &git_url(machine, path), &spec]).await;
        machines.push(HubMachine { machine: machine.name().to_string(), collected: fetched.is_ok(), handed_out: false, error: fetched.err() });
    }
    let listing = hub_git(hub, &["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/arbor", "refs/heads"]).await.unwrap_or_default();
    let mut tips: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut current: BTreeMap<String, String> = BTreeMap::new();
    for line in listing.lines() {
        let Some((refname, object)) = line.split_once('\t') else { continue };
        if let Some(branch) = refname.strip_prefix("refs/heads/") {
            current.insert(branch.to_string(), object.to_string());
        } else if let Some((machine, branch)) = refname.strip_prefix("refs/arbor/").and_then(|rest| rest.split_once('/')) {
            // Only machines collected this round count; one that couldn't be reached keeps its old copy out of it.
            if machines.iter().any(|entry| entry.collected && normalize_machine_name(&entry.machine) == machine) {
                tips.entry(branch.to_string()).or_default().push((machine.to_string(), object.to_string()));
            }
        }
    }
    let mut branches = Vec::new();
    for (branch, found) in &tips {
        let objects: Vec<&str> = found.iter().map(|(_, object)| object.as_str()).collect();
        let before = current.get(branch).map(String::as_str);
        // Ancestry, asked of the hub once per pair.
        let mut known: BTreeMap<(String, String), bool> = BTreeMap::new();
        for a in objects.iter().copied().chain(before) {
            for b in objects.iter().copied().chain(before) {
                if a != b && !known.contains_key(&(a.to_string(), b.to_string())) {
                    let is = hub_git(hub, &["merge-base", "--is-ancestor", a, b]).await.is_ok();
                    known.insert((a.to_string(), b.to_string()), is);
                }
            }
        }
        let is_ancestor = |a: &str, b: &str| known.get(&(a.to_string(), b.to_string())).copied().unwrap_or(false);
        let state = match choose_tip(before, &objects, is_ancestor) {
            Some(tip) if Some(tip) == before => HubBranchState::Same,
            Some(tip) => {
                let old = before.unwrap_or("0000000000000000000000000000000000000000");
                match hub_git(hub, &["update-ref", &format!("refs/heads/{branch}"), tip, old]).await {
                    Ok(_) if before.is_some() => HubBranchState::Advanced,
                    Ok(_) => HubBranchState::New,
                    Err(_) => HubBranchState::Same,
                }
            }
            None => HubBranchState::Diverged,
        };
        // Named as Arbor names the machines, not by the keys the hub files their branches under.
        let named = |key: &str| machines.iter().find(|entry| normalize_machine_name(&entry.machine) == key).map_or_else(|| key.to_string(), |entry| entry.machine.clone());
        let apart = if state == HubBranchState::Diverged { found.iter().map(|(machine, _)| named(machine)).collect() } else { Vec::new() };
        branches.push(HubBranch { branch: branch.clone(), state, apart });
    }
    for ((machine, path), entry) in checkouts.iter().zip(machines.iter_mut()) {
        if !entry.collected {
            continue;
        }
        match hand_out(hub, &git_url(machine, path)).await {
            Ok(()) => entry.handed_out = true,
            Err(error) => entry.error = Some(error),
        }
    }
    HubSync { project: project.to_string(), branches, machines }
}

/// The checkouts of local `project` at their places, with how to reach each machine.
pub(super) fn local_checkouts(found: &super::setup_sync::SetupRepo, inner: &Inner, project: &str) -> Vec<(Machine, String)> {
    drift(found.layers(), &arbor_machines(inner), &inner.projects)
        .cells_of(project)
        .into_iter()
        .filter(|cell| matches!(cell.state(), PlaceState::InPlace | PlaceState::Linked))
        .filter_map(|cell| Some((covered_machine(inner, cell.machine()).ok()?.0, cell.checkout()?.to_string())))
        .collect()
}

/// A round through the hub for every local project with a checkout at its place: the background fetch's part for
/// projects with no remote. Nothing before the window has named a setup repo, or with none of them.
pub(super) async fn sync_all_local(app: &tauri::AppHandle, repo: &str) {
    let Ok(found) = super::setup_sync::read_repo(Path::new(repo)).await else { return };
    for (project, hub) in hubs(found.layers().local_projects(), hub_dir) {
        let checkouts = local_checkouts(&found, &app.state::<MachineHealthState>().lock(), &project);
        if checkouts.is_empty() || ensure_hub(&hub).await.is_err() {
            continue;
        }
        round(&project, &hub, &checkouts).await;
    }
}

/// Keeps local `project`'s checkouts in step through the hub on this Mac: collects each machine's branches, moves the
/// hub's forward where one machine's copy is ahead of the rest, and hands them back out as `arbor/<branch>`.
#[tauri::command]
pub(crate) async fn sync_local_project(app: tauri::AppHandle, state: tauri::State<'_, MachineHealthState>, repo: String, project: String) -> Result<HubSync, String> {
    let found = super::setup_sync::read_repo(Path::new(&repo)).await?;
    let entry = found.layers().project(&project).ok_or_else(|| format!("The setup repo has no project {project}"))?;
    let name = project.strip_prefix("_local/").filter(|_| entry.remote().is_none()).ok_or("Only a project with no remote goes through the hub")?.to_string();
    let checkouts = {
        let mut inner = state.lock();
        inner.setup_repo = Some(repo.clone());
        local_checkouts(&found, &inner, &project)
    };
    if checkouts.is_empty() {
        return Err(format!("No machine has a checkout of {project} at its place yet"));
    }
    let hub = hub_dir(&name)?;
    ensure_hub(&hub).await?;
    let synced = round(&project, &hub, &checkouts).await;
    for machine in checkouts.iter().map(|(machine, _)| machine.name().to_string()).collect::<BTreeSet<_>>() {
        let _ = super::setup_projects::scan_projects(app.clone(), app.state(), machine, None, Some(repo.clone())).await;
    }
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_without_a_hub_is_skipped_and_the_round_goes_on() {
        let projects = ["_local/..", "_local/idler", "cam/arbor", "_local/notes"].map(String::from).to_vec();
        let found = hubs(projects, |name| hub_dir(name).map(|_| PathBuf::from(format!("/hubs/{name}.git"))));
        assert_eq!(found, [("_local/idler".to_string(), PathBuf::from("/hubs/idler.git")), ("_local/notes".to_string(), PathBuf::from("/hubs/notes.git"))]);
        assert!(hub_dir("a/b").is_err() && hub_dir("").is_err());
    }

    #[test]
    fn a_branch_moves_to_the_copy_every_other_one_is_behind_and_never_merges() {
        // a ← b ← c in history; d went its own way from a.
        let history = [("a", "b"), ("a", "c"), ("b", "c"), ("a", "d")];
        let is_ancestor = |x: &str, y: &str| history.contains(&(x, y));
        assert_eq!(choose_tip(Some("a"), &["b", "c"], is_ancestor), Some("c"));
        assert_eq!(choose_tip(Some("c"), &["b"], is_ancestor), Some("c"));
        assert_eq!(choose_tip(None, &["b", "b"], is_ancestor), Some("b"));
        assert_eq!(choose_tip(Some("a"), &["c", "d"], is_ancestor), None);
        assert_eq!(choose_tip(Some("c"), &["d"], is_ancestor), None);
    }

    #[test]
    fn a_machine_is_reached_as_arbor_reaches_it() {
        let machine = |endpoint: &str, local: bool| {
            let host = MachineHost { machine: "ci-01".into(), endpoint: endpoint.into(), port: 2222, enabled: true, source: String::new() };
            if local { Machine::this_mac("cam-mbp") } else { Machine::for_test(host) }
        };
        assert_eq!(git_url(&machine("", true), "/Users/cam/code/_local/idler"), "/Users/cam/code/_local/idler");
        assert_eq!(git_url(&machine("ci-01", false), "/home/cam/code/_local/idler"), "ssh://ci-01:2222/home/cam/code/_local/idler");
        assert_eq!(git_url(&machine("cam@fd7a::1", false), "/x"), "ssh://cam@[fd7a::1]:2222/x");
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;
        use crate::usage::machine_health::shell::shells;
        use std::fs;

        fn temp_dir(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-hub-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            dir.canonicalize().unwrap()
        }

        fn git(dir: &Path, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(["-c", "user.name=Arbor", "-c", "user.email=arbor@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn commit(dir: &Path, text: &str) {
            fs::write(dir.join("notes.txt"), text).unwrap();
            git(dir, &["add", "."]);
            git(dir, &["commit", "-qm", text]);
        }

        fn block<T>(future: impl std::future::Future<Output = T>) -> T {
            tokio::runtime::Runtime::new().unwrap().block_on(future)
        }

        #[test]
        fn machines_meet_through_the_hub_and_a_branch_that_moved_apart_is_left_alone() {
            let root = temp_dir("round");
            let (a, b, hub) = (root.join("home/code/_local/idler"), root.join("b"), root.join("hub.git"));
            fs::create_dir_all(&a).unwrap();
            git(&a, &["init", "-q"]);
            commit(&a, "one");
            git(&root, &["clone", "-q", a.to_str().unwrap(), b.to_str().unwrap()]);
            git(&b, &["remote", "remove", "origin"]);
            block(ensure_hub(&hub)).unwrap();
            let checkouts = vec![(Machine::this_mac("cam-mbp"), a.display().to_string()), (Machine::this_mac("ci-01"), b.display().to_string())];

            commit(&a, "two");
            let first = block(round("_local/idler", &hub, &checkouts));
            assert_eq!(first.branches, vec![HubBranch { branch: "main".into(), state: HubBranchState::New, apart: vec![] }], "{first:?}");
            assert!(first.machines.iter().all(|machine| machine.collected && machine.handed_out), "{first:?}");
            assert_eq!(git(&b, &["rev-parse", "refs/remotes/arbor/main"]), git(&a, &["rev-parse", "HEAD"]));

            // b's place scan reads it as behind the hub's copy, as Sync › Projects shows it.
            for shell in shells() {
                let found = crate::usage::machine_health::setup_projects::places_found(shell, &root.join("home"), &["~/code/_local/idler".into(), b.display().to_string()]);
                let behind = &found[1].status;
                assert_eq!((behind.upstream.as_deref(), behind.behind), (Some("arbor/main"), Some(1)), "{shell}");
            }
            git(&b, &["merge", "--ff-only", "-q", "refs/remotes/arbor/main"]);

            // b moves on alone: the hub follows it.
            commit(&b, "three");
            let second = block(round("_local/idler", &hub, &checkouts));
            assert_eq!(second.branches[0].state, HubBranchState::Advanced);
            assert_eq!(git(&hub, &["rev-parse", "refs/heads/main"]), git(&b, &["rev-parse", "HEAD"]));

            // Both move on apart: nothing moves, and it says which machines.
            git(&a, &["merge", "--ff-only", "-q", "refs/remotes/arbor/main"]);
            commit(&a, "four-a");
            commit(&b, "four-b");
            let before = git(&hub, &["rev-parse", "refs/heads/main"]);
            let third = block(round("_local/idler", &hub, &checkouts));
            assert_eq!(third.branches[0].state, HubBranchState::Diverged);
            assert_eq!(third.branches[0].apart, vec!["cam-mbp".to_string(), "ci-01".to_string()]);
            assert_eq!(git(&hub, &["rev-parse", "refs/heads/main"]), before);
            let _ = fs::remove_dir_all(&root);
        }
    }
}
