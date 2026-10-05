//! A project's own instructions, kept in the setup repo and copied into each of the project's checkouts.
//!
//! The repo holds them as plain Markdown, for every machine and, where one differs, for one machine:
//!
//! ```text
//! .agents/projects/<owner>/<name>/instructions.md
//! .agents/projects/<owner>/<name>/machines/<machine>.md
//! ```
//!
//! Each checkout gets them in the files its agents read beside the project's checked-in ones, and Git
//! ignores: Claude Code's CLAUDE.local.md, and Codex's AGENTS.override.md. Claude Code stops reading a
//! repo's AGENTS.md once any CLAUDE.local.md is there, so where the checkout has an AGENTS.md and no
//! CLAUDE.md, CLAUDE.local.md imports it first. Codex reads AGENTS.override.md in place of AGENTS.md, so
//! that file holds the checkout's AGENTS.md followed by the project's text, and is written again when
//! AGENTS.md changes.
//!
//! Arbor's files start with a line saying so, which names the text it holds by fingerprint (and the
//! AGENTS.md it copied), so a scan can tell whether a checkout is in step without reading the file.
//! A file without that line is someone's own, and Arbor leaves it; so is a checkout where Git would see a
//! new one. Each write is the careful kind (guarded_writes): only while the file is as Arbor read it,
//! backed up first, and listed on Sync › Repo › Arbor's changes to undo.

use super::guarded_writes::{cksum, edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, run_on, ChangeKind, Edit, EditFile, EditOutcome};
use super::checkout_settings::CheckoutOutcome;
use super::setup::covered_machine;
use super::setup_projects::InstructionFile;
use super::setup_sync::{git, git_out, repo_file, sha256_hex, GIT_TIMEOUT};
use super::shell::shell_quote;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ts_rs::TS;

/// Where the repo keeps projects' instructions.
pub(super) const PROJECTS_DIR: &str = ".agents/projects/";
/// Longer than any project's own instructions should be.
const TEXT_MAX_BYTES: usize = 65_536;
/// The most of a checkout's AGENTS.md Arbor copies into AGENTS.override.md.
const AGENTS_MAX_BYTES: usize = 262_144;
/// How Arbor's files start.
const MARKER: &str = "<!-- arbor: ";

/// A project's instructions in the repo: for every machine, or for one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoInstructions {
    /// Lowercase `owner/name`.
    project: String,
    /// The machine's normalized name, or None for every machine.
    machine: Option<String>,
    /// The text's fingerprint, as Arbor's files name it.
    hash: String,
    size: u64,
}

#[cfg(test)]
impl RepoInstructions {
    pub(super) fn machine(&self) -> Option<&str> {
        self.machine.as_deref()
    }

    pub(super) fn hash(&self) -> &str {
        &self.hash
    }
}

/// The project and machine a repo path holds instructions for, when it's one of those files.
pub(super) fn instructions_file(rel: &str) -> Option<(String, Option<String>)> {
    let rest = rel.strip_prefix(PROJECTS_DIR)?;
    let parts: Vec<&str> = rest.split('/').collect();
    let (owner, name, machine) = match parts.as_slice() {
        [owner, name, "instructions.md"] => (*owner, *name, None),
        [owner, name, "machines", file] => {
            let machine = file.strip_suffix(".md")?;
            (*owner, *name, Some(machine))
        }
        _ => return None,
    };
    let project = format!("{owner}/{name}");
    if !super::setup_wanted::is_project(&project) {
        return None;
    }
    if machine.is_some_and(|machine| machine.is_empty() || normalize_machine_name(machine) != machine) {
        return None;
    }
    Some((project.to_ascii_lowercase(), machine.map(str::to_string)))
}

/// The repo path for a project's instructions on every machine, or on one.
fn instructions_rel(project: &str, machine: Option<&str>) -> String {
    let project = project.to_ascii_lowercase();
    match machine {
        Some(machine) => format!("{PROJECTS_DIR}{project}/machines/{}.md", normalize_machine_name(machine)),
        None => format!("{PROJECTS_DIR}{project}/instructions.md"),
    }
}

