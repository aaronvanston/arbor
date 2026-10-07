//! Where each of the setup repo's projects is on each machine, against where the repo wants it (setup_layers).
//!
//! A machine's project scan (setup_projects) looks at each wanted place as well as the checkouts sessions point at,
//! so this only compares: in place, linked there, a checkout elsewhere with the place free, missing, or something
//! else in the way. One checkout per machine counts, the one the place leads to, else the most recently used; the
//! others are listed and never counted as drift. See docs/internals/projects-and-machines.md.

use super::setup_layers::{arbor_machines, ProjectPlaces, SetupLayers};
use super::setup_projects::{normalize_remote, CheckoutStatus, FoundCheckout, FoundPlace, MachineProjects, PlaceKind};
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

/// How a project stands at its place on one machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlaceState {
    /// The place is a checkout of the project.
    InPlace,
    /// The place is a link to a checkout of the project.
    Linked,
    /// A checkout is elsewhere on the machine, and the place is free for a link to it.
    Elsewhere,
    /// No checkout on the machine, and the place is free for one.
    Missing,
    /// Something else is at the place.
    Blocked,
    /// The machine's projects haven't been scanned with this place in mind yet.
    NotScanned,
}

/// A project on one machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectCell {
    machine: String,
    /// Where the repo wants it, `~/…` or absolute.
    path: String,
    state: PlaceState,
    /// For Blocked, what's there, and when it's another repo's checkout, that repo.
    blocker: Option<PlaceKind>,
    blocker_remote: Option<String>,
    /// Where the place leads, for Linked.
    link: Option<String>,
    /// The checkout that counts: the place's folder, or the one a link would lead to.
    checkout: Option<String>,
    /// How that checkout stands.
    status: Option<CheckoutStatus>,
    /// Its other checkouts on the machine, which are never moved or counted.
    others: Vec<String>,
    /// Of the project's own skills, the copies its checkouts and worktrees here should have, and how many of them
    /// are missing or out of date. A folder left alone as the project's own counts as in step.
    skills_total: u32,
    skills_out: u32,
    /// What it needs before it's where the repo wants it and up to date, in the order it'd be done. Sync's standing
    /// counts a project behind on a machine from this, so Sync › Projects and Overview never disagree.
    needs: Vec<CellNeed>,
}

impl ProjectCell {
    pub(super) fn state(&self) -> PlaceState {
        self.state
    }

    pub(super) fn path(&self) -> &str {
        &self.path
    }

    pub(super) fn machine(&self) -> &str {
        &self.machine
    }

    pub(super) fn checkout(&self) -> Option<&str> {
        self.checkout.as_deref()
    }

    pub(super) fn status(&self) -> Option<&CheckoutStatus> {
        self.status.as_ref()
    }

    #[cfg(test)]
    pub(super) fn for_test(state: PlaceState, path: &str, checkout: Option<&str>, status: Option<CheckoutStatus>) -> Self {
        ProjectCell { machine: "ci-01".into(), path: path.into(), state, blocker: None, blocker_remote: None, link: None, checkout: checkout.map(str::to_string), status, others: Vec::new(), skills_total: 0, skills_out: 0, needs: Vec::new() }
    }
}

/// A checkout of a project on a machine it isn't assigned to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placed {
    machine: String,
    path: String,
}

/// A project and where it stands on each machine it's on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDrift {
    project: String,
    local: bool,
    archived: bool,
    remote: Option<String>,
    branch: Option<String>,
    cells: Vec<ProjectCell>,
    /// Machines it lists that Arbor doesn't watch.
    unknown: Vec<String>,
    /// Checkouts on machines it doesn't list.
    unassigned: Vec<Placed>,
}

/// A checkout a scan found whose repo isn't one of the setup repo's projects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnlistedCheckout {
    machine: String,
    path: String,
    /// `host/owner/name`; None for a repo with no remote.
    remote: Option<String>,
}

/// A machine's project scan, as far as Sync › Projects needs it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriftMachine {
    machine: String,
    scanned_at: Option<i64>,
    scanning: bool,
    error: Option<String>,
}

/// Every project's places against what the machines' last scans found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectsDrift {
    projects: Vec<ProjectDrift>,
    unlisted: Vec<UnlistedCheckout>,
    machines: Vec<DriftMachine>,
}

