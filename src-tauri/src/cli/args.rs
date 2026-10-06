//! Reading `arbor`'s command line: the flags every command takes, then the command's own words.

use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Options {
    /// Print the app's answer as JSON instead of a table.
    pub(crate) json: bool,
    /// Go ahead with a change that asks first.
    pub(crate) yes: bool,
    /// Fail instead of opening Arbor when it isn't running.
    pub(crate) no_launch: bool,
    /// How long to wait for Arbor to open, in seconds.
    pub(crate) timeout: u64,
    pub(crate) help: bool,
    /// The command and its own words.
    pub(crate) words: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self { json: false, yes: false, no_launch: false, timeout: 30, help: false, words: Vec::new() }
    }
}

/// Splits the flags every command takes from the rest. `--` ends the flags, so a value can start with a dash.
pub(crate) fn parse(arguments: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut rest = arguments.iter();
    while let Some(argument) = rest.next() {
        match argument.as_str() {
            "--json" => options.json = true,
            "--yes" | "-y" => options.yes = true,
            "--no-launch" => options.no_launch = true,
            "--help" | "-h" => options.help = true,
            "--timeout" => {
                let value = rest.next().ok_or("--timeout needs a number of seconds")?;
                options.timeout = value.parse().map_err(|_| format!("--timeout needs a number of seconds, not {value}"))?;
            }
            "--" => {
                options.words.extend(rest.by_ref().cloned());
            }
            _ => options.words.push(argument.clone()),
        }
    }
    Ok(options)
}

/// `name=value` words as a command's arguments, plus any `--args '{…}'`. A value that reads as JSON is taken as JSON
/// (numbers, true, lists), anything else as text. Dashed names become the camelCase names the app uses.
pub(crate) fn command_arguments(words: &[String]) -> Result<Value, String> {
    let mut args = Map::new();
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        if word == "--args" {
            let text = rest.next().ok_or("--args needs a JSON object")?;
            match serde_json::from_str(text) {
                Ok(Value::Object(fields)) => args.extend(fields),
                _ => return Err(format!("--args needs a JSON object, not {text}")),
            }
            continue;
        }
        let Some((name, value)) = word.split_once('=') else {
            return Err(format!("{word} isn't name=value; pass each argument as name=value"));
        };
        let value = serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_string()));
        args.insert(camel_case(name), value);
    }
    Ok(Value::Object(args))
}

/// `window-ms` and `window_ms` as `windowMs`.
pub(crate) fn camel_case(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for char in name.chars() {
        if char == '-' || char == '_' {
            upper = !out.is_empty();
        } else if upper {
            out.extend(char.to_uppercase());
            upper = false;
        } else {
            out.push(char);
        }
    }
    out
}

/// `get-core-status` as `get_core_status`; a window action like `limits.read` stays as it is.
pub(crate) fn method_name(word: &str) -> String {
    if word.contains('.') {
        word.to_string()
    } else {
        word.replace('-', "_")
    }
}

/// What `arbor pools start` was given, past the pool's name.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PoolStart {
    pub(crate) prompt: String,
    /// `host/owner/name`, or `owner/name` for the client to find among the members' repositories.
    pub(crate) repo: Option<String>,
    pub(crate) folder: Option<String>,
    pub(crate) agent: String,
    /// On the agent's own command line rather than in Orca.
    pub(crate) cli: bool,
    pub(crate) model: Option<String>,
    pub(crate) title: Option<String>,
    /// In the checkout itself rather than a worktree of its own.
    pub(crate) no_worktree: bool,
    /// Orca's run may fall back to the command line on a member without Orca.
    pub(crate) fallback: bool,
}