/// The fingerprint Arbor's files name a text by.
pub(super) fn text_hash(text: &[u8]) -> String {
    sha256_hex(text).chars().take(12).collect()
}

/// Every project's instructions `commit` holds, from its listing under `prefix`.
pub(super) async fn list(folder: &Path, prefix: &str, commit: &str) -> Result<Vec<RepoInstructions>, String> {
    let listing = git_out(folder, &["ls-tree", "-r", "-l", "-z", "--full-name", commit, "--", &format!("./{PROJECTS_DIR}")]).await?;
    let mut found = Vec::new();
    for entry in listing.split('\0') {
        let Some((meta, full)) = entry.split_once('\t') else { continue };
        let Some(rel) = full.strip_prefix(prefix) else { continue };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [mode, "blob", object, size] = fields.as_slice() else { continue };
        let Some((project, machine)) = instructions_file(rel).filter(|_| matches!(*mode, "100644" | "100755")) else { continue };
        let Ok(size) = size.parse::<u64>() else { continue };
        if size as usize > TEXT_MAX_BYTES {
            continue;
        }
        found.push((project, machine, object.to_string(), size));
    }
    let objects: Vec<&str> = found.iter().map(|(_, _, object, _)| object.as_str()).collect();
    let contents = super::setup_sync::blobs(folder, &objects).await?;
    Ok(found
        .into_iter()
        .zip(contents)
        .map(|((project, machine, _, size), bytes)| RepoInstructions { project, machine, hash: text_hash(&bytes), size })
        .collect())
}