impl ProjectsDrift {
    /// How `project` stands on each machine it's on.
    pub(super) fn cells_of(&self, project: &str) -> Vec<ProjectCell> {
        self.projects.iter().filter(|found| found.project == project && !found.archived).flat_map(|found| found.cells.clone()).collect()
    }

    /// Each project on `machine`: its key, how it stands there, its remote and branch, and whether it's local.
    pub(super) fn on_machine(&self, machine: &str) -> Vec<(String, ProjectCell, Option<String>, Option<String>, bool)> {
        self.projects
            .iter()
            .filter(|project| !project.archived)
            .filter_map(|project| {
                let cell = project.cells.iter().find(|cell| cell.machine == machine)?;
                Some((project.project.clone(), cell.clone(), project.remote.clone(), project.branch.clone(), project.local))
            })
            .collect()
    }
}

/// A remote as compared: lowercase `host/owner/name`.
fn remote_key(remote: &str) -> Option<String> {
    normalize_remote(remote).filter(|remote| !remote.starts_with('/'))
}

/// A checkout's remote as compared. The scan gives it as `host/owner/name` already; a folder isn't one.
fn scanned_key(checkout: &FoundCheckout) -> Option<String> {
    checkout.remote.as_ref().filter(|remote| !remote.starts_with('/')).map(|remote| remote.to_ascii_lowercase())
}

/// How one project stands on one machine, from that machine's scan.
fn cell(project: &ProjectPlaces, machine: &str, path: &str, scan: Option<&MachineProjects>, checkouts: &[FoundCheckout]) -> ProjectCell {
    let mut cell = ProjectCell {
        machine: machine.to_string(),
        path: path.to_string(),
        state: PlaceState::NotScanned,
        blocker: None,
        blocker_remote: None,
        link: None,
        checkout: None,
        status: None,
        others: Vec::new(),
        skills_total: 0,
        skills_out: 0,
        needs: Vec::new(),
    };
    let Some(place) = scan.and_then(|scan| scan.places().iter().find(|place| place.path == path)) else {
        return cell;
    };
    let wanted = project.remote.as_deref().and_then(remote_key);
    // A local project's checkouts have no remote to tell them by, so only its place can be one.
    let ours: Vec<&FoundCheckout> = match &wanted {
        Some(wanted) => checkouts.iter().filter(|checkout| scanned_key(checkout).as_ref() == Some(wanted)).collect(),
        None => Vec::new(),
    };
    let is_ours = |place: &FoundPlace| match &wanted {
        Some(wanted) => place.remote.as_ref() == Some(wanted),
        None => project.local && place.remote.is_none(),
    };
    let real = place.real.as_deref();
    let others = |counted: Option<&str>| -> Vec<String> {
        ours.iter()
            .filter(|checkout| counted.is_none_or(|counted| checkout.path != counted && checkout.real.as_deref() != Some(counted)))
            .map(|checkout| checkout.path.clone())
            .collect()
    };
    match place.kind {
        PlaceKind::Checkout if is_ours(place) => {
            cell.state = if place.link.is_some() { PlaceState::Linked } else { PlaceState::InPlace };
            cell.link = place.link.clone();
            cell.checkout = real.map(str::to_string);
            cell.status = Some(place.status.clone());
            cell.others = others(real);
        }
        PlaceKind::Missing | PlaceKind::Empty => match ours.first() {
            Some(first) => {
                cell.state = PlaceState::Elsewhere;
                cell.checkout = Some(first.path.clone());
                cell.status = Some(first.status.clone());
                cell.others = others(Some(&first.path));
            }
            None => cell.state = PlaceState::Missing,
        },
        kind => {
            cell.state = PlaceState::Blocked;
            cell.blocker = Some(kind);
            cell.blocker_remote = place.remote.clone();
            cell.others = others(None);
        }
    }
    cell
}

/// What a project's cell needs before the project is where the repo wants it on that machine and up to date.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CellNeed {
    /// A checkout is elsewhere: a link at the place.
    Link,
    /// No checkout on the machine.
    Clone,
    /// Something else is at the place, which is the user's to clear.
    Clear,
    /// The machine's projects haven't been scanned with this place in mind. Never counted as behind.
    Scan,
    /// The checkout is behind its upstream on the remote's default branch.
    Pull,
    /// The last fetch failed.
    Fetch,
    /// Copies of the project's own skills are missing or out of date.
    Skills,
}

