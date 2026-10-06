//! A project's own skills, `projects/<owner>/<name>/skills/<skill>/` in the setup repo, copied into each of its
//! checkouts and worktrees on a machine: as `.claude/skills/<skill>` for Claude Code and `.agents/skills/<skill>` for
//! Codex and the harnesses that read the shared folder. They're the setup repo's, not the project's, so git is told
//! to leave them out in the repo's `.git/info/exclude`, which every worktree shares.
//!
//! A copy is known to be Arbor's by a list in that worktree's own git folder, `arbor-skills`, of the folders Arbor
//! wrote there. A skill folder it doesn't list, or one git tracks, is the project's own (checked in, or someone's),
//! which Arbor never writes over or takes away. The exclude block only keeps git quiet about the copies.
//!
//! ```text
//! # arbor: project skills from the setup repo
//! /.claude/skills/ledger-digest/
//! /.agents/skills/ledger-digest/
//! # arbor: end
//! ```
//!
//! Each folder written or taken out is backed up (a `G skill` line, project_fixes), and the exclude file is a
//! guarded edit (`E`), so Repo › History undoes the lot. Files git doesn't track don't follow a checkout into a new
//! worktree, so one made since shows as missing its skills until they're brought in line again.

use super::guarded_writes::{base64_lines, new_stamp, prune_backups, run_on, ChangeKind, STATE_FUNCTIONS};
use super::project_places::{drift, PlaceState};
use super::setup::{covered_machine, HELPERS};
use super::setup_layers::arbor_machines;
use super::setup_repo_skills::{skill_in, SkillFiles};
use super::setup_skills::SKILL_FUNCTIONS;
use super::setup_sync::read_repo;
use super::shell::shell_quote;
use super::*;
use ts_rs::TS;

/// The folders in a checkout a project's skill goes into: Claude Code's, and the one the other harnesses share.
pub(super) const SKILL_DIRS: [&str; 2] = [".claude/skills", ".agents/skills"];
const BLOCK_START: &str = "# arbor: project skills from the setup repo";
const BLOCK_END: &str = "# arbor: end";

/// How bringing a project's skills in line on a machine went.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSkillsOutcome {
    /// The backup the changes went into, which Repo › History undoes.
    backup: Option<String>,
    /// Skill folders written or brought up to date, and taken out.
    written: u32,
    removed: u32,
    /// Folders left alone, each `path: why`.
    skipped: Vec<String>,
    failed: Vec<String>,
}