/// The text a project's checkouts on `machine` get, from the repo's last commit: the machine's own, else every
/// machine's. None when the project has none.
async fn wanted_text(folder: &Path, project: &str, machine: &str) -> Result<Option<Vec<u8>>, String> {
    let head = git(folder, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_TIMEOUT).await?;
    if !head.status.success() {
        return Ok(None);
    }
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    for rel in [instructions_rel(project, Some(machine)), instructions_rel(project, None)] {
        if let Ok(bytes) = repo_file(folder, &head, &rel).await {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// The checkouts
// ---------------------------------------------------------------------------

/// A file to bring in step in one checkout.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutInstructionsChange {
    checkout: String,
    file: InstructionFile,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckoutInstructionsResult {
    checkout: String,
    file: InstructionFile,
    outcome: CheckoutOutcome,
}

/// One of the two files as the read found it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    /// Arbor's, with its fingerprint.
    Arbor(String),
    /// Not there, and Git ignores one there.
    None,
    Seen,
    Own,
}

/// What the read found in one checkout.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Found {
    missing: bool,
    claude_local: Option<Target>,
    agents_override: Option<Target>,
    /// Its AGENTS.md, with its fingerprint; None when there's none, or it's too large to copy.
    agents: Option<(String, Vec<u8>)>,
    agents_large: bool,
    claude_md: bool,
}

// Lines out, for checkout n:
//   X n                   no folder there
//   T n file arbor sum    one of the two files, Arbor's, with its fingerprint
//   T n file own|none|seen
//   A n sum               its AGENTS.md, then its base64 and a `.` line; `A n large` past the limit
//   M n                   it has a CLAUDE.md or .claude/CLAUDE.md
fn read_script(checkouts: &[&str]) -> String {
    let mut script = format!(
        "set -u\nexport LC_ALL=C\n\
         command -v base64 >/dev/null 2>&1 || {{ echo \"base64 isn't installed on this machine\" >&2; exit 3; }}\n\
         sum_of() {{ cksum < \"$1\" | awk '{{ printf \"c%s-%s\", $1, $2 }}'; }}\n\
         checkout() {{\n\
         \x20 n=$1; d=$2\n\
         \x20 if [ ! -d \"$d\" ]; then printf 'X\\t%s\\n' \"$n\"; return 0; fi\n\
         \x20 for f in CLAUDE.local.md AGENTS.override.md; do\n\
         \x20   p=\"$d/$f\"\n\
         \x20   if [ -L \"$p\" ]; then printf 'T\\t%s\\t%s\\town\\n' \"$n\" \"$f\"\n\
         \x20   elif [ -f \"$p\" ]; then\n\
         \x20     if [ \"$(head -c 12 \"$p\")\" = '{MARKER}' ]; then printf 'T\\t%s\\t%s\\tarbor\\t%s\\n' \"$n\" \"$f\" \"$(sum_of \"$p\")\"\n\
         \x20     else printf 'T\\t%s\\t%s\\town\\n' \"$n\" \"$f\"; fi\n\
         \x20   elif [ -e \"$p\" ]; then printf 'T\\t%s\\t%s\\town\\n' \"$n\" \"$f\"\n\
         \x20   elif git -C \"$d\" check-ignore -q \"$f\" 2>/dev/null; then printf 'T\\t%s\\t%s\\tnone\\n' \"$n\" \"$f\"\n\
         \x20   else printf 'T\\t%s\\t%s\\tseen\\n' \"$n\" \"$f\"; fi\n\
         \x20 done\n\
         \x20 if [ -f \"$d/AGENTS.md\" ]; then\n\
         \x20   if [ \"$(wc -c < \"$d/AGENTS.md\" | tr -d ' ')\" -gt {AGENTS_MAX_BYTES} ]; then printf 'A\\t%s\\tlarge\\n' \"$n\"\n\
         \x20   else printf 'A\\t%s\\t%s\\n' \"$n\" \"$(sum_of \"$d/AGENTS.md\")\"; base64 < \"$d/AGENTS.md\"; printf '.\\n'; fi\n\
         \x20 fi\n\
         \x20 if [ -e \"$d/CLAUDE.md\" ] || [ -e \"$d/.claude/CLAUDE.md\" ]; then printf 'M\\t%s\\n' \"$n\"; fi\n\
         }}\n"
    );
    for (n, path) in checkouts.iter().enumerate() {
        script.push_str(&format!("checkout {n} {}\n", shell_quote(path)));
    }
    script
}

fn parse_read(stdout: &str, count: usize) -> Vec<Found> {
    let mut found = vec![Found { missing: true, ..Found::default() }; count];
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let fields: Vec<&str> = line.split('\t').collect();
        let Some(slot) = fields.get(1).and_then(|n| n.parse::<usize>().ok()).and_then(|n| found.get_mut(n)) else { continue };
        match fields.as_slice() {
            ["X", _] => slot.missing = true,
            ["T", _, file, state, rest @ ..] => {
                slot.missing = false;
                let target = match (*state, rest) {
                    ("arbor", [sum]) => Target::Arbor(sum.to_string()),
                    ("none", []) => Target::None,
                    ("seen", []) => Target::Seen,
                    _ => Target::Own,
                };
                match *file {
                    "CLAUDE.local.md" => slot.claude_local = Some(target),
                    "AGENTS.override.md" => slot.agents_override = Some(target),
                    _ => {}
                }
            }
            ["A", _, "large"] => slot.agents_large = true,
            ["A", _, sum] => {
                let mut encoded = String::new();
                for line in lines.by_ref() {
                    if line == "." {
                        break;
                    }
                    encoded.push_str(line.trim());
                }
                match STANDARD.decode(encoded.as_bytes()) {
                    Ok(bytes) => slot.agents = Some((sum.to_string(), bytes)),
                    Err(_) => slot.agents_large = true,
                }
            }
            ["M", _] => slot.claude_md = true,
            _ => {}
        }
    }
    found
}