/// How far a checkout is behind, counted only on the remote's default branch, the one Sync keeps up to date.
fn behind_on_default(status: &CheckoutStatus) -> u32 {
    let behind = status.behind.unwrap_or(0);
    if behind == 0 || status.upstream.is_none() || status.branch.is_none() {
        return 0;
    }
    if status.default_branch.is_none() || status.upstream == status.default_branch { behind } else { 0 }
}

/// What a cell needs, in the order it'd be done: the place first, then bringing the checkout up to date.
pub(super) fn cell_needs(cell: &ProjectCell) -> Vec<CellNeed> {
    let mut needs = Vec::new();
    match cell.state {
        PlaceState::InPlace | PlaceState::Linked => {}
        PlaceState::Elsewhere => needs.push(CellNeed::Link),
        PlaceState::Missing => needs.push(CellNeed::Clone),
        PlaceState::Blocked => needs.push(CellNeed::Clear),
        PlaceState::NotScanned => needs.push(CellNeed::Scan),
    }
    if let Some(status) = &cell.status {
        if status.fetch_failed {
            needs.push(CellNeed::Fetch);
        }
        if behind_on_default(status) > 0 {
            needs.push(CellNeed::Pull);
        }
    }
    if cell.skills_out > 0 {
        needs.push(CellNeed::Skills);
    }
    needs
}

impl ProjectsDrift {
    /// Each project on record, archived ones aside, that `machine` is behind on: one that needs something there besides
    /// a scan. Its key and name.
    pub(super) fn behind_on(&self, machine: &str) -> Vec<&str> {
        self.projects
            .iter()
            .filter(|project| !project.archived)
            .filter(|project| project.cells.iter().any(|cell| cell.machine == machine && cell.needs.iter().any(|need| *need != CellNeed::Scan)))
            .map(|project| project.project.as_str())
            .collect()
    }
}

/// How many copies of a project's own skills its checkouts and worktrees on a machine should have, and how many are
/// missing or out of date, from the machine's last scan.
fn skill_standing(cell: &ProjectCell, scan: &MachineProjects, skills: &[(&str, &str, &str)], remote: Option<&str>) -> (u32, u32) {
    if skills.is_empty() || matches!(cell.state, PlaceState::NotScanned | PlaceState::Missing | PlaceState::Blocked) {
        return (0, 0);
    }
    let place = cell.checkout.as_deref().filter(|_| matches!(cell.state, PlaceState::InPlace | PlaceState::Linked));
    let remote = remote.and_then(normalize_remote);
    let (mut total, mut out) = (0, 0);
    for worktree in scan.project_worktrees(remote.as_deref(), place) {
        let records = scan.arbor_skills(&worktree);
        for (name, sum, ck) in skills {
            for sub in super::project_skills::SKILL_DIRS {
                let rel = format!("{sub}/{name}");
                total += 1;
                let own = records.iter().any(|(found, _)| found.strip_prefix('!') == Some(rel.as_str()));
                let current = records.iter().any(|(found, print)| *found == rel && (print.strip_prefix('D') == Some(sum) || print.strip_prefix('D') == Some(ck)));
                if !own && !current {
                    out += 1;
                }
            }
        }
    }
    (total, out)
}