/// Reads `arbor pools start`'s own flags. A session needs a prompt, an agent, and a repository or a folder.
pub(crate) fn pool_start(words: &[&str]) -> Result<PoolStart, String> {
    let mut start = PoolStart::default();
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        let mut value = |flag: &str| rest.next().map(|value| value.to_string()).ok_or(format!("{flag} needs a value"));
        match *word {
            "--prompt" | "-p" => start.prompt = value("--prompt")?,
            "--repo" => start.repo = Some(value("--repo")?),
            "--folder" => start.folder = Some(value("--folder")?),
            "--agent" => start.agent = value("--agent")?,
            "--model" => start.model = Some(value("--model")?),
            "--title" => start.title = Some(value("--title")?),
            "--cli" => start.cli = true,
            "--no-worktree" => start.no_worktree = true,
            "--fallback" => start.fallback = true,
            other => return Err(format!("arbor pools start doesn't take {other}. Run arbor help pools to see what it does.")),
        }
    }
    if start.prompt.trim().is_empty() {
        return Err("Say what the agent should do with --prompt \"…\", or --prompt - to read it from stdin.".into());
    }
    if start.agent.trim().is_empty() {
        return Err("Name the agent with --agent claude or --agent codex.".into());
    }
    match (&start.repo, &start.folder) {
        (Some(_), Some(_)) => Err("Give a repository or a folder, not both.".into()),
        (None, None) => Err("Name the repository with --repo owner/name, or a folder with --folder ~/path.".into()),
        _ => Ok(start),
    }
}

/// What `arbor archive export` was given.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ArchiveExport {
    pub(crate) out: String,
    pub(crate) project: Option<String>,
    pub(crate) machine: Option<String>,
    /// `30d`, `12h`, `2w`, or a date like 2026-09-01.
    pub(crate) since: Option<String>,
    pub(crate) all_versions: bool,
}

/// Reads `arbor archive export`'s own flags. It needs a folder to export to.
pub(crate) fn archive_export(words: &[&str]) -> Result<ArchiveExport, String> {
    let mut export = ArchiveExport::default();
    let mut rest = words.iter();
    while let Some(word) = rest.next() {
        let mut value = |flag: &str| rest.next().map(|value| value.to_string()).ok_or(format!("{flag} needs a value"));
        match *word {
            "--out" | "-o" => export.out = value("--out")?,
            "--project" => export.project = Some(value("--project")?),
            "--machine" => export.machine = Some(value("--machine")?),
            "--since" => export.since = Some(value("--since")?),
            "--all-versions" => export.all_versions = true,
            other => return Err(format!("arbor archive export doesn't take {other}. Run arbor help archive to see what it does.")),
        }
    }
    if export.out.trim().is_empty() {
        return Err("Name a new or empty folder to export to with --out <folder>.".into());
    }
    Ok(export)
}

/// When `--since` starts: so many hours, days or weeks before `now`, or a date's midnight here.
pub(crate) fn since_ms(text: &str, now: chrono::DateTime<chrono::Local>) -> Result<i64, String> {
    use chrono::{Duration, Local, NaiveDate, TimeZone};
    let text = text.trim();
    let wrong = || format!("--since takes a span like 30d, 12h or 2w, or a date like 2026-09-01, not {text}");
    if let Ok(day) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        let midnight = day.and_hms_opt(0, 0, 0).and_then(|at| Local.from_local_datetime(&at).earliest()).ok_or_else(wrong)?;
        return Ok(midnight.timestamp_millis());
    }
    let unit = text.chars().last().ok_or_else(wrong)?;
    let count: i64 = text[..text.len() - unit.len_utf8()].parse().map_err(|_| wrong())?;
    let span = match unit {
        'h' => Duration::try_hours(count),
        'd' => Duration::try_days(count),
        'w' => Duration::try_weeks(count),
        _ => None,
    };
    span.filter(|_| count >= 0).map(|span| (now - span).timestamp_millis()).ok_or_else(wrong)
}

