//! Changes Arbor makes to files on a machine, each kept so it can be undone.
//!
//! Every change is made the same careful way. Nothing is written unless the
//! file is still what Arbor last read of it, by its fingerprint. What's there
//! is copied first into a backup, ~/.arbor/setup-backups/<when>/, beside a list
//! of what the change does (its manifest). The new copy is written beside the
//! file, checked, then moved into place. The backups are the list of changes
//! Arbor made on a machine, which the Setup page shows with Undo: undoing puts
//! back what a change replaced, for as long as the files stay as it left them
//! (setup_sync's `undo_script`). The newest BACKUPS_KEPT are kept.
//!
//! Setup sync and the Skills tab change several files or skills at once, all or
//! none, with checks of their own (setup_sync, setup_skills). A settings file
//! another feature changes (the needs-you reporter's hooks, keeping Claude
//! Code's sessions, telemetry, a Codex home's MCP servers) is changed on its
//! own with `edit`, here.
//!
//! A backup can hold settings files, so its folder is the machine user's alone
//! and each copy keeps its file's mode. What Arbor reads back from the backups
//! is their manifests: paths, fingerprints and times, never what the files say.

use super::shell::shell_quote;
use ts_rs::TS;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

pub(super) const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// How many changes a machine keeps backups of.
pub(super) const BACKUPS_KEPT: usize = 20;

/// What made a change, as its backup names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChangeKind {
    Sync,
    Skills,
    Reporter,
    KeepSessions,
    Telemetry,
    Mcp,
    /// Settings in a project's checkouts.
    Checkouts,
    /// Plugins a home's settings still named after they'd gone.
    Plugins,
    /// The setup repo's hooks in a home's settings.
    Hooks,
    /// Pausing or resuming an automation another app keeps.
    Automations,
    /// The line that brings Arbor's pool hosts into ~/.ssh/config.
    Ssh,
    /// Projects put where the setup repo wants them: linked, cloned, moved or fast-forwarded.
    Projects,
    /// Folders set aside from a machine by its clean-up, which Undo puts back (`cleanup`).
    Cleanup,
}

impl ChangeKind {
    const ALL: [Self; 13] = [
        Self::Sync,
        Self::Skills,
        Self::Reporter,
        Self::KeepSessions,
        Self::Telemetry,
        Self::Mcp,
        Self::Checkouts,
        Self::Plugins,
        Self::Hooks,
        Self::Automations,
        Self::Ssh,
        Self::Projects,
        Self::Cleanup,
    ];

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::Skills => "skills",
            Self::Reporter => "reporter",
            Self::KeepSessions => "keep-sessions",
            Self::Telemetry => "telemetry",
            Self::Mcp => "mcp",
            Self::Checkouts => "checkouts",
            Self::Plugins => "plugins",
            Self::Hooks => "hooks",
            Self::Automations => "automations",
            Self::Ssh => "ssh",
            Self::Projects => "projects",
            Self::Cleanup => "cleanup",
        }
    }

    pub(super) fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }
}

