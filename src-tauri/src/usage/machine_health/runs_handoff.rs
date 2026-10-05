//! The scripts that hand a run to T3 Code or Orca on its machine. Each runs in one go over SSH and
//! prints only ids (`project_id=`, `thread_id=`, `terminal=`) or a short failure code (`failed=`).
//!
//! T3 Code: a session token from `t3 auth session issue`, the way its own `t3 project` gets one,
//! lives only in a 0600 file in a temp folder for the length of the script, goes to curl in a config
//! file (never on a command line), and is revoked on the way out. The prompt reaches the machine
//! inside the script and goes into a request body file in the same folder; neither is printed.
//!
//! Orca: the folder's repository is registered (`repo add` returns the existing one if it's known)
//! and a terminal opened in it running the agent with the prompt, which Orca's own worktree command
//! does too. Nothing Orca prints besides the terminal handle and an error code is kept.

use super::*;
use chrono::{SecondsFormat, Utc};

/// Reads the JSON the scripts need, on the machine: T3 Code's runtime file, a session issued, the
/// project for a folder, and a request body with the project and model filled in. The same code
/// runs under JXA on a Mac (bare python3 there can open an install dialog) and under node.
const JSON_CORE: &str = r##"function main(op, a, read) {
  const data = read(a[0]);
  if (!data || typeof data !== 'object') return '';
  if (op === 'origin') return typeof data.origin === 'string' && /^https?:\/\/[^\s"]+$/.test(data.origin) ? data.origin : '';
  if (op === 'session') {
    const ok = (value) => typeof value === 'string' && /^[A-Za-z0-9._~+\/=-]+$/.test(value);
    return ok(data.sessionId) && ok(data.token) ? data.sessionId + '\t' + data.token : '';
  }
  if (op === 'project') {
    const found = (Array.isArray(data.projects) ? data.projects : []).find((p) => p && p.deletedAt == null && p.workspaceRoot === a[1]);
    if (!found || typeof found.id !== 'string') return '';
    const chosen = found.defaultModelSelection;
    return found.id + '\t' + (chosen && chosen.instanceId === a[2] && typeof chosen.model === 'string' ? chosen.model : '');
  }
  if (op === 'fill') {
    if ('projectId' in data) data.projectId = a[1];
    if (data.modelSelection) data.modelSelection.model = a[2];
    return JSON.stringify(data);
  }
  return '';
}
"##;

const JSON_PY: &str = r##"import json, re, sys
def read(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except Exception:
        return None
def main(op, a):
    data = read(a[0])
    if not isinstance(data, dict):
        return ''
    if op == 'origin':
        origin = data.get('origin')
        return origin if isinstance(origin, str) and re.match(r'^https?://[^\s"]+$', origin) else ''
    if op == 'session':
        ok = lambda value: isinstance(value, str) and re.match(r'^[A-Za-z0-9._~+/=-]+$', value)
        return data['sessionId'] + '\t' + data['token'] if ok(data.get('sessionId')) and ok(data.get('token')) else ''
    if op == 'project':
        for project in data.get('projects') or []:
            if isinstance(project, dict) and project.get('deletedAt') is None and project.get('workspaceRoot') == a[1] and isinstance(project.get('id'), str):
                chosen = project.get('defaultModelSelection') or {}
                model = chosen.get('model') if chosen.get('instanceId') == a[2] and isinstance(chosen.get('model'), str) else ''
                return project['id'] + '\t' + model
        return ''
    if op == 'fill':
        if 'projectId' in data:
            data['projectId'] = a[1]
        if isinstance(data.get('modelSelection'), dict):
            data['modelSelection']['model'] = a[2]
        return json.dumps(data)
    return ''
print(main(sys.argv[1], sys.argv[2:]))
"##;

/// `json <op> <file> [args…]`, with whichever reader the machine has.
fn json_function() -> String {
    format!(
        r##"json() {{
  if [ "$(uname -s)" = Darwin ] && command -v osascript >/dev/null 2>&1; then
    osascript -l JavaScript - "$@" 2>/dev/null <<'JS'
ObjC.import('Foundation');
{core}function read(path) {{
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (text.isNil()) return null;
  try {{ return JSON.parse(ObjC.unwrap(text)); }} catch (error) {{ return null; }}
}}
function run(argv) {{ return main(argv[0], argv.slice(1), read); }}
JS
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$@" 2>/dev/null <<'PY'
{py}PY
  elif command -v node >/dev/null 2>&1; then
    node - "$@" 2>/dev/null <<'NODE'
const fs = require('fs');
{core}const read = (path) => {{ try {{ return JSON.parse(fs.readFileSync(path, 'utf8')); }} catch {{ return null; }} }};
process.stdout.write(main(process.argv[2], process.argv.slice(3), read) + '\n');
NODE
  else
    return 1
  fi
}}
"##,
        core = JSON_CORE,
        py = JSON_PY,
    )
}