/// What Arbor writes in a checkout's file for `project`'s `text`. CLAUDE.local.md imports AGENTS.md first when the
/// checkout reads that rather than a CLAUDE.md; AGENTS.override.md copies AGENTS.md, which it stands in for.
/// With no text (the project's was taken out), the file keeps only what the checkout had without it: the import, or
/// the copy of AGENTS.md.
fn compose(file: InstructionFile, project: &str, text: Option<&[u8]>, found: &Found) -> Vec<u8> {
    let hash = text.map(text_hash).unwrap_or_else(|| "-".into());
    let text = text.map(String::from_utf8_lossy).unwrap_or_default();
    let text = text.trim_end();
    let body = |out: &mut Vec<u8>| {
        if !text.is_empty() {
            out.extend_from_slice(text.as_bytes());
            out.push(b'\n');
        }
    };
    match file {
        InstructionFile::ClaudeLocal => {
            let import = found.agents.is_some() && !found.claude_md;
            let mut out = format!(
                "{MARKER}{project}'s own instructions from the setup repo. Arbor writes this file again when they change. text={hash} import={} -->\n",
                u8::from(import)
            );
            if import {
                out.push_str("@AGENTS.md\n");
            }
            let mut out = out.into_bytes();
            if !text.is_empty() {
                out.push(b'\n');
            }
            body(&mut out);
            out
        }
        InstructionFile::AgentsOverride => {
            let agents = found.agents.as_ref().map(|(sum, _)| sum.as_str()).unwrap_or("-");
            let mut out = format!(
                "{MARKER}{project}'s own instructions from the setup repo, after this checkout's AGENTS.md, which Codex reads this in place of. Arbor writes this file again when either changes. text={hash} agents={agents} -->\n"
            )
            .into_bytes();
            if let Some((_, content)) = &found.agents {
                out.extend_from_slice(content);
                if !content.ends_with(b"\n") {
                    out.push(b'\n');
                }
            }
            if !text.is_empty() {
                out.push(b'\n');
            }
            body(&mut out);
            out
        }
    }
}