/// A folder typed on the command line as the full path the app needs: `~` is the home folder, and a relative one
/// is from where arbor was run.
pub(crate) fn full_path(typed: &str, home: Option<&std::path::Path>, cwd: &std::path::Path) -> std::path::PathBuf {
    let typed = typed.trim();
    match (typed.strip_prefix('~'), home) {
        (Some(""), Some(home)) => home.to_path_buf(),
        (Some(rest), Some(home)) if rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => cwd.join(typed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn flags_go_anywhere_and_the_rest_is_the_command() {
        let options = parse(&words("core --json restart -y --timeout 5")).unwrap();
        assert_eq!(options.words, ["core", "restart"]);
        assert!(options.json && options.yes);
        assert_eq!(options.timeout, 5);
        assert!(parse(&words("--timeout soon")).is_err());
        assert_eq!(parse(&words("settings set -- arbor.x -1")).unwrap().words, ["settings", "set", "arbor.x", "-1"]);
    }

    #[test]
    fn arguments_are_json_when_they_read_as_json() {
        let args = command_arguments(&words("passive=true window-ms=60000 machine=cam-mbp")).unwrap();
        assert_eq!(args, json!({ "passive": true, "windowMs": 60000, "machine": "cam-mbp" }));
        let args = command_arguments(&["--args".into(), r#"{"query":{"page":2}}"#.into(), "page_size=5".into()]).unwrap();
        assert_eq!(args, json!({ "query": { "page": 2 }, "pageSize": 5 }));
        assert!(command_arguments(&words("loose")).is_err());
        assert!(command_arguments(&["--args".into(), "[1]".into()]).is_err());
    }

    #[test]
    fn a_pool_session_needs_a_prompt_an_agent_and_a_repo_or_a_folder() {
        let start = pool_start(&["--repo", "acme/storefront", "--agent", "claude", "--prompt", "Fix the upload test", "--cli"]).unwrap();
        assert_eq!(start.repo.as_deref(), Some("acme/storefront"));
        assert_eq!((start.agent.as_str(), start.cli, start.no_worktree), ("claude", true, false));
        assert!(pool_start(&["--repo", "acme/x", "--agent", "codex"]).unwrap_err().contains("--prompt"));
        assert!(pool_start(&["--folder", "~/src", "--prompt", "Go"]).unwrap_err().contains("--agent"));
        assert!(pool_start(&["--agent", "codex", "--prompt", "Go"]).unwrap_err().contains("--repo"));
        assert!(pool_start(&["--repo", "a/b", "--folder", "~/a", "--agent", "codex", "--prompt", "Go"]).unwrap_err().contains("not both"));
        assert!(pool_start(&["--repo"]).unwrap_err().contains("needs a value"));
        assert!(pool_start(&["--loud"]).unwrap_err().contains("--loud"));
    }

    #[test]
    fn an_archive_export_needs_a_folder_and_reads_its_span() {
        let export = archive_export(&["--project", "ledger", "--since", "30d", "--out", "exports/ledger", "--all-versions"]).unwrap();
        assert_eq!((export.project.as_deref(), export.since.as_deref(), export.out.as_str(), export.all_versions), (Some("ledger"), Some("30d"), "exports/ledger", true));
        assert!(archive_export(&["--project", "ledger"]).unwrap_err().contains("--out"));
        assert!(archive_export(&["--out", "x", "--loud"]).unwrap_err().contains("--loud"));
        assert!(archive_export(&["--out"]).unwrap_err().contains("needs a value"));

        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 10, 6, 15, 0, 0).unwrap();
        assert_eq!(since_ms("30d", now).unwrap(), (now - chrono::Duration::days(30)).timestamp_millis());
        assert_eq!(since_ms("12h", now).unwrap(), (now - chrono::Duration::hours(12)).timestamp_millis());
        assert_eq!(since_ms("2w", now).unwrap(), (now - chrono::Duration::weeks(2)).timestamp_millis());
        assert_eq!(since_ms("2026-09-01", now).unwrap(), chrono::Local.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap().timestamp_millis());
        for wrong in ["", "d", "30", "30y", "-3d", "soon", "2026-13-01"] {
            assert!(since_ms(wrong, now).is_err(), "{wrong}");
        }

        let home = std::path::Path::new("/Users/cam");
        let cwd = std::path::Path::new("/Users/cam/src");
        assert_eq!(full_path("~/exports", Some(home), cwd), home.join("exports"));
        assert_eq!(full_path("~", Some(home), cwd), home);
        assert_eq!(full_path("out", Some(home), cwd), cwd.join("out"));
        assert_eq!(full_path("/Volumes/Backup/x", Some(home), cwd), std::path::PathBuf::from("/Volumes/Backup/x"));
        assert_eq!(full_path("~other/x", Some(home), cwd), cwd.join("~other/x"));
    }

    #[test]
    fn names_take_the_apps_spelling() {
        assert_eq!(method_name("get-core-status"), "get_core_status");
        assert_eq!(method_name("limits.read"), "limits.read");
        assert_eq!(camel_case("api_key_hash"), "apiKeyHash");
    }
}
