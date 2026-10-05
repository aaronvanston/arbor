//! "Needs you": the sessions, on any machine, that are waiting on the person
//! at the keyboard. Requests can't say that, so an opt-in reporter does: a
//! small script that Claude Code's hooks and Codex's `notify` run, which
//! appends a line to ~/.arbor/agent-events for each event that matters. A line
//! holds the time, the agent, what happened and the session's id. Nothing else
//! the agents hand the script is kept, so no prompt, message or path is.
//!
//! Every few seconds each machine the reporter is set up on is asked for the
//! lines since the last look, over the same shell or SSH connection the health
//! samples use. A Claude Code session needs you once it asks for permission or
//! has a question, and is waiting for you once it stops; a Codex session once a
//! turn completes. That's over once the agent reports a new prompt or the end
//! of the session, or once the session's own thread sends another request.
//!
//! Setting the reporter up changes the agents' settings on the machine: the
//! hooks in Claude Code's settings.json and `notify` in Codex's config.toml, in
//! each of the machine's agent homes with Sync on (agent_homes). The files
//! are read, changed here and written back whole, only if nothing else
//! changed them in between, with the copy before kept as a
//! change on the Setup page's list, which can undo it (guarded_writes). A
//! `notify` that was already set keeps working: the reporter runs it once it
//! has recorded the turn. Taking the reporter away undoes all of it.

use super::agent_homes::{self, tilde, HomeUse};
use super::agents::AgentKind;
use super::guarded_writes::{edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, ChangeKind, Edit, EditFile, EditOutcome};
use super::*;
use crate::agents::set_codex_table_item;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use ts_rs::TS;
use serde::ser::{SerializeMap, SerializeSeq, Serializer};

/// How often machines with the reporter are asked for new events.
const POLL_INTERVAL: Duration = Duration::from_secs(10);
const POLL_TIMEOUT: Duration = Duration::from_secs(8);
const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Events are kept this long, and a wait this old is dropped: the session was left.
const WAIT_MAX_AGE_MS: i64 = 6 * 60 * 60_000;
/// The most events kept for a machine.
const EVENTS_KEPT: usize = 2_000;
/// The events file is cut back to its last EVENTS_KEPT lines past this size.
const EVENTS_FILE_BYTES: u64 = 256 * 1024;
/// A request this soon after a turn ends doesn't mean the user answered:
/// agents make side requests as a turn ends, for a title or a suggested
/// next prompt. A permission prompt stops the conversation at once, so a
/// request after one means it was answered.
const WAITING_SETTLE_MS: i64 = 15_000;
const PERMISSION_SETTLE_MS: i64 = 2_000;

pub(crate) const AGENT_ATTENTION_UPDATED_EVENT: &str = "agent-attention-updated";

/// What marks a hook or `notify` as the reporter's.
pub(super) const REPORTER_MARK: &str = "/.arbor/bin/arbor-agent-event";
/// The Claude Code events the reporter hooks.
const CLAUDE_EVENTS: [&str; 4] = ["Notification", "Stop", "UserPromptSubmit", "SessionEnd"];
/// How Claude Code's hooks run the reporter: through its shell, so the home is the machine's.
const CLAUDE_COMMAND: &str = "\"$HOME/.arbor/bin/arbor-agent-event\" claude";
const CLAUDE_HOOK_TIMEOUT_S: u64 = 10;

// Installed as ~/.arbor/bin/arbor-agent-event. The fields it needs come first
// in what the agents pass, so only the start is looked at, and a field only
// counts where JSON puts a key: after an unescaped quote. Whatever the rest
// holds (a prompt, a reply) is read and dropped unseen.
const REPORTER_SCRIPT: &str = r##"#!/bin/sh
# Arbor's agent event reporter, set up from Arbor's Machines page, which also
# takes it away. Claude Code's hooks and Codex's notify run it. It appends a
# line to ~/.arbor/agent-events for each event: the time, the agent, the event
# and the session's id. Nothing else the agents pass it is kept or sent. It
# prints nothing and always succeeds, so no agent waits on it or shows an error.
export LC_ALL=C
events="$HOME/.arbor/agent-events"

# The first "name":"value" field of the JSON the agent passed.
field() {
  rest=${json#*[!\\]\"$1\":\"}
  if [ "$rest" = "$json" ]; then rest=${json#*[!\\]\"$1\": \"}; fi
  if [ "$rest" != "$json" ]; then printf '%s' "${rest%%\"*}"; fi
}

# Appends an event for a session, when both are plain words.
record() {
  case "$1" in '' | *[!A-Za-z0-9_-]*) return ;; esac
  case "$2" in '' | *[!A-Za-z0-9._-]*) return ;; esac
  printf '%s %s %s %s\n' "$(date +%s)" "$agent" "$1" "$2" >> "$events" 2>/dev/null
}

agent=${1:-}
case "$agent" in
  claude)
    json=$(head -c 4096 2>/dev/null)
    cat > /dev/null 2>&1
    session=$(field session_id)
    case $(field hook_event_name) in
      Notification) record "$(field notification_type)" "$session" ;;
      Stop) record stop "$session" ;;
      UserPromptSubmit) record prompt "$session" ;;
      SessionEnd) record end "$session" ;;
    esac
    ;;
  codex)
    shift
    # Codex adds the turn's JSON after the words it's given.
    json=
    for json in "$@"; do :; done
    json=$(printf '%s' "$json" | head -c 4096)
    if [ "$(field type)" = agent-turn-complete ]; then record turn "$(field thread-id)"; fi
    # A notify command set before the reporter runs as it did.
    if [ "${1:-}" = --then ]; then
      shift
      exec "$@"
    fi
    ;;
esac
exit 0
"##;

/// Follows `agent_homes::shell_function` in the agents check: whether the reporter is there, and
/// which homes' settings run it.
pub(super) const REPORTER_CHECK: &str = r##"printf 'home=%s\n' "$HOME"
if [ -x "$HOME/.arbor/bin/arbor-agent-event" ]; then printf 'reporter=1\n'; fi
agent_homes | while IFS=$tab read -r agent home; do
  if grep -q '/\.arbor/bin/arbor-agent-event' "$(settings_file "$agent" "$home")" 2>/dev/null; then on=1; else on=0; fi
  printf 'reporter_home=%s\t%s\t%s\n' "$agent" "$on" "$home"
done
"##;

// Follows `agent_homes::shell_function`. Lines out:
//   H home                   the machine's home directory
//   F agent home file sum    a settings file: `sum` is what cksum says, or - when there's no file,
//   ...                      then its content in base64 when there is one,
//   .                        and a line with a dot.
// A settings file that links elsewhere is read, and later written, where it leads.
const READ_SCRIPT: &str = r##"command -v base64 >/dev/null 2>&1 || { echo "base64 isn't installed on this machine" >&2; exit 3; }
printf 'H\t%s\n' "$HOME"
agent_homes | while IFS=$tab read -r agent home; do
  file=$(settings_file "$agent" "$home")
  if [ -L "$file" ]; then
    file=$(realpath "$file" 2>/dev/null || readlink -f "$file" 2>/dev/null) || continue
  fi
  if [ -f "$file" ]; then
    printf 'F\t%s\t%s\t%s\t%s\n' "$agent" "$home" "$file" "$(cksum < "$file" | awk '{ printf "c%s-%s", $1, $2 }')"
    base64 < "$file"
  else
    printf 'F\t%s\t%s\t%s\t-\n' "$agent" "$home" "$file"
  fi
  printf '.\n'
done
"##;

// ---------------------------------------------------------------------------
// Settings files
// ---------------------------------------------------------------------------

/// JSON that keeps its keys in the order they came in, so a settings file
/// written back has what Arbor didn't touch where it was.
#[derive(Clone, Debug, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;

        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Number(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Json, E> {
                serde_json::Number::from_f64(value)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("a number JSON can't hold"))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::String(value.to_string()))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::String(value))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, Json>()? {
                    entries.push(entry);
                }
                Ok(Json::Object(entries))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => serializer.serialize_unit(),
            Json::Bool(value) => serializer.serialize_bool(*value),
            Json::Number(value) => value.serialize(serializer),
            Json::String(value) => serializer.serialize_str(value),
            Json::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl Json {
    fn field(&self, name: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(key, _)| key == name).map(|(_, value)| value),
            _ => None,
        }
    }

    fn field_mut(&mut self, name: &str) -> Option<&mut Json> {
        match self {
            Json::Object(entries) => entries.iter_mut().find(|(key, _)| key == name).map(|(_, value)| value),
            _ => None,
        }
    }
}

fn claude_handler() -> Json {
    Json::Object(vec![
        ("type".into(), Json::String("command".into())),
        ("command".into(), Json::String(CLAUDE_COMMAND.into())),
        ("timeout".into(), Json::Number(CLAUDE_HOOK_TIMEOUT_S.into())),
    ])
}

/// A hook handler that runs the reporter, whichever way it was written.
fn is_reporter_handler(handler: &Json) -> bool {
    matches!(handler.field("command"), Some(Json::String(command)) if command.contains(REPORTER_MARK))
}

/// Takes the reporter's handlers out of one event's groups, except the first
/// that's exactly `keep`. A group the reporter's handlers leave empty goes
/// too. Returns whether `keep` was found, and whether anything was taken out.
fn strip_claude_handlers(groups: &mut Vec<Json>, keep: Option<&Json>) -> (bool, bool) {
    let mut kept = false;
    let mut stripped = false;
    groups.retain_mut(|group| {
        let Some(Json::Array(handlers)) = group.field_mut("hooks") else {
            return true;
        };
        let before = handlers.len();
        handlers.retain(|handler| {
            if !is_reporter_handler(handler) {
                return true;
            }
            if !kept && keep == Some(handler) {
                kept = true;
                return true;
            }
            false
        });
        let emptied = before > 0 && handlers.is_empty();
        stripped |= handlers.len() < before;
        !emptied
    });
    (kept, stripped)
}