/// Runs a change's script on `machine`, allowing it the time a write gets.
pub(super) async fn run_on(machine: &Machine, op: MachineOp, script: &str) -> Result<String, String> {
    run_checked(machine, op, script, WRITE_TIMEOUT).await
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/// When a backup was made, from its stamp: 20260925T140233Z-1a2b.
pub(super) fn stamp_ms(stamp: &str) -> Option<i64> {
    let when = stamp.get(..15)?;
    chrono::NaiveDateTime::parse_from_str(when, "%Y%m%dT%H%M%S").ok().map(|when| when.and_utc().timestamp_millis())
}

pub(super) fn is_stamp(value: &str) -> bool {
    stamp_ms(value).is_some()
        && value.len() == 21
        && value.as_bytes()[15] == b'Z'
        && value.as_bytes()[16] == b'-'
        && value[17..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn new_stamp() -> String {
    let mut noise = [0u8; 2];
    let _ = getrandom::fill(&mut noise);
    format!("{}-{:02x}{:02x}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ"), noise[0], noise[1])
}

/// Starts backup `stamp` as `$dir`, with the folder `inside` it, once a change has passed its
/// checks. Nothing is changed when it can't be made.
pub(super) fn start_backup(stamp: &str, inside: &str) -> String {
    format!(
        "root=\"$HOME/.arbor/setup-backups\"\n\
         dir=\"$root\"/{}\n\
         if ! (umask 077 && mkdir -p \"$dir/{inside}\") || ! chmod 700 \"$root\"; then\n\
         \x20 echo \"Arbor couldn't make a folder for backups in ~/.arbor, so it changed nothing\" >&2; exit 5\n\
         fi\n",
        shell_quote(stamp)
    )
}

/// Writes down backup `stamp`'s manifest, `lines` after what made it, and says it's made
/// (`K stamp`). Nothing is changed when it can't be written.
pub(super) fn record_backup(stamp: &str, kind: ChangeKind, lines: &str) -> String {
    format!(
        "cat > \"$dir/manifest\" <<'ARBOR_MANIFEST' || {{ echo \"Arbor couldn't write down its backup, so it changed nothing\" >&2; rm -rf \"$dir\"; exit 5; }}\n\
         what\t{}\n{lines}ARBOR_MANIFEST\n\
         printf 'K\\t%s\\n' {}\n",
        kind.name(),
        shell_quote(stamp)
    )
}

/// Removes all but the newest backups in `$root`; their stamps sort by when.
pub(super) fn prune_backups() -> String {
    format!(
        "ls -1 \"$root\" 2>/dev/null | grep '^[0-9]\\{{8\\}}T[0-9]\\{{6\\}}Z-' | LC_ALL=C sort -r | sed -n '{},$p' \\\n\
         \x20 | while IFS= read -r old; do rm -rf \"$root/$old\"; done\n",
        BACKUPS_KEPT + 1
    )
}

// Lines out: `H home`, then for each backup `V stamp undone` (seconds, or -)
// and its manifest.
pub(super) const BACKUPS_SCRIPT: &str = r##"printf 'H\t%s\n' "$HOME"
root="$HOME/.arbor/setup-backups"
[ -d "$root" ] || exit 0
for dir in "$root"/*; do
  [ -f "$dir/manifest" ] || continue
  undone=-
  if [ -f "$dir/undone" ]; then undone=$(head -n 1 "$dir/undone" | tr -dc '0-9'); fi
  printf 'V\t%s\t%s\n' "${dir##*/}" "${undone:--}"
  cat "$dir/manifest"
done
"##;

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFailure {
    pub(super) path: String,
    /// `changed`: it isn't what the last scan found, so nothing was changed. `failed`: it couldn't be written.
    pub(super) reason: &'static str,
}

/// How a change, or undoing one, went.
#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncOutcome {
    /// The backup made first, which undoing the change needs.
    pub(super) backup: Option<String>,
    /// Files written, restored or removed, as the scan names them.
    pub(super) done: Vec<String>,
    pub(super) failed: Vec<SyncFailure>,
}

/// A path a script printed, as the page shows it: from the home folder with ~, or whole when it's elsewhere.
fn shown(rel: &str) -> String {
    if rel.starts_with('/') {
        rel.to_string()
    } else {
        format!("~/{rel}")
    }
}

/// Reads `X file why`, `K stamp`, and `W file` or `D file` for each file written or removed.
pub(super) fn parse_outcome(stdout: &str) -> SyncOutcome {
    let mut outcome = SyncOutcome::default();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["K", stamp] => outcome.backup = Some(stamp.to_string()),
            ["W" | "D", rel] => outcome.done.push(shown(rel)),
            ["X", rel, why] => outcome.failed.push(SyncFailure {
                path: shown(rel),
                reason: if *why == "changed" { "changed" } else { "failed" },
            }),
            _ => {}
        }
    }
    outcome
}