/// Writes `project`'s instructions from the setup repo into its checkouts on `machine`: CLAUDE.local.md, and
/// AGENTS.override.md where asked. Only checkouts of that project the machine's last Projects scan found are changed.
#[tauri::command]
pub(crate) async fn apply_checkout_instructions(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    project: String,
    machine: String,
    changes: Vec<CheckoutInstructionsChange>,
) -> Result<Vec<CheckoutInstructionsResult>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if !super::setup_wanted::is_project(&project) {
        return Err("That isn't a project Arbor knows".into());
    }
    let project = project.to_ascii_lowercase();
    let target = {
        let inner = state.lock();
        let (target, _) = covered_machine(&inner, &machine)?;
        let projects = inner.projects.get(&machine);
        if let Some(change) = changes.iter().find(|change| projects.and_then(|projects| projects.checkout_project(&change.checkout)).as_deref() != Some(project.as_str())) {
            return Err(format!("Arbor hasn't found {} on {machine} as a checkout of {project}. Scan its projects again.", change.checkout));
        }
        target
    };
    let result = |change: &CheckoutInstructionsChange, outcome| CheckoutInstructionsResult { checkout: change.checkout.clone(), file: change.file, outcome };
    // None once the project's text is taken out: Arbor's files keep only the import or the AGENTS.md copy.
    let text = wanted_text(Path::new(&repo), &project, &machine).await?;
    let checkouts: Vec<&str> = {
        let mut seen: Vec<&str> = Vec::new();
        for change in &changes {
            if !seen.contains(&change.checkout.as_str()) {
                seen.push(&change.checkout);
            }
        }
        seen
    };
    let found = parse_read(&run_on(&target, MachineOp::ClaudeSettingsRead, &read_script(&checkouts)).await?, checkouts.len());
    let mut outcomes: Vec<Option<CheckoutOutcome>> = vec![None; changes.len()];
    let mut edits: Vec<(usize, Edit)> = Vec::new();
    for (index, change) in changes.iter().enumerate() {
        let Some(found) = checkouts.iter().position(|checkout| *checkout == change.checkout).and_then(|at| found.get(at)) else { continue };
        let current = match change.file {
            InstructionFile::ClaudeLocal => &found.claude_local,
            InstructionFile::AgentsOverride => &found.agents_override,
        };
        let before = match (found.missing, current) {
            (true, _) | (false, None) => { outcomes[index] = Some(CheckoutOutcome::Missing); continue; }
            (false, Some(Target::Own)) => { outcomes[index] = Some(CheckoutOutcome::Own); continue; }
            (false, Some(Target::Seen)) => { outcomes[index] = Some(CheckoutOutcome::NotIgnored); continue; }
            // Nothing to empty in a file Arbor never wrote.
            (false, Some(Target::None)) if text.is_none() => { outcomes[index] = Some(CheckoutOutcome::Already); continue; }
            (false, Some(Target::None)) => "-".to_string(),
            (false, Some(Target::Arbor(sum))) => sum.clone(),
        };
        if change.file == InstructionFile::AgentsOverride && found.agents_large {
            outcomes[index] = Some(CheckoutOutcome::Unusable);
            continue;
        }
        let content = compose(change.file, &project, text.as_deref(), found);
        if cksum(&content) == before {
            outcomes[index] = Some(CheckoutOutcome::Already);
            continue;
        }
        edits.push((index, Edit { file: EditFile::Path(format!("{}/{}", change.checkout, change.file.name())), before, content }));
    }
    if !edits.is_empty() {
        let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start(&new_stamp(), ChangeKind::Checkouts));
        for (n, (_, edit)) in edits.iter().enumerate() {
            script.push_str(&edit_call(n, edit));
        }
        script.push_str(&edit_finish());
        let written = edit_outcomes(&run_on(&target, MachineOp::ClaudeSettingsWrite, &script).await?);
        for (n, (index, _)) in edits.iter().enumerate() {
            outcomes[*index] = Some(match written.get(&n) {
                Some(EditOutcome::Done) => CheckoutOutcome::Done,
                Some(EditOutcome::Changed) => CheckoutOutcome::Changed,
                _ => CheckoutOutcome::Failed,
            });
        }
    }
    Ok(changes.iter().zip(outcomes).map(|(change, outcome)| result(change, outcome.unwrap_or(CheckoutOutcome::Failed))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_projects_files_are_instructions() {
        assert_eq!(instructions_file(".agents/projects/Casey/Arbor/instructions.md"), Some(("casey/arbor".into(), None)));
        assert_eq!(instructions_file(".agents/projects/casey/arbor/machines/macmini.md"), Some(("casey/arbor".into(), Some("macmini".into()))));
        assert_eq!(instructions_file(".agents/projects/casey/arbor/machines/Mac-Mini.md"), None);
        assert_eq!(instructions_file(".agents/projects/casey/arbor/notes.md"), None);
        assert_eq!(instructions_file(".agents/projects/casey/instructions.md"), None);
        assert_eq!(instructions_file(".agents/projects/../x/instructions.md"), None);
        assert_eq!(instructions_rel("Casey/Arbor", Some("Mac-Mini")), ".agents/projects/casey/arbor/machines/macmini.md");
    }

    #[test]
    fn claude_local_imports_agents_md_only_where_claude_code_would_read_it() {
        let agents = Found { missing: false, agents: Some(("c1-5".into(), b"# Repo\n".to_vec())), ..Found::default() };
        let text = b"Use the mock.\n";
        let local = String::from_utf8(compose(InstructionFile::ClaudeLocal, "casey/arbor", Some(text), &agents)).unwrap();
        let lines: Vec<&str> = local.lines().collect();
        assert!(lines[0].starts_with(MARKER) && lines[0].contains(&format!("text={}", text_hash(text))) && lines[0].contains("import=1"));
        assert_eq!(&lines[1..], ["@AGENTS.md", "", "Use the mock."]);
        let with_claude = Found { claude_md: true, ..agents.clone() };
        let local = String::from_utf8(compose(InstructionFile::ClaudeLocal, "casey/arbor", Some(text), &with_claude)).unwrap();
        assert!(local.contains("import=0") && !local.contains("@AGENTS.md"));
        // The scan reads the fields back from the first line.
        let first = local.lines().next().unwrap();
        assert_eq!(super::super::setup_projects::marker_field(first, "text"), Some(text_hash(text).as_str()));
    }

    #[test]
    fn agents_override_copies_agents_md_before_the_projects_text() {
        let agents = Found { missing: false, agents: Some(("c9-6".into(), b"# Repo".to_vec())), ..Found::default() };
        let out = String::from_utf8(compose(InstructionFile::AgentsOverride, "casey/arbor", Some(b"Mine."), &agents)).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].contains("agents=c9-6"));
        assert_eq!(&lines[1..], ["# Repo", "", "Mine."]);
        let none = String::from_utf8(compose(InstructionFile::AgentsOverride, "casey/arbor", Some(b"Mine."), &Found::default())).unwrap();
        assert!(none.lines().next().unwrap().contains("agents=-"));
        // Once the text is taken out, the file is the checkout's AGENTS.md again, and says so.
        let emptied = String::from_utf8(compose(InstructionFile::AgentsOverride, "casey/arbor", None, &agents)).unwrap();
        let lines: Vec<&str> = emptied.lines().collect();
        assert!(lines[0].contains("text=- "));
        assert_eq!(&lines[1..], ["# Repo"]);
        let local = String::from_utf8(compose(InstructionFile::ClaudeLocal, "casey/arbor", None, &agents)).unwrap();
        assert_eq!(&local.lines().skip(1).collect::<Vec<_>>(), &["@AGENTS.md"]);
    }

    #[test]
    fn the_read_says_whose_each_file_is() {
        let body = STANDARD.encode("# Repo\n");
        let stdout = format!(
            "T\t0\tCLAUDE.local.md\tarbor\tc1-2\nT\t0\tAGENTS.override.md\tnone\nA\t0\tc3-7\n{body}\n.\nM\t0\n\
             T\t1\tCLAUDE.local.md\town\nT\t1\tAGENTS.override.md\tseen\nA\t1\tlarge\nX\t2\n"
        );
        let found = parse_read(&stdout, 4);
        assert_eq!(found[0].claude_local, Some(Target::Arbor("c1-2".into())));
        assert_eq!(found[0].agents_override, Some(Target::None));
        assert_eq!(found[0].agents, Some(("c3-7".into(), b"# Repo\n".to_vec())));
        assert!(found[0].claude_md && !found[0].missing);
        assert_eq!((found[1].claude_local.clone(), found[1].agents_override.clone(), found[1].agents_large), (Some(Target::Own), Some(Target::Seen), true));
        assert!(found[2].missing && found[3].missing);
    }

    #[cfg(unix)]
    #[test]
    fn the_read_script_tells_arbors_files_from_someones_own_on_disk() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("arbor-instructions-read-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (ours, theirs) = (root.join("ours"), root.join("theirs"));
        for dir in [&ours, &theirs] {
            fs::create_dir_all(dir).unwrap();
            assert!(Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap().success());
        }
        fs::write(ours.join(".git/info/exclude"), "CLAUDE.local.md\nAGENTS.override.md\n").unwrap();
        fs::write(ours.join("CLAUDE.local.md"), format!("{MARKER}x text=abc import=0 -->\n\nHi\n")).unwrap();
        fs::write(ours.join("AGENTS.md"), "# Repo\n").unwrap();
        fs::write(theirs.join("CLAUDE.local.md"), "My own notes\n").unwrap();
        fs::write(theirs.join("CLAUDE.md"), "# Claude\n").unwrap();
        let paths = [ours.display().to_string(), theirs.display().to_string(), root.join("gone").display().to_string()];
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        for shell in ["sh", "dash"] {
            let Ok(output) = Command::new(shell).arg("-c").arg(read_script(&refs)).env("HOME", &root).env("GIT_CONFIG_GLOBAL", "/dev/null").output() else { continue };
            let found = parse_read(&String::from_utf8_lossy(&output.stdout), refs.len());
            let ours_sum = cksum(&fs::read(ours.join("CLAUDE.local.md")).unwrap());
            assert_eq!(found[0].claude_local, Some(Target::Arbor(ours_sum)), "{shell}");
            assert_eq!(found[0].agents_override, Some(Target::None), "{shell}");
            assert_eq!(found[0].agents.as_ref().map(|(_, bytes)| bytes.as_slice()), Some(b"# Repo\n".as_slice()), "{shell}");
            assert_eq!(found[1].claude_local, Some(Target::Own), "{shell}");
            assert_eq!(found[1].agents_override, Some(Target::Seen), "{shell}");
            assert!(found[1].claude_md && found[2].missing, "{shell}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_but_the_outcome_leaves_the_command() {
        // SECRET: instruction files may say anything; the results say only which checkout, which file and how.
        let result = CheckoutInstructionsResult { checkout: "/src/a".into(), file: InstructionFile::ClaudeLocal, outcome: CheckoutOutcome::Own };
        assert_eq!(serde_json::to_string(&result).unwrap(), "{\"checkout\":\"/src/a\",\"file\":\"claudeLocal\",\"outcome\":\"own\"}");
    }
}