/// Claude Code's settings.json as its object, and the byte order mark it
/// started with, if any. No file, or an empty one, is an empty object.
fn read_claude_settings(content: Option<&str>) -> Result<(&'static str, Json), String> {
    let (bom, text) = match content {
        Some(text) => text.strip_prefix('\u{feff}').map_or(("", text), |rest| ("\u{feff}", rest)),
        None => ("", ""),
    };
    let settings = if text.trim().is_empty() {
        Json::Object(Vec::new())
    } else {
        serde_json::from_str::<Json>(text).map_err(|error| format!("settings.json isn't valid JSON ({error})"))?
    };
    if !matches!(settings, Json::Object(_)) {
        return Err("settings.json doesn't hold a JSON object".into());
    }
    Ok((bom, settings))
}

fn render_claude_settings(bom: &str, settings: &Json) -> Result<String, String> {
    let pretty = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    Ok(format!("{bom}{pretty}\n"))
}

/// Claude Code's settings with `key` set to `value`, or None when `keep`
/// accepts what it's set to already. Everything else stays as it was.
pub(super) fn set_claude_setting(
    content: Option<&str>,
    key: &str,
    value: serde_json::Value,
    keep: impl Fn(Option<&serde_json::Value>) -> bool,
) -> Result<Option<String>, String> {
    let (bom, mut settings) = read_claude_settings(content)?;
    let current = settings.field(key).map(serde_json::to_value).transpose().map_err(|error| error.to_string())?;
    if keep(current.as_ref()) {
        return Ok(None);
    }
    let value = serde_json::from_value::<Json>(value).map_err(|error| error.to_string())?;
    let Json::Object(entries) = &mut settings else {
        unreachable!();
    };
    match entries.iter_mut().find(|(name, _)| name == key) {
        Some((_, current)) => *current = value,
        None => entries.push((key.to_string(), value)),
    }
    render_claude_settings(bom, &settings).map(Some)
}

/// Claude Code's settings with the setup repo's hooks as `wanted` has them, each an event, a matcher and a handler:
/// every handler `is_repo` says is the repo's is taken out, a group that leaves empty goes too, and then each wanted
/// hook is put back in a group of its own at the end of its event. Every other hook stays as it was, where it was.
/// None when that leaves the file as it was.
pub(super) fn set_repo_hooks(
    content: Option<&str>,
    wanted: &[(String, Option<String>, serde_json::Value)],
    is_repo: impl Fn(&str) -> bool,
) -> Result<Option<String>, String> {
    let (bom, mut settings) = read_claude_settings(content)?;
    let before = render_claude_settings(bom, &settings)?;
    let Json::Object(entries) = &mut settings else {
        unreachable!();
    };
    if !entries.iter().any(|(key, _)| key == "hooks") {
        if wanted.is_empty() {
            return Ok(None);
        }
        entries.push(("hooks".into(), Json::Object(Vec::new())));
    }
    let Some((_, Json::Object(events))) = entries.iter_mut().find(|(key, _)| key == "hooks") else {
        return Err("hooks in settings.json isn't an object".into());
    };
    let repo_handler = |handler: &Json| matches!(handler.field("command"), Some(Json::String(command)) if is_repo(command));
    events.retain_mut(|(_, groups)| {
        let Json::Array(groups) = groups else { return true };
        let had = !groups.is_empty();
        groups.retain_mut(|group| {
            let Some(Json::Array(handlers)) = group.field_mut("hooks") else { return true };
            let before = handlers.len();
            handlers.retain(|handler| !repo_handler(handler));
            !(before > 0 && handlers.is_empty())
        });
        !(had && groups.is_empty())
    });
    for (event, matcher, handler) in wanted {
        let handler = serde_json::from_value::<Json>(handler.clone()).map_err(|error| error.to_string())?;
        let mut group = Vec::new();
        if let Some(matcher) = matcher {
            group.push(("matcher".to_string(), Json::String(matcher.clone())));
        }
        group.push(("hooks".to_string(), Json::Array(vec![handler])));
        match events.iter_mut().find(|(name, _)| name == event) {
            Some((_, Json::Array(groups))) => groups.push(Json::Object(group)),
            Some(_) => return Err(format!("hooks.{event} in settings.json isn't a list")),
            None => events.push((event.clone(), Json::Array(vec![Json::Object(group)]))),
        }
    }
    let after = render_claude_settings(bom, &settings)?;
    Ok((after != before).then_some(after))
}

/// Claude Code's settings without `names` in the object at `key`, or None when it names none of them. Everything else
/// stays as it was, in its order.
pub(super) fn drop_claude_setting_entries(content: Option<&str>, key: &str, names: &[&str]) -> Result<Option<String>, String> {
    let (bom, mut settings) = read_claude_settings(content)?;
    let Some(Json::Object(entries)) = settings.field_mut(key) else { return Ok(None) };
    let before = entries.len();
    entries.retain(|(name, _)| !names.contains(&name.as_str()));
    if entries.len() == before {
        return Ok(None);
    }
    render_claude_settings(bom, &settings).map(Some)
}

/// Claude Code's settings with `change` made to the text values in its `env`,
/// given in order as name and value, or None when that leaves them as they
/// were. Values that aren't text stay where they are, unseen. Everything else
/// in the file stays as it was.
pub(super) fn edit_claude_env(
    content: Option<&str>,
    change: impl FnOnce(&mut Vec<(String, String)>) -> Result<(), String>,
) -> Result<Option<String>, String> {
    let (bom, mut settings) = read_claude_settings(content)?;
    let before: Vec<(String, Json)> = match settings.field("env") {
        None | Some(Json::Null) => Vec::new(),
        Some(Json::Object(entries)) => entries.clone(),
        Some(_) => return Err("env in settings.json isn't an object".into()),
    };
    let mut texts: Vec<(String, String)> = before
        .iter()
        .filter_map(|(name, value)| match value {
            Json::String(text) => Some((name.clone(), text.clone())),
            _ => None,
        })
        .collect();
    let original = texts.clone();
    change(&mut texts)?;
    if texts == original {
        return Ok(None);
    }
    let mut after: Vec<(String, Json)> = Vec::new();
    for (name, value) in &before {
        match value {
            Json::String(_) => {
                if let Some((_, text)) = texts.iter().find(|(entry, _)| entry == name) {
                    after.push((name.clone(), Json::String(text.clone())));
                }
            }
            other => after.push((name.clone(), other.clone())),
        }
    }
    for (name, text) in &texts {
        if !after.iter().any(|(entry, _)| entry == name) {
            after.push((name.clone(), Json::String(text.clone())));
        }
    }
    let Json::Object(entries) = &mut settings else {
        unreachable!();
    };
    match entries.iter().position(|(name, _)| name == "env") {
        // An env emptied of what Arbor put there goes, unless it was there before as {}.
        Some(index) if after.is_empty() && !before.is_empty() => {
            entries.remove(index);
        }
        Some(index) => entries[index].1 = Json::Object(after),
        None => entries.push(("env".into(), Json::Object(after))),
    }
    render_claude_settings(bom, &settings).map(Some)
}

/// Claude Code's settings with the reporter's hooks put in or taken out, or
/// None when they're already that way. Everything else stays as it was.
fn claude_settings(content: Option<&str>, install: bool) -> Result<Option<String>, String> {
    let (bom, original) = read_claude_settings(content)?;
    let mut settings = original.clone();
    let Json::Object(entries) = &mut settings else {
        unreachable!();
    };
    if install && !entries.iter().any(|(key, _)| key == "hooks") {
        entries.push(("hooks".into(), Json::Object(Vec::new())));
    }
    if let Some(index) = entries.iter().position(|(key, _)| key == "hooks") {
        let Json::Object(events) = &mut entries[index].1 else {
            return Err("The hooks in settings.json aren't a JSON object".into());
        };
        let handler = claude_handler();
        let mut emptied = false;
        for (event, groups) in events.iter_mut() {
            let Json::Array(groups) = groups else {
                continue;
            };
            let ours = install && CLAUDE_EVENTS.contains(&event.as_str());
            let (kept, stripped) = strip_claude_handlers(groups, ours.then_some(&handler));
            if ours && !kept {
                groups.push(Json::Object(vec![("hooks".into(), Json::Array(vec![handler.clone()]))]));
            }
            emptied |= stripped && groups.is_empty();
        }
        if emptied {
            events.retain(|(_, groups)| !matches!(groups, Json::Array(groups) if groups.is_empty()));
        }
        if install {
            for event in CLAUDE_EVENTS {
                if !events.iter().any(|(key, _)| key == event) {
                    let group = Json::Object(vec![("hooks".into(), Json::Array(vec![handler.clone()]))]);
                    events.push((event.into(), Json::Array(vec![group])));
                }
            }
        } else if emptied && events.is_empty() {
            entries.remove(index);
        }
    }
    if settings == original {
        return Ok(None);
    }
    render_claude_settings(bom, &settings).map(Some)
}