// Follows HELPERS, SKILL_FUNCTIONS (for `place`) and STATE_FUNCTIONS, with `stamp` and `what` set. The skills' files
// are written by `want`, each into the backup's new/<i> first and checked there, then swapped in. Lines out:
//   W path | D path | S path why | F path why, and K stamp when anything was changed
const SKILLS_BODY: &str = r##"tab=$(printf '\t')
dir=
n=0
mine=$(mktemp "${TMPDIR:-/tmp}/arbor-skills.XXXXXX") || exit 1
trap 'rm -f "$mine" "$mine.want"' EXIT
pick() { if [ "$hashed" = sha ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
open_backup() {
  [ -z "$dir" ] || return 0
  root="$HOME/.arbor/setup-backups"
  dir="$root/$stamp"
  if ! (umask 077 && mkdir -p "$dir/new" "$dir/folders" "$dir/edits") || ! chmod 700 "$root" || ! printf 'what\t%s\n' "$what" > "$dir/manifest"; then
    rm -rf "$dir"; echo "Arbor couldn't make a folder for backups in ~/.arbor, so it changed nothing" >&2; exit 5
  fi
}
note() { line=G; for field in "$@"; do line="$line$tab$field"; done; printf '%s\n' "$line" >> "$dir/manifest"; }
# The exclude file of checkout $1's repo, which its worktrees share.
exclude_of() {
  common=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$common" in /*) ;; *) common="$1/$common" ;; esac
  printf '%s/info/exclude' "$common"
}
# The list of skill folders Arbor wrote in worktree $1, in its own git folder.
record_of() { g=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) && printf '%s/arbor-skills' "$g"; }
# Whether Arbor wrote folder $2 (`.claude/skills/x`) in worktree $1, and git doesn't track anything in it.
owned() {
  r=$(record_of "$1") && [ -f "$r" ] && grep -qxF "$2" "$r" || return 1
  [ -z "$(git -C "$1" ls-files -- "$2" 2>/dev/null | head -n 1)" ]
}
# Writes the text on its input to file $1, backed up first as a guarded edit; nothing when it's unchanged.
put_text() {
  tmp="$1.arbor-tmp"
  cat > "$tmp" || { rm -f "$tmp"; return 0; }
  before=$(state_of "$1")
  if [ "$(state_of "$tmp")" = "$before" ] || { [ "$before" = - ] && [ ! -s "$tmp" ]; }; then rm -f "$tmp"; return 0; fi
  open_backup; e=$n; n=$((n + 1))
  [ ! -f "$1" ] || cp -p "$1" "$dir/edits/$e"
  printf 'E\t%s\t%s\t%s\t%s\n' "$e" "$1" "$before" "$(state_of "$tmp")" >> "$dir/manifest"
  mv -f "$tmp" "$1"
}
# Writes skill $2 (`want` lines on its input, ending with `.`) into checkout $1's folder $3, as fingerprint $4/$5.
want() {
  wt=$1; name=$2; sub=$3; exclude_of "$wt" > /dev/null || { cat > /dev/null; printf 'F\t%s\tnot a checkout now\n' "$wt/$sub/$name"; return 0; }
  f="$wt/$sub/$name"; i=$n; n=$((n + 1))
  open_backup
  new="$dir/new/$i"; mkdir -p "$new"
  # Each file: its path, x or -, its base64, then a line with a dot; a dot alone after the last.
  while IFS= read -r rel && [ "$rel" != . ]; do
    IFS= read -r x
    : > "$dir/b64"
    while IFS= read -r l && [ "$l" != . ]; do printf '%s\n' "$l" >> "$dir/b64"; done
    mkdir -p "$(dirname "$new/$rel")" && unbase < "$dir/b64" > "$new/$rel" && { [ "$x" = - ] || chmod +x "$new/$rel"; }
  done
  rm -f "$dir/b64"
  after="D$(pick "$4" "$5")"
  was=$(place "$f")
  if [ "$was" != - ] && ! owned "$wt" "$sub/$name"; then rm -rf "$new"; printf '!%s\n' "$sub/$name" >> "$mine"; printf 'S\t%s\town\n' "$f"; return 0; fi
  [ "$was" = "$after" ] && { rm -rf "$new"; printf '%s\n' "$sub/$name" >> "$mine"; return 0; }
  [ "$(place "$new")" = "$after" ] || { rm -rf "$new"; printf 'F\t%s\tcopy\n' "$f"; return 0; }
  if [ "$was" != - ] && ! mv "$f" "$dir/folders/$i"; then rm -rf "$new"; printf 'F\t%s\tmove\n' "$f"; return 0; fi
  if mkdir -p "$wt/$sub" && mv "$new" "$f"; then note skill "$f" "$was" "$after" "$i"; printf '%s\n' "$sub/$name" >> "$mine"; printf 'W\t%s\n' "$f"
  else [ "$was" = - ] || mv "$dir/folders/$i" "$f"; printf 'F\t%s\twrite\n' "$f"; fi
}
# Takes out each copy Arbor made in worktree $1 that the project no longer has: the folders its record lists that
# the lines on input (`.claude/skills/x`, what's wanted) don't.
prune() {
  wt=$1; cat > "$mine.want"
  r=$(record_of "$wt") && [ -f "$r" ] || return 0
  while IFS= read -r rel <&4; do
    [ -n "$rel" ] && ! grep -qxF "$rel" "$mine.want" && owned "$wt" "$rel" || continue
    f="$wt/$rel"; was=$(place "$f"); [ "$was" = - ] && continue
    open_backup; i=$n; n=$((n + 1))
    if mv "$f" "$dir/folders/$i"; then note skill "$f" "$was" - "$i"; printf 'D\t%s\n' "$f"; else printf 'F\t%s\tmove\n' "$f"; printf '%s\n' "$rel" >> "$mine"; fi
  done 4< "$r"
}
# Ends a checkout: its record lists what's Arbor's there now, and its repo's exclude block names the lines on input.
finish_checkout() {
  r=$(record_of "$1") || { cat > /dev/null; return 0; }
  sort -u "$mine" | put_text "$r"
  : > "$mine"
  ex=$(exclude_of "$1") || { cat > /dev/null; return 0; }
  lines=$(cat)
  # Nothing to name and no block yet: the file stays as it is, or absent.
  if [ -z "$lines" ] && ! { [ -f "$ex" ] && grep -qxF "$BLOCK_START" "$ex"; }; then return 0; fi
  if [ -f "$ex" ]; then rest=$(awk -v s="$BLOCK_START" -v e="$BLOCK_END" '$0 == s { on = 1; next } $0 == e { on = 0; next } !on' "$ex"); else rest=; fi
  mkdir -p "$(dirname "$ex")"
  if [ -n "$lines" ]; then printf '%s\n%s\n%s\n%s\n' "$rest" "$BLOCK_START" "$lines" "$BLOCK_END" | sed '/./,$!d' | put_text "$ex"
  else printf '%s\n' "$rest" | put_text "$ex"; fi
}
"##;

/// The script that brings `skills` in line in each of `checkouts`, taking out copies Arbor made of ones not among them.
fn skills_script(stamp: &str, checkouts: &[String], skills: &[(String, SkillFiles)]) -> String {
    let mut script = format!(
        "set -u\nexport LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0\ncd / || exit 3\n{HELPERS}{SKILL_FUNCTIONS}{STATE_FUNCTIONS}stamp={}\nwhat={}\nBLOCK_START={}\nBLOCK_END={}\n{SKILLS_BODY}",
        shell_quote(stamp),
        ChangeKind::Projects.name(),
        shell_quote(BLOCK_START),
        shell_quote(BLOCK_END),
    );
    for checkout in checkouts {
        let at = shell_quote(checkout);
        script.push_str(&format!("if [ -d {at} ]; then\nprune {at} <<'ARBOR_WANT'\n"));
        for (name, _) in skills {
            for sub in SKILL_DIRS {
                script.push_str(&format!("{sub}/{name}\n"));
            }
        }
        script.push_str("ARBOR_WANT\n");
        for (name, files) in skills {
            for sub in SKILL_DIRS {
                script.push_str(&format!("want {at} {} {} {} {} <<'ARBOR_SKILL'\n", shell_quote(name), shell_quote(sub), shell_quote(&files.sum), shell_quote(&files.ck)));
                for file in &files.files {
                    script.push_str(&file.rel);
                    script.push('\n');
                    script.push_str(if file.exec { "x\n" } else { "-\n" });
                    script.push_str(&base64_lines(&file.bytes));
                    script.push_str(".\n");
                }
                script.push_str(".\nARBOR_SKILL\n");
            }
        }
        script.push_str(&format!("finish_checkout {at} <<'ARBOR_BLOCK'\n"));
        for (name, _) in skills {
            for sub in SKILL_DIRS {
                script.push_str(&format!("/{sub}/{name}/\n"));
            }
        }
        script.push_str("ARBOR_BLOCK\nfi\n");
    }
    script.push_str(&format!(
        "if [ -n \"$dir\" ]; then\n\
         \x20 rm -rf \"$dir/new\"\n\
         \x20 if grep -q '^[GE]\t' \"$dir/manifest\"; then printf 'K\\t%s\\n' \"$stamp\"; else rm -rf \"$dir\"; fi\n\
         {}fi\n",
        prune_backups()
    ));
    script
}

fn parse_outcome(stdout: &str) -> ProjectSkillsOutcome {
    let mut outcome = ProjectSkillsOutcome::default();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["K", stamp] => outcome.backup = Some(stamp.to_string()),
            ["W", _] => outcome.written += 1,
            ["D", _] => outcome.removed += 1,
            ["S", path, why] => outcome.skipped.push(format!("{path}: {why}")),
            ["F", path, why] => outcome.failed.push(format!("{path}: {why}")),
            _ => {}
        }
    }
    outcome
}

