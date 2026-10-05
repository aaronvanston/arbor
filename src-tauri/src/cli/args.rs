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
        let args = command_arguments(&words("passive=true window-ms=60000 machine=casey-mbp")).unwrap();
        assert_eq!(args, json!({ "passive": true, "windowMs": 60000, "machine": "casey-mbp" }));
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
    fn names_take_the_apps_spelling() {
        assert_eq!(method_name("get-core-status"), "get_core_status");
        assert_eq!(method_name("limits.read"), "limits.read");
        assert_eq!(camel_case("api_key_hash"), "apiKeyHash");
    }
}