// ---------------------------------------------------------------------------
// Edits: one settings file at a time
// ---------------------------------------------------------------------------

/// What the scan gives as a file's fingerprint on a machine without a SHA-256
/// tool, and what edits go by: POSIX `cksum`'s checksum and length, after a c.
pub(super) fn cksum(bytes: &[u8]) -> String {
    let mut crc: u32 = 0;
    let mut feed = |byte: u8| {
        crc ^= u32::from(byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
        }
    };
    for &byte in bytes {
        feed(byte);
    }
    let mut length = bytes.len() as u64;
    while length > 0 {
        feed((length & 0xff) as u8);
        length >>= 8;
    }
    format!("c{}-{}", !crc, bytes.len())
}

/// An edit's fingerprint as `cksum` gives it, or - for no file.
fn is_fingerprint(value: &str) -> bool {
    value == "-"
        || value
            .strip_prefix('c')
            .and_then(|rest| rest.split_once('-'))
            .is_some_and(|(crc, size)| !crc.is_empty() && !size.is_empty() && format!("{crc}{size}").bytes().all(|byte| byte.is_ascii_digit()))
}

/// Wraps base64 for a heredoc, which then can't hold a line of anything else.
pub(super) fn base64_lines(bytes: &[u8]) -> String {
    let encoded = STANDARD.encode(bytes);
    let mut lines = String::with_capacity(encoded.len() + encoded.len() / 76 + 1);
    for chunk in encoded.as_bytes().chunks(76) {
        lines.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        lines.push('\n');
    }
    lines
}