/// Codex's config with `notify` running the reporter, or back to what it was
/// before, or None when it's already that way. A `notify` set before goes
/// after `--then`, for the reporter to run.
fn codex_config(content: Option<&str>, reporter: &str, install: bool) -> Result<Option<String>, String> {
    let mut document = content
        .unwrap_or("")
        .parse::<toml_edit::Document>()
        .map_err(|error| format!("config.toml isn't valid TOML ({})", error.to_string().trim()))?;
    let current = match document.get("notify") {
        None => None,
        Some(item) => Some(
            item.as_array()
                .and_then(|array| array.iter().map(|value| value.as_str().map(str::to_string)).collect::<Option<Vec<_>>>())
                .ok_or("notify in config.toml isn't a list of words")?,
        ),
    };
    let previous = match &current {
        Some(words) if words.first().is_some_and(|first| first.contains(REPORTER_MARK)) => match words.get(1..) {
            Some([_, then, previous @ ..]) if then == "--then" && !previous.is_empty() => Some(previous.to_vec()),
            _ => None,
        },
        other => other.clone(),
    };
    let next = if install {
        let mut words = vec![reporter.to_string(), "codex".to_string()];
        if let Some(previous) = &previous {
            words.push("--then".into());
            words.extend(previous.iter().cloned());
        }
        Some(words)
    } else {
        previous
    };
    if next == current {
        return Ok(None);
    }
    match next {
        Some(words) => {
            let array = words.iter().map(String::as_str).collect::<toml_edit::Array>();
            set_codex_table_item(document.as_table_mut(), "notify", toml_edit::value(array));
        }
        None => {
            document.remove("notify");
        }
    }
    Ok(Some(document.to_string()))
}

/// A settings file as the read script found it.
#[derive(Clone, Debug, PartialEq)]
struct SettingsFile {
    agent: AgentKind,
    home: String,
    path: String,
    /// What cksum said, or None when there's no file.
    sum: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
struct ReadOutput {
    home: String,
    files: Vec<SettingsFile>,
}

fn parse_read(stdout: &str) -> Result<ReadOutput, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut output = ReadOutput::default();
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        if let Some(home) = line.strip_prefix("H\t") {
            output.home = home.to_string();
            continue;
        }
        let Some(fields) = line.strip_prefix("F\t") else {
            continue;
        };
        let parts: Vec<&str> = fields.splitn(4, '\t').collect();
        let [agent, home, path, sum] = parts[..] else {
            return Err("The machine returned an unreadable settings list".into());
        };
        let agent = match agent {
            "claude" => AgentKind::Claude,
            "codex" => AgentKind::Codex,
            _ => return Err("The machine returned an unreadable settings list".into()),
        };
        let mut encoded = String::new();
        for line in lines.by_ref() {
            if line == "." {
                break;
            }
            encoded.push_str(line.trim());
        }
        let (sum, content) = if sum == "-" {
            (None, None)
        } else {
            let bytes = STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| format!("{path} came back unreadable"))?;
            // cksum's second number is the size, which the decoded copy has to match.
            if sum.rsplit('-').next().and_then(|size| size.parse::<usize>().ok()) != Some(bytes.len()) {
                return Err(format!("{path} came back incomplete"));
            }
            let text = String::from_utf8(bytes).map_err(|_| format!("{path} isn't text Arbor can edit"))?;
            (Some(sum.to_string()), Some(text))
        };
        output.files.push(SettingsFile {
            agent,
            home: home.to_string(),
            path: path.to_string(),
            sum,
            content,
        });
    }
    if output.home.is_empty() {
        return Err("The machine didn't say where its home is".into());
    }
    Ok(output)
}

/// What a change does, or did, to a settings file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FileChange {
    /// A new file.
    Create,
    Edit,
    /// It was already right.
    #[serde(rename = "none")]
    Unchanged,
}

/// One settings file the reporter is set up in, or taken out of.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReporterFile {
    agent: AgentKind,
    /// The agent home, with the machine's home as ~.
    home: String,
    /// The settings file, with the machine's home as ~.
    path: String,
    change: FileChange,
    /// Codex's `notify` was already set: the reporter runs it after itself.
    chained: bool,
    /// Whether the change was made; false for a plan.
    written: bool,
    /// Why it couldn't be made.
    error: Option<String>,
}

/// What setting the reporter up or taking it away changes, or changed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReporterSetup {
    files: Vec<ReporterFile>,
    /// Whether the reporter script itself was put there or taken away.
    reporter_changed: bool,
}

/// A file's new content, ready to write.
struct Change {
    path: String,
    sum: Option<String>,
    content: String,
}

impl Change {
    fn edit(&self) -> Edit {
        Edit {
            file: EditFile::Path(self.path.clone()),
            before: self.sum.clone().unwrap_or_else(|| "-".into()),
            content: self.content.as_bytes().to_vec(),
        }
    }
}

/// Works out each file's change from what the read script found.
fn plan(read: &ReadOutput, install: bool) -> (ReporterSetup, Vec<Change>) {
    let reporter = format!("{}{REPORTER_MARK}", read.home);
    let mut setup = ReporterSetup::default();
    let mut changes = Vec::new();
    let mut seen = HashSet::new();
    for file in &read.files {
        // Homes that share a settings file through a link change it once.
        if !seen.insert(file.path.clone()) {
            continue;
        }
        let content = file.content.as_deref();
        let result = match file.agent {
            AgentKind::Claude => claude_settings(content, install),
            AgentKind::Codex => codex_config(content, &reporter, install),
        };
        let chained = file.agent == AgentKind::Codex
            && content
                .and_then(|text| text.parse::<toml_edit::Document>().ok())
                .and_then(|document| document.get("notify").and_then(|item| item.as_array()).map(|array| {
                    let words: Vec<&str> = array.iter().filter_map(|value| value.as_str()).collect();
                    match words.first() {
                        Some(first) if first.contains(REPORTER_MARK) => words.get(2) == Some(&"--then"),
                        Some(_) => true,
                        None => false,
                    }
                }))
                .unwrap_or(false);
        let (change, error) = match &result {
            Ok(Some(new)) => {
                changes.push(Change { path: file.path.clone(), sum: file.sum.clone(), content: new.clone() });
                (if file.content.is_some() { FileChange::Edit } else { FileChange::Create }, None)
            }
            Ok(None) => (FileChange::Unchanged, None),
            Err(error) => (FileChange::Unchanged, Some(error.clone())),
        };
        // Nothing to take the reporter out of where there's no file.
        if !install && file.content.is_none() {
            continue;
        }
        setup.files.push(ReporterFile {
            agent: file.agent,
            home: tilde(&file.home, &read.home),
            path: tilde(&file.path, &read.home),
            change,
            chained,
            written: false,
            error,
        });
    }
    (setup, changes)
}

pub(super) use super::shell::shell_quote;

/// A heredoc delimiter that no line of `texts` is.
fn heredoc_delimiter(texts: &[&str]) -> String {
    (0..)
        .map(|n| if n == 0 { "ARBOR_EOF".to_string() } else { format!("ARBOR_EOF_{n}") })
        .find(|delimiter| texts.iter().all(|text| !text.lines().any(|line| line == delimiter)))
        .expect("a free delimiter")
}

// Lines out: `E n how` for each change (see guarded_writes), `K stamp` once
// the files it changed are backed up, and `R` once the reporter itself was put
// there or taken away. When taking it away, the reporter stays while any
// settings may still run it.
fn write_script(stamp: &str, kind: ChangeKind, changes: &[Change], install: bool, keep_reporter: bool) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start(stamp, kind));
    if install {
        // The reporter goes in first, so no hook ever points at nothing.
        let end = heredoc_delimiter(&[REPORTER_SCRIPT]);
        script.push_str(&format!(
            "mkdir -p \"$HOME/.arbor/bin\" || exit 1\n\
             cat > \"$HOME/.arbor/bin/arbor-agent-event.tmp\" <<'{end}' || exit 1\n{REPORTER_SCRIPT}{end}\n\
             chmod 755 \"$HOME/.arbor/bin/arbor-agent-event.tmp\" && mv -f \"$HOME/.arbor/bin/arbor-agent-event.tmp\" \"$HOME/.arbor/bin/arbor-agent-event\" || exit 1\n\
             printf 'R\\n'\n"
        ));
    }
    for (n, change) in changes.iter().enumerate() {
        script.push_str(&edit_call(n, &change.edit()));
    }
    script.push_str(&edit_finish());
    if !install && !keep_reporter {
        // Only once no settings run it any more.
        script.push_str(
            "if [ \"$failed\" = 0 ]; then\n\
             \x20 rm -f \"$HOME/.arbor/bin/arbor-agent-event\" \"$HOME/.arbor/agent-events\" \"$HOME/.arbor/agent-events.tmp\"\n\
             \x20 rmdir \"$HOME/.arbor/bin\" \"$HOME/.arbor\" 2>/dev/null\n\
             \x20 printf 'R\\n'\nfi\n",
        );
    }
    script
}

/// What to tell the page about an edit that wasn't made.
fn edit_error(outcome: EditOutcome) -> String {
    match outcome {
        EditOutcome::Changed => "It changed while Arbor was editing it. Try again.".into(),
        _ => "Arbor couldn't write it.".into(),
    }
}

/// Marks each planned file with what the write script says happened to it. False when the
/// script stopped before saying how every change went.
fn apply_write_output(setup: &mut ReporterSetup, changes: &[Change], stdout: &str, home: &str) -> bool {
    setup.reporter_changed = stdout.lines().any(|line| line == "R");
    let outcomes = edit_outcomes(stdout);
    for (n, change) in changes.iter().enumerate() {
        let path = tilde(&change.path, home);
        if let (Some(outcome), Some(file)) = (outcomes.get(&n), setup.files.iter_mut().find(|file| file.path == path)) {
            match outcome {
                EditOutcome::Done => file.written = true,
                other => file.error = Some(edit_error(*other)),
            }
        }
    }
    outcomes.len() == changes.len()
}

/// `body` after the homes whose settings Arbor reads on `machine`.
fn script_with_homes(machine: &str, body: &str) -> String {
    format!("set -u\nexport LC_ALL=C\n{}{body}", agent_homes::shell_function(machine, HomeUse::Sync))
}