/// Every project's places against `scans`, each machine's last project scan by its name, for `machines`, the machines
/// Arbor watches.
pub(super) fn drift(layers: &SetupLayers, machines: &[String], scans: &BTreeMap<String, MachineProjects>) -> ProjectsDrift {
    let found: BTreeMap<&str, Vec<FoundCheckout>> = scans.iter().map(|(machine, scan)| (machine.as_str(), scan.main_checkouts())).collect();
    let empty = Vec::new();
    let places = layers.places(machines);
    let mut on_record: BTreeSet<String> = BTreeSet::new();
    let mut local_places: BTreeSet<(String, String)> = BTreeSet::new();
    let projects = places
        .iter()
        .map(|project| {
            if let Some(remote) = project.remote.as_deref().and_then(remote_key) {
                on_record.insert(remote);
            }
            let cells: Vec<ProjectCell> = project
                .places
                .iter()
                .map(|place| {
                    let scan = scans.get(&place.machine);
                    let mut cell = cell(project, &place.machine, &place.path, scan, found.get(place.machine.as_str()).unwrap_or(&empty));
                    if let (Some(scan), Some(entry)) = (scan, layers.project(&project.project)) {
                        (cell.skills_total, cell.skills_out) = skill_standing(&cell, scan, &entry.own_skill_prints(), project.remote.as_deref());
                    }
                    cell.needs = cell_needs(&cell);
                    cell
                })
                .collect();
            for cell in cells.iter().filter(|_| project.local) {
                if let Some(checkout) = &cell.checkout {
                    local_places.insert((cell.machine.clone(), checkout.clone()));
                }
            }
            let assigned: BTreeSet<&str> = project.places.iter().map(|place| place.machine.as_str()).collect();
            let wanted = project.remote.as_deref().and_then(remote_key);
            let unassigned = match (&wanted, project.archived) {
                (Some(wanted), false) => found
                    .iter()
                    .filter(|(machine, _)| !assigned.contains(*machine))
                    .flat_map(|(machine, checkouts)| {
                        checkouts
                            .iter()
                            .filter(|checkout| scanned_key(checkout).as_ref() == Some(wanted))
                            .map(|checkout| Placed { machine: machine.to_string(), path: checkout.path.clone() })
                    })
                    .collect(),
                _ => Vec::new(),
            };
            ProjectDrift {
                project: project.project.clone(),
                local: project.local,
                archived: project.archived,
                remote: project.remote.clone(),
                branch: project.branch.clone(),
                cells,
                unknown: project.unknown.clone(),
                unassigned,
            }
        })
        .collect();
    let unlisted = found
        .iter()
        .flat_map(|(machine, checkouts)| {
            checkouts
                .iter()
                .filter(|checkout| match scanned_key(checkout) {
                    Some(remote) => !on_record.contains(&remote),
                    None => [Some(&checkout.path), checkout.real.as_ref()].into_iter().flatten().all(|path| !local_places.contains(&(machine.to_string(), path.clone()))),
                })
                .map(|checkout| UnlistedCheckout { machine: machine.to_string(), path: checkout.path.clone(), remote: checkout.remote.clone() })
        })
        .collect();
    let machines = machines
        .iter()
        .map(|machine| {
            let scan = scans.get(machine);
            DriftMachine {
                machine: machine.clone(),
                scanned_at: scan.and_then(MachineProjects::scanned_at),
                scanning: scan.is_some_and(MachineProjects::is_scanning),
                error: scan.and_then(|scan| scan.error().map(str::to_string)),
            }
        })
        .collect();
    ProjectsDrift { projects, unlisted, machines }
}

/// How often the checkouts at the projects' places are fetched while Arbor is open.
const FETCH_EVERY: Duration = Duration::from_secs(60 * 60);

/// Fetches the checkouts at each machine's project places every hour, so behind counts don't go stale. Only
/// remote-tracking refs change; bringing a branch up to date stays a fix the user picks.
pub(crate) fn start_place_fetcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(FETCH_EVERY).await;
            let machines = arbor_machines(&app.state::<MachineHealthState>().lock());
            // Local projects first, so the fetch after reads each checkout against the hub's latest.
            let named = app.state::<MachineHealthState>().lock().setup_repo.clone();
            // After a restart the window hasn't named the repo yet; the setting it saves does.
            let repo = named.or_else(|| app.state::<crate::saved_store::SavedStoreState>().value(super::setup_layers::SETUP_REPO_SETTING)).filter(|repo| !repo.is_empty());
            if let Some(repo) = repo {
                super::project_hub::sync_all_local(&app, &repo).await;
            }
            for machine in machines {
                // A machine that's away, or busy with a scan, is tried again next round.
                let _ = super::setup_projects::fetch_places(&app, &machine).await;
            }
        }
    });
}