/// Brings a project's own skills in line in each of its checkouts and worktrees on `machine`, as the setup repo's last
/// commit has them, and takes out ones it has dropped. Backed up first; Repo › History undoes it.
#[tauri::command]
pub(crate) async fn apply_project_skills(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    project: String,
) -> Result<ProjectSkillsOutcome, String> {
    let folder = Path::new(&repo);
    let found = read_repo(folder).await?;
    let commit = found.head_sha().ok_or("The setup repo has nothing committed yet")?.to_string();
    let entry = found.layers().project(&project).ok_or_else(|| format!("The setup repo has no project {project}"))?;
    let (project_folder, names, remote) = (entry.folder().to_string(), entry.own_skill_names(), entry.remote().map(str::to_string));
    let (target, checkouts) = {
        let mut inner = state.lock();
        inner.setup_repo = Some(repo.clone());
        let (target, _) = covered_machine(&inner, &machine)?;
        let drift = drift(found.layers(), &arbor_machines(&inner), &inner.projects);
        let cell = drift.on_machine(&machine).into_iter().find(|(key, ..)| *key == project).map(|(_, cell, ..)| cell);
        let place = cell.as_ref().filter(|cell| matches!(cell.state(), PlaceState::InPlace | PlaceState::Linked)).and_then(|cell| cell.checkout().map(str::to_string));
        let remote = remote.as_deref().and_then(super::setup_projects::normalize_remote);
        let checkouts = inner.projects.get(&machine).map(|scan| scan.project_worktrees(remote.as_deref(), place.as_deref())).unwrap_or_default();
        (target, checkouts)
    };
    if checkouts.is_empty() {
        return Err(format!("{machine} has no checkout of {project} that a scan has found"));
    }
    let mut skills = Vec::new();
    for name in &names {
        skills.push((name.clone(), skill_in(folder, &commit, &format!("{project_folder}/skills"), name).await?));
    }
    let stdout = run_on(&target, MachineOp::ProjectFixes, &skills_script(&new_stamp(), &checkouts, &skills)).await?;
    let outcome = parse_outcome(&stdout);
    let _ = super::setup_projects::scan_projects(app.clone(), state, machine, None, Some(repo)).await;
    Ok(outcome)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::usage::machine_health::guarded_writes::BACKUPS_SCRIPT;
    use crate::usage::machine_health::setup_repo_skills::SkillFile;
    use crate::usage::machine_health::setup_sync::{parse_backups, undo_script};
    use crate::usage::machine_health::shell::{run_script, shells};
    use std::fs;
    use std::path::PathBuf;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("arbor-pskills-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn git(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(["-c", "user.name=Arbor", "-c", "user.email=arbor@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
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

    fn skill(body: &str) -> SkillFiles {
        SkillFiles::of(vec![
            SkillFile { rel: "SKILL.md".into(), bytes: format!("---\nname: digest\n---\n{body}\n").into_bytes(), exec: false },
            SkillFile { rel: "scripts/run.sh".into(), bytes: b"#!/bin/sh\necho hi\n".to_vec(), exec: true },
        ])
    }

    #[test]
    fn a_projects_skills_go_into_each_checkout_kept_out_of_git_and_come_back_out_on_undo() {
        for shell in shells() {
            let root = temp_dir("round");
            let home = root.join("home");
            let app = root.join("app");
            let wt = root.join("wt");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(app.join(".claude/skills/own")).unwrap();
            git(&app, &["init", "-q"]);
            fs::write(app.join(".claude/skills/own/SKILL.md"), "mine\n").unwrap();
            git(&app, &["add", "."]);
            git(&app, &["commit", "-qm", "one"]);
            git(&app, &["worktree", "add", "-q", "-b", "fix", wt.to_str().unwrap()]);
            let exclude = app.join(".git/info/exclude");
            let exclude_before = fs::read(&exclude).unwrap();
            let checkouts = vec![app.display().to_string(), wt.display().to_string()];

            let out = run(shell, &home, &skills_script(&new_stamp(), &checkouts, &[("digest".into(), skill("v1")), ("own".into(), skill("theirs"))]));
            let first = parse_outcome(&out);
            // The project's own skill folder in .claude is left alone in both worktrees; .agents has none, so it gets one.
            assert_eq!((first.written, first.failed.len()), (6, 0), "{shell}: {out}");
            assert_eq!(first.skipped.len(), 2, "{shell}: {out}");
            assert_eq!(fs::read_to_string(app.join(".claude/skills/own/SKILL.md")).unwrap(), "mine\n");
            for checkout in [&app, &wt] {
                for sub in SKILL_DIRS {
                    assert!(checkout.join(sub).join("digest/SKILL.md").is_file(), "{shell} {checkout:?} {sub}");
                }
            }
            assert!(fs::metadata(wt.join(".agents/skills/digest/scripts/run.sh")).unwrap().permissions().mode() & 0o111 != 0);
            let status = std::process::Command::new("git").args(["status", "--porcelain"]).current_dir(&app).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&status.stdout), "", "{shell}: git sees the copies");

            // A scan fingerprints the copy as the repo does, so drift sees it in step.
            let print = run(shell, &home, &format!("{HELPERS}{}folder_print {}\n", super::super::setup_projects::FOLDER_PRINT, shell_quote(&app.join(".claude/skills/digest").display().to_string())));
            let files = skill("v1");
            assert!(print == format!("D{}", files.sum) || print == format!("D{}", files.ck), "{shell}: {print}");

            // own leaves the project: Arbor's copies of it go, the project's own folder stays.
            let again = parse_outcome(&run(shell, &home, &skills_script(&new_stamp(), &checkouts, &[("digest".into(), skill("v1"))])));
            assert_eq!((again.written, again.removed), (0, 2), "{shell}");
            assert!(!app.join(".agents/skills/own").exists() && app.join(".claude/skills/own/SKILL.md").is_file(), "{shell}");
            let quiet = parse_outcome(&run(shell, &home, &skills_script(&new_stamp(), &checkouts, &[("digest".into(), skill("v1"))])));
            assert_eq!((quiet.written, quiet.backup), (0, None), "{shell}");

            // A new version replaces Arbor's copies.
            let updated = parse_outcome(&run(shell, &home, &skills_script(&new_stamp(), &checkouts, &[("digest".into(), skill("v2"))])));
            assert_eq!(updated.written, 4, "{shell}");
            assert!(fs::read_to_string(app.join(".claude/skills/digest/SKILL.md")).unwrap().contains("v2"));

            // Undoing the update puts v1 back.
            let backups = parse_backups(&run(shell, &home, BACKUPS_SCRIPT));
            let newest = backups.iter().find(|backup| Some(&backup.id) == updated.backup.as_ref()).unwrap();
            let undone = run(shell, &home, &undo_script(newest));
            assert!(!undone.contains("\tchanged") && !undone.contains("\tfailed"), "{shell}: {undone}");
            assert!(fs::read_to_string(app.join(".claude/skills/digest/SKILL.md")).unwrap().contains("v1"), "{shell}");

            // Dropped from the project: Arbor's copies go, and the block with them.
            let dropped = parse_outcome(&run(shell, &home, &skills_script(&new_stamp(), &checkouts, &[])));
            assert_eq!(dropped.removed, 4, "{shell}");
            for checkout in [&app, &wt] {
                let record = std::process::Command::new("git").args(["rev-parse", "--absolute-git-dir"]).current_dir(checkout).output().unwrap();
                let record = PathBuf::from(String::from_utf8_lossy(&record.stdout).trim()).join("arbor-skills");
                assert_eq!(fs::read_to_string(&record).unwrap_or_default().trim(), "", "{shell}");
            }
            assert!(!app.join(".claude/skills/digest").exists() && app.join(".claude/skills/own/SKILL.md").is_file(), "{shell}");
            assert_eq!(fs::read(&exclude).unwrap(), exclude_before, "{shell}");
            let _ = fs::remove_dir_all(&root);
        }
    }
}
