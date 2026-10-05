//! Skills: each machine keeps one store of skills, ~/.agents/skills, which
//! Codex loads itself. Claude Code loads only a home's own skills folder, so a
//! Claude Code home loads a store skill through a link to it, and turning a
//! skill on or off there adds or removes that link. The store also takes in a
//! home's own copies: a copy gives way to a link to the store's, and a skill the
//! store hasn't got moves into it.
//!
//! Changes are made the way setup sync makes them, into the same backups:
//! nothing changes unless every skill is still as the last scan found it,
//! whatever's moved aside or removed is kept in the backup first, and the change
//! can be undone.

use super::shell::shell_quote;
use ts_rs::TS;
use super::setup::{covered_machine, home_agent, home_harness, rescan, skills_link, HomeAgent, HELPERS};
use super::guarded_writes::{new_stamp, parse_outcome, prune_backups, record_backup, run_on, start_backup, ChangeKind, SyncOutcome};
use super::*;
use std::collections::BTreeSet;

/// What a change does to a skill in one home.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillAction {
    /// Links the store's skill into a Claude Code home that has nothing by its name.
    Link,
    /// Puts a Claude Code home's own copy aside and links the store's in its place.
    UseStore,
    /// Moves a home's own copy into the store, putting the store's aside, and
    /// links it back into a Claude Code home. Codex loads it from the store.
    Adopt,
    /// Puts a home's own copy or link aside.
    Remove,
}

impl SkillAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Link => "link",
            Self::UseStore => "useStore",
            Self::Adopt => "adopt",
            Self::Remove => "remove",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        [Self::Link, Self::UseStore, Self::Adopt, Self::Remove].into_iter().find(|action| action.as_str() == value)
    }
}

/// A change to a skill in one home, as the page asks for it.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillChange {
    /// The home, as the scan names it: ~/.claude.
    home: String,
    /// The skill's folder name.
    name: String,
    action: SkillAction,
    /// What the last scan found by that name in the home, and in the store: `-`
    /// for nothing, `D` and a skill folder's fingerprint, `L` and where a link leads.
    home_before: String,
    store_before: String,
}

/// A change to a skill in one home, as it's made and as its backup lists it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupSkill {
    /// As the scan names it: ~/.claude.
    home: String,
    name: String,
    action: SkillAction,
    /// A home that loads store skills through links, as Claude Code's does, rather than loading the store itself.
    /// A backup's list keeps the words it always had for the two: `claude` and `codex`.
    #[serde(skip)]
    links: bool,
    #[serde(skip)]
    home_before: String,
    #[serde(skip)]
    store_before: String,
}

/// A name a skill's folder can have, that can't lead anywhere else.
pub(super) fn is_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

/// A home under the machine's home folder, as a path in it: `.claude`.
pub(super) fn home_relative(home: &str) -> Option<&str> {
    home.strip_prefix("~/").filter(|rel| plain_path(rel))
}

/// A home as scripts take it: a path in the machine's home folder (`.claude`), or the whole path of a home kept
/// elsewhere (`/srv/agents/claude`). Scripts tell the two apart by the leading slash.
pub(super) fn home_place(home: &str) -> Option<&str> {
    home_relative(home).or_else(|| home.strip_prefix('/').filter(|rest| plain_path(rest)).map(|_| home))
}

/// A path within a home from `home_place`, as shell words: from $HOME for a home in the home folder, else whole.
pub(super) fn place_words(place: &str, within: &str) -> String {
    let path = if within.is_empty() { place.to_string() } else { format!("{place}/{within}") };
    if place.starts_with('/') {
        shell_quote(&path)
    } else {
        format!("\"$HOME/\"{}", shell_quote(&path))
    }
}

/// Folder names joined by slashes, with none empty and none that could lead out of where they say.
fn plain_path(path: &str) -> bool {
    !path.split('/').any(|part| part.is_empty() || part == "." || part == "..") && !path.chars().any(|c| c == '\\' || c.is_control())
}

/// How a place can stand before a change: nothing, a skill folder's fingerprint, or where a link leads.
fn is_state(value: &str) -> bool {
    match value.split_at_checked(1) {
        Some(("-", "")) => true,
        Some(("D", sum)) => {
            (sum.len() == 64 && sum.bytes().all(|byte| byte.is_ascii_hexdigit()))
                || sum.strip_prefix('c').and_then(|rest| rest.split_once('-')).is_some_and(|(crc, len)| {
                    !crc.is_empty() && !len.is_empty() && crc.bytes().chain(len.bytes()).all(|byte| byte.is_ascii_digit())
                })
        }
        Some(("L", target)) => {
            (target.starts_with("~/") || target.starts_with('/')) && target.len() <= 4_096 && !target.chars().any(char::is_control)
        }
        _ => false,
    }
}