// `unbase` decodes the base64 on its input. `state_of` prints a file's
// fingerprint as `cksum` gives it, or - when there's no file.
pub(super) const STATE_FUNCTIONS: &str = r##"if printf 'YQ==' | base64 -d >/dev/null 2>&1; then unbase() { base64 -d; }; else unbase() { base64 -D; }; fi
state_of() {
  if [ -f "$1" ]; then cksum < "$1" | awk '{ printf "c%s-%s", $1, $2 }'; else printf -; fi
}
rel_of() {
  case "$1" in "$HOME"/*) printf '%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac
}
"##;

// Follows STATE_FUNCTIONS, with `stamp` and `what` set. `edit n file before
// after` writes the base64 on its input as `file`, only while it's still
// `before`. A link is written where it leads. The backup is started with the
// first edit; the file there is copied into it and noted in its manifest, then
// the new copy is written beside the file, checked against `after`, and moved
// into place with the file's mode (600 for a new one). It says `E n` and how
// it went: ok, changed (nothing written) or failed, and sets `made` to 1 when
// it was made. `put_back n`, straight after edit n, puts back what it replaced
// and takes it out of the backup, saying `E n back`. `finish_edits` says `K stamp` when the backup holds
// anything and otherwise removes it.
const EDIT_FUNCTIONS: &str = r##"failed=0
dir=
open_backup() {
  [ -z "$dir" ] || return 0
  root="$HOME/.arbor/setup-backups"
  dir="$root/$stamp"
  if ! (umask 077 && mkdir -p "$dir/edits") || ! chmod 700 "$root" || ! printf 'what\t%s\n' "$what" > "$dir/manifest"; then
    rm -rf "$dir"
    echo "Arbor couldn't make a folder for backups in ~/.arbor, so it left the settings alone" >&2
    exit 5
  fi
}
forget() {
  awk -F'\t' -v n="$1" '!($1 == "E" && $2 == n)' "$dir/manifest" > "$dir/manifest.tmp" && mv -f "$dir/manifest.tmp" "$dir/manifest"
  rm -f "$dir/edits/$1"
}
edit() {
  n=$1; f=$2; made=0
  if [ -L "$f" ]; then
    f=$(realpath "$f" 2>/dev/null || readlink -f "$f" 2>/dev/null) || { printf 'E\t%s\tfailed\n' "$n"; failed=1; return 0; }
  fi
  case "$f" in *'	'*|*'
'*) printf 'E\t%s\tfailed\n' "$n"; failed=1; return 0 ;; esac
  if [ "$(state_of "$f")" != "$3" ]; then printf 'E\t%s\tchanged\n' "$n"; failed=1; return 0; fi
  open_backup
  tmp="$f.arbor-tmp"
  rm -f "$tmp"
  if [ -f "$f" ] && ! { cp -p "$f" "$dir/edits/$n" && cp -p "$f" "$tmp"; }; then
    rm -f "$tmp" "$dir/edits/$n"; printf 'E\t%s\tfailed\n' "$n"; failed=1; return 0
  fi
  if printf 'E\t%s\t%s\t%s\t%s\n' "$n" "$f" "$3" "$4" >> "$dir/manifest" && unbase > "$tmp" && [ "$(state_of "$tmp")" = "$4" ]; then
    [ -f "$f" ] || chmod 600 "$tmp"
    if mv -f "$tmp" "$f"; then printf 'E\t%s\tok\n' "$n"; made=1; return 0; fi
  fi
  rm -f "$tmp"; forget "$n"; printf 'E\t%s\tfailed\n' "$n"; failed=1
}
put_back() {
  if [ -f "$dir/edits/$1" ]; then cp -p "$dir/edits/$1" "$f"; else rm -f "$f"; fi
  forget "$1"
  printf 'E\t%s\tback\n' "$1"
}
"##;

/// Where a file to edit is.
pub(super) enum EditFile {
    /// A whole path, as the machine gave it.
    Path(String),
    /// A path in the home folder.
    InHome(String),
}

impl EditFile {
    /// A file within a home as `setup_skills::home_place` gives it: in the home folder, or whole for one kept elsewhere.
    pub(super) fn in_home(place: &str, within: &str) -> Self {
        let path = format!("{place}/{within}");
        if place.starts_with('/') {
            Self::Path(path)
        } else {
            Self::InHome(path)
        }
    }

    fn shell(&self) -> String {
        match self {
            Self::Path(path) => shell_quote(path),
            Self::InHome(rel) => format!("\"$HOME/\"{}", shell_quote(rel)),
        }
    }
}

/// A settings file to change on its own.
pub(super) struct Edit {
    pub(super) file: EditFile,
    /// Its fingerprint when Arbor read it, or - when there was none.
    pub(super) before: String,
    pub(super) content: Vec<u8>,
}

/// Starts a script that makes edits: the functions they need, and what the backup
/// they go into is called and made by.
pub(super) fn edit_start(stamp: &str, kind: ChangeKind) -> String {
    format!("stamp={}\nwhat={}\n{STATE_FUNCTIONS}{EDIT_FUNCTIONS}", shell_quote(stamp), kind.name())
}

/// The script line that makes `edit`, as number `n`.
pub(super) fn edit_call(n: usize, edit: &Edit) -> String {
    format!(
        "edit {n} {} {} {} <<'ARBOR_EOF'\n{}ARBOR_EOF\n",
        edit.file.shell(),
        shell_quote(&edit.before),
        shell_quote(&cksum(&edit.content)),
        base64_lines(&edit.content)
    )
}

/// Ends a script that makes edits: the backup stays when it holds anything.
pub(super) fn edit_finish() -> String {
    format!(
        "if [ -n \"$dir\" ]; then\n\
         \x20 if awk -F'\\t' '$1 == \"E\" {{ found = 1 }} END {{ exit !found }}' \"$dir/manifest\"; then printf 'K\\t%s\\n' \"$stamp\"; else rm -rf \"$dir\"; fi\n\
         {}fi\n",
        prune_backups()
    )
}

/// How an edit went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditOutcome {
    Done,
    /// The file wasn't as Arbor read it, so nothing was written.
    Changed,
    Failed,
    /// Written, then put back as it was.
    Back,
}

/// How each edit went, by its number, from what the script printed; the last word on each counts.
pub(super) fn edit_outcomes(stdout: &str) -> BTreeMap<usize, EditOutcome> {
    let mut outcomes = BTreeMap::new();
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let ["E", n, how] = fields.as_slice() else { continue };
        let Ok(n) = n.parse::<usize>() else { continue };
        let outcome = match *how {
            "ok" => EditOutcome::Done,
            "changed" => EditOutcome::Changed,
            "back" => EditOutcome::Back,
            _ => EditOutcome::Failed,
        };
        outcomes.insert(n, outcome);
    }
    outcomes
}

/// An edit as its backup's manifest has it.
#[derive(Debug, PartialEq)]
pub(super) struct BackupEdit {
    /// Its number, which names its copy in the backup.
    n: String,
    pub(super) path: String,
    pub(super) before: String,
    after: String,
}

impl BackupEdit {
    /// From a manifest's `E n path before after`. The path has to be a whole one with nothing
    /// that could lead out of where it says.
    pub(super) fn parse(fields: &[&str]) -> Option<Self> {
        let ["E", n, path, before, after] = fields else { return None };
        let whole = path.starts_with('/') && !path.split('/').any(|part| part == "." || part == "..") && !path.chars().any(char::is_control);
        (!n.is_empty() && n.bytes().all(|byte| byte.is_ascii_digit()) && whole && is_fingerprint(before) && is_fingerprint(after)).then(|| Self {
            n: n.to_string(),
            path: path.to_string(),
            before: before.to_string(),
            after: after.to_string(),
        })
    }
}

/// For undoing a backup's edits, after STATE_FUNCTIONS: each file must be as its edit left it,
/// or as it was before, which is left alone. Sets `changed` for any that's neither.
pub(super) fn undo_edit_checks(edits: &[BackupEdit]) -> String {
    let mut script = String::new();
    for (index, edit) in edits.iter().enumerate() {
        let path = shell_quote(&edit.path);
        script.push_str(&format!(
            "e{index}=$(state_of {path})\n\
             if [ \"$e{index}\" != {} ] && [ \"$e{index}\" != {} ]; then printf 'X\\t%s\\tchanged\\n' \"$(rel_of {path})\"; changed=1; fi\n",
            shell_quote(&edit.after),
            shell_quote(&edit.before)
        ));
    }
    script
}

/// Puts back each edited file that isn't as it was before already: the copy in the backup, or
/// no file where there was none.
pub(super) fn undo_edit_actions(edits: &[BackupEdit]) -> String {
    let mut script = String::from(
        "restore() {\n\
         \x20 r=$(rel_of \"$2\")\n\
         \x20 if [ -f \"$dir/edits/$1\" ]; then\n\
         \x20   tmp=\"$2.arbor-tmp\"\n\
         \x20   if cp -p \"$dir/edits/$1\" \"$tmp\" && mv -f \"$tmp\" \"$2\"; then printf 'W\\t%s\\n' \"$r\"; else rm -f \"$tmp\"; printf 'X\\t%s\\tfailed\\n' \"$r\"; failed=1; fi\n\
         \x20 elif rm -f \"$2\"; then printf 'D\\t%s\\n' \"$r\"\n\
         \x20 else printf 'X\\t%s\\tfailed\\n' \"$r\"; failed=1\n\
         \x20 fi\n\
         }\n",
    );
    for (index, edit) in edits.iter().enumerate() {
        script.push_str(&format!(
            "[ \"$e{index}\" = {} ] || restore {} {}\n",
            shell_quote(&edit.before),
            edit.n,
            shell_quote(&edit.path)
        ));
    }
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backup_is_named_by_when_it_was_made() {
        let stamp = new_stamp();
        assert!(is_stamp(&stamp), "{stamp}");
        assert!(!is_stamp("20260925T140233Z-zz12"));
        assert!(!is_stamp("../../etc"));
        assert_eq!(ChangeKind::ALL.map(|kind| ChangeKind::named(kind.name())), ChangeKind::ALL.map(Some));
    }

    #[test]
    fn a_manifest_line_that_could_lead_elsewhere_is_not_an_edit() {
        let ok = ["E", "0", "/home/ada/.claude/settings.json", "c123-45", "-"];
        assert!(BackupEdit::parse(&ok).is_some());
        for bad in [
            ["E", "0", ".claude/settings.json", "c123-45", "-"],
            ["E", "0", "/home/ada/../../etc/passwd", "c123-45", "-"],
            ["E", "x", "/home/ada/.claude/settings.json", "c123-45", "-"],
            ["E", "0", "/home/ada/.claude/settings.json", "123-45", "-"],
            ["E", "0", "/home/ada/.claude/settings.json", "c123-45", "c1-"],
        ] {
            assert!(BackupEdit::parse(&bad).is_none(), "{bad:?}");
        }
    }

    mod on_disk {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("arbor-edits-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(&dir).unwrap()
        }

        fn run_in(shell: &str, home: &Path, script: &str) -> String {
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
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        fn edits(stamp: &str, list: &[Edit]) -> String {
            let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start(stamp, ChangeKind::Telemetry));
            for (n, edit) in list.iter().enumerate() {
                script.push_str(&edit_call(n, edit));
            }
            script + &edit_finish()
        }

        #[test]
        fn fingerprints_match_what_cksum_prints() {
            let dir = temp_home("cksum");
            for (index, content) in [&b""[..], b"a", b"hello\n", &[7u8; 300][..], "naïve – “quotes”".as_bytes()].into_iter().enumerate() {
                let path = dir.join(format!("f{index}"));
                fs::write(&path, content).unwrap();
                let output = std::process::Command::new("cksum").stdin(fs::File::open(&path).unwrap()).output().unwrap();
                let printed = String::from_utf8_lossy(&output.stdout).trim().replace(' ', "-");
                assert_eq!(cksum(content), format!("c{printed}"));
            }
            let _ = fs::remove_dir_all(&dir);
        }

        #[test]
        fn an_edit_is_backed_up_first_and_only_made_while_the_file_is_as_read() {
            for shell in shells() {
                let home = temp_home(shell);
                let settings = home.join(".claude/settings.json");
                fs::create_dir_all(settings.parent().unwrap()).unwrap();
                fs::write(&settings, b"{\"env\":{\"TOKEN\":\"sk-secret\"}}\n").unwrap();
                fs::set_permissions(&settings, fs::Permissions::from_mode(0o640)).unwrap();
                // Settings kept elsewhere are written where the link leads.
                let kept = home.join("dotfiles/codex.toml");
                fs::create_dir_all(kept.parent().unwrap()).unwrap();
                fs::write(&kept, b"model = \"o3\"\n").unwrap();
                fs::create_dir_all(home.join(".codex")).unwrap();
                std::os::unix::fs::symlink(&kept, home.join(".codex/config.toml")).unwrap();
                let list = [
                    Edit { file: EditFile::Path(settings.display().to_string()), before: cksum(&fs::read(&settings).unwrap()), content: b"{}\n".to_vec() },
                    Edit { file: EditFile::InHome(".codex/config.toml".into()), before: cksum(b"model = \"o3\"\n"), content: b"model = \"o4\"\n".to_vec() },
                    Edit { file: EditFile::InHome(".agent-app/claude/settings.json".into()), before: "-".into(), content: b"{\"a\":1}".to_vec() },
                    Edit { file: EditFile::InHome(".claude.json".into()), before: "c1-1".into(), content: b"{}".to_vec() },
                ];
                fs::create_dir_all(home.join(".agent-app/claude")).unwrap();
                let stdout = run_in(shell, &home, &edits("20260926T010203Z-00aa", &list));
                let outcomes = edit_outcomes(&stdout);
                assert_eq!(
                    outcomes.values().copied().collect::<Vec<_>>(),
                    [EditOutcome::Done, EditOutcome::Done, EditOutcome::Done, EditOutcome::Changed],
                    "{shell}: {stdout}"
                );
                assert!(stdout.contains("K\t20260926T010203Z-00aa"), "{shell}");
                assert_eq!(fs::read_to_string(&settings).unwrap(), "{}\n");
                assert_eq!(fs::metadata(&settings).unwrap().permissions().mode() & 0o777, 0o640, "{shell}: the file keeps its mode");
                assert!(fs::symlink_metadata(home.join(".codex/config.toml")).unwrap().file_type().is_symlink(), "{shell}: the link stays");
                assert_eq!(fs::read_to_string(&kept).unwrap(), "model = \"o4\"\n");
                let created = home.join(".agent-app/claude/settings.json");
                assert_eq!(fs::metadata(&created).unwrap().permissions().mode() & 0o777, 0o600, "{shell}");
                assert!(!home.join(".claude.json").exists(), "{shell}: a file that changed since isn't written");

                let backup = home.join(".arbor/setup-backups/20260926T010203Z-00aa");
                assert_eq!(fs::metadata(home.join(".arbor/setup-backups")).unwrap().permissions().mode() & 0o777, 0o700, "{shell}");
                assert_eq!(fs::read_to_string(backup.join("edits/0")).unwrap(), "{\"env\":{\"TOKEN\":\"sk-secret\"}}\n");
                assert_eq!(fs::read_to_string(backup.join("edits/1")).unwrap(), "model = \"o3\"\n");
                assert!(!backup.join("edits/2").exists(), "{shell}: there was nothing to keep");
                let manifest = fs::read_to_string(backup.join("manifest")).unwrap();
                assert_eq!(manifest.lines().next(), Some("what\ttelemetry"));
                assert_eq!(manifest.lines().filter(|line| line.starts_with("E\t")).count(), 3, "{manifest}");
                assert!(manifest.contains(&format!("E\t1\t{}\t", kept.display())), "{shell}: the file the link leads to");
                assert!(!manifest.contains("sk-secret"));
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn an_edit_put_back_leaves_nothing_to_undo_and_a_backup_with_nothing_in_it_goes() {
            for shell in shells() {
                let home = temp_home(&format!("back-{shell}"));
                let file = home.join(".codex/config.toml");
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(&file, b"a = 1\n").unwrap();
                let edit = Edit { file: EditFile::InHome(".codex/config.toml".into()), before: cksum(b"a = 1\n"), content: b"a = [\n".to_vec() };
                let script = format!(
                    "set -u\nexport LC_ALL=C\n{}{}put_back 0\n{}",
                    edit_start("20260926T010203Z-00bb", ChangeKind::Mcp),
                    edit_call(0, &edit),
                    edit_finish()
                );
                let stdout = run_in(shell, &home, &script);
                assert_eq!(edit_outcomes(&stdout).get(&0), Some(&EditOutcome::Back), "{shell}: {stdout}");
                assert_eq!(fs::read_to_string(&file).unwrap(), "a = 1\n");
                assert!(!stdout.contains("K\t"), "{shell}");
                assert!(!home.join(".arbor/setup-backups/20260926T010203Z-00bb").exists(), "{shell}");

                // Nothing to change: no backup is started at all.
                let stale = Edit { file: EditFile::InHome(".codex/config.toml".into()), before: "-".into(), content: Vec::new() };
                let stdout = run_in(shell, &home, &edits("20260926T010203Z-00cc", &[stale]));
                assert_eq!(edit_outcomes(&stdout).get(&0), Some(&EditOutcome::Changed));
                assert!(!home.join(".arbor/setup-backups/20260926T010203Z-00cc").exists(), "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }
    }
}