/// Writes `text` to `path` on the machine without it passing through a command line.
fn file_from(path: &str, text: &str) -> String {
    // serde_json writes one line, so it can't end the here-document early.
    format!("cat > {path} <<'ARBOR_BODY'\n{text}\nARBOR_BODY\n")
}

const PREAMBLE: &str = r##"fail() { printf 'failed=%s\n' "$1"; exit 0; }
if ! cd "$folder" 2>/dev/null; then printf 'no_folder\n'; exit 0; fi
folder=$(pwd -L)
"##;

/// Hands a run to T3 Code: a thread in the folder's project (added when T3 Code doesn't have it yet),
/// then its first turn with the prompt.
pub(super) fn t3_script(request: &RunRequest, title: &str) -> String {
    let thread = new_uuid();
    let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let create = serde_json::json!({
        "type": "thread.create",
        "commandId": new_uuid(),
        "threadId": thread,
        "projectId": "",
        "title": title,
        "modelSelection": { "instanceId": request.setup, "model": "" },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": null,
        "worktreePath": null,
        "createdAt": created_at,
    });
    let turn = serde_json::json!({
        "type": "thread.turn.start",
        "commandId": new_uuid(),
        "threadId": thread,
        "message": { "messageId": new_uuid(), "role": "user", "text": request.prompt, "attachments": [] },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "createdAt": created_at,
    });
    let model = request.model.as_deref().map(str::trim).filter(|model| !model.is_empty());
    format!(
        r##"{env}{folder}{preamble}base="${{T3CODE_HOME:-$HOME/.t3}}"
t3=$(command -v t3 2>/dev/null || true)
if [ -z "$t3" ]; then
  for candidate in "$base"/runtime/versions/*/t3; do
    if [ -x "$candidate" ]; then t3=$candidate; fi
  done
fi
if [ -z "$t3" ]; then fail no_cli; fi
if ! command -v curl >/dev/null 2>&1; then fail no_curl; fi
umask 077
work=$(mktemp -d "${{TMPDIR:-/tmp}}/arbor-run.XXXXXX") || fail no_temp
session=
cleanup() {{
  if [ -n "$session" ]; then "$t3" auth session revoke "$session" >/dev/null 2>&1; fi
  rm -rf "$work"
}}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
{json}origin=$(json origin "$base/userdata/server-runtime.json")
if [ -z "$origin" ]; then fail not_running; fi
"$t3" auth session issue --ttl 10m --label 'Arbor run' --json > "$work/session" 2>/dev/null || fail auth
issued=$(json session "$work/session")
rm -f "$work/session"
session=${{issued%%	*}}
if [ -z "$issued" ] || [ "$session" = "$issued" ]; then session=; fail auth; fi
printf 'header = "Authorization: Bearer %s"\n' "${{issued#*	}}" > "$work/auth"
issued=
api() {{ curl -sS -K "$work/auth" --max-time 20 -o "$work/out" -w '%{{http_code}}' "$@" 2>/dev/null; }}
code=$(api "$origin/api/orchestration/snapshot")
case "$code" in 2??) ;; *) fail "snapshot_$code" ;; esac
found=$(json project "$work/out" "$folder" {setup})
if [ -z "$found" ]; then
  "$t3" project add "$folder" >/dev/null 2>&1 || fail project_add
  code=$(api "$origin/api/orchestration/snapshot")
  case "$code" in 2??) ;; *) fail "snapshot_$code" ;; esac
  found=$(json project "$work/out" "$folder" {setup})
fi
project=${{found%%	*}}
if [ -z "$found" ] || [ "$project" = "$found" ]; then fail no_project; fi
model={model}
if [ -z "$model" ]; then model=${{found#*	}}; fi
if [ -z "$model" ]; then fail no_model; fi
{create}{turn}json fill "$work/create.tpl" "$project" "$model" > "$work/create" || fail json
json fill "$work/turn.tpl" "$project" "$model" > "$work/turn" || fail json
code=$(api -X POST -H 'Content-Type: application/json' --data-binary @"$work/create" "$origin/api/orchestration/dispatch")
case "$code" in 2??) ;; *) fail "create_$code" ;; esac
code=$(api -X POST -H 'Content-Type: application/json' --data-binary @"$work/turn" "$origin/api/orchestration/dispatch")
case "$code" in 2??) ;; *) fail "turn_$code" ;; esac
printf 'project_id=%s\nthread_id=%s\n' "$project" {thread}
"##,
        env = agents::AGENT_ENV,
        folder = folder_line(&request.folder),
        preamble = PREAMBLE,
        json = json_function(),
        setup = shell_quote(&request.setup),
        model = shell_quote(model.unwrap_or("")),
        create = file_from("\"$work/create.tpl\"", &create.to_string()),
        turn = file_from("\"$work/turn.tpl\"", &turn.to_string()),
        thread = shell_quote(&thread),
    )
}

/// Finds Orca's command on the machine: on PATH, or inside the app.
const FIND_ORCA: &str = r##"orca=$(command -v orca 2>/dev/null || true)
if [ -z "$orca" ]; then
  for candidate in /Applications/Orca.app/Contents/Resources/bin/orca "$HOME"/Applications/Orca.app/Contents/Resources/bin/orca; do
    if [ -x "$candidate" ]; then orca=$candidate; break; fi
  done
fi
if [ -z "$orca" ]; then fail no_cli; fi
"##;

/// The agent's own command with the prompt, as typed into the terminal Orca opens.
fn orca_agent_command(request: &RunRequest) -> String {
    let model = request.model.as_deref().map(str::trim).filter(|model| !model.is_empty());
    let mut parts = vec![shell_quote(&request.setup)];
    match (request.setup.as_str(), model) {
        ("claude", Some(model)) => parts.extend(["--model".into(), shell_quote(model)]),
        ("codex", Some(model)) => parts.extend(["-m".into(), shell_quote(model)]),
        _ => {}
    }
    parts.push(shell_quote(&request.prompt));
    parts.join(" ")
}

/// Hands a run to Orca: a terminal in the folder's repository, running the agent with the prompt. A run in its own
/// worktree is Orca's own `worktree create`, which makes the worktree off the repo's default base and starts the agent
/// in it, so Orca shows it as one of its worktrees; Orca starts its agents with their own default model there.
pub(super) fn orca_script(run_id: &str, request: &RunRequest, title: &str) -> String {
    let start = if request.worktree {
        format!(
            r##"out=$("$orca" worktree create --repo "path:$root" --name {name} --agent {agent} --prompt {prompt} --no-parent --json 2>/dev/null)
handle=$(printf '%s\n' "$out" | sed -n 's/.*"agentTerminalHandle" *: *"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
[ -n "$handle" ] || handle=$(printf '%s\n' "$out" | sed -n 's/.*"handle" *: *"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
"##,
            name = shell_quote(&super::worktree_name(run_id)),
            agent = shell_quote(&request.setup),
            prompt = shell_quote(&request.prompt),
        )
    } else {
        format!(
            r##"quote() {{ printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }}
agent={agent}
command="cd $(quote "$folder") && $agent"
out=$("$orca" terminal create --worktree "path:$root" --title {title} --command "$command" --json 2>/dev/null)
handle=$(printf '%s\n' "$out" | sed -n 's/.*"handle" *: *"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
"##,
            agent = shell_quote(&orca_agent_command(request)),
            title = shell_quote(title),
        )
    };
    format!(
        r##"{env}{folder}{preamble}{find}root=$(git -C "$folder" rev-parse --show-toplevel 2>/dev/null) || fail not_git
"$orca" repo add --path "$root" --json >/dev/null 2>&1 || fail repo_add
{start}if [ -z "$handle" ]; then
  code=$(printf '%s\n' "$out" | sed -n 's/.*"code" *: *"\([a-z_]*\)".*/\1/p' | head -n 1)
  fail "orca_${{code:-unknown}}"
fi
printf 'terminal=%s\n' "$handle"
"##,
        env = agents::AGENT_ENV,
        folder = folder_line(&request.folder),
        preamble = PREAMBLE,
        find = FIND_ORCA,
    )
}

/// Brings an Orca run's terminal to the front on its machine.
pub(super) fn orca_open_script(terminal: &str) -> String {
    format!(
        "{env}fail() {{ printf 'failed=%s\\n' \"$1\"; exit 0; }}\n{find}\"$orca\" terminal switch --terminal {terminal} --json >/dev/null 2>&1 || fail orca_switch\nprintf 'opened\\n'\n",
        env = agents::AGENT_ENV,
        find = FIND_ORCA,
        terminal = shell_quote(terminal),
    )
}

/// The failure code a script printed, kept only when it's the plain code it should be.
pub(super) fn failure_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("failed="))
        .filter(|code| !code.is_empty() && code.len() <= 40 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .map(str::to_string)
}