impl BackupSkill {
    /// A line of a backup's list: `S action agent home name home-before store-before`.
    pub(super) fn parse(fields: &[&str]) -> Option<Self> {
        let ["S", action, agent, home, name, home_before, store_before] = fields else {
            return None;
        };
        // A home kept outside the home folder is listed whole; one in it, from there.
        let home = if home.starts_with('/') { home.to_string() } else { format!("~/{home}") };
        if home_place(&home).is_none() || !is_skill_name(name) || !is_state(home_before) || !is_state(store_before) {
            return None;
        }
        let links = match *agent {
            "claude" => true,
            "codex" => false,
            _ => return None,
        };
        Some(Self {
            home,
            name: name.to_string(),
            action: SkillAction::parse(action)?,
            links,
            home_before: home_before.to_string(),
            store_before: store_before.to_string(),
        })
    }

    fn line(&self) -> String {
        format!(
            "S\t{}\t{}\t{}\t{}\t{}\t{}\n",
            self.action.as_str(),
            if self.links { "claude" } else { "codex" },
            home_place(&self.home).unwrap_or_default(),
            self.name,
            self.home_before,
            self.store_before
        )
    }

    /// Where the skill sits in its home, as the machine has it, and as the page names it: from the machine's home
    /// folder, or whole for a home kept elsewhere.
    fn entry(&self) -> String {
        in_home(&self.within())
    }

    fn rel(&self) -> String {
        shell_quote(&self.within())
    }

    fn within(&self) -> String {
        format!("{}/skills/{}", home_place(&self.home).unwrap_or_default(), self.name)
    }

    fn in_store(&self) -> String {
        format!("\"$store/\"{}", shell_quote(&self.name))
    }

    /// A link to the store's copy, as `place` gives it.
    fn to_store(&self) -> String {
        format!("\"L$store/\"{}", shell_quote(&self.name))
    }
}

/// A path from `home_place` on, as shell words for the skill functions: under $home, or whole when it starts with /.
fn in_home(path: &str) -> String {
    if path.starts_with('/') {
        shell_quote(path)
    } else {
        format!("\"$home/\"{}", shell_quote(path))
    }
}

/// Checks each home's skills folder is its own, once each.
fn own_folders(skills: &[BackupSkill]) -> String {
    let homes: BTreeSet<&str> = skills.iter().filter_map(|skill| home_place(&skill.home)).collect();
    homes
        .into_iter()
        .map(|home| {
            let folder = format!("{home}/skills");
            format!("own_folder {} {}\n", in_home(&folder), shell_quote(&folder))
        })
        .collect()
}

/// A state as `place` gives it on the machine, where ~ is its home folder.
fn state_expr(state: &str) -> String {
    match state.strip_prefix("L~/") {
        Some(rest) => format!("\"L$home/\"{}", shell_quote(rest)),
        None => shell_quote(state),
    }
}

/// The changes the page asks for, checked against the machine's last scan, in the order they're made:
/// what goes into the store first, so a link made after can lead to it.
fn plan(setup: &setup::MachineSetup, changes: Vec<SkillChange>) -> Result<Vec<BackupSkill>, String> {
    let mut seen = BTreeSet::new();
    let mut adopted = BTreeSet::new();
    let mut store_states: BTreeMap<String, String> = BTreeMap::new();
    let mut planned = Vec::with_capacity(changes.len());
    for change in changes {
        let where_ = format!("{}/skills/{}", change.home, change.name);
        if home_place(&change.home).is_none() || !is_skill_name(&change.name) {
            return Err(format!("Arbor doesn't change skills at {where_}"));
        }
        let links = match (home_agent(setup, &change.home), home_harness(setup, &change.home)) {
            (Some(HomeAgent::Claude), _) => true,
            (Some(HomeAgent::Codex), _) => false,
            (None, Some(harness)) => !harness.spec().loads_store(),
            _ => return Err(format!("{} isn't an agent home Arbor reads on this machine", change.home)),
        };
        if let Some(target) = skills_link(setup, &change.home) {
            return Err(format!("{}/skills is a link to {target}, so Arbor leaves the skills in it alone", change.home));
        }
        if !is_state(&change.home_before) || !is_state(&change.store_before) {
            return Err(format!("Arbor can't tell what {where_} was"));
        }
        if !seen.insert((change.home.clone(), change.name.clone())) {
            return Err(format!("{where_} is in the changes twice"));
        }
        if store_states.entry(change.name.clone()).or_insert_with(|| change.store_before.clone()) != &change.store_before {
            return Err(format!("The changes don't agree on what the store has for {}", change.name));
        }
        let (home, store) = (change.home_before.as_bytes()[0], change.store_before.as_bytes()[0]);
        let fits = match change.action {
            SkillAction::Link => links && home == b'-',
            SkillAction::UseStore => links && home == b'D',
            SkillAction::Adopt => home == b'D' && store != b'L' && adopted.insert(change.name.clone()),
            SkillAction::Remove => home != b'-',
        };
        if !fits {
            return Err(format!("Arbor can't {} {where_} as it is", change.action.as_str()));
        }
        planned.push(BackupSkill {
            home: change.home,
            name: change.name,
            action: change.action,
            links,
            home_before: change.home_before,
            store_before: change.store_before,
        });
    }
    // A link needs the store's copy, or the store's link to one: there already, or moving in with this change.
    if let Some(link) = planned.iter().find(|skill| {
        matches!(skill.action, SkillAction::Link | SkillAction::UseStore) && skill.store_before == "-" && !adopted.contains(&skill.name)
    }) {
        return Err(format!("The store hasn't got {} to link to", link.name));
    }
    planned.sort_by_key(|skill| skill.action != SkillAction::Adopt);
    Ok(planned)
}