/// Reads each agent home's settings with `run` and, unless it's only a plan,
/// writes the changes back.
async fn set_up<F, C>(run: F, install: bool, apply: bool) -> Result<ReporterSetup, String>
where
    F: Fn() -> C,
    C: Into<MachineCommand>,
{
    let command: MachineCommand = run().into();
    let script = script_with_homes(command.machine_name(), READ_SCRIPT);
    let read = parse_read(&run_checked(command, MachineOp::ReporterCheck, &script, SETUP_TIMEOUT).await?)?;
    if install && read.files.is_empty() {
        return Err("Neither Claude Code nor Codex has been run on this machine yet.".into());
    }
    let (mut setup, changes) = plan(&read, install);
    if !apply {
        return Ok(setup);
    }
    // A file that can't be read as settings is left alone, and so is the reporter it may still run.
    let keep_reporter = setup.files.iter().any(|file| file.error.is_some());
    let script = write_script(&new_stamp(), ChangeKind::Reporter, &changes, install, keep_reporter);
    let output = run_on_machine(run(), MachineOp::ReporterSetup, &script, SETUP_TIMEOUT).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let heard = apply_write_output(&mut setup, &changes, &stdout, &read.home);
    if !heard || (install && !setup.reporter_changed) {
        return Err(failure_detail(&output));
    }
    Ok(setup)
}

/// One Claude Code home's settings.json, as another change to the settings left it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsEdit {
    /// The agent home, with the machine's home as ~.
    pub(crate) home: String,
    /// The settings file, with the machine's home as ~.
    pub(crate) path: String,
    pub(crate) change: FileChange,
    pub(crate) written: bool,
    pub(crate) error: Option<String>,
}

/// Changes settings.json in the Claude Code `homes` (named with the machine's
/// home as ~) with `edit`, which takes the file's content and gives the new
/// content, or None when there's nothing to change. The files are read, changed
/// here and written back the same careful way the reporter's are, as a change
/// of `kind`. Unless `write`, nothing is written and the edits say what would
/// change.
pub(super) async fn edit_claude_settings<F, C, E>(run: F, homes: &[String], kind: ChangeKind, edit: E, write: bool) -> Result<Vec<SettingsEdit>, String>
where
    F: Fn() -> C,
    C: Into<MachineCommand>,
    E: Fn(Option<&str>) -> Result<Option<String>, String>,
{
    edit_home_files(run, HomeFile::ClaudeSettings, homes, kind, edit, write).await
}

/// Codex keeps its hooks in hooks.json beside config.toml, in the same shape
/// Claude Code's settings keep theirs, so the read script is pointed there.
const CODEX_HOOKS_FILE: &str = "settings_file() {\n  case \"$1\" in claude) printf '%s/settings.json' \"$2\" ;; *) printf '%s/hooks.json' \"$2\" ;; esac\n}\n";

/// Changes hooks.json in the Codex `homes` the way `edit_claude_settings`
/// changes Claude Code's settings.
pub(super) async fn edit_codex_hooks<F, C, E>(run: F, homes: &[String], kind: ChangeKind, edit: E, write: bool) -> Result<Vec<SettingsEdit>, String>
where
    F: Fn() -> C,
    C: Into<MachineCommand>,
    E: Fn(Option<&str>) -> Result<Option<String>, String>,
{
    edit_home_files(run, HomeFile::CodexHooks, homes, kind, edit, write).await
}

/// Changes config.toml in the Codex `homes` the way `edit_claude_settings`
/// changes Claude Code's settings.
pub(super) async fn edit_codex_config<F, C, E>(run: F, homes: &[String], kind: ChangeKind, edit: E, write: bool) -> Result<Vec<SettingsEdit>, String>
where
    F: Fn() -> C,
    C: Into<MachineCommand>,
    E: Fn(Option<&str>) -> Result<Option<String>, String>,
{
    edit_home_files(run, HomeFile::CodexConfig, homes, kind, edit, write).await
}

/// The file in each agent home an edit changes.
#[derive(Clone, Copy)]
enum HomeFile {
    ClaudeSettings,
    CodexConfig,
    CodexHooks,
}

async fn edit_home_files<F, C, E>(run: F, file: HomeFile, homes: &[String], kind: ChangeKind, edit: E, write: bool) -> Result<Vec<SettingsEdit>, String>
where
    F: Fn() -> C,
    C: Into<MachineCommand>,
    E: Fn(Option<&str>) -> Result<Option<String>, String>,
{
    let command: MachineCommand = run().into();
    let machine = command.machine_name();
    let (agent, read_op, write_op, script, named) = match file {
        HomeFile::ClaudeSettings => (AgentKind::Claude, MachineOp::ClaudeSettingsRead, MachineOp::ClaudeSettingsWrite, script_with_homes(machine, READ_SCRIPT), "Claude Code"),
        // READ_SCRIPT's own settings file for a Codex home is its config.toml.
        HomeFile::CodexConfig => (AgentKind::Codex, MachineOp::CodexSettingsRead, MachineOp::CodexSettingsWrite, script_with_homes(machine, READ_SCRIPT), "Codex"),
        HomeFile::CodexHooks => {
            (AgentKind::Codex, MachineOp::CodexSettingsRead, MachineOp::CodexSettingsWrite, script_with_homes(machine, &format!("{CODEX_HOOKS_FILE}{READ_SCRIPT}")), "Codex")
        }
    };
    let read = parse_read(&run_checked(command, read_op, &script, SETUP_TIMEOUT).await?)?;
    let mut edits = Vec::new();
    let mut changes = Vec::new();
    let mut seen = HashSet::new();
    for home in homes {
        let Some(file) = read.files.iter().find(|file| file.agent == agent && &tilde(&file.home, &read.home) == home) else {
            return Err(format!("{home} isn't a {named} home on this machine any more"));
        };
        let path = tilde(&file.path, &read.home);
        // Homes that share a settings file through a link change it once.
        if !seen.insert(file.path.clone()) {
            continue;
        }
        let (change, error) = match edit(file.content.as_deref()) {
            Ok(Some(content)) => {
                changes.push(Change { path: file.path.clone(), sum: file.sum.clone(), content });
                (if file.content.is_some() { FileChange::Edit } else { FileChange::Create }, None)
            }
            Ok(None) => (FileChange::Unchanged, None),
            Err(error) => (FileChange::Unchanged, Some(error)),
        };
        edits.push(SettingsEdit { home: home.clone(), path, change, written: false, error });
    }
    if changes.is_empty() || !write {
        return Ok(edits);
    }
    let output = run_on_machine(run(), write_op, &write_script(&new_stamp(), kind, &changes, false, true), SETUP_TIMEOUT).await?;
    let outcomes = edit_outcomes(&String::from_utf8_lossy(&output.stdout));
    for (n, change) in changes.iter().enumerate() {
        let Some(outcome) = outcomes.get(&n) else {
            return Err(failure_detail(&output));
        };
        let path = tilde(&change.path, &read.home);
        if let Some(edit) = edits.iter_mut().find(|edit| edit.path == path) {
            edit.written = *outcome == EditOutcome::Done;
            edit.error = (!edit.written).then(|| edit_error(*outcome));
        }
    }
    Ok(edits)
}