/// Where each of the setup repo's projects stands on each machine, from the machines' last project scans. Remembers
/// `repo` as the one the window names, so scans started elsewhere look at its places too.
#[tauri::command]
pub(crate) async fn get_project_drift(state: tauri::State<'_, MachineHealthState>, repo: String) -> Result<ProjectsDrift, String> {
    state.lock().setup_repo = Some(repo.clone());
    let found = super::setup_sync::read_repo(Path::new(&repo)).await?;
    let inner = state.lock();
    Ok(drift(found.layers(), &arbor_machines(&inner), &inner.projects))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::setup_layers::{layer_path, read_layers};

    fn layers(files: &[(&str, &str)]) -> SetupLayers {
        read_layers(files.iter().map(|(rel, text)| (rel.to_string(), layer_path(rel).unwrap(), text.as_bytes().to_vec())).collect(), &[])
    }

    /// One repo as the scan prints it: its main checkout, how it stands and its linked worktrees.
    fn repo(path: &str, remote: Option<&str>, linked: &[&str]) -> String {
        let mut lines = format!("R\t{path}\tok\n");
        if let Some(remote) = remote {
            lines += &format!("O\t{remote}\nD\trefs/remotes/origin/main\n");
        }
        lines += &format!("T\t{path}\tabc\tmain\t-\t1\nS\t2\t0\t1\t-\t-\t0\t0\t0\t0\t0\t{path}\n");
        for worktree in linked {
            lines += &format!("T\t{worktree}\tdef\tfix\t-\t0\n");
        }
        lines
    }

    fn scans(found: &[(&str, String)]) -> BTreeMap<String, MachineProjects> {
        found.iter().map(|(machine, stdout)| (machine.to_string(), MachineProjects::from_scan(machine, stdout))).collect()
    }

    fn states(drift: &ProjectsDrift, project: &str) -> Vec<(String, PlaceState)> {
        drift.projects.iter().find(|found| found.project == project).unwrap().cells.iter().map(|cell| (cell.machine.clone(), cell.state)).collect()
    }

    const ARBOR: &str = r#"{"remote": "git@github.com:cam/arbor.git", "machines": "all"}"#;

    #[test]
    fn each_machine_is_in_place_linked_elsewhere_missing_or_blocked() {
        let found = layers(&[("projects/cam/arbor/project.json", ARBOR)]);
        let place = "~/code/cam/arbor";
        let scans = scans(&[
            ("cam-mbp", format!("H\t/Users/cam\n{}K\t{place}\tcheckout\t/Users/cam/src/arbor\t/Users/cam/src/arbor\nKO\tgit@github.com:cam/arbor.git\nKS\tmain\t0\t0\torigin/main\t[behind 3]\torigin/main\t1700000000\t2\n", repo("/Users/cam/src/arbor", Some("https://github.com/cam/arbor"), &["/Users/cam/.wt/a", "/Users/cam/.wt/b"]))),
            ("ci-01", format!("{}{}K\t{place}\tmissing\t-\t-\n", repo("/home/cam/arbor", Some("git@github.com:cam/arbor.git"), &[]), repo("/srv/arbor-old", Some("git@github.com:Cam/Arbor"), &[]))),
            ("cedar-02", format!("K\t{place}\tcheckout\t-\t/home/cam/code/cam/arbor\nKO\thttps://github.com/cam/arbor.git\nKS\tmain\t0\t0\t-\t-\t-\t-\t0\n")),
            ("lab-box", format!("K\t{place}\tempty\t-\t/home/cam/code/cam/arbor\n")),
            ("studio", format!("K\t{place}\tcheckout\t-\t/home/cam/code/cam/arbor\nKO\tgit@github.com:cam/site.git\n")),
        ]);
        let machines: Vec<String> = ["cam-mbp", "ci-01", "cedar-02", "lab-box", "studio", "build-01"].map(String::from).to_vec();
        let drift = drift(&found, &machines, &scans);
        assert_eq!(
            states(&drift, "cam/arbor"),
            vec![
                ("cam-mbp".into(), PlaceState::Linked),
                ("ci-01".into(), PlaceState::Elsewhere),
                ("cedar-02".into(), PlaceState::InPlace),
                ("lab-box".into(), PlaceState::Missing),
                ("studio".into(), PlaceState::Blocked),
                ("build-01".into(), PlaceState::NotScanned),
            ]
        );
        let cells = &drift.projects[0].cells;
        let mbp = &cells[0];
        assert_eq!(mbp.link.as_deref(), Some("/Users/cam/src/arbor"));
        assert_eq!(mbp.status.as_ref().map(|status| (status.behind, status.worktrees)), Some((Some(3), 2)));
        // The checkout the link leads to is the one that counts, not another.
        assert!(mbp.others.is_empty());
        let ci = &cells[1];
        assert_eq!(ci.checkout.as_deref(), Some("/home/cam/arbor"));
        assert_eq!(ci.others, vec!["/srv/arbor-old".to_string()]);
        let studio = &cells[4];
        assert_eq!((studio.blocker, studio.blocker_remote.as_deref()), (Some(PlaceKind::Checkout), Some("github.com/cam/site")));
        assert!(drift.unlisted.is_empty(), "{:?}", drift.unlisted);
    }

    #[test]
    fn checkouts_on_machines_it_doesnt_list_and_repos_not_on_record_are_said() {
        let found = layers(&[
            ("projects/cam/arbor/project.json", r#"{"remote": "git@github.com:cam/arbor.git", "machines": {"ci-01": {}}}"#),
            ("projects/_local/scratch/project.json", r#"{"machines": {"ci-01": {}}}"#),
            ("projects/_archive/cam/old/project.json", r#"{"remote": "git@github.com:cam/old.git", "machines": "all"}"#),
        ]);
        let scans = scans(&[
            ("ci-01", format!("{}{}K\t~/code/cam/arbor\tmissing\t-\t-\nK\t~/code/_local/scratch\tcheckout\t-\t/home/cam/code/_local/scratch\nKS\tmain\t0\t0\t-\t-\t-\t-\t0\n", repo("/home/cam/code/_local/scratch", None, &[]), repo("/home/cam/tmp", None, &[]))),
            ("cam-mbp", format!("{}{}", repo("/Users/cam/arbor", Some("git@github.com:cam/arbor.git"), &[]), repo("/Users/cam/old", Some("git@github.com:cam/old.git"), &[]) + &repo("/Users/cam/site", Some("git@github.com:cam/site.git"), &[]))),
        ]);
        let drift = drift(&found, &["cam-mbp".to_string(), "ci-01".to_string()], &scans);
        assert_eq!(states(&drift, "cam/arbor"), vec![("ci-01".into(), PlaceState::Missing)]);
        assert_eq!(states(&drift, "_local/scratch"), vec![("ci-01".into(), PlaceState::InPlace)]);
        let arbor = drift.projects.iter().find(|found| found.project == "cam/arbor").unwrap();
        assert_eq!(arbor.unassigned, vec![Placed { machine: "cam-mbp".into(), path: "/Users/cam/arbor".into() }]);
        // An archived project is still on record, so its checkouts aren't unlisted, and it's planned nowhere.
        assert!(states(&drift, "cam/old").is_empty());
        let unlisted: Vec<(&str, &str)> = drift.unlisted.iter().map(|found| (found.machine.as_str(), found.path.as_str())).collect();
        assert_eq!(unlisted, vec![("cam-mbp", "/Users/cam/site"), ("ci-01", "/home/cam/tmp")]);
    }

    #[test]
    fn skill_copies_count_out_of_step_unless_current_or_the_projects_own() {
        let files = [("projects/cam/arbor/project.json", ARBOR)];
        let mut found = read_layers(files.iter().map(|(rel, text)| (rel.to_string(), layer_path(rel).unwrap(), text.as_bytes().to_vec())).collect(), &[("projects/cam/arbor".into(), "digest".into())]);
        found.projects_mut()[0].set_skill_print("digest", &"a".repeat(64), "c1-2");
        let sum = "a".repeat(64);
        let place = "~/code/cam/arbor";
        // Main checkout: Claude's copy current, the shared one out of date. Its worktree: Claude's is the project's own,
        // the shared one missing.
        let stdout = format!(
            "K\t{place}\tcheckout\t-\t/h/code/cam/arbor\nKO\tgit@github.com:cam/arbor.git\nKS\tmain\t0\t0\t-\t-\t-\t-\t1\n\
             R\t/h/code/cam/arbor\tok\nO\tgit@github.com:cam/arbor.git\n\
             T\t/h/code/cam/arbor\tabc\tmain\t-\t1\nS\t0\t0\t1\t-\t-\t0\t0\t0\t0\t0\t/h/code/cam/arbor\n\
             Y\t.claude/skills/digest\tD{sum}\nY\t.agents/skills/digest\tDbbbb\n\
             T\t/h/wt\tdef\tfix\t-\t0\nS\t0\t0\t0\t-\t-\t0\t0\t0\t0\t0\t/h/wt\n\
             Y\t!.claude/skills/digest\t-\n"
        );
        let scans = scans(&[("ci-01", stdout)]);
        let drift = drift(&found, &["ci-01".to_string()], &scans);
        let cell = &drift.projects[0].cells[0];
        assert_eq!(cell.state, PlaceState::InPlace);
        assert_eq!((cell.skills_total, cell.skills_out), (4, 2));
    }
}