// Follows HELPERS. `place` gives how a skill's place stands, as the scan gives
// it: - for nothing, L and where a link leads (with . and .. worked out, and no
// further link followed), D and a skill folder's fingerprint, and ? for anything
// else. `own_folder` stops everything when a home's skills folder is a link, or
// is the store: a skill in it is then another folder's, and changing it there
// would change that one. Each change function takes the skill's place in its
// home, its name, the folder its backup goes in, and whether to link it back;
// each undo function takes the same as the change it undoes.
pub(super) const SKILL_FUNCTIONS: &str = r##"home=${HOME%/}
store="$home/.agents/skills"
changed=0
failed=0
lead() {
  t=$(readlink "$1") || return 0
  case "$t" in /*) ;; *) t="${1%/*}/$t" ;; esac
  printf '%s\n' "$t" | awk -F/ '{
    n = 0
    for (i = 1; i <= NF; i++) { if ($i == "" || $i == ".") continue; if ($i == "..") { if (n > 0) n--; continue }; p[++n] = $i }
    s = ""; for (i = 1; i <= n; i++) s = s "/" p[i]
    printf "%s", (s == "" ? "/" : s)
  }'
}
place() {
  if [ -L "$1" ]; then printf L; lead "$1"
  elif [ -d "$1" ] && [ -f "$1/SKILL.md" ]; then
    listing=$(dir_listing "$1")
    if [ -n "$listing" ]; then printf D; printf '%s\n' "$listing" | sum_in; else printf '?'; fi
  elif [ -e "$1" ]; then printf '?'
  else printf -
  fi
}
check() {
  if [ "$(place "$1")" != "$2" ]; then printf 'X\t%s\tchanged\n' "$3"; changed=1; fi
}
own_folder() {
  if [ -L "$1" ] || { [ -d "$1" ] && [ -d "$store" ] && [ "$1" -ef "$store" ]; }; then printf 'X\t%s\tchanged\n' "$2"; changed=1; fi
}
report() {
  if [ "$1" = 0 ]; then printf 'W\t%s\n' "$2"; else printf 'X\t%s\tfailed\n' "$2"; failed=1; fi
}
there() { [ -e "$1" ] || [ -L "$1" ]; }
link_in() { mkdir -p "${1%/*}" && ln -s "$store/$2" "$1"; }
use_store() {
  mkdir -p "$3" && mv "$1" "$3/home" || return 1
  ln -s "$store/$2" "$1" && return 0
  mv "$3/home" "$1"; return 1
}
adopt() {
  mkdir -p "$3" "$store" || return 1
  if there "$store/$2"; then mv "$store/$2" "$3/store" || return 1; fi
  if mv "$1" "$store/$2"; then
    [ "$4" = 1 ] || return 0
    ln -s "$store/$2" "$1" && return 0
    mv "$store/$2" "$1"
  fi
  if there "$3/store"; then mv "$3/store" "$store/$2"; fi
  return 1
}
remove_skill() {
  mkdir -p "$3" || return 1
  if [ -L "$1" ]; then readlink "$1" > "$3/link" && rm -f "$1"; else mv "$1" "$3/home"; fi
}
unlink_in() { rm -f "$1"; }
unuse_store() { rm -f "$1" && mv "$3/home" "$1"; }
unadopt() {
  if [ "$4" = 1 ]; then rm -f "$1" || return 1; fi
  mv "$store/$2" "$1" || return 1
  if there "$3/store"; then mv "$3/store" "$store/$2"; fi
}
unremove() {
  mkdir -p "${1%/*}" || return 1
  if [ -f "$3/link" ]; then ln -s "$(cat "$3/link")" "$1"; else mv "$3/home" "$1"; fi
}
"##;

/// Makes the changes on a machine, all or none: every skill is checked first,
/// with the store's copy of each one a change links to or replaces, then the
/// backup `stamp` is started with its list, then each change is made, putting
/// aside into the backup whatever it moves or removes. Lines out as setup sync's.
fn apply_script(stamp: &str, skills: &[BackupSkill]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{SKILL_FUNCTIONS}{}", own_folders(skills));
    let mut stores = BTreeSet::new();
    for skill in skills {
        script.push_str(&format!("check {} {} {}\n", skill.entry(), state_expr(&skill.home_before), skill.rel()));
        if skill.action != SkillAction::Remove && stores.insert(skill.name.as_str()) {
            let rel = shell_quote(&format!(".agents/skills/{}", skill.name));
            script.push_str(&format!("check {} {} {rel}\n", skill.in_store(), state_expr(&skill.store_before)));
        }
    }
    let manifest: String = skills.iter().map(BackupSkill::line).collect();
    script.push_str("[ \"$changed\" = 0 ] || exit 0\n");
    script.push_str(&start_backup(stamp, "skills"));
    script.push_str(&record_backup(stamp, ChangeKind::Skills, &manifest));
    for (index, skill) in skills.iter().enumerate() {
        let (entry, name, backup) = (skill.entry(), shell_quote(&skill.name), format!("\"$dir/skills/{index}\""));
        let call = match skill.action {
            SkillAction::Link => format!("link_in {entry} {name}"),
            SkillAction::UseStore => format!("use_store {entry} {name} {backup}"),
            SkillAction::Adopt => format!("adopt {entry} {name} {backup} {}", u8::from(skill.links)),
            SkillAction::Remove => format!("remove_skill {entry} {name} {backup}"),
        };
        script.push_str(&format!("{call}; report $? {}\n", skill.rel()));
    }
    script.push_str(&prune_backups());
    script
}

/// For undoing a backup's skill changes, after SKILL_FUNCTIONS: each must be as
/// the change left it, or as it was before where the change couldn't be made,
/// which is left alone. Sets `changed` for any that's neither.
pub(super) fn undo_checks(skills: &[BackupSkill]) -> String {
    let mut script = own_folders(skills);
    for (index, skill) in skills.iter().enumerate() {
        let (home_before, store_before) = (state_expr(&skill.home_before), state_expr(&skill.store_before));
        script.push_str(&format!("sh{index}=$(place {})\nss{index}=$(place {})\nsu{index}=0\n", skill.entry(), skill.in_store()));
        let (after, before) = match skill.action {
            SkillAction::Link => (format!("[ \"$sh{index}\" = {} ]", skill.to_store()), format!("[ \"$sh{index}\" = - ]")),
            SkillAction::UseStore => (format!("[ \"$sh{index}\" = {} ]", skill.to_store()), format!("[ \"$sh{index}\" = {home_before} ]")),
            SkillAction::Adopt => (
                format!(
                    "[ \"$sh{index}\" = {} ] && [ \"$ss{index}\" = {home_before} ]",
                    if skill.links { skill.to_store() } else { "-".into() }
                ),
                format!("[ \"$sh{index}\" = {home_before} ] && [ \"$ss{index}\" = {store_before} ]"),
            ),
            SkillAction::Remove => (format!("[ \"$sh{index}\" = - ]"), format!("[ \"$sh{index}\" = {home_before} ]")),
        };
        script.push_str(&format!(
            "if {after}; then su{index}=1; elif {before}; then :; else printf 'X\\t%s\\tchanged\\n' {}; changed=1; fi\n",
            skill.rel()
        ));
    }
    script
}

/// Undoes each skill change that was made, the last made first.
pub(super) fn undo_actions(skills: &[BackupSkill]) -> String {
    let mut script = String::new();
    for (index, skill) in skills.iter().enumerate().rev() {
        let (entry, name, backup) = (skill.entry(), shell_quote(&skill.name), format!("\"$dir/skills/{index}\""));
        let call = match skill.action {
            SkillAction::Link => format!("unlink_in {entry}"),
            SkillAction::UseStore => format!("unuse_store {entry} {name} {backup}"),
            SkillAction::Adopt => format!("unadopt {entry} {name} {backup} {}", u8::from(skill.links)),
            SkillAction::Remove => format!("unremove {entry} {name} {backup}"),
        };
        script.push_str(&format!("if [ \"$su{index}\" = 1 ]; then {call}; report $? {}; fi\n", skill.rel()));
    }
    script
}

/// Changes the skills in a machine's homes, after backing up whatever's moved or removed.
/// Nothing changes unless every skill is as the page's last scan found it.
#[tauri::command]
pub(crate) async fn apply_skill_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    changes: Vec<SkillChange>,
) -> Result<SyncOutcome, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    let (target, planned) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        (target, plan(setup, changes)?)
    };
    let stdout = run_on(&target, MachineOp::SkillsApply, &apply_script(&new_stamp(), &planned)).await;
    rescan(&app, &machine);
    Ok(parse_outcome(&stdout?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::machine_health::harnesses::Harness;

    fn change(home: &str, name: &str, action: SkillAction, home_before: &str, store_before: &str) -> SkillChange {
        SkillChange { home: home.into(), name: name.into(), action, home_before: home_before.into(), store_before: store_before.into() }
    }

    const SUM: &str = "D0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn only_names_and_states_that_cant_lead_elsewhere_are_taken() {
        assert!(is_skill_name("pdf") && is_skill_name("superpowers:brainstorming") && is_skill_name("My Skill"));
        for bad in ["", ".hidden", "..", "a/b", "a\\b", "a\tb", "a\nb"] {
            assert!(!is_skill_name(bad), "{bad:?}");
        }
        assert_eq!(home_place("~/.agent-app/homes/claude-other"), Some(".agent-app/homes/claude-other"));
        assert_eq!(home_place("/srv/agents/claude"), Some("/srv/agents/claude"), "a home kept elsewhere is taken whole");
        for bad in ["~/../x", "~/.claude/", "~//x", "~", "/", "/srv/../etc", "/srv//x", "srv/agents", "/srv/a\nb"] {
            assert!(home_place(bad).is_none(), "{bad:?}");
        }
        for good in ["-", SUM, "Dc123-45", "L~/.agents/skills/pdf", "L/opt/skills/pdf"] {
            assert!(is_state(good), "{good}");
        }
        for bad in ["", "D", "Dxyz", "Dc12", "Dc-4", "Lrelative/path", "L~/a\tb", "X"] {
            assert!(!is_state(bad), "{bad}");
        }
        let line = ["S", "adopt", "codex", ".codex", "pdf", SUM, "-"];
        assert_eq!(BackupSkill::parse(&line).map(|skill| (skill.home, skill.links)), Some(("~/.codex".into(), false)));
        assert!(BackupSkill::parse(&["S", "adopt", "codex", "../x", "pdf", SUM, "-"]).is_none());
        assert!(BackupSkill::parse(&["S", "delete", "codex", ".codex", "pdf", SUM, "-"]).is_none());
    }

    #[cfg(unix)]
    mod on_disk {
        use super::*;
        use std::os::unix::fs::symlink;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-skills-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(&dir).unwrap()
        }

        fn write(path: &Path, content: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn skill(folder: &Path, doc: &str) {
            write(&folder.join("SKILL.md"), &format!("---\nname: x\ndescription: {doc}\n---\n"));
            write(&folder.join("reference/notes.md"), "Notes.\n");
        }

        fn run_in(shell: &str, home: &Path, script: &str) -> (SyncOutcome, String) {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let output = tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(30))).unwrap();
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            (parse_outcome(&String::from_utf8_lossy(&output.stdout)), String::from_utf8_lossy(&output.stderr).into_owned())
        }

        /// How a place stands, as the scan and the checks give it: in the home folder, or whole.
        fn place(shell: &str, home: &Path, path: &str) -> String {
            let script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{SKILL_FUNCTIONS}place {}\n", in_home(path));
            let mut command = std::process::Command::new(shell);
            let output = command.env_clear().env("HOME", home).env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").arg("-c").arg(script).output().unwrap();
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        /// A skill folder's fingerprint worked out here: each file's path and SHA-256 in byte order, one line each.
        fn folder_sum(folder: &Path) -> String {
            fn walk(root: &Path, dir: &Path, lines: &mut Vec<String>) {
                for entry in fs::read_dir(dir).unwrap().flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(root, &path, lines);
                    } else {
                        let rel = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                        lines.push(format!("{rel}\t{:x}", sha2::Sha256::digest(fs::read(&path).unwrap())));
                    }
                }
            }
            use sha2::Digest;
            let mut lines = Vec::new();
            walk(folder, folder, &mut lines);
            lines.sort();
            format!("D{:x}", sha2::Sha256::digest(format!("{}\n", lines.join("\n"))))
        }

        fn planned(home: &str, name: &str, action: SkillAction, links: bool, home_before: &str, store_before: &str) -> BackupSkill {
            BackupSkill { home: home.into(), name: name.into(), action, links, home_before: home_before.into(), store_before: store_before.into() }
        }

        #[test]
        fn places_read_as_the_scan_reads_them() {
            for shell in shells() {
                let home = temp_home(&format!("place-{shell}"));
                skill(&home.join(".agents/skills/pdf"), "Read PDFs.");
                fs::create_dir_all(home.join(".claude/skills")).unwrap();
                symlink("../../.agents/skills/pdf", home.join(".claude/skills/pdf")).unwrap();
                symlink("../../nowhere", home.join(".claude/skills/gone")).unwrap();
                fs::create_dir_all(home.join(".claude/skills/scratch")).unwrap();
                assert_eq!(place(shell, &home, ".agents/skills/pdf"), folder_sum(&home.join(".agents/skills/pdf")), "{shell}");
                let expected = format!("L{}/.agents/skills/pdf", home.display());
                assert_eq!(place(shell, &home, ".claude/skills/pdf"), expected, "{shell}: a relative link, worked out");
                assert_eq!(place(shell, &home, ".claude/skills/gone"), format!("L{}/nowhere", home.display()), "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/scratch"), "?", "{shell}: no SKILL.md");
                assert_eq!(place(shell, &home, ".claude/skills/none"), "-", "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn skills_are_linked_taken_into_the_store_and_put_back() {
            for shell in shells() {
                let home = temp_home(&format!("apply-{shell}"));
                let at = |rel: &str| home.join(rel);
                skill(&at(".agents/skills/pdf"), "Read PDFs.");
                skill(&at(".agents/skills/design"), "Design.");
                skill(&at(".claude/skills/pdf"), "Read PDFs.");
                skill(&at(".claude/skills/design"), "Design, my way.");
                skill(&at(".claude/skills/notes"), "Notes.");
                skill(&at(".codex/skills/codex-only"), "Old folder.");
                symlink(at("src/elsewhere"), at(".claude/skills/gone")).unwrap();
                let sum = |rel: &str| folder_sum(&at(rel));
                let (pdf, design, my_design, notes, codex_only) = (
                    sum(".agents/skills/pdf"),
                    sum(".agents/skills/design"),
                    sum(".claude/skills/design"),
                    sum(".claude/skills/notes"),
                    sum(".codex/skills/codex-only"),
                );
                let gone = "L~/src/elsewhere".to_string();
                // A second Claude Code home kept outside the home folder.
                let outside = temp_home(&format!("apply-{shell}-srv"));
                let second = format!("{}/agents/claude", outside.display());
                let second_notes = format!("{second}/skills/notes");
                let second = second.as_str();
                let skills = [
                    // Adopting goes first, so the link after it can lead to the store's copy.
                    planned("~/.claude", "notes", SkillAction::Adopt, true, &notes, "-"),
                    planned("~/.claude", "design", SkillAction::Adopt, true, &my_design, &design),
                    planned("~/.codex", "codex-only", SkillAction::Adopt, false, &codex_only, "-"),
                    planned("~/.claude", "pdf", SkillAction::UseStore, true, &pdf, &pdf),
                    planned(second, "notes", SkillAction::Link, true, "-", "-"),
                    planned("~/.claude", "gone", SkillAction::Remove, true, &gone, "-"),
                ];

                // One skill that isn't as the scan found it stops everything.
                let mut stale = skills.to_vec();
                stale[3].home_before = design.clone();
                let (refused, _) = run_in(shell, &home, &apply_script("20260925T090000Z-0001", &stale));
                assert_eq!((refused.backup.as_deref(), refused.done.len()), (None, 0), "{shell}");
                assert_eq!(refused.failed.iter().map(|failure| (failure.path.as_str(), failure.reason)).collect::<Vec<_>>(), [("~/.claude/skills/pdf", "changed")]);
                assert!(!at(".arbor").exists() && at(".claude/skills/notes/SKILL.md").exists(), "{shell}: nothing changed");

                let (applied, _) = run_in(shell, &home, &apply_script("20260925T090000Z-0002", &skills));
                assert_eq!(applied.backup.as_deref(), Some("20260925T090000Z-0002"), "{shell}");
                assert!(applied.failed.is_empty(), "{shell}: {:?}", applied.failed);
                assert_eq!(applied.done.len(), 6, "{shell}");
                let store = |name: &str| format!("L{}/.agents/skills/{name}", home.display());
                assert_eq!(place(shell, &home, ".claude/skills/notes"), store("notes"), "{shell}");
                assert_eq!(place(shell, &home, ".agents/skills/notes"), notes, "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/design"), store("design"), "{shell}");
                assert_eq!(place(shell, &home, ".agents/skills/design"), my_design, "{shell}: this home's copy won");
                assert_eq!(place(shell, &home, ".codex/skills/codex-only"), "-", "{shell}: Codex loads it from the store");
                assert_eq!(place(shell, &home, ".agents/skills/codex-only"), codex_only, "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/pdf"), store("pdf"), "{shell}");
                assert_eq!(place(shell, &home, &second_notes), store("notes"), "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/gone"), "-", "{shell}");
                let kept = at(".arbor/setup-backups/20260925T090000Z-0002");
                assert_eq!(folder_sum(&kept.join("skills/1/store")), design, "{shell}: the store's copy is kept");
                assert_eq!(folder_sum(&kept.join("skills/3/home")), pdf, "{shell}: and the copy a link replaced");
                assert_eq!(fs::read_to_string(kept.join("skills/5/link")).unwrap().trim(), at("src/elsewhere").display().to_string());

                let listed = backups_in(shell, &home);
                assert_eq!(listed[0].skills, skills.to_vec(), "{shell}: the list reads back as it was made");

                // Undoing waits until every skill is as the change left it.
                fs::remove_file(&second_notes).unwrap();
                skill(Path::new(&second_notes), "Edited since.");
                let (blocked, _) = run_in(shell, &home, &setup_sync::undo_script(&listed[0]));
                assert_eq!(blocked.failed.iter().map(|failure| failure.path.as_str()).collect::<Vec<_>>(), [second_notes.as_str()]);
                assert_eq!(place(shell, &home, ".claude/skills/pdf"), store("pdf"), "{shell}: nothing undone");

                fs::remove_dir_all(&second_notes).unwrap();
                symlink(at(".agents/skills/notes"), &second_notes).unwrap();
                let (undone, _) = run_in(shell, &home, &setup_sync::undo_script(&listed[0]));
                assert!(undone.failed.is_empty(), "{shell}: {:?}", undone.failed);
                assert_eq!(place(shell, &home, ".claude/skills/notes"), notes, "{shell}");
                assert_eq!(place(shell, &home, ".agents/skills/notes"), "-", "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/design"), my_design, "{shell}");
                assert_eq!(place(shell, &home, ".agents/skills/design"), design, "{shell}");
                assert_eq!(place(shell, &home, ".codex/skills/codex-only"), codex_only, "{shell}");
                assert_eq!(place(shell, &home, ".agents/skills/codex-only"), "-", "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/pdf"), pdf, "{shell}");
                assert_eq!(place(shell, &home, &second_notes), "-", "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/gone"), format!("L{}/src/elsewhere", home.display()), "{shell}");
                assert!(backups_in(shell, &home)[0].undone_at_ms.is_some(), "{shell}");
                let _ = fs::remove_dir_all(&home);
                let _ = fs::remove_dir_all(&outside);
            }
        }

        #[test]
        fn a_skill_that_cant_be_changed_is_left_and_the_rest_undone() {
            for shell in shells() {
                let home = temp_home(&format!("partial-{shell}"));
                skill(&home.join(".agents/skills/pdf"), "Read PDFs.");
                // A file where the second home's skills folder goes, so nothing can be linked in it.
                write(&home.join(".agent-app/homes/claude-other/skills"), "not a folder\n");
                let pdf = folder_sum(&home.join(".agents/skills/pdf"));
                let skills = [
                    planned("~/.claude", "pdf", SkillAction::Link, true, "-", &pdf),
                    planned("~/.agent-app/homes/claude-other", "pdf", SkillAction::Link, true, "-", &pdf),
                ];
                let (applied, _) = run_in(shell, &home, &apply_script("20260925T100000Z-0001", &skills));
                assert_eq!(applied.done, ["~/.claude/skills/pdf"], "{shell}");
                assert_eq!(applied.failed.iter().map(|failure| (failure.path.as_str(), failure.reason)).collect::<Vec<_>>(), [("~/.agent-app/homes/claude-other/skills/pdf", "failed")]);
                let listed = backups_in(shell, &home);
                let (undone, _) = run_in(shell, &home, &setup_sync::undo_script(&listed[0]));
                assert_eq!((undone.done.as_slice(), undone.failed.len()), (&["~/.claude/skills/pdf".to_string()][..], 0), "{shell}");
                assert_eq!(place(shell, &home, ".claude/skills/pdf"), "-", "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn a_skills_folder_that_leads_to_another_is_left_alone() {
            for shell in shells() {
                let home = temp_home(&format!("folder-{shell}"));
                skill(&home.join(".agents/skills/pdf"), "Read PDFs.");
                fs::create_dir_all(home.join(".codex")).unwrap();
                symlink("../.agents/skills", home.join(".codex/skills")).unwrap();
                let pdf = folder_sum(&home.join(".agents/skills/pdf"));
                assert_eq!(place(shell, &home, ".codex/skills/pdf"), pdf, "{shell}: through the link it looks like a copy of its own");
                for action in [SkillAction::Remove, SkillAction::Adopt] {
                    let skills = [planned("~/.codex", "pdf", action, false, &pdf, &pdf)];
                    let (refused, _) = run_in(shell, &home, &apply_script("20260925T110000Z-0001", &skills));
                    assert_eq!(refused.failed.iter().map(|failure| (failure.path.as_str(), failure.reason)).collect::<Vec<_>>(), [("~/.codex/skills", "changed")], "{shell}");
                    assert_eq!(place(shell, &home, ".agents/skills/pdf"), pdf, "{shell}: the store's copy is where it was");
                }
                // The store reached by another path is the store too.
                fs::remove_file(home.join(".codex/skills")).unwrap();
                fs::create_dir_all(home.join(".claude")).unwrap();
                symlink(home.join(".agents"), home.join(".claude/agents-home")).unwrap();
                let skills = [planned("~/.claude/agents-home", "pdf", SkillAction::Remove, true, &pdf, "-")];
                let (refused, _) = run_in(shell, &home, &apply_script("20260925T110000Z-0002", &skills));
                assert_eq!(refused.failed.len(), 1, "{shell}");
                assert!(!home.join(".arbor").exists(), "{shell}: nothing changed");
                let _ = fs::remove_dir_all(&home);
            }
        }

        fn backups_in(shell: &str, home: &Path) -> Vec<setup_sync::SetupBackup> {
            let mut command = std::process::Command::new(shell);
            let output = command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .arg("-c")
                .arg(format!("set -u\n{}", crate::usage::machine_health::guarded_writes::BACKUPS_SCRIPT))
                .output()
                .unwrap();
            setup_sync::parse_backups(&String::from_utf8_lossy(&output.stdout))
        }
    }

    #[test]
    fn a_plan_is_checked_against_the_last_scan_and_put_in_order() {
        let setup = setup::MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude"), (HomeAgent::Codex, "~/.codex"), (HomeAgent::Shared, "~/.agents")]);
        let planned = plan(&setup, vec![
            change("~/.claude", "pdf", SkillAction::Link, "-", "-"),
            change("~/.codex", "pdf", SkillAction::Adopt, SUM, "-"),
        ])
        .unwrap();
        assert_eq!(planned.iter().map(|skill| (skill.home.as_str(), skill.action)).collect::<Vec<_>>(), [("~/.codex", SkillAction::Adopt), ("~/.claude", SkillAction::Link)]);
        assert!(!planned[0].links && planned[1].links);

        let refused = |changes: Vec<SkillChange>| plan(&setup, changes).unwrap_err();
        let linked = setup::MachineSetup::with_homes(&[(HomeAgent::Codex, "~/.codex")]).with_skills_link("~/.codex", "~/.agents/skills");
        assert!(plan(&linked, vec![change("~/.codex", "pdf", SkillAction::Remove, SUM, "-")]).unwrap_err().contains("is a link to ~/.agents/skills"));
        assert!(refused(vec![change("~/.claude", "pdf", SkillAction::Link, "-", "-")]).contains("hasn't got pdf"));
        assert!(refused(vec![change("~/.claude", "pdf", SkillAction::UseStore, SUM, "-")]).contains("hasn't got pdf"));
        assert!(plan(&setup, vec![change("~/.claude", "pdf", SkillAction::UseStore, SUM, "L~/src/pdf")]).is_ok(), "the store's link to a skill will do");
        assert!(refused(vec![change("~/.claude", "pdf", SkillAction::Adopt, SUM, "L~/src/pdf")]).contains("can't adopt"), "but isn't put aside for another");
        // Copies that match: one moves into the store, and the other gives way to a link to it.
        let second = setup::MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude"), (HomeAgent::Claude, "~/.agent-app/homes/claude-other")]);
        let both = plan(&second, vec![
            change("~/.agent-app/homes/claude-other", "pdf", SkillAction::UseStore, SUM, "-"),
            change("~/.claude", "pdf", SkillAction::Adopt, SUM, "-"),
        ])
        .unwrap();
        assert_eq!(both.iter().map(|skill| skill.action).collect::<Vec<_>>(), [SkillAction::Adopt, SkillAction::UseStore]);
        assert!(refused(vec![change("~/.codex", "pdf", SkillAction::Link, "-", SUM)]).contains("can't link"), "Codex loads the store itself");
        assert!(refused(vec![change("~/.agents", "pdf", SkillAction::Remove, SUM, "-")]).contains("isn't an agent home Arbor reads"));
        assert!(refused(vec![change("~/.agent-app/homes/other", "pdf", SkillAction::Remove, SUM, "-")]).contains("isn't an agent home Arbor reads"));
        // Another harness that loads the store itself takes the changes Codex's homes do.
        let pi = setup::MachineSetup::with_homes(&[(HomeAgent::Shared, "~/.agents")]).with_harness_home(Harness::Pi, "~/.pi/agent");
        let adopted = plan(&pi, vec![change("~/.pi/agent", "deploy", SkillAction::Adopt, SUM, "-")]).unwrap();
        assert!(!adopted[0].links, "no link back: Pi loads the store");
        assert!(plan(&pi, vec![change("~/.pi/agent", "deploy", SkillAction::Remove, SUM, SUM)]).is_ok());
        assert!(plan(&pi, vec![change("~/.pi/agent", "deploy", SkillAction::Link, "-", SUM)]).unwrap_err().contains("can't link"));
        assert!(refused(vec![change("~/.claude", "../x", SkillAction::Remove, SUM, "-")]).contains("doesn't change skills"));
        assert!(refused(vec![change("~/.claude", "pdf", SkillAction::Remove, "SUM", "-")]).contains("can't tell"));
        assert!(refused(vec![change("~/.claude", "pdf", SkillAction::Remove, "-", "-")]).contains("can't remove"));
        assert!(refused(vec![
            change("~/.claude", "pdf", SkillAction::Remove, SUM, "-"),
            change("~/.claude", "pdf", SkillAction::Remove, SUM, "-"),
        ])
        .contains("twice"));
        assert!(refused(vec![
            change("~/.claude", "pdf", SkillAction::Adopt, SUM, "-"),
            change("~/.codex", "pdf", SkillAction::Adopt, SUM, "-"),
        ])
        .contains("can't adopt"));
        assert!(refused(vec![
            change("~/.claude", "pdf", SkillAction::Link, "-", SUM),
            change("~/.codex", "pdf", SkillAction::Remove, SUM, "-"),
        ])
        .contains("don't agree"));
    }
}