/// Sets the reporter up on a machine, or takes it away. `plan` only says what
/// would change. Afterward the machine's agents are checked again, so the
/// page shows where it runs now.
#[tauri::command]
pub(crate) async fn set_agent_reporter(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    enabled: bool,
    plan: Option<bool>,
) -> Result<ReporterSetup, String> {
    let target = find_machine(&state.lock(), &machine)?;
    let apply = plan != Some(true);
    let result = set_up(|| &target, enabled, apply).await;
    if apply {
        if !enabled {
            if let Some(series) = state.lock().series.get_mut(&machine) {
                series.attention = AttentionLog::default();
            }
        }
        agents::recheck(&app, &state, &target).await;
        let _ = app.emit(AGENT_ATTENTION_UPDATED_EVENT, Local::now().timestamp_millis());
    }
    result
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// The reporter on a machine, as the agents check last found it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReporterStatus {
    /// The reporter script is there.
    installed: bool,
    /// Each agent home found, and whether its settings run the reporter.
    homes: Vec<ReporterHome>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReporterHome {
    agent: AgentKind,
    /// With the machine's home as ~.
    home: String,
    reporting: bool,
}

impl ReporterStatus {
    pub(super) fn installed(&self) -> bool {
        self.installed
    }
}

/// The reporter lines of the agents check.
pub(super) fn parse_status(stdout: &str) -> ReporterStatus {
    let home = stdout.lines().find_map(|line| line.strip_prefix("home=")).map(str::trim_end);
    let mut status = ReporterStatus::default();
    for line in stdout.lines() {
        if line.trim() == "reporter=1" {
            status.installed = true;
        } else if let Some(fields) = line.strip_prefix("reporter_home=") {
            let mut parts = fields.splitn(3, '\t');
            let (Some(agent), Some(on), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            let agent = match agent {
                "claude" => AgentKind::Claude,
                "codex" => AgentKind::Codex,
                _ => continue,
            };
            status.homes.push(ReporterHome {
                agent,
                home: home.map_or_else(|| path.to_string(), |home| tilde(path, home)),
                reporting: on == "1",
            });
        }
    }
    status
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// One line of a machine's events file.
#[derive(Clone, Debug, PartialEq)]
struct AgentEvent {
    /// When, in Arbor's clock.
    at_ms: i64,
    /// When, in the machine's clock, as the file has it.
    at_s: i64,
    agent: AgentKind,
    event: String,
    session: String,
}

/// A machine's recent events, and how looking for new ones went.
#[derive(Debug, Default)]
pub(super) struct AttentionLog {
    /// The last WAIT_MAX_AGE_MS of them, oldest first.
    events: VecDeque<AgentEvent>,
    /// The newest event's time in the machine's clock, where the next look starts.
    since_s: i64,
    polling: bool,
    polled_at: Option<i64>,
    error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct PollOutput {
    /// The machine's clock, in seconds.
    now_s: i64,
    events: Vec<(i64, AgentKind, String, String)>,
}

fn poll_script(since_s: i64) -> String {
    format!(
        "set -u\nexport LC_ALL=C\n\
         now=$(date +%s)\nprintf 'now %s\\n' \"$now\"\n\
         f=\"$HOME/.arbor/agent-events\"\n[ -f \"$f\" ] || exit 0\n\
         since={since_s}\n[ \"$since\" -gt 0 ] || since=$((now - {max_age_s}))\n\
         awk -v since=\"$since\" '$1 >= since' \"$f\"\n\
         size=$(wc -c < \"$f\" | tr -d ' ')\n\
         if [ \"$size\" -gt {EVENTS_FILE_BYTES} ]; then tail -n {EVENTS_KEPT} \"$f\" > \"$f.tmp\" && mv -f \"$f.tmp\" \"$f\"; fi\n",
        max_age_s = WAIT_MAX_AGE_MS / 1000,
    )
}

fn is_word(value: &str, extra: &[char]) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || extra.contains(&c))
}

fn parse_poll(stdout: &str) -> Result<PollOutput, String> {
    let mut output = PollOutput::default();
    for line in stdout.lines() {
        let words: Vec<&str> = line.split(' ').collect();
        match words[..] {
            ["now", now] => output.now_s = now.parse().map_err(|_| "The machine's clock came back unreadable".to_string())?,
            [at, agent, event, session] => {
                let (Ok(at), Some(agent)) = (at.parse::<i64>(), match agent {
                    "claude" => Some(AgentKind::Claude),
                    "codex" => Some(AgentKind::Codex),
                    _ => None,
                }) else {
                    continue;
                };
                if is_word(event, &[]) && is_word(session, &['.']) {
                    output.events.push((at, agent, event.to_string(), session.to_string()));
                }
            }
            _ => {}
        }
    }
    if output.now_s == 0 {
        return Err("The machine didn't say what time it is".into());
    }
    Ok(output)
}

/// Adds a look's events to a machine's log, in Arbor's clock. Returns whether any were new.
fn merge_poll(log: &mut AttentionLog, poll: PollOutput, now_ms: i64) -> bool {
    // The machine's clock can be off from this one's.
    let offset_ms = now_ms - poll.now_s * 1000;
    let mut added = false;
    for (at_s, agent, event, session) in poll.events {
        let seen = at_s < log.since_s
            || log.events.iter().rev().take_while(|known| known.at_s >= at_s).any(|known| {
                known.at_s == at_s && known.agent == agent && known.event == event && known.session == session
            });
        if seen {
            continue;
        }
        log.since_s = log.since_s.max(at_s);
        let event = AgentEvent { at_ms: at_s * 1000 + offset_ms, at_s, agent, event, session };
        let index = log.events.iter().rposition(|known| known.at_s <= at_s).map_or(0, |index| index + 1);
        log.events.insert(index, event);
        added = true;
    }
    while log
        .events
        .front()
        .is_some_and(|event| log.events.len() > EVENTS_KEPT || event.at_ms < now_ms - WAIT_MAX_AGE_MS)
    {
        log.events.pop_front();
    }
    added
}

/// Machines the reporter is set up on that answered their last sample, marked as being asked.
fn take_pollable(state: &MachineHealthState) -> Vec<(Machine, i64)> {
    let mut inner = state.lock();
    inner
        .series
        .values_mut()
        .filter(|series| series.host.enabled && series.error.is_none() && series.last_ok_at.is_some())
        .filter(|series| series.agents.reporter().installed() && !series.attention.polling)
        .map(|series| {
            series.attention.polling = true;
            (Machine::listed(series), series.attention.since_s)
        })
        .collect()
}

async fn poll(machine: &Machine, since_s: i64) -> Result<PollOutput, String> {
    parse_poll(&run_checked(machine, MachineOp::NeedsYouPoll, &poll_script(since_s), POLL_TIMEOUT).await?)
}

/// Stores a look's result, unless the machine has since been pointed somewhere else.
fn record_poll(state: &MachineHealthState, machine: &str, host: &MachineHost, result: Result<PollOutput, String>, now_ms: i64) -> bool {
    let mut inner = state.lock();
    let Some(series) = inner.series.get_mut(machine) else {
        return false;
    };
    if series.host.endpoint != host.endpoint || series.host.port != host.port {
        return false;
    }
    let log = &mut series.attention;
    log.polling = false;
    log.polled_at = Some(now_ms);
    match result {
        Ok(poll) => {
            log.error = None;
            merge_poll(log, poll, now_ms)
        }
        Err(error) => {
            log.error = Some(error);
            false
        }
    }
}

/// Asks each machine the reporter is set up on for its new events, every few seconds.
pub(super) async fn poll_loop(app: tauri::AppHandle, token: CancellationToken) {
    let state = app.state::<MachineHealthState>();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {},
            _ = token.cancelled() => return,
        }
        let targets = take_pollable(&state);
        if targets.is_empty() {
            continue;
        }
        let results = futures_util::future::join_all(targets.into_iter().map(|(machine, since_s)| async move {
            let started_ms = Local::now().timestamp_millis();
            let result = poll(&machine, since_s).await;
            // The machine read its clock somewhere in between.
            let at_ms = (started_ms + Local::now().timestamp_millis()) / 2;
            (machine, result, at_ms)
        }))
        .await;
        let mut changed = false;
        for (machine, result, at_ms) in results {
            changed |= record_poll(&state, machine.name(), machine.host(), result, at_ms);
        }
        if changed {
            let _ = app.emit(AGENT_ATTENTION_UPDATED_EVENT, Local::now().timestamp_millis());
        }
    }
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WaitKind {
    /// Asking to use a tool.
    Permission,
    /// Asking something only the user can answer.
    Question,
    /// Done with its turn, waiting for the next prompt.
    Waiting,
}

impl WaitKind {
    fn rank(self) -> u8 {
        match self {
            Self::Permission => 0,
            Self::Question => 1,
            Self::Waiting => 2,
        }
    }

    fn settle_ms(self) -> i64 {
        match self {
            Self::Permission | Self::Question => PERMISSION_SETTLE_MS,
            Self::Waiting => WAITING_SETTLE_MS,
        }
    }
}

/// A session waiting on its user, by its events alone.
#[derive(Clone, Debug, PartialEq)]
struct Wait {
    machine: String,
    agent: AgentKind,
    session: String,
    kind: WaitKind,
    since_ms: i64,
}

/// The sessions a machine's events leave waiting.
fn event_waits(machine: &str, events: &[&AgentEvent]) -> Vec<Wait> {
    let mut waits: Vec<Wait> = Vec::new();
    let mut ended: HashSet<(AgentKind, &str)> = HashSet::new();
    for event in events {
        let key = (event.agent, event.session.as_str());
        let index = waits.iter().position(|wait| (wait.agent, wait.session.as_str()) == key);
        let kind = match event.event.as_str() {
            "permission_prompt" => Some(WaitKind::Permission),
            "elicitation_dialog" | "agent_needs_input" => Some(WaitKind::Question),
            "stop" | "turn" => Some(WaitKind::Waiting),
            // Claude Code saying again that it's idle doesn't start the wait over, or end one for permission.
            "idle_prompt" if index.is_none() => Some(WaitKind::Waiting),
            "prompt" | "end" => {
                if let Some(index) = index {
                    waits.remove(index);
                }
                if event.event == "end" {
                    ended.insert(key);
                }
                continue;
            }
            _ => None,
        };
        let Some(kind) = kind else {
            continue;
        };
        ended.remove(&key);
        let wait = Wait {
            machine: machine.to_string(),
            agent: event.agent,
            session: event.session.clone(),
            kind,
            since_ms: event.at_ms,
        };
        match index {
            Some(index) => waits[index] = wait,
            None => waits.push(wait),
        }
    }
    waits
}

/// Drops the waits the requests show are over: the session's own thread sent
/// one after the wait began. A subagent's turn doesn't wait on anyone.
fn unanswered(connection: &Connection, waits: Vec<Wait>, now_ms: i64) -> Result<Vec<Wait>, String> {
    let mut statement = connection
        .prepare(
            "SELECT MAX(timestamp_ms), MAX(COALESCE(parent_session_id, '') <> '')
             FROM usage_events WHERE session_id = ?1",
        )
        .map_err(|error| format!("Failed to prepare the waiting sessions query: {error}"))?;
    let mut open = Vec::new();
    for wait in waits {
        if now_ms - wait.since_ms > WAIT_MAX_AGE_MS {
            continue;
        }
        let (latest, subagent): (Option<i64>, Option<bool>) = statement
            .query_row([&wait.session], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| format!("Failed to check a waiting session: {error}"))?;
        if subagent == Some(true) || latest.is_some_and(|latest| latest > wait.since_ms + wait.kind.settle_ms()) {
            continue;
        }
        open.push(wait);
    }
    Ok(open)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttentionItem {
    machine: String,
    agent: AgentKind,
    session_id: String,
    kind: WaitKind,
    since_ms: i64,
    /// The session as the Sessions page lists it, when its requests came through Arbor.
    session: Option<UsageSession>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAttentionReport {
    /// Those asking for permission or an answer first, then those done with their turn; the longest waiting first.
    items: Vec<AttentionItem>,
    /// Machines the reporter is set up on.
    reporting: Vec<String>,
}

/// What the machines' reporters have said, taken under the lock so the database is read without it.
pub(in crate::usage) struct PendingWaits {
    waits: Vec<Wait>,
    /// Machines the reporter is set up on.
    reporting: Vec<String>,
}

pub(in crate::usage) fn pending_waits(state: &MachineHealthState) -> PendingWaits {
    let inner = state.lock();
    let mut waits = Vec::new();
    let mut reporting = Vec::new();
    for series in inner.series.values().filter(|series| series.host.enabled) {
        if series.agents.reporter().installed() {
            reporting.push(series.host.machine.clone());
        }
        let events: Vec<&AgentEvent> = series.attention.events.iter().collect();
        waits.extend(event_waits(&series.host.machine, &events));
    }
    PendingWaits { waits, reporting }
}

/// The waits still unanswered, each with its session: the Needs you card's report, and the fleet board's.
pub(in crate::usage) fn attention_report(
    connection: &Connection,
    config: &GuiConfigFile,
    pending: PendingWaits,
    now_ms: i64,
) -> Result<AgentAttentionReport, String> {
    let items = attention_items(connection, config, unanswered(connection, pending.waits, now_ms)?, now_ms)?;
    Ok(AgentAttentionReport { items, reporting: pending.reporting })
}

/// Each wait with its session, most pressing first.
fn attention_items(connection: &Connection, config: &GuiConfigFile, mut waits: Vec<Wait>, now_ms: i64) -> Result<Vec<AttentionItem>, String> {
    waits.sort_by(|left, right| {
        left.kind
            .rank()
            .cmp(&right.kind.rank())
            .then(left.since_ms.cmp(&right.since_ms))
            .then_with(|| left.session.cmp(&right.session))
    });
    let mut items = Vec::with_capacity(waits.len());
    for wait in waits {
        let query = UsageQuery {
            session: Some(wait.session.clone()),
            ..UsageQuery::default()
        };
        let mut sessions = session_read::select_sessions(
            connection,
            config,
            now_ms,
            &session_read::SessionSelect {
                query: &query,
                only_active: false,
                order: session_read::SessionOrder::Recent,
                limit: None,
                transcripts: true,
            },
        )?
        .sessions;
        sessions.retain(|session| session.root.id == wait.session);
        items.push(AttentionItem {
            machine: wait.machine,
            agent: wait.agent,
            session_id: wait.session,
            kind: wait.kind,
            since_ms: wait.since_ms,
            session: sessions.pop(),
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7";
    const THREAD: &str = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

    // What `~/.claude/settings.json` looks like after Claude Code wrote it:
    // two-space JSON, keys in the order they were added, a hook of another tool.
    const CLAUDE_SETTINGS: &str = r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317"
  },
  "permissions": {
    "allow": [
      "Bash(git status:*)"
    ],
    "deny": []
  },
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/other-tool stop"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/other-tool guard",
            "timeout": 1.5
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  },
  "alwaysThinkingEnabled": true
}
"#;

    const CODEX_CONFIG: &str = r#"# Codex settings
model = "gpt-5.5"
notify = ["/Applications/Sky.app/Contents/MacOS/SkyComputerUseClient", "turn-ended"] # keeps the dock badge
approval_policy = "on-request"

[projects."/Users/cam/src/arbor"]
trust_level = "trusted"

[hooks.state]
"#;

    fn claude_commands(settings: &str, event: &str) -> Vec<String> {
        let value: Value = serde_json::from_str(settings).unwrap();
        value["hooks"][event]
            .as_array()
            .map(|groups| {
                groups
                    .iter()
                    .flat_map(|group| group["hooks"].as_array().cloned().unwrap_or_default())
                    .map(|handler| handler["command"].as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn claude_hooks_go_in_beside_the_others_and_come_out_leaving_the_file_as_it_was() {
        let installed = claude_settings(Some(CLAUDE_SETTINGS), true).unwrap().expect("a change");
        for event in CLAUDE_EVENTS {
            assert!(claude_commands(&installed, event).contains(&CLAUDE_COMMAND.to_string()), "{event}");
        }
        assert_eq!(
            claude_commands(&installed, "Stop"),
            ["~/.local/bin/other-tool stop", CLAUDE_COMMAND],
            "another tool's hook runs as before, first",
        );
        assert!(claude_commands(&installed, "PreToolUse").iter().all(|command| !command.contains(REPORTER_MARK)));
        // Keys stay where they were, the new events go after the ones there, and the timeout stays 1.5.
        let keys: Vec<&str> = installed.lines().filter(|line| line.starts_with("  \"")).map(|line| line.trim().split('"').nth(1).unwrap()).collect();
        assert_eq!(keys, ["env", "permissions", "model", "hooks", "statusLine", "alwaysThinkingEnabled"]);
        let events: Vec<&str> = installed.lines().filter(|line| line.starts_with("    \"")).map(|line| line.trim().split('"').nth(1).unwrap()).collect();
        assert_eq!(events, ["ANTHROPIC_BASE_URL", "allow", "deny", "Stop", "PreToolUse", "Notification", "UserPromptSubmit", "SessionEnd", "type", "command"]);
        assert!(installed.contains("\"timeout\": 1.5"));

        assert_eq!(claude_settings(Some(&installed), true).unwrap(), None, "setting up twice changes nothing");
        let removed = claude_settings(Some(&installed), false).unwrap().expect("a change");
        assert_eq!(removed, CLAUDE_SETTINGS, "taking it out gives back the file byte for byte");
        assert_eq!(claude_settings(Some(CLAUDE_SETTINGS), false).unwrap(), None);
    }

    #[test]
    fn claude_settings_are_created_when_missing_and_odd_ones_are_left_alone() {
        let created = claude_settings(None, true).unwrap().expect("a new file");
        let value: Value = serde_json::from_str(&created).unwrap();
        assert_eq!(value.as_object().unwrap().keys().collect::<Vec<_>>(), ["hooks"]);
        assert_eq!(value["hooks"]["Notification"][0]["hooks"][0]["timeout"], CLAUDE_HOOK_TIMEOUT_S);
        assert_eq!(claude_settings(Some(&created), false).unwrap().as_deref(), Some("{}\n"));
        assert_eq!(claude_settings(None, false).unwrap(), None);
        assert_eq!(claude_settings(Some(""), true).unwrap(), Some(created));

        assert!(claude_settings(Some("{\"model\": \"opus\",}"), true).unwrap_err().starts_with("settings.json isn't valid JSON"));
        assert_eq!(claude_settings(Some("[]"), true).unwrap_err(), "settings.json doesn't hold a JSON object");
        assert_eq!(claude_settings(Some("{\"hooks\": []}"), true).unwrap_err(), "The hooks in settings.json aren't a JSON object");
    }

    #[test]
    fn an_older_reporter_hook_is_replaced_and_a_hook_someone_shared_keeps_its_group() {
        let older = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/home/cam/.arbor/bin/arbor-agent-event claude"},{"type":"command","command":"say done"}]}],"SubagentStop":[{"hooks":[{"type":"command","command":"/home/cam/.arbor/bin/arbor-agent-event claude"}]}]}}"#;
        let installed = claude_settings(Some(older), true).unwrap().expect("a change");
        assert_eq!(claude_commands(&installed, "Stop"), ["say done", CLAUDE_COMMAND]);
        assert!(!installed.contains("SubagentStop"), "an event only the reporter used goes");
        let removed = claude_settings(Some(&installed), false).unwrap().expect("a change");
        assert_eq!(claude_commands(&removed, "Stop"), ["say done"]);
        assert!(!removed.contains(REPORTER_MARK));
    }

    #[test]
    fn codex_notify_runs_the_reporter_first_and_goes_back_to_what_it_was() {
        let reporter = "/Users/cam/.arbor/bin/arbor-agent-event";
        let installed = codex_config(Some(CODEX_CONFIG), reporter, true).unwrap().expect("a change");
        let document = installed.parse::<toml_edit::Document>().unwrap();
        let notify: Vec<&str> = document["notify"].as_array().unwrap().iter().filter_map(|value| value.as_str()).collect();
        assert_eq!(notify, [reporter, "codex", "--then", "/Applications/Sky.app/Contents/MacOS/SkyComputerUseClient", "turn-ended"]);
        assert!(installed.contains("# keeps the dock badge"));
        assert!(installed.starts_with("# Codex settings\nmodel = \"gpt-5.5\"\nnotify = ["));
        assert_eq!(codex_config(Some(&installed), reporter, true).unwrap(), None);
        assert_eq!(codex_config(Some(&installed), reporter, false).unwrap().as_deref(), Some(CODEX_CONFIG));

        let fresh = codex_config(None, reporter, true).unwrap().expect("a new file");
        assert_eq!(fresh, format!("notify = [\"{reporter}\", \"codex\"]\n"));
        assert_eq!(codex_config(Some(&fresh), reporter, false).unwrap().as_deref(), Some(""));
        let tables = "[projects.\"/src\"]\ntrust_level = \"trusted\"\n";
        let added = codex_config(Some(tables), reporter, true).unwrap().unwrap();
        assert!(added.starts_with("notify = ["), "a top-level key goes above the tables: {added}");
        assert_eq!(codex_config(Some(&added), reporter, false).unwrap().as_deref(), Some(tables));

        assert_eq!(codex_config(Some("notify = \"say\"\n"), reporter, true).unwrap_err(), "notify in config.toml isn't a list of words");
        assert!(codex_config(Some("model = \n"), reporter, true).unwrap_err().starts_with("config.toml isn't valid TOML"));
    }

    #[test]
    fn the_read_output_needs_whole_files() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let body = STANDARD.encode("{}\n");
        let stdout = format!(
            "H\t/home/cam\nF\tclaude\t/home/cam/.claude\t/home/cam/.claude/settings.json\tc123-3\n{body}\n.\n\
             F\tcodex\t/home/cam/.codex\t/home/cam/.codex/config.toml\t-\n.\n"
        );
        let read = parse_read(&stdout).unwrap();
        assert_eq!(read.home, "/home/cam");
        assert_eq!(read.files[0].content.as_deref(), Some("{}\n"));
        assert_eq!(read.files[0].sum.as_deref(), Some("c123-3"));
        assert_eq!(read.files[1].content, None);
        let short = stdout.replace("c123-3", "c123-4");
        assert_eq!(parse_read(&short).unwrap_err(), "/home/cam/.claude/settings.json came back incomplete");
        assert_eq!(parse_read("F\tclaude\n").unwrap_err(), "The machine returned an unreadable settings list");
    }

    fn event(at_s: i64, agent: AgentKind, name: &str, session: &str) -> AgentEvent {
        AgentEvent { at_ms: at_s * 1000, at_s, agent, event: name.into(), session: session.into() }
    }

    #[test]
    fn events_are_read_once_in_this_machines_clock_and_forgotten_after_a_while() {
        let output = parse_poll(&format!(
            "now 1000\n990 claude stop {SESSION}\n995 codex turn {THREAD}\n996 claude stop bad/id\n997 gemini stop x\nnot an event\n"
        ))
        .unwrap();
        assert_eq!(output.now_s, 1000);
        assert_eq!(output.events.len(), 2, "odd lines are skipped");
        assert_eq!(parse_poll("").unwrap_err(), "The machine didn't say what time it is");

        let mut log = AttentionLog::default();
        // The machine's clock is 2 seconds behind.
        assert!(merge_poll(&mut log, output.clone(), 1_002_000));
        assert_eq!(log.events.iter().map(|event| event.at_ms).collect::<Vec<_>>(), [992_000, 997_000]);
        assert_eq!(log.since_s, 995);
        assert!(!merge_poll(&mut log, output, 1_012_000), "the same lines again are nothing new");
        let later = PollOutput { now_s: 1010, events: vec![(995, AgentKind::Codex, "turn".into(), THREAD.into()), (1005, AgentKind::Claude, "prompt".into(), SESSION.into())] };
        assert!(merge_poll(&mut log, later, 1_012_000));
        assert_eq!(log.events.len(), 3);
        let much_later = PollOutput { now_s: 1000 + WAIT_MAX_AGE_MS / 1000, events: Vec::new() };
        merge_poll(&mut log, much_later, 1_000_000 + WAIT_MAX_AGE_MS);
        assert_eq!(log.events.len(), 1, "only the last WAIT_MAX_AGE_MS stay");
        assert_eq!(log.events[0].event, "prompt");
    }

    #[test]
    fn a_session_waits_from_its_prompt_or_its_stop_until_it_has_a_new_prompt() {
        let events = [
            event(100, AgentKind::Claude, "prompt", SESSION),
            event(110, AgentKind::Claude, "permission_prompt", SESSION),
            event(120, AgentKind::Codex, "turn", THREAD),
            event(130, AgentKind::Claude, "stop", SESSION),
            event(190, AgentKind::Claude, "idle_prompt", SESSION),
            event(200, AgentKind::Claude, "auth_success", SESSION),
        ];
        let refs: Vec<&AgentEvent> = events.iter().collect();
        let waits = event_waits("mbp", &refs);
        assert_eq!(
            waits.iter().map(|wait| (wait.agent, wait.kind, wait.since_ms)).collect::<Vec<_>>(),
            [(AgentKind::Claude, WaitKind::Waiting, 130_000), (AgentKind::Codex, WaitKind::Waiting, 120_000)],
            "being idle again doesn't restart the wait",
        );
        let answered = [event(110, AgentKind::Claude, "permission_prompt", SESSION), event(115, AgentKind::Claude, "prompt", SESSION)];
        assert!(event_waits("mbp", &answered.iter().collect::<Vec<_>>()).is_empty());
        let ended = [event(130, AgentKind::Claude, "stop", SESSION), event(140, AgentKind::Claude, "end", SESSION)];
        assert!(event_waits("mbp", &ended.iter().collect::<Vec<_>>()).is_empty());
        let asked = [event(130, AgentKind::Claude, "stop", SESSION), event(140, AgentKind::Claude, "elicitation_dialog", SESSION)];
        assert_eq!(event_waits("mbp", &asked.iter().collect::<Vec<_>>())[0].kind, WaitKind::Question);
    }

    fn requests_database(requests: &[(&str, i64, Option<&str>)]) -> Connection {
        let connection = crate::usage::schema::test_database();
        for (session, at_ms, parent) in requests {
            crate::usage::schema::insert_request(
                &connection,
                "session_id, parent_session_id, timestamp_ms",
                rusqlite::params![session, parent, at_ms],
            );
        }
        connection
    }

    fn wait(session: &str, kind: WaitKind, since_ms: i64) -> Wait {
        Wait { machine: "mbp".into(), agent: AgentKind::Claude, session: session.into(), kind, since_ms }
    }

    #[test]
    fn a_request_from_the_session_after_the_wait_ends_it_unless_it_came_as_the_turn_ended() {
        let now = 10_000_000;
        let connection = requests_database(&[
            ("permission", now - 60_000, None),
            ("permission", now - 50_000, None),
            ("side-call", now - 120_000 + 5_000, None),
            ("answered", now - 60_000, None),
            ("subagent", now - 600_000, Some("root")),
        ]);
        let open = unanswered(
            &connection,
            vec![
                wait("permission", WaitKind::Permission, now - 55_000),
                wait("side-call", WaitKind::Waiting, now - 120_000),
                wait("answered", WaitKind::Waiting, now - 120_000),
                wait("unknown", WaitKind::Waiting, now - 60_000),
                wait("subagent", WaitKind::Waiting, now - 60_000),
                wait("stale", WaitKind::Permission, now - WAIT_MAX_AGE_MS - 1),
            ],
            now,
        )
        .unwrap();
        assert_eq!(open.iter().map(|wait| wait.session.as_str()).collect::<Vec<_>>(), ["side-call", "unknown"]);
    }

    #[test]
    fn the_agents_check_says_where_the_reporter_runs() {
        let status = parse_status(
            "claude_path=/usr/local/bin/claude\nhome=/home/cam\nreporter=1\nreporter_home=claude\t1\t/home/cam/.claude\n\
             reporter_home=codex\t0\t/home/cam/.agent-app/homes/codex proxy\nreporter_home=gemini\t1\t/x\n",
        );
        assert!(status.installed());
        assert_eq!(
            status.homes,
            [
                ReporterHome { agent: AgentKind::Claude, home: "~/.claude".into(), reporting: true },
                ReporterHome { agent: AgentKind::Codex, home: "~/.agent-app/homes/codex proxy".into(), reporting: false },
            ],
        );
        assert_eq!(parse_status(""), ReporterStatus::default());
    }

    #[test]
    fn heredocs_end_on_a_line_no_file_has() {
        assert_eq!(heredoc_delimiter(&["a\nb\n"]), "ARBOR_EOF");
        assert_eq!(heredoc_delimiter(&["ARBOR_EOF\n", "x\nARBOR_EOF_1\n"]), "ARBOR_EOF_2");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        const SECRET: &str = "NEVER-LEAVES-THE-SESSION";

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-attention-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            fs::canonicalize(&home).unwrap()
        }

        fn shell(home: &Path) -> tokio::process::Command {
            let mut command = tokio::process::Command::new("sh");
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            command
        }

        fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
            tokio::runtime::Runtime::new().unwrap().block_on(future)
        }

        fn write(path: &Path, content: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        /// Runs the installed reporter as an agent would: `input` on stdin, `args` after it.
        fn report(home: &Path, args: &[&str], input: &str) -> std::process::Output {
            use std::io::Write as _;
            let mut child = std::process::Command::new(home.join(".arbor/bin/arbor-agent-event"))
                .args(args)
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
            child.wait_with_output().unwrap()
        }

        fn claude_hook(event: &str, extra: &str) -> String {
            format!(
                r#"{{"session_id":"{SESSION}","transcript_path":"/home/x/.claude/projects/p/{SESSION}.jsonl","cwd":"/home/x/src","permission_mode":"default","hook_event_name":"{event}"{extra}}}"#
            )
        }

        fn events(home: &Path) -> Vec<String> {
            fs::read_to_string(home.join(".arbor/agent-events"))
                .unwrap_or_default()
                .lines()
                .map(|line| line.split_once(' ').unwrap().1.to_string())
                .collect()
        }

        #[test]
        fn setting_up_edits_each_home_and_taking_it_away_puts_every_file_back() {
            let home = temp_home("setup");
            let claude = home.join(".claude/settings.json");
            let codex = home.join(".codex/config.toml");
            write(&claude, CLAUDE_SETTINGS);
            write(&codex, CODEX_CONFIG);
            fs::set_permissions(&codex, fs::Permissions::from_mode(0o600)).unwrap();
            // Another app's homes, on the list with Sync on: one for Claude Code without settings yet, one for Codex.
            agent_homes::tests::save_on_this_thread(vec![
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Claude, "~/.agent-app/homes/*", true, true),
                agent_homes::tests::home("", agent_homes::AgentHomeKind::Codex, "~/.agent-app/homes/*", true, true),
            ]);
            fs::create_dir_all(home.join(".agent-app/homes/claude-other/projects")).unwrap();
            fs::create_dir_all(home.join(".agent-app/homes/codex-other/sessions")).unwrap();
            // A home whose settings link to the default's is edited once, through the link.
            fs::create_dir_all(home.join(".agent-app/homes/claude-linked/projects")).unwrap();
            std::os::unix::fs::symlink(&claude, home.join(".agent-app/homes/claude-linked/settings.json")).unwrap();

            let planned = block_on(set_up(|| shell(&home), true, false)).unwrap();
            let summary: Vec<(&str, FileChange, bool)> = planned.files.iter().map(|file| (file.path.as_str(), file.change, file.chained)).collect();
            assert_eq!(
                summary,
                [
                    ("~/.claude/settings.json", FileChange::Edit, false),
                    ("~/.codex/config.toml", FileChange::Edit, true),
                    ("~/.agent-app/homes/claude-other/settings.json", FileChange::Create, false),
                    ("~/.agent-app/homes/codex-other/config.toml", FileChange::Create, false),
                ],
            );
            assert!(!home.join(".arbor").exists(), "a plan changes nothing");

            let done = block_on(set_up(|| shell(&home), true, true)).unwrap();
            assert!(done.reporter_changed);
            assert!(done.files.iter().all(|file| file.written && file.error.is_none()), "{done:?}");
            let reporter = home.join(".arbor/bin/arbor-agent-event");
            assert_eq!(fs::metadata(&reporter).unwrap().permissions().mode() & 0o777, 0o755);
            assert_eq!(claude_commands(&fs::read_to_string(&claude).unwrap(), "Stop"), ["~/.local/bin/other-tool stop", CLAUDE_COMMAND]);
            assert!(fs::symlink_metadata(home.join(".agent-app/homes/claude-linked/settings.json")).unwrap().file_type().is_symlink());
            assert!(!claude.with_extension("json.arbor-backup").exists(), "the copy before goes into the list of changes");
            assert_eq!(fs::metadata(&codex).unwrap().permissions().mode() & 0o777, 0o600, "a file keeps its mode");
            let created = home.join(".agent-app/homes/codex-other/config.toml");
            assert_eq!(fs::read_to_string(&created).unwrap(), format!("notify = [\"{}\", \"codex\"]\n", reporter.display()));
            assert_eq!(fs::metadata(&created).unwrap().permissions().mode() & 0o777, 0o600);

            // The agents check sees it.
            let output = block_on(run_script(shell(&home), &script_with_homes("", REPORTER_CHECK), Duration::from_secs(10))).unwrap();
            let status = parse_status(&String::from_utf8_lossy(&output.stdout));
            assert!(status.installed());
            assert_eq!(status.homes.len(), 5);
            assert!(status.homes.iter().all(|home| home.reporting));

            let again = block_on(set_up(|| shell(&home), true, true)).unwrap();
            assert!(again.files.iter().all(|file| file.change == FileChange::Unchanged), "{again:?}");

            let removed = block_on(set_up(|| shell(&home), false, true)).unwrap();
            assert!(removed.reporter_changed);
            assert_eq!(fs::read_to_string(&claude).unwrap(), CLAUDE_SETTINGS);
            assert_eq!(fs::read_to_string(&codex).unwrap(), CODEX_CONFIG);
            assert_eq!(fs::read_to_string(home.join(".agent-app/homes/claude-other/settings.json")).unwrap(), "{}\n");
            assert_eq!(fs::read_to_string(&created).unwrap(), "");
            assert!(!home.join(".arbor/bin").exists() && !home.join(".arbor/agent-events").exists(), "the reporter and its events go too");
            // Setting it up and taking it away are each a change on the list, which can undo them.
            let backups: Vec<String> = fs::read_dir(home.join(".arbor/setup-backups")).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
            assert_eq!(backups.len(), 2, "{backups:?}");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_file_arbor_cant_read_keeps_the_reporter_while_the_rest_is_undone() {
            let home = temp_home("unreadable");
            write(&home.join(".claude/settings.json"), "{}\n");
            write(&home.join(".codex/config.toml"), "");
            block_on(set_up(|| shell(&home), true, true)).unwrap();
            write(&home.join(".claude/settings.json"), "{\"hooks\": {\"Stop\": [{\"hooks\": [{\"command\": \"~/.arbor/bin/arbor-agent-event claude\"}]}]},}\n");
            let removed = block_on(set_up(|| shell(&home), false, true)).unwrap();
            assert!(removed.files[0].error.as_deref().is_some_and(|error| error.starts_with("settings.json isn't valid JSON")));
            assert!(removed.files[1].written);
            assert_eq!(fs::read_to_string(home.join(".codex/config.toml")).unwrap(), "");
            assert!(!removed.reporter_changed);
            assert!(home.join(".arbor/bin/arbor-agent-event").exists(), "a hook may still run it");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_file_changed_after_it_was_read_is_left_alone() {
            let home = temp_home("race");
            let claude = home.join(".claude/settings.json");
            write(&claude, CLAUDE_SETTINGS);
            let output = block_on(run_script(shell(&home), &script_with_homes("", READ_SCRIPT), Duration::from_secs(10))).unwrap();
            let read = parse_read(&String::from_utf8_lossy(&output.stdout)).unwrap();
            let (mut setup, changes) = plan(&read, true);
            write(&claude, "{\"model\": \"sonnet\"}\n");
            let script = write_script(&new_stamp(), ChangeKind::Reporter, &changes, true, false);
            let output = block_on(run_script(shell(&home), &script, Duration::from_secs(10))).unwrap();
            assert!(apply_write_output(&mut setup, &changes, &String::from_utf8_lossy(&output.stdout), &read.home));
            assert_eq!(setup.files[0].error.as_deref(), Some("It changed while Arbor was editing it. Try again."));
            assert!(!setup.files[0].written);
            assert_eq!(fs::read_to_string(&claude).unwrap(), "{\"model\": \"sonnet\"}\n");
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn the_reporter_keeps_the_event_and_the_session_and_nothing_else() {
            let home = temp_home("reporter");
            write(&home.join(".claude/settings.json"), "{}\n");
            write(&home.join(".codex/config.toml"), "notify = [\"sh\", \"-c\", \"printf '%s' \\\"$1\\\" > \\\"$HOME/chained\\\"\", \"sh\"]\n");
            block_on(set_up(|| shell(&home), true, true)).unwrap();

            let prompt = format!(r#","prompt":"{SECRET} \"session_id\":\"{SECRET}\",\"hook_event_name\":\"Stop\"""#);
            let long = format!(r#","last_assistant_message":"{}""#, SECRET.repeat(20_000));
            for (event, extra) in [
                ("UserPromptSubmit", prompt.as_str()),
                ("Notification", r#","message":"Claude needs your permission to use Bash","notification_type":"permission_prompt""#),
                ("Stop", long.as_str()),
                ("SessionEnd", r#","reason":"prompt_input_exit""#),
                ("PreToolUse", r#","tool_name":"Bash""#),
            ] {
                let output = report(&home, &["claude"], &claude_hook(event, extra));
                assert!(output.status.success());
                assert!(output.stdout.is_empty() && output.stderr.is_empty(), "{event} printed something");
            }
            let payload = format!(
                r#"{{"type":"agent-turn-complete","thread-id":"{THREAD}","turn-id":"t1","cwd":"/home/x/src","client":"codex-tui","input-messages":["{SECRET}"],"last-assistant-message":"{SECRET}"}}"#
            );
            let notify = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
            let words: Vec<String> = notify.parse::<toml_edit::Document>().unwrap()["notify"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect();
            let mut command = std::process::Command::new(&words[0]);
            let output = command.args(&words[1..]).arg(&payload).env_clear().env("HOME", &home).env("PATH", "/usr/bin:/bin").output().unwrap();
            assert!(output.status.success());
            assert_eq!(fs::read_to_string(home.join("chained")).unwrap(), payload, "the notify set before still gets the turn");
            report(&home, &["claude"], "not json");
            report(&home, &["claude"], "");

            assert_eq!(
                events(&home),
                [
                    format!("claude prompt {SESSION}"),
                    format!("claude permission_prompt {SESSION}"),
                    format!("claude stop {SESSION}"),
                    format!("claude end {SESSION}"),
                    format!("codex turn {THREAD}"),
                ],
            );
            let file = fs::read_to_string(home.join(".arbor/agent-events")).unwrap();
            assert!(!file.contains(SECRET) && !file.contains("/home/x"));

            // Arbor reads the lines back with the machine's clock.
            let output = block_on(run_script(shell(&home), &poll_script(0), Duration::from_secs(10))).unwrap();
            let poll = parse_poll(&String::from_utf8_lossy(&output.stdout)).unwrap();
            assert_eq!(poll.events.len(), 5);
            let latest = poll.events.iter().map(|event| event.0).max().unwrap();
            let output = block_on(run_script(shell(&home), &poll_script(latest + 1), Duration::from_secs(10))).unwrap();
            assert!(parse_poll(&String::from_utf8_lossy(&output.stdout)).unwrap().events.is_empty());
            let _ = fs::remove_dir_all(&home);
        }

        #[test]
        fn a_big_events_file_is_cut_back_to_its_latest_lines() {
            let home = temp_home("rotate");
            let line = format!("1000 claude stop {SESSION}\n");
            write(&home.join(".arbor/agent-events"), &line.repeat((EVENTS_FILE_BYTES as usize / line.len()) + 10));
            block_on(run_script(shell(&home), &poll_script(1), Duration::from_secs(10))).unwrap();
            assert_eq!(fs::read_to_string(home.join(".arbor/agent-events")).unwrap().lines().count(), EVENTS_KEPT);
            let _ = fs::remove_dir_all(&home);
        }
    }
}
