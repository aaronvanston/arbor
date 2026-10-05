//! MCP servers kept in the setup repo, in .agents/mcp-servers.json: each
//! server's definition for Claude Code and for Codex. Every home of an agent
//! gets its definition unless the server lists the homes it goes in, and a
//! machine can have its own definition or none. A definition names its secrets
//! rather than holding them: `${VAR}` for Claude Code, and for Codex a variable
//! in env_vars, bearer_token_env_var or env_http_headers. So neither the repo
//! nor Arbor ever holds one. A definition with something in it that looks like a
//! secret is refused, and only where that is gets said.
//!
//! Each home's servers are compared with the repo's by fingerprint, as the scan
//! took them, and read again before they're changed: one that's changed since
//! the scan is left alone. The repo keeps a path in a machine's home folder as
//! ~, which each machine gets as its own. A Claude Code home is changed with its
//! own `claude mcp` command, which keeps ~/.claude.json the way it would for a
//! person there. Codex's `mcp add` can start a sign-in, so a Codex home's
//! config.toml is changed here with only the server's table touched, and written
//! back only if nothing changed it in between, keeping the copy before as a
//! change on the Setup page's list, which can undo it (guarded_writes). Codex
//! then reads the file, and if it can't, the copy before goes back. Claude
//! Code's own changes aren't on that list: `claude mcp` keeps them in
//! ~/.claude.json, which Claude Code rewrites all the time.
//!
//! A machine's server can be taken into the repo too, once it passes the same
//! check, as a commit of the file alone.
//!
//! A server can go to other agents too, the ones `agents` lists: each takes its
//! Claude Code definition in its own shape, written into its MCP file the way a
//! Codex home's config.toml is, as a guarded edit that keeps the rest of the file.

use super::agents::AGENT_ENV;
use super::harnesses::Harness;
use ts_rs::TS;
use super::shell::shell_quote;
use super::setup::{covered_machine, file_name, home_agent, home_harness, mcp_sum, normalized_mcp, rescan, scanned_machines, url_host, HomeAgent, MachineSetup, EMIT_FUNCTIONS, HELPERS};
use super::setup_plugins::message;
use super::setup_skills::{home_place, place_words};
use super::guarded_writes::{cksum, edit_call, edit_finish, edit_outcomes, edit_start, new_stamp, parse_outcome, run_on, ChangeKind, Edit, EditFile, EditOutcome};
use super::setup_sync::{git, git_out, is_commit, repo_file, take_into_repo, GIT_TIMEOUT};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::BTreeSet;

/// Where the repo keeps its MCP servers.
pub(super) const MCP_FILE: &str = ".agents/mcp-servers.json";
const FILE_VERSION: u64 = 1;
/// Claude Code starts once for each change; Codex reads its config back once for each home.
const APPLY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// The most changes one apply makes.
const MOST_CHANGES: usize = 50;

/// Codex's fields, in the order its own `mcp add` writes them. Others follow, by name.
const CODEX_ORDER: [&str; 24] = [
    "command",
    "args",
    "env",
    "env_vars",
    "cwd",
    "url",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
    "http_headers_helper",
    "auth",
    "enabled",
    "required",
    "startup_timeout_sec",
    "startup_timeout_ms",
    "tool_timeout_sec",
    "enabled_tools",
    "disabled_tools",
    "default_tools_approval_mode",
    "scopes",
    "oauth",
    "oauth_resource",
    "experimental_environment",
    "tools",
];

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/// Words that make a name one for a secret.
const SECRET_WORDS: [&str; 33] = [
    "token",
    "tokens",
    "secret",
    "secrets",
    "password",
    "passwords",
    "passwd",
    "pass",
    "passphrase",
    "pwd",
    "key",
    "keys",
    "apikey",
    "accesskey",
    "secretkey",
    "privatekey",
    "accesstoken",
    "authtoken",
    "refreshtoken",
    "idtoken",
    "sessiontoken",
    "clientsecret",
    "auth",
    "authorization",
    "credential",
    "credentials",
    "cookie",
    "cookies",
    "pat",
    "bearer",
    "jwt",
    "signature",
    "sig",
];

/// Endings that make a word run together from others one for a secret: PGPASSWORD, GHTOKEN, OPENAIAPIKEY.
const SECRET_ENDINGS: [&str; 9] = ["password", "passwd", "passphrase", "pwd", "token", "tokens", "secret", "secrets", "apikey"];

/// Words that make a name one for where a secret is, which it is, or how much of something there
/// is, rather than for the secret: TOKEN_FILE, AWS_ACCESS_KEY_ID, MAX_TOKENS.
const NOT_SECRET_WORDS: [&str; 27] = [
    "file", "path", "dir", "url", "uri", "env", "var", "name", "id", "type", "mode", "public", "host", "port", "endpoint", "helper", "max", "min", "limit",
    "count", "size", "budget", "length", "ttl", "timeout", "expiry", "expires",
];

/// Prefixes keys and tokens start with, each with how many characters follow at least.
const TOKEN_PREFIXES: [(&str, usize); 32] = [
    ("sk-", 20),
    ("sk_live_", 16),
    ("sk_test_", 16),
    ("rk_live_", 16),
    ("pk_live_", 16),
    ("ghp_", 30),
    ("gho_", 30),
    ("ghu_", 30),
    ("ghs_", 30),
    ("ghr_", 30),
    ("github_pat_", 30),
    ("glpat-", 20),
    ("xoxb-", 10),
    ("xoxp-", 10),
    ("xoxa-", 10),
    ("xoxr-", 10),
    ("xoxs-", 10),
    ("xapp-", 10),
    ("AKIA", 16),
    ("ASIA", 16),
    ("AIza", 30),
    ("npm_", 30),
    ("pypi-", 30),
    ("hf_", 30),
    ("lin_api_", 20),
    ("shpat_", 20),
    ("dop_v1_", 40),
    ("sntrys_", 30),
    ("glsa_", 30),
    ("figd_", 30),
    ("ntn_", 30),
    ("secret_", 30),
];

/// A name's words in lower case: `X-Api-Key`, `xApiKey` and `X_API_KEY` each give x, api and key.
fn words(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut words = Vec::new();
    let mut current = String::new();
    for (index, &c) in chars.iter().enumerate() {
        if !c.is_ascii_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        let before = index.checked_sub(1).map(|at| chars[at]);
        let after = chars.get(index + 1).copied();
        let starts = c.is_ascii_uppercase()
            && before.is_some_and(|before| {
                before.is_ascii_lowercase() || before.is_ascii_digit() || (before.is_ascii_uppercase() && after.is_some_and(|after| after.is_ascii_lowercase()))
            });
        if starts && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        current.push(c.to_ascii_lowercase());
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

/// A name for a secret: GITHUB_TOKEN, Authorization, --api-key, PGPASSWORD. Not PATH, PWD,
/// TOKENIZERS_PARALLELISM or --token-file.
fn secret_name(name: &str) -> bool {
    let words = words(name);
    let secret = |word: &String| SECRET_WORDS.contains(&word.as_str()) || SECRET_ENDINGS.iter().any(|ending| word.len() > ending.len() && word.ends_with(ending));
    // PWD alone is the shell's working folder.
    words != ["pwd"] && words.iter().any(secret) && !words.iter().any(|word| NOT_SECRET_WORDS.contains(&word.as_str()))
}

/// A number, a switch or a mode, which a secret isn't: MAX_TOKENS=4096, USE_AUTH=true, --auth oauth,
/// or the scheme alone in `Bearer ${TOKEN}` once its reference is left out.
fn plain_setting(text: &str) -> bool {
    matches!(
        text.to_ascii_lowercase().as_str(),
        "true" | "false" | "yes" | "no" | "on" | "off" | "none" | "null" | "auto" | "oauth" | "oauth2" | "bearer" | "basic" | "token" | "bot"
    ) || text.parse::<f64>().is_ok()
}

/// A value that could be a secret's: not empty, and not a number, a switch or a mode.
fn given(value: &str) -> bool {
    let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
    !value.is_empty() && !plain_setting(value)
}

/// A name as a flag, header, setting or variable has one: `--api-key`, `X-Api-Key`, `GITHUB_TOKEN`.
fn is_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// The name that ends just before `at` in `text`, past a quote around it, or "" when none does.
fn name_before(text: &str, at: usize) -> &str {
    let head = &text[..at];
    let head = head.strip_suffix(|c| c == '"' || c == '\'').unwrap_or(head);
    let start = head
        .char_indices()
        .rev()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .map_or(0, |(index, c)| index + c.len_utf8());
    &head[start..]
}

/// Somewhere in `text` a secret's name is given a value: `NOTION_TOKEN=abc`, a header as it's
/// written (`Authorization: Bearer abc`), `--api-key abc`, or `Bearer abc` alone. What Claude Code
/// fills in from a variable, when it `expands` them, isn't there to find; a default after :- is.
fn names_a_secret(text: &str, expands: bool) -> bool {
    let text = if expands { take_references(text).0 } else { text.to_string() };
    let secret = |name: &str, value: &str| {
        let name = name.trim_start_matches('-');
        is_name(name) && secret_name(name) && given(value)
    };
    for (at, separator) in text.match_indices(|c: char| c == '=' || c == ':') {
        let after = &text[at + separator.len()..];
        // A header's value runs to the end; another's to the next space or separator.
        let value = if separator == ":" { after } else { after.split(|c: char| c.is_whitespace() || matches!(c, '&' | ';' | ',')).next().unwrap_or_default() };
        if secret(name_before(&text, at), value) {
            return true;
        }
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    words.windows(2).any(|pair| {
        let [word, next] = pair else {
            return false;
        };
        (word.starts_with('-') && !word.contains('=') && !next.starts_with('-') && secret(word, next))
            || (matches!(word.to_ascii_lowercase().as_str(), "bearer" | "basic") && given(next))
    })
}

/// Each URL in `text`, from its scheme to the next space or quote.
fn urls(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("://").map(|at| from + at) {
        let start = text[..at]
            .char_indices()
            .rev()
            .take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            .last()
            .map_or(at, |(index, _)| index);
        let end = text[at..].find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>')).map_or(text.len(), |end| at + end);
        found.push(&text[start..end]);
        from = end.max(at + 3);
    }
    found
}

/// A URL in `text` with a password in it: `postgres://me:hunter2@db/app`. One Claude Code fills
/// in from a variable doesn't count, when `expands`.
fn url_password(text: &str, expands: bool) -> bool {
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let after = &rest[at + 3..];
        let end = after.find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '\'')).unwrap_or(after.len());
        let authority = &after[..end];
        if let Some((user, _)) = authority.rsplit_once('@') {
            if let Some((_, password)) = user.split_once(':') {
                if !password.is_empty() && !(expands && refers_only(password)) {
                    return true;
                }
            }
        }
        rest = &after[end..];
    }
    false
}

/// A name an environment variable can have.
fn is_variable(name: &str) -> bool {
    name.len() <= 128
        && name.as_bytes().first().is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `text` without the ${VAR}s it refers to, and their names. A default after `:-` stays in the text.
fn take_references(text: &str) -> (String, Vec<String>) {
    let mut kept = String::with_capacity(text.len());
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        kept.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            kept.push_str(&rest[start..]);
            return (kept, names);
        };
        let inner = &after[..end];
        let (name, default) = inner.split_once(":-").unwrap_or((inner, ""));
        if is_variable(name) {
            names.push(name.to_string());
            kept.push_str(default);
        } else {
            kept.push_str(&rest[start..start + end + 3]);
        }
        rest = &after[end + 1..];
    }
    kept.push_str(rest);
    (kept, names)
}

/// A value that only refers to a secret: `${TOKEN}`, or `Bearer ${TOKEN}`.
fn refers_only(text: &str) -> bool {
    let (kept, names) = take_references(text);
    if names.is_empty() {
        return false;
    }
    let mut rest = kept.trim();
    for scheme in ["Bearer", "bearer", "Basic", "basic", "Token", "token", "Bot", "bot"] {
        if let Some(after) = rest.strip_prefix(scheme) {
            rest = after;
            break;
        }
    }
    rest.chars().all(|c| c.is_whitespace() || c == ':')
}

/// Somewhere in `text`, a script or a command line, there's what looks like a secret: one given to
/// a name for one, a key or token, or a URL carrying one. What's referred to as ${VAR} doesn't count.
pub(super) fn holds_secret(text: &str) -> bool {
    text.lines().any(|line| {
        names_a_secret(line, true) || looks_like_token(line) || urls(line).into_iter().any(|url| url_holds_secret(url, true) || url_password(url, true))
    })
}

/// Somewhere in `text` there's what a key or token looks like: a known prefix with enough after
/// it, a private key, a JWT, a long run of mixed letters and digits, or a long one of letters and
/// digits standing alone as a value (a key in hex, say). What it refers to with ${VAR} doesn't count.
fn looks_like_token(text: &str) -> bool {
    let (text, _) = take_references(text);
    let bytes = text.as_bytes();
    let token_byte = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-';
    for (prefix, least) in TOKEN_PREFIXES {
        let mut from = 0;
        while let Some(at) = text[from..].find(prefix) {
            let start = from + at;
            let alone = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
            if alone && bytes[start + prefix.len()..].iter().take_while(|byte| token_byte(byte)).count() >= least {
                return true;
            }
            from = start + prefix.len();
        }
    }
    if text.contains("-----BEGIN") {
        return true;
    }
    let mut from = 0;
    while let Some(at) = text[from..].find("eyJ") {
        let start = from + at;
        let head = bytes[start..].iter().take_while(|byte| token_byte(byte)).count();
        let body_at = start + head + 1;
        if head >= 10 && bytes.get(start + head) == Some(&b'.') && bytes[body_at.min(bytes.len())..].iter().take_while(|byte| token_byte(byte)).count() >= 10 {
            return true;
        }
        from = start + 3;
    }
    let mixed = text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '='))).any(|run| {
        run.len() >= 32
            && run.bytes().any(|byte| byte.is_ascii_uppercase())
            && run.bytes().any(|byte| byte.is_ascii_lowercase())
            && run.bytes().any(|byte| byte.is_ascii_digit())
    });
    // Alone, so not a path's part, a commit after @ or #, or a digest after sha256:.
    mixed
        || text.split(|c: char| c.is_whitespace() || matches!(c, '=' | '"' | '\'' | ',')).any(|word| {
            word.len() >= 32
                && word.bytes().all(|byte| byte.is_ascii_alphanumeric())
                && word.bytes().any(|byte| byte.is_ascii_digit())
                && word.bytes().any(|byte| byte.is_ascii_alphabetic())
        })
}

/// A URL that carries a secret: a token as its user name (GitHub takes one there), a query
/// parameter named for one, or a long key-like part in its path. A password in it is found by
/// url_password. Claude Code fills in ${VAR} in a URL; Codex doesn't.
fn url_holds_secret(url: &str, expands: bool) -> bool {
    let (plain, _) = take_references(url);
    let rest = plain.split_once("://").map_or(plain.as_str(), |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.rsplit_once('@').is_some_and(|(user, _)| user.split(':').next().unwrap_or_default().len() >= 20) {
        return true;
    }
    let raw_rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    if let Some((_, query)) = raw_rest.split_once('?') {
        let query = query.split('#').next().unwrap_or_default();
        for pair in query.split('&') {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            if secret_name(name) && given(value) && !(expands && refers_only(value)) {
                return true;
            }
        }
    }
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    path.split('/').skip(1).any(|part| {
        part.len() >= 24
            && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            && part.bytes().any(|byte| byte.is_ascii_digit())
            && part.bytes().any(|byte| byte.is_ascii_alphabetic())
    })
}

/// Calls `found` with each string in `value` and where it is: `args[2]`, `env.HOME`.
fn each_text(value: &Value, at: &str, found: &mut impl FnMut(&str, &str)) {
    match value {
        Value::String(text) => found(at, text),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                each_text(item, &format!("{at}[{index}]"), found);
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                let place = if at.is_empty() { key.clone() } else { format!("{at}.{key}") };
                each_text(item, &place, found);
            }
        }
        _ => {}
    }
}

/// Where a definition holds what looks like a secret, by field and never by value: `env.GITHUB_TOKEN`,
/// `headers.Authorization`, `args[3]`, `url`.
fn secret_places(agent: HomeAgent, definition: &Value) -> Vec<String> {
    let claude = agent == HomeAgent::Claude;
    let mut places = BTreeSet::new();
    each_text(definition, "", &mut |at, text| {
        let found = looks_like_token(text)
            || url_password(text, claude)
            || urls(text).into_iter().any(|url| url_holds_secret(url, claude))
            || names_a_secret(text, claude);
        if found {
            places.insert(at.to_string());
        }
    });
    for field in ["bearer_token", "client_secret", "clientSecret"] {
        if definition.get(field).is_some() {
            places.insert(field.to_string());
        }
        if definition.get("oauth").and_then(|oauth| oauth.get(field)).is_some() {
            places.insert(format!("oauth.{field}"));
        }
    }
    // Claude Code fills in ${VAR} in env and headers; Codex never does.
    for field in ["env", "headers", "http_headers"] {
        for (key, value) in definition.get(field).and_then(Value::as_object).into_iter().flatten() {
            let Some(text) = value.as_str() else {
                continue;
            };
            if secret_name(key) && given(text) && !(claude && field != "http_headers" && refers_only(text)) {
                places.insert(format!("{field}.{key}"));
            }
        }
    }
    // A flag's value in the argument after it: --api-key abc.
    let args: Vec<&str> = definition.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    for (index, pair) in args.windows(2).enumerate() {
        let [flag, value] = pair else {
            continue;
        };
        let named = flag.starts_with('-') && !flag.contains('=') && !value.starts_with('-') && secret_name(flag.trim_start_matches('-'));
        if named && given(value) && !(claude && refers_only(value)) {
            places.insert(format!("args[{}]", index + 1));
        }
    }
    places.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/// A server's name as Arbor keeps one, which both agents' commands take and nothing reads as an option.
fn is_server_name(name: &str) -> bool {
    name.len() <= 64
        && name.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn agent_key(agent: HomeAgent) -> &'static str {
    match agent {
        HomeAgent::Claude => "claude",
        _ => "codex",
    }
}

fn agent_name(agent: HomeAgent) -> &'static str {
    match agent {
        HomeAgent::Claude => "Claude Code",
        _ => "Codex",
    }
}

#[derive(Clone, Copy)]
enum Shape {
    Text,
    Texts,
    TextMap,
    Number,
    Whole,
    Flag,
    Table,
}

fn fits(value: &Value, shape: Shape) -> bool {
    match shape {
        Shape::Text => value.is_string(),
        Shape::Texts => value.as_array().is_some_and(|items| items.iter().all(Value::is_string)),
        Shape::TextMap => value.as_object().is_some_and(|entries| entries.values().all(Value::is_string)),
        Shape::Number => value.as_f64().is_some_and(|number| number >= 0.0),
        Shape::Whole => value.as_u64().is_some(),
        Shape::Flag => value.is_boolean(),
        Shape::Table => value.is_object(),
    }
}

fn shape_words(shape: Shape) -> &'static str {
    match shape {
        Shape::Text => "text",
        Shape::Texts => "a list of text",
        Shape::TextMap => "an object of text",
        Shape::Number => "a number",
        Shape::Whole => "a whole number",
        Shape::Flag => "true or false",
        Shape::Table => "an object",
    }
}

const CLAUDE_SHAPES: [(&str, Shape); 10] = [
    ("type", Shape::Text),
    ("command", Shape::Text),
    ("args", Shape::Texts),
    ("env", Shape::TextMap),
    ("url", Shape::Text),
    ("headers", Shape::TextMap),
    ("headersHelper", Shape::Text),
    ("oauth", Shape::Table),
    ("timeout", Shape::Number),
    ("alwaysLoad", Shape::Flag),
];

const CODEX_SHAPES: [(&str, Shape); 24] = [
    ("command", Shape::Text),
    ("args", Shape::Texts),
    ("env", Shape::TextMap),
    ("cwd", Shape::Text),
    ("url", Shape::Text),
    ("bearer_token_env_var", Shape::Text),
    ("http_headers", Shape::TextMap),
    ("env_http_headers", Shape::TextMap),
    ("http_headers_helper", Shape::Text),
    ("auth", Shape::Text),
    ("enabled", Shape::Flag),
    ("required", Shape::Flag),
    ("supports_parallel_tool_calls", Shape::Flag),
    ("startup_timeout_sec", Shape::Number),
    ("startup_timeout_ms", Shape::Whole),
    ("tool_timeout_sec", Shape::Number),
    ("tool_input_schema_max_bytes", Shape::Whole),
    ("enabled_tools", Shape::Texts),
    ("disabled_tools", Shape::Texts),
    ("default_tools_approval_mode", Shape::Text),
    ("scopes", Shape::Texts),
    ("oauth", Shape::Table),
    ("oauth_resource", Shape::Text),
    ("tools", Shape::Table),
];

/// Codex's fields for a server it starts, and for one it reaches at a URL.
const CODEX_STDIO_ONLY: [&str; 5] = ["args", "env", "env_vars", "cwd", "experimental_environment"];
const CODEX_URL_ONLY: [&str; 7] = ["bearer_token_env_var", "http_headers", "env_http_headers", "http_headers_helper", "oauth", "oauth_resource", "auth"];

fn shape_problems(fields: &serde_json::Map<String, Value>, shapes: &[(&str, Shape)], problems: &mut Vec<String>) {
    for (key, shape) in shapes {
        if let Some(value) = fields.get(*key) {
            if !fits(value, *shape) {
                problems.push(format!("{key} should be {}", shape_words(*shape)));
            }
        }
    }
}

/// Claude Code's fields for a server it starts, and for one it reaches at a URL. It drops what its
/// kind of server doesn't have, so a home given one would never match the repo.
const CLAUDE_STDIO_ONLY: [&str; 3] = ["command", "args", "env"];
const CLAUDE_URL_ONLY: [&str; 4] = ["url", "headers", "headersHelper", "oauth"];

fn claude_problems(fields: &serde_json::Map<String, Value>, problems: &mut Vec<String>) {
    let unknown: Vec<String> = fields.keys().filter(|key| !CLAUDE_SHAPES.iter().any(|(known, _)| known == key)).map(|key| shown_key(key)).collect();
    if !unknown.is_empty() {
        problems.push(format!("Arbor doesn't know {} for Claude Code", unknown.join(", ")));
    }
    shape_problems(fields, &CLAUDE_SHAPES, problems);
    let text = |key: &str| fields.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty());
    let stray = |only: &[&str]| -> Option<String> {
        let stray: Vec<&str> = only.iter().copied().filter(|key| fields.contains_key(*key)).collect();
        (!stray.is_empty()).then(|| stray.join(", "))
    };
    match fields.get("type").and_then(Value::as_str) {
        None if fields.contains_key("url") => problems.push("It has a url but no type. Add \"type\": \"http\" (or \"sse\" or \"ws\").".into()),
        None => problems.push("It needs a command, or a type and a url".into()),
        Some("stdio") => {
            if text("command").is_none() {
                problems.push("A stdio server needs a command".into());
            }
            if let Some(stray) = stray(&CLAUDE_URL_ONLY) {
                problems.push(format!("{stray} only go with a url"));
            }
        }
        Some("http" | "sse" | "ws") => {
            if text("url").is_none() {
                problems.push("It needs a url".into());
            }
            if let Some(stray) = stray(&CLAUDE_STDIO_ONLY) {
                problems.push(format!("{stray} only go with a command"));
            }
        }
        Some(_) => problems.push("type should be stdio, http, sse or ws".into()),
    }
}

fn codex_problems(fields: &serde_json::Map<String, Value>, problems: &mut Vec<String>) {
    shape_problems(fields, &CODEX_SHAPES, problems);
    let mut nulls = Vec::new();
    each_null(&Value::Object(fields.clone()), "", &mut nulls);
    if !nulls.is_empty() {
        problems.push(format!("{} can't be null, which config.toml can't hold", nulls.join(", ")));
    }
    if fields.contains_key("type") {
        problems.push("Codex has no type. It tells a server it starts (a command) from one at a url.".into());
    }
    if fields.contains_key("headers") {
        problems.push("Codex calls headers http_headers, or env_http_headers for ones from variables".into());
    }
    match (fields.contains_key("command"), fields.contains_key("url")) {
        (false, false) => problems.push("It needs a command or a url".into()),
        (true, true) => problems.push("It has both a command and a url; Codex takes one".into()),
        (true, false) => {
            let stray: Vec<&str> = CODEX_URL_ONLY.iter().copied().filter(|key| fields.contains_key(*key)).collect();
            if !stray.is_empty() {
                problems.push(format!("{} only go with a url", stray.join(", ")));
            }
        }
        (false, true) => {
            let stray: Vec<&str> = CODEX_STDIO_ONLY.iter().copied().filter(|key| fields.contains_key(*key)).collect();
            if !stray.is_empty() {
                problems.push(format!("{} only go with a command", stray.join(", ")));
            }
        }
    }
    let expanded: Vec<&String> = fields
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, value)| value.as_str().is_some_and(|text| text.contains("${")))
        .map(|(key, _)| key)
        .collect();
    if !expanded.is_empty() {
        problems.push(format!(
            "Codex doesn't fill in ${{VAR}}, so env.{} would get it as written. List the variable in env_vars instead.",
            expanded.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(", env.")
        ));
    }
    if let Some(entries) = fields.get("env_vars") {
        let fine = entries.as_array().is_some_and(|entries| {
            entries.iter().all(|entry| match entry {
                Value::String(name) => is_variable(name),
                Value::Object(parts) => {
                    parts.get("name").and_then(Value::as_str).is_some_and(is_variable)
                        && parts.keys().all(|key| key == "name" || key == "source")
                        && parts.get("source").is_none_or(|source| matches!(source.as_str(), Some("local" | "remote")))
                }
                _ => false,
            })
        });
        if !fine {
            problems.push("env_vars should list variable names, or { name, source } with source local or remote".into());
        }
    }
    let named = fields.get("bearer_token_env_var").and_then(Value::as_str).is_none_or(is_variable)
        && fields.get("env_http_headers").and_then(Value::as_object).into_iter().flatten().all(|(_, name)| name.as_str().is_some_and(is_variable));
    if !named {
        problems.push("bearer_token_env_var and env_http_headers name variables, like GITHUB_TOKEN".into());
    }
}

fn each_null(value: &Value, at: &str, found: &mut Vec<String>) {
    match value {
        Value::Null => found.push(at.to_string()),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                each_null(item, &format!("{at}[{index}]"), found);
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                each_null(item, &if at.is_empty() { key.clone() } else { format!("{at}.{key}") }, found);
            }
        }
        _ => {}
    }
}

/// What's wrong with a definition for `agent`, secrets last.
fn definition_problems(agent: HomeAgent, definition: &Value) -> Vec<String> {
    let Some(fields) = definition.as_object() else {
        return vec!["It isn't a JSON object".into()];
    };
    let mut problems = Vec::new();
    match agent {
        HomeAgent::Claude => claude_problems(fields, &mut problems),
        _ => codex_problems(fields, &mut problems),
    }
    let places = secret_places(agent, definition);
    if !places.is_empty() {
        problems.push(secrets_problem(agent, &places));
    }
    problems
}

fn secrets_problem(agent: HomeAgent, places: &[String]) -> String {
    let what = match places {
        [one] => format!("{one} looks like a secret"),
        _ => format!("{} look like secrets", places.join(", ")),
    };
    match agent {
        HomeAgent::Claude => format!("{what}. Refer to it with ${{VAR}} instead, so the repo never holds one."),
        _ => format!("{what}. Codex reads a secret from a variable named in env_vars, bearer_token_env_var or env_http_headers."),
    }
}

// ---------------------------------------------------------------------------
// Home folders
// ---------------------------------------------------------------------------

/// Where a path can start in a definition's text: at its start, or after a space, `=`, `:`, `,` or a quote.
fn path_start(text: &str, at: usize) -> bool {
    text[..at].chars().next_back().is_none_or(|before| before.is_whitespace() || matches!(before, '=' | ':' | ',' | '"' | '\''))
}

/// `text` with the folder `from` written as `to` where a path starts with it, and all of it when
/// it's `from` alone. The repo keeps a machine's home folder as ~, and each machine gets its own.
/// A fingerprint takes the home folder as ~ anywhere, so either way the same server reads the same.
fn swap_home(text: &str, from: &str, to: &str) -> String {
    if [from, to].iter().any(|folder| folder.is_empty() || *folder == "/") {
        return text.to_string();
    }
    if text == from {
        return to.to_string();
    }
    let prefix = format!("{from}/");
    let mut swapped = String::with_capacity(text.len());
    let mut rest = 0;
    while let Some(at) = text[rest..].find(&prefix).map(|at| rest + at) {
        swapped.push_str(&text[rest..at]);
        swapped.push_str(if path_start(text, at) { to } else { from });
        swapped.push('/');
        rest = at + prefix.len();
    }
    swapped.push_str(&text[rest..]);
    swapped
}

/// `value` with each text in it changed by `change`.
fn with_texts(value: &Value, change: &impl Fn(&str) -> String) -> Value {
    match value {
        Value::String(text) => Value::String(change(text)),
        Value::Array(items) => Value::Array(items.iter().map(|item| with_texts(item, change)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), with_texts(item, change))).collect()),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------
// Other agents
// ---------------------------------------------------------------------------

/// The other agents a server can go to. Prime Agent keeps servers in its settings.json in a shape it doesn't publish,
/// so it isn't one.
const MCP_AGENTS: [Harness; 4] = [Harness::Pi, Harness::Droid, Harness::Amp, Harness::OpenCode];

fn mcp_agent_ids() -> String {
    MCP_AGENTS.iter().map(|harness| harness.spec().id).collect::<Vec<_>>().join(", ")
}

fn harness_name(harness: Harness) -> &'static str {
    match harness {
        Harness::Pi => "Pi",
        Harness::Droid => "Droid",
        Harness::Amp => "Amp",
        Harness::OpenCode => "OpenCode",
        other => other.spec().id,
    }
}

/// Somewhere in `text` there's a `${VAR:-default}`, which only Claude Code fills in.
fn has_default(text: &str) -> bool {
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { return false };
        if after[..end].split_once(":-").is_some_and(|(name, _)| is_variable(name)) {
            return true;
        }
        rest = &after[end + 1..];
    }
    false
}

/// `text` with each `${VAR}` as OpenCode writes one: `{env:VAR}`.
fn opencode_references(text: &str) -> String {
    let mut kept = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        kept.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}').filter(|end| is_variable(&after[..*end])) {
            Some(end) => {
                kept.push_str(&format!("{{env:{}}}", &after[..end]));
                rest = &after[end + 1..];
            }
            None => {
                kept.push_str("${");
                rest = after;
            }
        }
    }
    kept.push_str(rest);
    kept
}

/// A Claude Code definition, as `harness` keeps the server in its MCP file. Pi and Droid read Claude Code's shape. Amp's
/// has no type. OpenCode's has the command and its arguments as one list, `environment` for env, and `{env:VAR}` where
/// Claude Code has `${VAR}`. Only a command, its arguments and environment, or a URL and its headers, go across: the
/// rest is Claude Code's alone, so a definition with it can't go.
fn harness_definition(harness: Harness, claude: &Value) -> Result<Value, String> {
    let name = harness_name(harness);
    let Some(fields) = claude.as_object() else {
        return Err("It isn't a JSON object".into());
    };
    let left: Vec<String> = fields.keys().filter(|key| !["type", "command", "args", "env", "url", "headers"].contains(&key.as_str())).map(|key| shown_key(key)).collect();
    if !left.is_empty() {
        return Err(format!("{name} has no {}, so Arbor can't set it up there", left.join(", ")));
    }
    let stdio = fields.get("type").and_then(Value::as_str).is_none_or(|kind| kind == "stdio");
    if fields.get("type").and_then(Value::as_str) == Some("ws") {
        return Err(format!("{name} can't reach a server over ws"));
    }
    let mut defaults = false;
    each_text(claude, "", &mut |_, text| defaults |= has_default(text));
    if defaults {
        return Err(format!("{name} doesn't fill in ${{VAR:-default}}. Use ${{VAR}} alone."));
    }
    let in_args = fields.get("args").and_then(Value::as_array).into_iter().flatten().any(|arg| arg.as_str().is_some_and(|arg| !take_references(arg).1.is_empty()));
    if harness == Harness::Droid && in_args {
        return Err("Droid doesn't fill in ${VAR} in args. Pass it in env instead.".into());
    }
    match harness {
        Harness::Pi | Harness::Droid => Ok(claude.clone()),
        Harness::Amp => {
            let mut fields = fields.clone();
            fields.remove("type");
            Ok(Value::Object(fields))
        }
        Harness::OpenCode => {
            let claude = with_texts(claude, &opencode_references);
            let mut fields = serde_json::Map::new();
            if stdio {
                let mut command: Vec<Value> = claude.get("command").into_iter().cloned().collect();
                command.extend(claude.get("args").and_then(Value::as_array).into_iter().flatten().cloned());
                fields.insert("type".into(), "local".into());
                fields.insert("command".into(), Value::Array(command));
                if let Some(env) = claude.get("env") {
                    fields.insert("environment".into(), env.clone());
                }
            } else {
                fields.insert("type".into(), "remote".into());
                for key in ["url", "headers"] {
                    if let Some(value) = claude.get(key) {
                        fields.insert(key.into(), value.clone());
                    }
                }
            }
            Ok(Value::Object(fields))
        }
        _ => Err(format!("Arbor doesn't set up MCP servers for {name}")),
    }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/// How a machine has a server in its homes of one agent.
#[derive(Clone, Debug, PartialEq)]
enum Wanted {
    /// As the repo defines it for every machine.
    Default,
    /// Not at all.
    Off,
    /// Its own way.
    Own(Value),
}

#[derive(Clone, Debug, PartialEq)]
struct Server {
    name: String,
    claude: Option<Value>,
    codex: Option<Value>,
    /// The homes it goes in, as the scan names them; every home of the agent when None.
    homes: Option<Vec<String>>,
    /// Machines set apart, with what their Claude Code and Codex homes have.
    machines: BTreeMap<String, [Wanted; 2]>,
    /// The other agents it goes to, each in every home of it, as the machine's Claude Code homes have it.
    agents: Vec<Harness>,
    problems: Vec<String>,
}

impl Server {
    fn definition(&self, agent: HomeAgent) -> Option<&Value> {
        match agent {
            HomeAgent::Claude => self.claude.as_ref(),
            HomeAgent::Codex => self.codex.as_ref(),
            HomeAgent::Shared => None,
        }
    }

    /// The definition the home at `home`, of `agent`, on `machine` should have, and whether it's the machine's own.
    fn wanted(&self, machine: &str, agent: HomeAgent, home: &str) -> Option<(&Value, bool)> {
        if self.homes.as_ref().is_some_and(|homes| !homes.iter().any(|listed| listed == home)) {
            return None;
        }
        let slot = match agent {
            HomeAgent::Claude => 0,
            HomeAgent::Codex => 1,
            HomeAgent::Shared => return None,
        };
        match self.machines.get(machine).map(|choices| &choices[slot]) {
            Some(Wanted::Off) => None,
            Some(Wanted::Own(definition)) => Some((definition, true)),
            _ => self.definition(agent).map(|definition| (definition, false)),
        }
    }

    /// The definition `harness`'s homes on `machine` should have, in its own shape, and whether it's the machine's own.
    /// One that can't be put in its shape is a problem with the server, so it's given as Claude Code's.
    fn wanted_by(&self, machine: &str, harness: Harness) -> Option<(Value, bool)> {
        if !self.agents.contains(&harness) {
            return None;
        }
        let (definition, own) = match self.machines.get(machine).map(|choices| &choices[0]) {
            Some(Wanted::Off) => return None,
            Some(Wanted::Own(definition)) => (definition, true),
            _ => (self.claude.as_ref()?, false),
        };
        Some((harness_definition(harness, definition).unwrap_or_else(|_| definition.clone()), own))
    }
}

#[derive(Debug, Default, PartialEq)]
pub(super) struct Registry {
    servers: Vec<Server>,
    /// What's wrong with the file as a whole.
    problems: Vec<String>,
}

impl Registry {
    fn server(&self, name: &str) -> Option<&Server> {
        self.servers.iter().find(|server| server.name == name)
    }

    /// The Claude Code definition `machine`'s ~/.claude gets for `name`, with ~ as the machine's home folder, to set it up
    /// in one of a project's checkouts: None when the repo doesn't set it up there, an error when it can't be used.
    pub(super) fn checkout_definition(&self, machine: &str, home_dir: &str, name: &str) -> Result<Option<Value>, String> {
        if let Some(problem) = self.problems.first() {
            return Err(problem.clone());
        }
        let Some(server) = self.server(name) else { return Ok(None) };
        if !server.problems.is_empty() || !is_server_name(name) {
            return Err(format!("{name}: {}", RegistryBlock::Broken.message()));
        }
        Ok(server.wanted(machine, HomeAgent::Claude, "~/.claude").map(|(definition, _)| with_texts(definition, &|text| swap_home(text, "~", home_dir))))
    }
}

/// The repo's MCP servers as its last commit has them.
pub(super) async fn latest_registry(folder: &Path) -> Result<Registry, String> {
    Ok(load_registry(folder, None).await?.3)
}

/// A key the file has that Arbor doesn't read, shortened to something safe to show.
fn shown_key(key: &str) -> String {
    let clean: String = key.chars().filter(|c| !c.is_control()).take(40).collect();
    if clean.len() < key.len() {
        format!("{clean}…")
    } else {
        clean
    }
}

/// A definition for `agent` as the file gives it, or None for null. What's wrong with it goes in
/// `problems`, after `at`.
fn read_definition(agent: HomeAgent, value: &Value, at: &str, problems: &mut Vec<String>) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Object(_) => {
            let definition = normalized_mcp(agent, value);
            problems.extend(definition_problems(agent, &definition).into_iter().map(|problem| format!("{at}: {problem}")));
            Some(definition)
        }
        _ => {
            problems.push(format!("{at} should be an object, or null"));
            None
        }
    }
}

fn read_server(name: &str, entry: &Value) -> Server {
    let mut server = Server { name: name.to_string(), claude: None, codex: None, homes: None, machines: BTreeMap::new(), agents: Vec::new(), problems: Vec::new() };
    if !is_server_name(name) {
        server.problems.push("Arbor keeps servers named with letters, digits, - and _, starting with a letter or digit, up to 64 long".into());
    }
    let Some(fields) = entry.as_object() else {
        server.problems.push("It should be an object".into());
        return server;
    };
    for (key, value) in fields {
        match key.as_str() {
            "claude" => server.claude = read_definition(HomeAgent::Claude, value, "claude", &mut server.problems),
            "codex" => server.codex = read_definition(HomeAgent::Codex, value, "codex", &mut server.problems),
            "homes" => {
                let homes: Option<Vec<String>> = value
                    .as_array()
                    .and_then(|homes| homes.iter().map(|home| home.as_str().filter(|home| home_place(home).is_some()).map(str::to_string)).collect());
                match homes {
                    Some(homes) => server.homes = Some(homes),
                    None => server.problems.push("homes should list agent homes, like \"~/.claude\" or \"/srv/agents/claude\"".into()),
                }
            }
            "machines" => {
                let Some(machines) = value.as_object() else {
                    server.problems.push("machines should be an object of machine names".into());
                    continue;
                };
                for (machine, choice) in machines {
                    let at = format!("machines.{}", shown_key(machine));
                    let choices = match choice {
                        Value::Null => [Wanted::Off, Wanted::Off],
                        Value::Object(agents) => {
                            let mut choices = [Wanted::Default, Wanted::Default];
                            for (agent_key, definition) in agents {
                                let (slot, agent) = match agent_key.as_str() {
                                    "claude" => (0, HomeAgent::Claude),
                                    "codex" => (1, HomeAgent::Codex),
                                    other => {
                                        server.problems.push(format!("{at}: Arbor doesn't know {}", shown_key(other)));
                                        continue;
                                    }
                                };
                                choices[slot] = match read_definition(agent, definition, &format!("{at}.{agent_key}"), &mut server.problems) {
                                    Some(definition) => Wanted::Own(definition),
                                    None => Wanted::Off,
                                };
                            }
                            choices
                        }
                        _ => {
                            server.problems.push(format!("{at} should be an object, or null"));
                            continue;
                        }
                    };
                    server.machines.insert(machine.clone(), choices);
                }
            }
            "agents" => {
                let Some(ids) = value.as_array().and_then(|ids| ids.iter().map(Value::as_str).collect::<Option<Vec<&str>>>()) else {
                    server.problems.push("agents should list agents by id, like \"pi\" or \"opencode\"".into());
                    continue;
                };
                for id in ids {
                    match MCP_AGENTS.into_iter().find(|harness| harness.spec().id == id) {
                        Some(harness) if !server.agents.contains(&harness) => server.agents.push(harness),
                        Some(_) => {}
                        None => server.problems.push(format!("agents: Arbor doesn't set up MCP servers for {}. It does for {}.", shown_key(id), mcp_agent_ids())),
                    }
                }
            }
            other => server.problems.push(format!("Arbor doesn't know {}", shown_key(other))),
        }
    }
    // Each agent it goes to takes each of its Claude Code definitions, so each has to fit every one of them.
    let claude = server.claude.iter().map(|definition| ("claude".to_string(), definition));
    let own = server.machines.iter().filter_map(|(machine, choices)| match &choices[0] {
        Wanted::Own(definition) => Some((format!("machines.{}.claude", shown_key(machine)), definition)),
        _ => None,
    });
    let mut unfit = Vec::new();
    for (at, definition) in claude.chain(own) {
        for harness in &server.agents {
            if let Err(problem) = harness_definition(*harness, definition) {
                unfit.push(format!("{at}: {problem}"));
            }
        }
    }
    server.problems.extend(unfit);
    server
}

fn read_registry(bytes: &[u8]) -> Registry {
    let mut registry = Registry::default();
    let Some(file) = serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object) else {
        registry.problems.push(format!("{MCP_FILE} isn't a JSON object Arbor can read"));
        return registry;
    };
    if file.get("version").is_some_and(|version| version.as_u64() != Some(FILE_VERSION)) {
        registry.problems.push(format!("{MCP_FILE} is a version this Arbor doesn't read. Update Arbor."));
        return registry;
    }
    for key in file.as_object().into_iter().flatten().map(|(key, _)| key) {
        if key != "version" && key != "servers" {
            registry.problems.push(format!("Arbor doesn't know {} in {MCP_FILE}", shown_key(key)));
        }
    }
    match file.get("servers") {
        None => {}
        Some(Value::Object(servers)) => {
            registry.servers = servers.iter().map(|(name, entry)| read_server(name, entry)).collect();
        }
        Some(_) => registry.problems.push(format!("servers in {MCP_FILE} should be an object of server names")),
    }
    registry
}

// ---------------------------------------------------------------------------
// Comparing with the machines
// ---------------------------------------------------------------------------

/// How a home's server stands against the repo.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RegistryState {
    /// It's as the repo defines it.
    Same,
    /// The repo has it for this home, which hasn't got it.
    Add,
    /// The home has it, set up differently.
    Update,
    /// The home has it and the repo doesn't have it here.
    Extra,
}

/// Why Arbor won't change a home's server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RegistryBlock {
    /// Its name has more in it than the agents' commands take.
    Name,
    /// The repo's definition of it has problems.
    Broken,
}

impl RegistryBlock {
    fn message(self) -> &'static str {
        match self {
            Self::Name => "Arbor only changes servers named with letters, digits, - and _",
            Self::Broken => "Fix the repo's definition of it first",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryCell {
    machine: String,
    /// As the scan names it.
    home: String,
    name: String,
    state: RegistryState,
    /// The repo has a definition of its own for this machine.
    own: bool,
    /// Why Arbor won't change it, when it won't.
    blocked: Option<RegistryBlock>,
}

/// How each server in each of a machine's homes stands against the repo.
fn machine_cells(registry: &Registry, machine: &str, setup: &MachineSetup) -> Vec<RegistryCell> {
    let mut cells = Vec::new();
    for (agent, home) in setup.agent_homes() {
        // A shadow home's config.toml is the home it shares's, so its servers are that home's to change.
        if agent == HomeAgent::Codex && setup.shares(home, "config.toml") {
            continue;
        }
        let present = setup.home_servers(home);
        let mut cell = |name: &str, state: RegistryState, own: bool, broken: bool| {
            let blocked = if !is_server_name(name) {
                Some(RegistryBlock::Name)
            } else if broken {
                Some(RegistryBlock::Broken)
            } else {
                None
            };
            cells.push(RegistryCell { machine: machine.to_string(), home: home.to_string(), name: name.to_string(), state, own, blocked });
        };
        for server in &registry.servers {
            let found = present.get(server.name.as_str());
            let (state, own) = match (server.wanted(machine, agent, home), found) {
                (Some((_, own)), None) => (RegistryState::Add, own),
                (Some((definition, own)), Some(sum)) => {
                    let same = *sum == Some(mcp_sum(agent, definition, setup.home_dir()).as_str());
                    (if same { RegistryState::Same } else { RegistryState::Update }, own)
                }
                (None, Some(_)) => (RegistryState::Extra, false),
                (None, None) => continue,
            };
            cell(&server.name, state, own, !server.problems.is_empty());
        }
        for name in present.keys() {
            if registry.server(name).is_none() {
                cell(name, RegistryState::Extra, false, false);
            }
        }
    }
    // The other agents' homes have only what the repo sends them, so a server of their own is never the repo's.
    for (harness, home, present) in setup.harness_servers() {
        if !MCP_AGENTS.contains(&harness) {
            continue;
        }
        for server in &registry.servers {
            let found = present.get(server.name.as_str());
            let (state, own) = match (server.wanted_by(machine, harness), found) {
                (Some((_, own)), None) => (RegistryState::Add, own),
                (Some((definition, own)), Some(sum)) => {
                    let same = *sum == Some(mcp_sum(HomeAgent::Shared, &definition, setup.home_dir()).as_str());
                    (if same { RegistryState::Same } else { RegistryState::Update }, own)
                }
                (None, Some(_)) if server.agents.contains(&harness) => (RegistryState::Extra, false),
                _ => continue,
            };
            let blocked = if !is_server_name(&server.name) {
                Some(RegistryBlock::Name)
            } else if !server.problems.is_empty() {
                Some(RegistryBlock::Broken)
            } else {
                None
            };
            cells.push(RegistryCell { machine: machine.to_string(), home: home.to_string(), name: server.name.clone(), state, own, blocked });
        }
    }
    cells
}

/// A definition, as far as it's safe to show: how it's reached, where, and the variables it reads.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DefinitionView {
    transport: String,
    /// The host of its URL, or the program it runs.
    place: Option<String>,
    /// The environment variables it reads secrets and settings from, by name.
    variables: Vec<String>,
}

fn definition_view(agent: HomeAgent, definition: &Value) -> DefinitionView {
    let url = definition.get("url").and_then(Value::as_str);
    let command = definition.get("command").and_then(Value::as_str);
    let transport = match agent {
        HomeAgent::Claude => definition.get("type").and_then(Value::as_str).unwrap_or("stdio").to_string(),
        _ => if url.is_some() { "http" } else { "stdio" }.to_string(),
    };
    let place = url
        .and_then(|url| url_host(&take_references(url).0))
        .or_else(|| command.map(|command| file_name(command.split_whitespace().next().unwrap_or(command)).to_string()));
    let mut variables = BTreeSet::new();
    match agent {
        HomeAgent::Claude => each_text(definition, "", &mut |_, text| variables.extend(take_references(text).1)),
        _ => {
            for entry in definition.get("env_vars").and_then(Value::as_array).into_iter().flatten() {
                if let Some(name) = entry.as_str().or_else(|| entry.get("name").and_then(Value::as_str)) {
                    variables.insert(name.to_string());
                }
            }
            if let Some(name) = definition.get("bearer_token_env_var").and_then(Value::as_str) {
                variables.insert(name.to_string());
            }
            for (_, name) in definition.get("env_http_headers").and_then(Value::as_object).into_iter().flatten() {
                if let Some(name) = name.as_str() {
                    variables.insert(name.to_string());
                }
            }
        }
    }
    variables.retain(|name| is_variable(name));
    DefinitionView { transport, place, variables: variables.into_iter().collect() }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerView {
    name: String,
    claude: Option<DefinitionView>,
    codex: Option<DefinitionView>,
    /// The homes it's kept to.
    homes: Option<Vec<String>>,
    /// The other agents it goes to.
    agents: Vec<Harness>,
    /// Machines with their own definition, and machines it's kept off.
    own: Vec<String>,
    off: Vec<String>,
    problems: Vec<String>,
}

/// The repo's MCP servers and how every machine's homes stand against them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpRegistry {
    /// The commit they're read from, the repo's last. None before anything's committed.
    commit: Option<String>,
    /// The file is in that commit.
    found: bool,
    /// The file has changes that aren't committed, which count once they are.
    uncommitted: bool,
    problems: Vec<String>,
    servers: Vec<ServerView>,
    cells: Vec<RegistryCell>,
}

fn registry_view(commit: Option<String>, found: bool, uncommitted: bool, registry: &Registry, machines: &[(String, MachineSetup)]) -> McpRegistry {
    let servers = registry
        .servers
        .iter()
        .map(|server| {
            let (mut own, mut off) = (Vec::new(), Vec::new());
            for (machine, choices) in &server.machines {
                if choices.iter().any(|choice| matches!(choice, Wanted::Own(_))) {
                    own.push(machine.clone());
                }
                if choices.iter().any(|choice| *choice == Wanted::Off) {
                    off.push(machine.clone());
                }
            }
            ServerView {
                name: server.name.clone(),
                claude: server.claude.as_ref().map(|definition| definition_view(HomeAgent::Claude, definition)),
                codex: server.codex.as_ref().map(|definition| definition_view(HomeAgent::Codex, definition)),
                homes: server.homes.clone(),
                agents: server.agents.clone(),
                own,
                off,
                problems: server.problems.clone(),
            }
        })
        .collect();
    // A file Arbor can't read says nothing about what each home should have.
    let cells = if registry.problems.is_empty() { machines.iter().flat_map(|(machine, setup)| machine_cells(registry, machine, setup)).collect() } else { Vec::new() };
    McpRegistry { commit, found, uncommitted, problems: registry.problems.clone(), servers, cells }
}

// ---------------------------------------------------------------------------
// Reading the repo
// ---------------------------------------------------------------------------

/// The repo's last commit, or `commit`, and its MCP servers: whether the file is there, and whether
/// it has changes that aren't committed.
async fn load_registry(folder: &Path, commit: Option<&str>) -> Result<(Option<String>, bool, bool, Registry), String> {
    if !folder.is_dir() {
        return Err(format!("Arbor can't find {}", folder.display()));
    }
    let inside = git(folder, &["rev-parse", "--is-inside-work-tree"], GIT_TIMEOUT).await?;
    if !inside.status.success() || String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return Err(format!("{} isn't in a git repo", folder.display()));
    }
    let pathspec = format!("./{MCP_FILE}");
    let uncommitted = !git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", &pathspec]).await?.is_empty();
    let commit = match commit {
        Some(commit) if is_commit(commit) => commit.to_string(),
        Some(_) => return Err("That isn't a commit".into()),
        None => {
            let head = git(folder, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_TIMEOUT).await?;
            if !head.status.success() {
                return Ok((None, false, uncommitted, Registry::default()));
            }
            String::from_utf8_lossy(&head.stdout).trim().to_string()
        }
    };
    let listed = git_out(folder, &["ls-tree", "-z", &commit, "--", &pathspec]).await?;
    let mode = listed.split('\0').find_map(|entry| entry.split_whitespace().next().filter(|_| entry.split_whitespace().nth(1) == Some("blob")));
    let registry = match mode {
        Some("100644" | "100755") => read_registry(&repo_file(folder, &commit, MCP_FILE).await?),
        Some(_) => Registry { servers: Vec::new(), problems: vec![format!("{MCP_FILE} is a link in the repo, which Arbor doesn't follow")] },
        None => Registry::default(),
    };
    Ok((Some(commit), mode.is_some(), uncommitted, registry))
}

/// The repo's MCP servers, and how every machine's homes stand against them as their last scans found them.
#[tauri::command]
pub(crate) async fn get_mcp_registry(state: tauri::State<'_, MachineHealthState>, repo: String) -> Result<McpRegistry, String> {
    let (commit, found, uncommitted, registry) = load_registry(Path::new(&repo), None).await?;
    let machines = scanned_machines(&state.lock());
    Ok(registry_view(commit, found, uncommitted, &registry, &machines))
}

// ---------------------------------------------------------------------------
// Reading a machine
// ---------------------------------------------------------------------------

/// Settings files a script sent back: after each `N index` line, the file there, if it's there.
pub(super) fn read_blocks(stdout: &str) -> Result<BTreeMap<usize, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let mut index = None;
    let mut ended = false;
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["N", at] => index = at.parse::<usize>().ok(),
            ["E"] => ended = true,
            ["J", _, _, size] => {
                let mut encoded = String::new();
                for line in lines.by_ref() {
                    if line == "." {
                        break;
                    }
                    encoded.push_str(line.trim());
                }
                if *size == "large" {
                    return Err("A settings file there is over 1 MB, so Arbor didn't read it".into());
                }
                let bytes = STANDARD
                    .decode(encoded.as_bytes())
                    .ok()
                    .filter(|bytes| size.parse::<usize>().ok() == Some(bytes.len()))
                    .ok_or("A settings file came back incomplete")?;
                if let Some(index) = index {
                    files.insert(index, bytes);
                }
            }
            _ => {}
        }
    }
    if !ended {
        return Err("Arbor didn't hear back from the whole read".into());
    }
    Ok(files)
}

/// Reads each home's servers file: the .claude.json a Claude Code home keeps them in, or a Codex home's config.toml.
async fn read_homes(machine: &Machine, homes: &[(HomeAgent, String)]) -> Result<BTreeMap<usize, Vec<u8>>, String> {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{EMIT_FUNCTIONS}");
    for (index, (agent, rel)) in homes.iter().enumerate() {
        let dir = place_words(rel, "");
        script.push_str(&format!("printf 'N\\t{index}\\n'\n"));
        match agent {
            HomeAgent::Claude => script.push_str(&format!("claude_mcp {dir}\n")),
            _ => script.push_str(&format!("emit_data config {dir}/config.toml\n")),
        }
    }
    script.push_str("printf 'E\\n'\n");
    read_blocks(&run_on(machine, MachineOp::McpRead, &script).await?)
}

/// The servers a home's file defines.
fn file_servers(agent: HomeAgent, bytes: Option<&[u8]>) -> Result<serde_json::Map<String, Value>, String> {
    let Some(bytes) = bytes else {
        return Ok(serde_json::Map::new());
    };
    let parsed = match agent {
        HomeAgent::Claude => serde_json::from_slice::<Value>(bytes).ok(),
        _ => std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| toml::from_str::<toml::Value>(text).ok())
            .and_then(|config| serde_json::to_value(config).ok())
            .map(|config| config.get("mcp_servers").cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new()))),
    };
    match parsed {
        Some(Value::Object(servers)) => Ok(servers),
        _ => Err(format!("Arbor couldn't read the {} there", if agent == HomeAgent::Claude { "MCP servers in .claude.json" } else { "config.toml" })),
    }
}

// ---------------------------------------------------------------------------
// Changing Codex's config.toml
// ---------------------------------------------------------------------------

/// A JSON value as TOML. config.toml has no null.
fn toml_value(value: &Value) -> Result<toml_edit::Value, String> {
    Ok(match value {
        Value::String(text) => text.as_str().into(),
        Value::Bool(flag) => (*flag).into(),
        Value::Number(number) => match number.as_i64() {
            Some(whole) => whole.into(),
            None => number.as_f64().ok_or("config.toml can't hold that number")?.into(),
        },
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(toml_value(item)?);
            }
            array.into()
        }
        Value::Object(entries) => {
            let mut table = toml_edit::InlineTable::new();
            for (key, item) in entries {
                table.insert(key, toml_value(item)?);
            }
            table.into()
        }
        Value::Null => return Err("config.toml can't hold null".into()),
    })
}

/// A server's table, its fields in the order Codex writes them. An object of objects, like
/// `tools`, gets a table of its own.
fn server_table(definition: &Value) -> Result<toml_edit::Table, String> {
    let fields = definition.as_object().ok_or("A definition should be an object")?;
    let mut keys: Vec<&String> = fields.keys().collect();
    keys.sort_by_key(|key| (CODEX_ORDER.iter().position(|known| known == key).unwrap_or(CODEX_ORDER.len()), key.as_str()));
    let mut table = toml_edit::Table::new();
    for key in keys {
        let value = &fields[key];
        match value.as_object() {
            Some(entries) if !entries.is_empty() && entries.values().all(Value::is_object) => {
                let mut inner = toml_edit::Table::new();
                for (name, entry) in entries {
                    inner.insert(name, toml_edit::Item::Value(toml_value(entry)?));
                }
                table.insert(key, toml_edit::Item::Table(inner));
            }
            _ => {
                table.insert(key, toml_edit::Item::Value(toml_value(value)?));
            }
        }
    }
    Ok(table)
}

/// config.toml with each server in `changes` set to its definition, or taken out for None. Only
/// those servers' tables change: everything else stays as it was written, and a server that's
/// replaced keeps its place and the comments above it.
fn edit_codex_config(text: &str, changes: &[(&str, Option<&Value>)]) -> Result<String, String> {
    let mut document = text.parse::<toml_edit::Document>().map_err(|_| "config.toml there isn't TOML Arbor can read, so Arbor left it alone".to_string())?;
    let root = document.as_table_mut();
    if !root.contains_key("mcp_servers") {
        let mut servers = toml_edit::Table::new();
        servers.set_implicit(true);
        root.insert("mcp_servers", toml_edit::Item::Table(servers));
    }
    let servers = root
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_mut)
        .ok_or("config.toml there sets mcp_servers in a way Arbor doesn't change, so Arbor left it alone")?;
    for (name, definition) in changes {
        match definition {
            Some(definition) => {
                let mut table = server_table(definition)?;
                if let Some(old) = servers.get(name).and_then(toml_edit::Item::as_table) {
                    if let Some(position) = old.position() {
                        table.set_position(position);
                    }
                    *table.decor_mut() = old.decor().clone();
                }
                servers.insert(name, toml_edit::Item::Table(table));
            }
            None => {
                servers.remove(name);
            }
        }
    }
    Ok(document.to_string())
}

/// How config.toml stands on a machine: POSIX `cksum`'s checksum and length after a c, or - when it isn't there.
fn file_state(bytes: Option<&[u8]>) -> String {
    bytes.map_or_else(|| "-".to_string(), cksum)
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpAction {
    /// Sets the server up as the repo defines it.
    Add,
    /// Replaces the home's definition with the repo's.
    Update,
    /// Takes out a server the repo doesn't have there.
    Remove,
}

impl McpAction {
    fn verb(self) -> &'static str {
        match self {
            Self::Add => "set up",
            Self::Update => "update",
            Self::Remove => "remove",
        }
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpChange {
    /// As the scan names it.
    home: String,
    name: String,
    action: McpAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpOutcome {
    Done,
    Failed,
    /// The server changed since the last scan, or a Codex home's config.toml after Arbor read it,
    /// so it was left alone.
    Changed,
    /// Claude Code took the server out to replace it, then couldn't set it up again.
    Removed,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpResult {
    home: String,
    name: String,
    action: McpAction,
    outcome: McpOutcome,
    message: String,
    /// The backup a change to another agent's file is kept in, which Sync's undo takes it back from.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    backup: Option<String>,
}

/// A change as it's made.
#[derive(Debug, PartialEq)]
struct Planned {
    home: String,
    /// Shared for another agent's home.
    agent: HomeAgent,
    /// The agent, for a home that isn't Claude Code's or Codex's.
    harness: Option<Harness>,
    /// The home's folder under the machine's home folder.
    rel: String,
    name: String,
    action: McpAction,
    /// The repo's definition, for an add or an update, with ~ as the machine's home folder.
    definition: Option<Value>,
    /// The server's fingerprint as the last scan found it, or None when it wasn't there.
    seen: Option<String>,
}

/// Checks each change against how the last scan found the home, and puts Claude Code's first.
fn plan(registry: &Registry, machine: &str, setup: &MachineSetup, changes: Vec<McpChange>) -> Result<Vec<Planned>, String> {
    if changes.is_empty() {
        return Err("There's nothing to change".into());
    }
    if changes.len() > MOST_CHANGES {
        return Err(format!("Arbor makes at most {MOST_CHANGES} changes at a time"));
    }
    if let Some(problem) = registry.problems.first() {
        return Err(problem.clone());
    }
    let cells = machine_cells(registry, machine, setup);
    let mut seen = BTreeSet::new();
    let mut planned = Vec::with_capacity(changes.len());
    for change in changes {
        let what = format!("{} in {}", change.name, change.home);
        if !seen.insert((change.home.clone(), change.name.clone())) {
            return Err(format!("{what} is in the changes twice"));
        }
        let cell = cells.iter().find(|cell| cell.home == change.home && cell.name == change.name);
        let fits = matches!(
            (change.action, cell.map(|cell| cell.state)),
            (McpAction::Add, Some(RegistryState::Add)) | (McpAction::Update, Some(RegistryState::Update)) | (McpAction::Remove, Some(RegistryState::Extra))
        );
        if !fits {
            return Err(format!("Arbor can't {} {what} as it is", change.action.verb()));
        }
        if let Some(blocked) = cell.and_then(|cell| cell.blocked) {
            return Err(format!("{what}: {}", blocked.message()));
        }
        let harness = home_harness(setup, &change.home).filter(|harness| MCP_AGENTS.contains(harness));
        let agent = home_agent(setup, &change.home).or(harness.map(|_| HomeAgent::Shared));
        let (Some(agent), Some(rel)) = (agent, home_place(&change.home).map(str::to_string)) else {
            return Err(format!("{} isn't a home Arbor changes on this machine", change.home));
        };
        let server = registry.server(&change.name);
        let definition = match (change.action, harness) {
            (McpAction::Remove, _) => None,
            (_, Some(harness)) => server.and_then(|server| server.wanted_by(machine, harness)).map(|(definition, _)| definition),
            (_, None) => server.and_then(|server| server.wanted(machine, agent, &change.home)).map(|(definition, _)| definition.clone()),
        }
        .map(|definition| with_texts(&definition, &|text| swap_home(text, "~", setup.home_dir())));
        let present = match harness {
            Some(_) => setup.harness_servers().into_iter().find(|(_, home, _)| *home == change.home).map(|(_, _, servers)| servers).unwrap_or_default(),
            None => setup.home_servers(&change.home),
        };
        // A server the scan found with no fingerprint never matches what's there, so it's left alone.
        let seen = present.get(change.name.as_str()).map(|sum| sum.unwrap_or_default().to_string());
        planned.push(Planned { home: change.home, agent, harness, rel, name: change.name, action: change.action, definition, seen });
    }
    planned.sort_by_key(|change| change.agent != HomeAgent::Claude);
    Ok(planned)
}

// Follows AGENT_ENV. Each agent runs where no project's settings or servers are,
// never with a terminal to ask on, and one too old for these commands is
// refused before anything is changed.
pub(super) const APPLY_START: &str = r##"export GIT_TERMINAL_PROMPT=0 DISABLE_AUTOUPDATER=1
unset CLAUDE_CONFIG_DIR CODEX_HOME
cd / || exit 3
out=$(mktemp "${TMPDIR:-/tmp}/arbor-mcp.XXXXXX") || exit 3
err=$(mktemp "${TMPDIR:-/tmp}/arbor-mcp.XXXXXX") || { rm -f "$out"; exit 3; }
trap 'rm -f "$out" "$err"' EXIT
"##;

// `claude_run dir words…` runs Claude Code for the home at $HOME/dir (or at dir
// when it's a whole path), or for ~/.claude with an empty dir, and gives its exit code and the last line it
// printed, or for a command that failed, the last it printed as an error.
// `said n stage` gives both as the result of change n: `add` or `remove`, or
// `taken` once a server's out to be replaced and `readd` for setting it up again.
pub(super) const CLAUDE_FUNCTIONS: &str = r##"claude=$(command -v claude 2>/dev/null || true)
case "$claude" in
  /*) ;;
  *) echo "Claude Code isn't installed where Arbor looks for it" >&2; exit 127 ;;
esac
if ! "$claude" mcp --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+add-json([[:space:]]|$)' ||
  ! "$claude" mcp --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+remove([[:space:]]|$)' ||
  ! "$claude" mcp add-json --help </dev/null 2>/dev/null | grep -q -e '--scope'; then
  echo "This version of Claude Code can't change MCP servers for Arbor. Update it first." >&2
  exit 2
fi
claude_run() {
  dir=$1; shift
  if [ -z "$dir" ] && [ -f "$HOME/.claude/.claude.json" ]; then dir=.claude; fi
  case $dir in /* | '') ;; *) dir=$HOME/$dir ;; esac
  if [ -n "$dir" ]; then
    CLAUDE_CONFIG_DIR="$dir" "$claude" "$@" </dev/null >"$out" 2>"$err"
  else
    "$claude" "$@" </dev/null >"$out" 2>"$err"
  fi
  code=$?
  last=$(grep -v '^[[:space:]]*$' "$out" | tail -n 1)
  if [ "$code" -ne 0 ] || [ -z "$last" ]; then
    said=$(grep -v '^[[:space:]]*$' "$err" | tail -n 1)
    if [ -n "$said" ]; then last=$said; fi
  fi
}
said() {
  printf 'R\t%s\t%s\t%s\t%s\n' "$1" "$code" "$2" "$(printf '%s' "$last" | tr '\t\r' '  ' | cut -c 1-4000)"
}
"##;

// `codex_reads n dir name` asks Codex to show server `name` for the home at
// $HOME/dir (or at dir when it's a whole path), which it can only do once it has read the whole of config.toml.
// If it can't, edit n goes back (see guarded_writes).
const CODEX_FUNCTIONS: &str = r##"codex=$(command -v codex 2>/dev/null || true)
case "$codex" in
  /*) ;;
  *) echo "Codex isn't installed where Arbor looks for it" >&2; exit 127 ;;
esac
if ! "$codex" mcp --help </dev/null 2>/dev/null | grep -Eq '^[[:space:]]+get([[:space:]]|$)'; then
  echo "This version of Codex can't show its MCP servers for Arbor. Update it first." >&2
  exit 2
fi
codex_reads() {
  [ -n "$3" ] || return 0
  case $2 in /*) at=$2 ;; *) at=$HOME/$2 ;; esac
  CODEX_HOME="$at" "$codex" mcp get "$3" </dev/null >/dev/null 2>&1 || put_back "$1"
}
"##;

/// A Codex home's config.toml as it will be written.
#[derive(Debug, PartialEq)]
struct CodexWrite {
    rel: String,
    before: String,
    content: String,
    /// A server Codex should show once it has read the file.
    check: Option<String>,
}

/// The script for a machine's changes: Claude Code's, each by its number in `planned`, then each
/// Codex home's config.toml, by its number in `writes`, as edits kept in backup `stamp`.
fn apply_script(stamp: &str, planned: &[Planned], writes: &[CodexWrite]) -> String {
    let mut script = format!("{AGENT_ENV}{APPLY_START}");
    let claude: Vec<(usize, &Planned)> = planned.iter().enumerate().filter(|(_, change)| change.agent == HomeAgent::Claude).collect();
    if !claude.is_empty() {
        script.push_str(CLAUDE_FUNCTIONS);
    }
    if !writes.is_empty() {
        script.push_str(&edit_start(stamp, ChangeKind::Mcp));
        script.push_str(CODEX_FUNCTIONS);
    }
    for (index, change) in claude {
        let dir = shell_quote(if change.rel == ".claude" { "" } else { &change.rel });
        let name = shell_quote(&change.name);
        let json = shell_quote(&change.definition.as_ref().map(Value::to_string).unwrap_or_default());
        let add = format!("claude_run {dir} mcp add-json --scope user {name} {json}");
        let remove = format!("claude_run {dir} mcp remove --scope user {name}");
        match change.action {
            McpAction::Add => script.push_str(&format!("{add}; said {index} add\n")),
            McpAction::Remove => script.push_str(&format!("{remove}; said {index} remove\n")),
            McpAction::Update => script.push_str(&format!(
                "{remove}\nif [ \"$code\" -eq 0 ]; then said {index} taken; {add}; said {index} readd; else said {index} remove; fi\n"
            )),
        }
    }
    for (index, write) in writes.iter().enumerate() {
        let edit = Edit {
            file: EditFile::in_home(&write.rel, "config.toml"),
            before: write.before.clone(),
            content: write.content.as_bytes().to_vec(),
        };
        script.push_str(&edit_call(index, &edit));
        script.push_str(&format!(
            "[ \"$made\" = 0 ] || codex_reads {index} {} {}\n",
            shell_quote(&write.rel),
            shell_quote(write.check.as_deref().unwrap_or_default())
        ));
    }
    if !writes.is_empty() {
        script.push_str(&edit_finish());
    }
    script
}

/// Each Codex home's config.toml with its changes made, from the files as they were read.
fn codex_writes(planned: &[Planned], files: &BTreeMap<usize, Vec<u8>>, homes: &[(HomeAgent, String)]) -> Result<Vec<CodexWrite>, String> {
    let mut writes = Vec::new();
    for (index, (agent, rel)) in homes.iter().enumerate() {
        if *agent != HomeAgent::Codex {
            continue;
        }
        let bytes = files.get(&index).map(Vec::as_slice);
        let text = match bytes {
            Some(bytes) => std::str::from_utf8(bytes).map_err(|_| "config.toml there isn't text Arbor can read, so Arbor left it alone".to_string())?,
            None => "",
        };
        let changes: Vec<(&str, Option<&Value>)> = planned
            .iter()
            .filter(|change| change.agent == HomeAgent::Codex && change.rel == *rel)
            .map(|change| (change.name.as_str(), change.definition.as_ref()))
            .collect();
        if changes.is_empty() {
            continue;
        }
        let content = edit_codex_config(text, &changes)?;
        let left = file_servers(HomeAgent::Codex, Some(content.as_bytes()))?;
        let check = changes
            .iter()
            .find(|(_, definition)| definition.is_some())
            .map(|(name, _)| name.to_string())
            .or_else(|| left.keys().find(|name| is_server_name(name)).cloned());
        writes.push(CodexWrite { rel: rel.clone(), before: file_state(bytes), content, check });
    }
    Ok(writes)
}

/// Each change's result, from what the apply printed.
fn parse_results(stdout: &str, planned: &[Planned], writes: &[CodexWrite]) -> Vec<McpResult> {
    let mut outcomes: Vec<Option<(McpOutcome, String)>> = vec![None; planned.len()];
    let homes = edit_outcomes(stdout);
    for line in stdout.lines() {
        let fields: Vec<&str> = line.splitn(5, '\t').collect();
        match fields.as_slice() {
            ["R", index, code, stage, last] => {
                let Some(slot) = index.parse::<usize>().ok().and_then(|index| outcomes.get_mut(index)) else {
                    continue;
                };
                let ok = code.trim() == "0";
                let said = message(last);
                *slot = Some(match (*stage, ok) {
                    // Until the line after it, if that ever comes.
                    ("taken", _) => (McpOutcome::Failed, "Taken out to be replaced, and Arbor didn't hear whether it was set up again. Scan again to see.".into()),
                    (_, true) => (McpOutcome::Done, said),
                    ("readd", false) => (McpOutcome::Removed, said),
                    _ => (McpOutcome::Failed, said),
                });
            }
            _ => {}
        }
    }
    for (index, write) in writes.iter().enumerate() {
        let outcome = match homes.get(&index).copied() {
            Some(EditOutcome::Done) => (McpOutcome::Done, String::new()),
            Some(EditOutcome::Changed) => (McpOutcome::Changed, "config.toml changed after Arbor read it, so nothing in this home was changed. Scan and try again.".to_string()),
            Some(EditOutcome::Back) => (McpOutcome::Failed, "Codex couldn't read config.toml with this change, so Arbor put the file back as it was".to_string()),
            Some(EditOutcome::Failed) => (McpOutcome::Failed, "Arbor couldn't write config.toml".to_string()),
            None => continue,
        };
        for (slot, change) in outcomes.iter_mut().zip(planned) {
            if change.agent == HomeAgent::Codex && change.rel == write.rel {
                *slot = Some(outcome.clone());
            }
        }
    }
    planned
        .iter()
        .zip(outcomes)
        .map(|(change, outcome)| {
            let (outcome, message) = outcome.unwrap_or_else(|| (McpOutcome::Failed, "Arbor didn't hear how this went".into()));
            McpResult { home: change.home.clone(), name: change.name.clone(), action: change.action, outcome, message, backup: None }
        })
        .collect()
}

/// Each home a change is in, once.
fn planned_homes(planned: &[Planned]) -> Vec<(HomeAgent, String)> {
    let mut homes: Vec<(HomeAgent, String)> = Vec::new();
    for change in planned {
        if !homes.iter().any(|(agent, rel)| *agent == change.agent && *rel == change.rel) {
            homes.push((change.agent, change.rel.clone()));
        }
    }
    homes
}

/// The changes to servers that are still as the last scan found them, and a result for each of the
/// others, which are left alone: whoever changed one there since may have meant it.
fn still_as_scanned(
    planned: Vec<Planned>,
    files: &BTreeMap<usize, Vec<u8>>,
    homes: &[(HomeAgent, String)],
    home_dir: &str,
) -> Result<(Vec<Planned>, Vec<McpResult>), String> {
    let mut servers = Vec::with_capacity(homes.len());
    for (index, (agent, _)) in homes.iter().enumerate() {
        servers.push(file_servers(*agent, files.get(&index).map(Vec::as_slice))?);
    }
    let (mut fresh, mut stale) = (Vec::new(), Vec::new());
    for change in planned {
        let now = homes
            .iter()
            .position(|(agent, rel)| *agent == change.agent && *rel == change.rel)
            .and_then(|index| servers.get(index))
            .and_then(|found| found.get(&change.name))
            .map(|definition| mcp_sum(change.agent, definition, home_dir));
        if now == change.seen {
            fresh.push(change);
        } else {
            let message = "It's changed there since the last scan, so Arbor left it alone. Scan and try again.".to_string();
            stale.push(McpResult { home: change.home, name: change.name, action: change.action, outcome: McpOutcome::Changed, message, backup: None });
        }
    }
    Ok((fresh, stale))
}

/// Makes a machine's servers match the repo's commit the page showed, then scans the machine again.
#[tauri::command]
pub(crate) async fn apply_mcp_changes(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    commit: String,
    machine: String,
    changes: Vec<McpChange>,
) -> Result<Vec<McpResult>, String> {
    let (_, found, _, registry) = load_registry(Path::new(&repo), Some(&commit)).await?;
    if !found {
        return Err(format!("That commit has no {MCP_FILE}"));
    }
    let (target, home_dir, planned) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        (target, setup.home_dir().to_string(), plan(&registry, &machine, setup, changes)?)
    };
    let (others, planned): (Vec<Planned>, Vec<Planned>) = planned.into_iter().partition(|change| change.harness.is_some());
    let mut results = Vec::new();
    if !others.is_empty() {
        let applied = apply_harness_changes(&target, &home_dir, others).await;
        if planned.is_empty() || applied.is_err() {
            rescan(&app, &machine);
        }
        results.extend(applied?);
    }
    if planned.is_empty() {
        return Ok(results);
    }
    let homes = planned_homes(&planned);
    let files = read_homes(&target, &homes).await?;
    let (planned, stale) = still_as_scanned(planned, &files, &homes, &home_dir)?;
    results.extend(stale);
    if planned.is_empty() {
        rescan(&app, &machine);
        return Ok(results);
    }
    let writes = codex_writes(&planned, &files, &homes)?;
    // Each change reports its own line, so a script that stopped part way still says what it did.
    let output = run_on_machine(&target, MachineOp::McpApply, &apply_script(&new_stamp(), &planned, &writes), APPLY_TIMEOUT).await;
    rescan(&app, &machine);
    let output = output?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() && !stdout.lines().any(|line| line.starts_with("R\t") || line.starts_with("E\t")) {
        return Err(failure_detail(&output));
    }
    results.extend(parse_results(&stdout, &planned, &writes));
    Ok(results)
}

// ---------------------------------------------------------------------------
// Changing the other agents' MCP files
// ---------------------------------------------------------------------------

/// An agent's MCP file, in its home at `rel`, and the key its servers sit under.
#[derive(Debug, PartialEq)]
struct HarnessFile {
    harness: Harness,
    rel: String,
    file: &'static str,
    key: &'static str,
}

impl HarnessFile {
    fn shown(&self) -> String {
        format!("~/{}/{}", self.rel, self.file).replacen("~//", "/", 1)
    }

    fn holds(&self, change: &Planned) -> bool {
        change.harness == Some(self.harness) && change.rel == self.rel
    }
}

/// Each other agent's MCP file a change is in, once.
fn harness_files(planned: &[Planned]) -> Vec<HarnessFile> {
    let mut files: Vec<HarnessFile> = Vec::new();
    for change in planned {
        let Some((harness, mcp)) = change.harness.and_then(|harness| Some((harness, harness.spec().mcp?))) else { continue };
        let file = HarnessFile { harness, rel: change.rel.clone(), file: mcp.path, key: mcp.key };
        if !files.contains(&file) {
            files.push(file);
        }
    }
    files
}

fn harness_read_script(files: &[HarnessFile]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{EMIT_FUNCTIONS}");
    for (index, file) in files.iter().enumerate() {
        script.push_str(&format!("printf 'N\\t{index}\\n'\nemit_data config {}/{}\n", place_words(&file.rel, ""), shell_quote(file.file)));
    }
    script.push_str("printf 'E\\n'\n");
    script
}

/// The file as JSON, or an empty one when it isn't there. One with comments isn't JSON, so it's left alone.
fn harness_json(file: &HarnessFile, bytes: Option<&[u8]>) -> Result<serde_json::Map<String, Value>, String> {
    let Some(bytes) = bytes else {
        return Ok(serde_json::Map::new());
    };
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(fields)) if fields.get(file.key).is_none_or(Value::is_object) => Ok(fields),
        _ => Err(format!("{} isn't JSON Arbor can read, so Arbor left it alone", file.shown())),
    }
}

/// The file with its changes made: only the servers named are touched.
fn edit_harness_file(file: &HarnessFile, bytes: Option<&[u8]>, changes: &[&Planned]) -> Result<String, String> {
    let mut fields = harness_json(file, bytes)?;
    let servers = fields.entry(file.key).or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(servers) = servers.as_object_mut() else {
        return Err(format!("{} isn't JSON Arbor can read, so Arbor left it alone", file.shown()));
    };
    for change in changes {
        match &change.definition {
            Some(definition) => servers.insert(change.name.clone(), definition.clone()),
            None => servers.remove(&change.name),
        };
    }
    Ok(serde_json::to_string_pretty(&Value::Object(fields)).map_err(|error| error.to_string())? + "\n")
}

/// A file as it will be written.
#[derive(Debug, PartialEq)]
struct HarnessWrite {
    /// Its number in the files read.
    at: usize,
    before: String,
    content: String,
}

/// Makes the changes in the other agents' files, each still as the last scan found it, and says how each went: as
/// guarded edits, kept in a backup that Sync › Repo › Arbor's changes can undo.
async fn apply_harness_changes(target: &Machine, home_dir: &str, planned: Vec<Planned>) -> Result<Vec<McpResult>, String> {
    let files = harness_files(&planned);
    let read = read_blocks(&run_on(target, MachineOp::McpRead, &harness_read_script(&files)).await?)?;
    let (planned, writes, mut results) = harness_writes(planned, &files, &read, home_dir);
    if writes.is_empty() {
        return Ok(results);
    }
    let stdout = run_on(target, MachineOp::McpApply, &harness_apply_script(&new_stamp(), &files, &writes)).await?;
    results.extend(harness_results(&stdout, &planned, &files, &writes));
    Ok(results)
}

/// The script that writes each file, as edit number its place in `writes`, kept in backup `stamp`.
fn harness_apply_script(stamp: &str, files: &[HarnessFile], writes: &[HarnessWrite]) -> String {
    let mut script = format!("set -u\nexport LC_ALL=C\n{}", edit_start(stamp, ChangeKind::Mcp));
    for (index, write) in writes.iter().enumerate() {
        let Some(file) = files.get(write.at) else { continue };
        let edit = Edit { file: EditFile::in_home(&file.rel, file.file), before: write.before.clone(), content: write.content.as_bytes().to_vec() };
        script.push_str(&edit_call(index, &edit));
    }
    script.push_str(&edit_finish());
    script
}

/// Each file with its changes made, from the files as they were read, and a result for each change that's left alone:
/// one whose server changed since the scan, or that's in a file Arbor can't read.
fn harness_writes(planned: Vec<Planned>, files: &[HarnessFile], read: &BTreeMap<usize, Vec<u8>>, home_dir: &str) -> (Vec<Planned>, Vec<HarnessWrite>, Vec<McpResult>) {
    let (mut fresh, mut writes, mut results) = (Vec::new(), Vec::new(), Vec::new());
    let left = |change: Planned, outcome: McpOutcome, message: String| McpResult { home: change.home, name: change.name, action: change.action, outcome, message, backup: None };
    let mut changes: Vec<Vec<Planned>> = files.iter().map(|_| Vec::new()).collect();
    for change in planned {
        match files.iter().position(|file| file.holds(&change)).and_then(|at| changes.get_mut(at)) {
            Some(slot) => slot.push(change),
            None => results.push(left(change, McpOutcome::Failed, "Arbor doesn't change MCP servers for this agent".into())),
        }
    }
    for ((at, file), changes) in files.iter().enumerate().zip(changes) {
        let bytes = read.get(&at).map(Vec::as_slice);
        let servers = match harness_json(file, bytes) {
            Ok(fields) => fields.get(file.key).and_then(Value::as_object).cloned().unwrap_or_default(),
            Err(problem) => {
                results.extend(changes.into_iter().map(|change| left(change, McpOutcome::Failed, problem.clone())));
                continue;
            }
        };
        let (still, changed): (Vec<Planned>, Vec<Planned>) =
            changes.into_iter().partition(|change| servers.get(&change.name).map(|definition| mcp_sum(HomeAgent::Shared, definition, home_dir)) == change.seen);
        let message = "It's changed there since the last scan, so Arbor left it alone. Scan and try again.";
        results.extend(changed.into_iter().map(|change| left(change, McpOutcome::Changed, message.into())));
        if still.is_empty() {
            continue;
        }
        match edit_harness_file(file, bytes, &still.iter().collect::<Vec<_>>()) {
            Ok(content) => {
                writes.push(HarnessWrite { at, before: file_state(bytes), content });
                fresh.extend(still);
            }
            Err(problem) => results.extend(still.into_iter().map(|change| left(change, McpOutcome::Failed, problem.clone()))),
        }
    }
    (fresh, writes, results)
}

/// Each change's result, from how its file's edit went.
fn harness_results(stdout: &str, planned: &[Planned], files: &[HarnessFile], writes: &[HarnessWrite]) -> Vec<McpResult> {
    let outcomes = edit_outcomes(stdout);
    let backup = parse_outcome(stdout).backup;
    planned
        .iter()
        .map(|change| {
            let found = writes.iter().enumerate().find(|(_, write)| files.get(write.at).is_some_and(|file| file.holds(change)));
            let (outcome, message) = match found.map(|(index, write)| (outcomes.get(&index).copied(), files.get(write.at).map(HarnessFile::shown).unwrap_or_default())) {
                Some((Some(EditOutcome::Done), _)) => (McpOutcome::Done, String::new()),
                Some((Some(EditOutcome::Changed), shown)) => (McpOutcome::Changed, format!("{shown} changed after Arbor read it, so nothing in it was changed. Scan and try again.")),
                Some((Some(EditOutcome::Failed | EditOutcome::Back), shown)) => (McpOutcome::Failed, format!("Arbor couldn't write {shown}")),
                _ => (McpOutcome::Failed, "Arbor didn't hear how this went".into()),
            };
            let backup = backup.clone().filter(|_| outcome == McpOutcome::Done);
            McpResult { home: change.home.clone(), name: change.name.clone(), action: change.action, outcome, message, backup }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Taking a machine's server into the repo
// ---------------------------------------------------------------------------

fn unreadable() -> String {
    format!("{MCP_FILE} isn't JSON Arbor can read. Fix it, then try again.")
}

/// The repo's file as it is in the folder, to change and commit alone: refused while it has changes that aren't
/// committed, which the commit would take along, or when it's a link.
async fn read_file_to_change(folder: &Path) -> Result<Value, String> {
    let pathspec = format!("./{MCP_FILE}");
    if !git_out(folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", &pathspec]).await?.is_empty() {
        return Err(format!("{MCP_FILE} has changes in the repo that aren't committed. Commit or drop them, then try again."));
    }
    let path = folder.join(MCP_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("{MCP_FILE} is a link in the repo, which Arbor leaves alone"));
    }
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object).ok_or_else(unreadable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({ "version": FILE_VERSION, "servers": {} })),
        Err(error) => Err(format!("Arbor couldn't read {MCP_FILE}: {error}")),
    }
}

/// What the repo wants of a server, for every machine or one.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpWanted {
    /// One machine: as every machine has it, dropping the machine's own definition or its being kept off.
    Default,
    /// One machine: kept off it, so its homes' copies are the repo's to remove.
    Off,
    /// Every machine: the repo keeps the server's name with no definition, so every home's copy is the repo's to
    /// remove and none is set up. Taking a home's server into the repo brings it back.
    Removed,
}

/// Changes a server's value in `file`: for every machine when `machine` is None, or for that machine.
fn set_wanted(file: &mut Value, name: &str, machine: Option<&str>, wanted: McpWanted) -> Result<(), String> {
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    let servers = root.entry("servers").or_insert_with(|| serde_json::json!({})).as_object_mut().ok_or_else(unreadable)?;
    match (machine, wanted) {
        (None, McpWanted::Removed) => {
            let mut removed = serde_json::json!({ "claude": null, "codex": null });
            // The other agents it went to stay listed, so each of them is rid of it too.
            if let Some(agents) = servers.get(name).and_then(|server| server.get("agents")).cloned() {
                removed["agents"] = agents;
            }
            servers.insert(name.to_string(), removed);
        }
        (None, _) => return Err("Every machine's value is a definition: take one into the repo from a home".into()),
        (Some(_), McpWanted::Removed) => return Err("A server is removed from every machine, or kept off one".into()),
        (Some(machine), wanted) => {
            let server = servers.get_mut(name).and_then(Value::as_object_mut).ok_or_else(|| format!("The repo hasn't got {name}"))?;
            let machines = server.entry("machines").or_insert_with(|| serde_json::json!({}));
            if !machines.is_object() {
                *machines = serde_json::json!({});
            }
            let machines = machines.as_object_mut().ok_or_else(unreadable)?;
            if wanted == McpWanted::Off {
                machines.insert(machine.to_string(), Value::Null);
            } else {
                machines.remove(machine);
            }
            if machines.is_empty() {
                server.remove("machines");
            }
        }
    }
    Ok(())
}

/// Sets what the repo wants of a server, for every machine or one, and commits the file alone.
#[tauri::command]
pub(crate) async fn set_mcp_wanted(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    name: String,
    machine: Option<String>,
    wanted: McpWanted,
) -> Result<McpRegistry, String> {
    if !is_server_name(&name) {
        return Err(RegistryBlock::Name.message().into());
    }
    let folder = Path::new(&repo);
    let mut file = read_file_to_change(folder).await?;
    set_wanted(&mut file, &name, machine.as_deref(), wanted)?;
    let text = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n";
    let message = match (&machine, wanted) {
        (None, _) => format!("Remove MCP server {name} from all machines"),
        (Some(machine), McpWanted::Off) => format!("Keep MCP server {name} off {machine}"),
        (Some(machine), _) => format!("Give {machine} MCP server {name} as every machine has it"),
    };
    take_into_repo(folder, MCP_FILE, text.as_bytes(), &message, &[]).await?;
    let (commit, found, uncommitted, registry) = load_registry(folder, None).await?;
    let machines = scanned_machines(&state.lock());
    Ok(registry_view(commit, found, uncommitted, &registry, &machines))
}

/// Whether a server's entry in the file defines it anywhere: for every machine, or as one machine's own.
fn defines_server(entry: &Value) -> bool {
    let set = |key: &str| entry.get(key).is_some_and(|value| !value.is_null());
    set("claude") || set("codex") || entry.get("machines").and_then(Value::as_object).is_some_and(|machines| machines.values().any(Value::is_object))
}

/// Puts back a server removed from every machine as the repo last defined it, from the newest commit of the file
/// that has a definition, and commits the file alone. It's read from the repo's history here, so a definition's
/// secrets never pass through the window.
async fn put_back_server(folder: &Path, name: &str, git_config: &[&str]) -> Result<(), String> {
    let mut file = read_file_to_change(folder).await?;
    if file.get("servers").and_then(|servers| servers.get(name)).is_some_and(defines_server) {
        return Ok(());
    }
    let pathspec = format!("./{MCP_FILE}");
    let commits = git_out(folder, &["log", "--format=%H", "-n", "500", "--", &pathspec]).await?;
    let mut found = None;
    for commit in commits.lines().map(str::trim).filter(|commit| is_commit(commit)) {
        let Ok(bytes) = repo_file(folder, commit, MCP_FILE).await else { continue };
        let entry = serde_json::from_slice::<Value>(&bytes).ok().and_then(|old| old.get("servers")?.get(name).cloned());
        if let Some(entry) = entry.filter(defines_server) {
            found = Some(entry);
            break;
        }
    }
    let entry = found.ok_or_else(|| format!("The repo's history has no definition of {name} to put back"))?;
    let root = file.as_object_mut().ok_or_else(unreadable)?;
    root.entry("version").or_insert(Value::from(FILE_VERSION));
    let servers = root.entry("servers").or_insert_with(|| serde_json::json!({})).as_object_mut().ok_or_else(unreadable)?;
    servers.insert(name.to_string(), entry);
    let text = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n";
    take_into_repo(folder, MCP_FILE, text.as_bytes(), &format!("Put back MCP server {name}"), git_config).await
}

/// Puts back a server removed from every machine, as the repo last had it: Undo, and the removed row's menu.
#[tauri::command]
pub(crate) async fn put_back_mcp_server(state: tauri::State<'_, MachineHealthState>, repo: String, name: String) -> Result<McpRegistry, String> {
    if !is_server_name(&name) {
        return Err(RegistryBlock::Name.message().into());
    }
    let folder = Path::new(&repo);
    put_back_server(folder, &name, &[]).await?;
    let (commit, found, uncommitted, registry) = load_registry(folder, None).await?;
    let machines = scanned_machines(&state.lock());
    Ok(registry_view(commit, found, uncommitted, &registry, &machines))
}

/// Puts `definition` in the repo's file as `name`'s for `agent`, or as `machine`'s own when `own`,
/// so that `home` on `machine` has it as the repo does, and commits the file alone.
#[allow(clippy::too_many_arguments)]
async fn record_server(
    folder: &Path,
    name: &str,
    agent: HomeAgent,
    machine: &str,
    home: &str,
    own: bool,
    definition: Value,
    git_config: &[&str],
) -> Result<(), String> {
    let mut file = read_file_to_change(folder).await?;
    let key = agent_key(agent);
    let other = if agent == HomeAgent::Claude { "codex" } else { "claude" };
    {
        let root = file.as_object_mut().ok_or_else(unreadable)?;
        root.entry("version").or_insert(Value::from(FILE_VERSION));
        let servers = root.entry("servers").or_insert_with(|| serde_json::json!({})).as_object_mut().ok_or_else(unreadable)?;
        let server = servers.entry(name).or_insert_with(|| serde_json::json!({}));
        if !server.is_object() {
            *server = serde_json::json!({});
        }
        let server = server.as_object_mut().ok_or_else(unreadable)?;
        // The home it came from gets it, where the server is kept to other homes.
        if let Some(homes) = server.get_mut("homes").and_then(Value::as_array_mut) {
            if !homes.iter().any(|listed| listed.as_str() == Some(home)) {
                homes.push(Value::from(home));
            }
        }
        if own {
            let machines = server.entry("machines").or_insert_with(|| serde_json::json!({}));
            if !machines.is_object() {
                *machines = serde_json::json!({});
            }
            let choice = machines.as_object_mut().ok_or_else(unreadable)?.entry(machine).or_insert_with(|| serde_json::json!({}));
            // A machine the server was kept off stays that way for the other agent.
            if !choice.is_object() {
                *choice = serde_json::json!({ other: null });
            }
            choice.as_object_mut().ok_or_else(unreadable)?.insert(key.to_string(), definition);
        } else {
            server.insert(key.to_string(), definition);
            // The machine it came from then has the repo's definition, rather than its own or none.
            if let Some(machines) = server.get_mut("machines").and_then(Value::as_object_mut) {
                match machines.get_mut(machine) {
                    Some(choice @ Value::Null) => *choice = serde_json::json!({ other: null }),
                    Some(Value::Object(agents)) => {
                        agents.remove(key);
                    }
                    _ => {}
                }
                if machines.get(machine).and_then(Value::as_object).is_some_and(serde_json::Map::is_empty) {
                    machines.remove(machine);
                }
            }
        }
    }
    let text = serde_json::to_string_pretty(&file).map_err(|error| error.to_string())? + "\n";
    let message = if own { format!("Take {machine}'s own MCP server {name}") } else { format!("Take MCP server {name} from {machine}") };
    take_into_repo(folder, MCP_FILE, text.as_bytes(), &message, git_config).await
}

/// Takes a server from a machine's home into the repo, as the repo's definition for that agent or
/// as the machine's own, once it holds nothing that looks like a secret.
#[tauri::command]
pub(crate) async fn take_mcp_server(
    state: tauri::State<'_, MachineHealthState>,
    repo: String,
    machine: String,
    home: String,
    name: String,
    own: bool,
) -> Result<McpRegistry, String> {
    if !is_server_name(&name) {
        return Err(RegistryBlock::Name.message().into());
    }
    let (target, agent, rel, home_dir) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        let agent = home_agent(setup, &home).filter(|agent| *agent != HomeAgent::Shared);
        let (Some(agent), Some(rel)) = (agent, home_place(&home)) else {
            return Err(format!("{home} isn't a home Arbor changes on this machine"));
        };
        if !setup.home_servers(&home).contains_key(name.as_str()) {
            return Err("Arbor can only take a server its last scan of this machine found. Scan again.".into());
        }
        (target, agent, rel.to_string(), setup.home_dir().to_string())
    };
    let homes = [(agent, rel)];
    let files = read_homes(&target, &homes).await?;
    let servers = file_servers(agent, files.get(&0).map(Vec::as_slice))?;
    let definition = servers.get(&name).ok_or_else(|| format!("{name} isn't in {home} on {machine} any more. Scan again."))?;
    let definition = with_texts(&normalized_mcp(agent, definition), &|text| swap_home(text, &home_dir, "~"));
    let places = secret_places(agent, &definition);
    if !places.is_empty() {
        let fix = match agent {
            HomeAgent::Claude => "Change them there to ${VAR} references",
            _ => "Change them there to variables Codex reads by name (env_vars, bearer_token_env_var or env_http_headers)",
        };
        let what = match places.as_slice() {
            [one] => format!("{one} looks like a secret"),
            _ => format!("{} look like secrets", places.join(", ")),
        };
        return Err(format!("Arbor didn't take {name}: {what}, and the repo mustn't hold one. {fix}, then take it again."));
    }
    let problems = definition_problems(agent, &definition);
    if !problems.is_empty() {
        return Err(format!("Arbor didn't take {name}, as {} would refuse it: {}", agent_name(agent), problems.join("; ")));
    }
    let folder = Path::new(&repo);
    record_server(folder, &name, agent, &machine, &home, own, definition, &[]).await?;
    let (commit, found, uncommitted, registry) = load_registry(folder, None).await?;
    let machines = scanned_machines(&state.lock());
    Ok(registry_view(commit, found, uncommitted, &registry, &machines))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registry(file: Value) -> Registry {
        read_registry(file.to_string().as_bytes())
    }

    #[test]
    fn a_server_is_kept_off_a_machine_or_removed_from_every_one() {
        let definition = json!({ "type": "http", "url": "https://mcp.linear.app/mcp" });
        let mut file = json!({ "version": 1, "servers": { "linear": { "claude": definition, "homes": ["~/.claude"] } } });
        set_wanted(&mut file, "linear", Some("ci-01"), McpWanted::Off).unwrap();
        assert_eq!(file["servers"]["linear"]["machines"], json!({ "ci-01": null }));
        let kept = registry(file.clone());
        assert!(kept.server("linear").unwrap().wanted("ci-01", HomeAgent::Claude, "~/.claude").is_none());
        assert!(kept.server("linear").unwrap().wanted("mac", HomeAgent::Claude, "~/.claude").is_some());
        // Back to as every machine has it, which leaves no machines at all.
        set_wanted(&mut file, "linear", Some("ci-01"), McpWanted::Default).unwrap();
        assert!(file["servers"]["linear"].get("machines").is_none());
        // Removed everywhere: the name stays with no definition, so no home is given it and every copy is extra.
        set_wanted(&mut file, "linear", None, McpWanted::Removed).unwrap();
        assert_eq!(file["servers"]["linear"], json!({ "claude": null, "codex": null }));
        let removed = registry(file.clone());
        assert!(removed.problems.is_empty() && removed.server("linear").unwrap().problems.is_empty());
        assert!(removed.server("linear").unwrap().wanted("mac", HomeAgent::Codex, "~/.codex").is_none());
        // Only a definition taken from a home is every machine's value, and a machine is kept off rather than removed.
        assert!(set_wanted(&mut file, "linear", None, McpWanted::Off).is_err());
        assert!(set_wanted(&mut file, "linear", Some("mac"), McpWanted::Removed).is_err());
        assert!(set_wanted(&mut file, "sentry", Some("mac"), McpWanted::Off).is_err());

        // The other agents a removed server went to stay listed, so they're rid of it too.
        let mut sent = json!({ "version": 1, "servers": { "fs": { "claude": { "command": "npx" }, "agents": ["pi"] } } });
        set_wanted(&mut sent, "fs", None, McpWanted::Removed).unwrap();
        assert_eq!(sent["servers"]["fs"], json!({ "claude": null, "codex": null, "agents": ["pi"] }));
    }

    #[test]
    fn secrets_are_found_by_where_they_are_and_never_said() {
        let claude = |definition: Value| secret_places(HomeAgent::Claude, &definition);
        let codex = |definition: Value| secret_places(HomeAgent::Codex, &definition);
        let token = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
        assert_eq!(claude(json!({ "command": "npx", "env": { "GITHUB_TOKEN": token } })), ["env.GITHUB_TOKEN"]);
        assert_eq!(claude(json!({ "command": "npx", "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}", "TOKENIZERS_PARALLELISM": "false", "PATH": "/usr/bin" } })), Vec::<String>::new());
        assert_eq!(claude(json!({ "command": "npx", "env": { "API_KEY": "hunter2" } })), ["env.API_KEY"], "a secret's name with a value");
        assert_eq!(claude(json!({ "command": "npx", "env": { "API_KEY": "${API_KEY:-hunter2}" } })), ["env.API_KEY"], "a default is a value");
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } })), Vec::<String>::new());
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example/mcp", "headers": { "X-Api-Key": "abc" } })), ["headers.X-Api-Key"]);
        assert_eq!(claude(json!({ "type": "http", "url": "https://me:pw@x.example/mcp" })), ["url"]);
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example/mcp?api_key=abc" })), ["url"]);
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example/mcp?api_key=${KEY}&team=a" })), Vec::<String>::new());
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example/s/3f2504e04f8911d39a0c0305e82c3301/mcp" })), ["url"], "a key-like part of the path");
        assert_eq!(claude(json!({ "command": "npx", "args": ["-y", "server", "--token", "abc"] })), ["args[3]"]);
        assert_eq!(claude(json!({ "command": "npx", "args": ["--api-key=abc", "--token-file", "/k", "--token=${T}"] })), ["args[0]"]);
        assert_eq!(claude(json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/casey/src/dev-tools/EasyCLIProxyAPI"] })), Vec::<String>::new());
        assert_eq!(claude(json!({ "command": "run", "args": ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz"] })), ["args[0]"]);
        assert_eq!(claude(json!({ "command": "run", "args": ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"] })), ["args[0]"]);
        assert_eq!(claude(json!({ "command": "run", "args": ["disk-cache-size-limit-for-everything", "task-runner-with-a-long-name-here"] })), Vec::<String>::new());
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example", "oauth": { "clientId": "abc", "clientSecret": "s" } })), ["oauth.clientSecret"]);
        assert_eq!(claude(json!({ "command": "llm", "args": ["--max-tokens", "4096", "--auth", "true"], "env": { "MAX_TOKENS": "4096", "PWD": "/srv", "USE_AUTH": "false" } })), Vec::<String>::new(), "numbers and flags");
        assert_eq!(claude(json!({ "command": "db", "env": { "DATABASE_URL": "postgres://me:hunter2@db.local/app" } })), ["env.DATABASE_URL"], "a password in a URL anywhere");
        assert_eq!(claude(json!({ "command": "db", "env": { "DATABASE_URL": "postgres://me:${DB_PASSWORD}@db.local/app", "REPO": "ssh://git@github.com/me/repo" } })), Vec::<String>::new());

        assert_eq!(codex(json!({ "command": "npx", "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } })), ["env.GITHUB_TOKEN"], "Codex doesn't fill in ${{VAR}}");
        assert_eq!(codex(json!({ "command": "npx", "env_vars": ["GITHUB_TOKEN"] })), Vec::<String>::new());
        assert_eq!(codex(json!({ "url": "https://x.example", "http_headers": { "Authorization": "Bearer ${T}" } })), ["http_headers.Authorization"]);
        assert_eq!(codex(json!({ "url": "https://x.example", "bearer_token_env_var": "T", "env_http_headers": { "X-Api-Key": "KEY" } })), Vec::<String>::new());
        assert_eq!(codex(json!({ "url": "https://x.example", "bearer_token": "abc" })), ["bearer_token"]);
        assert_eq!(codex(json!({ "command": "db", "env": { "DATABASE_URL": "postgres://me:${DB_PASSWORD}@db.local/app" } })), ["env.DATABASE_URL"]);

        // Where else one hides: a remote's URL or headers in its arguments, a variable set on a
        // container, names run together, a value alone, a shell's line.
        assert_eq!(claude(json!({ "command": "npx", "args": ["-y", "mcp-remote", "https://x.example/sse?api_key=abc123"] })), ["args[2]"], "a key in a URL anywhere");
        assert_eq!(codex(json!({ "command": "npx", "args": ["-y", "mcp-remote", "https://x.example/sse?token=3f2504e04f8911d39a0c0305e82c33013f2504e0"] })), ["args[2]"]);
        assert_eq!(claude(json!({ "command": "npx", "args": ["mcp-remote", "https://x.example/sse", "--header", "Authorization: Bearer 3f2504e04f8911d39a0c"] })), ["args[3]"], "a header as it's written");
        assert_eq!(claude(json!({ "command": "npx", "args": ["mcp-remote", "https://x.example/sse", "--header", "X-API-Key: 3f2504e0-4f89-11d3-9a0c-0305e82c3301"] })), ["args[3]"]);
        assert_eq!(claude(json!({ "command": "npx", "args": ["mcp-remote", "https://x.example/sse", "--header", "Authorization: Bearer ${TOKEN}"] })), Vec::<String>::new());
        assert_eq!(claude(json!({ "command": "docker", "args": ["run", "--env", "NOTION_TOKEN=abc123def", "-e", "GITHUB_TOKEN", "image"] })), ["args[2]"], "one set, not one passed through");
        assert_eq!(claude(json!({ "command": "db", "env": { "PGPASSWORD": "hunter2", "MYSQL_PWD": "hunter3", "PGHOST": "db.local" } })), ["env.MYSQL_PWD", "env.PGPASSWORD"], "names run together");
        assert_eq!(claude(json!({ "command": "x", "env": { "ENDPOINT": "https://x.example/v1?key=abc123" } })), ["env.ENDPOINT"]);
        assert_eq!(claude(json!({ "command": "x", "args": ["serve", "3f2504e04f8911d39a0c0305e82c3301"] })), ["args[1]"], "a key in hex alone");
        assert_eq!(claude(json!({ "command": "sh", "args": ["-c", "API_KEY=abc123 exec server --verbose"] })), ["args[1]"], "a shell's line");
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example", "headersHelper": "echo Authorization: Bearer abc123" })), ["headersHelper"]);
        assert_eq!(claude(json!({ "type": "http", "url": "https://ghp0123456789abcdefghij@x.example/mcp" })), ["url"], "a token as the user name");
        for definition in [
            json!({ "command": "uvx", "args": ["--from", "git+ssh://git@github.com/me/server@3f2504e04f8911d39a0c0305e82c33013f2504e0", "server"] }),
            json!({ "command": "docker", "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server@sha256:3f2504e04f8911d39a0c0305e82c33013f2504e04f8911d39a0c0305e82c3301"] }),
            json!({ "command": "npx", "args": ["-y", "notion-mcp", "--workspace-id", "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "--auth", "oauth"] }),
            json!({ "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.notion.com/sse", "--transport", "sse-only"] }),
            json!({ "command": "npx", "env": { "PATH": "/usr/bin:/bin", "NODE_OPTIONS": "--max-old-space-size=4096", "ACCEPT": "Content-Type: application/json" } }),
        ] {
            assert_eq!(claude(definition.clone()), Vec::<String>::new(), "a commit, a digest, an id, a mode or a setting isn't a secret: {definition}");
        }

        let problems = definition_problems(HomeAgent::Claude, &json!({ "type": "stdio", "command": "npx", "env": { "GITHUB_TOKEN": token, "SLACK_BOT_TOKEN": "xoxb-1234567890-abcdefghij" } }));
        assert_eq!(problems, ["env.GITHUB_TOKEN, env.SLACK_BOT_TOKEN look like secrets. Refer to it with ${VAR} instead, so the repo never holds one."]);
        assert!(!format!("{problems:?}").contains("ghp_") && !format!("{problems:?}").contains("xoxb"));
    }

    #[test]
    fn names_are_read_as_words() {
        assert_eq!(words("X-Api-Key"), ["x", "api", "key"]);
        assert_eq!(words("xApiKey"), ["x", "api", "key"]);
        assert_eq!(words("APIKey"), ["api", "key"]);
        assert_eq!(words("GITHUB_PERSONAL_ACCESS_TOKEN"), ["github", "personal", "access", "token"]);
        for name in ["GITHUB_TOKEN", "Authorization", "api-key", "OPENAI_API_KEY", "clientSecret", "DB_PASS", "Cookie", "AWS_SECRET_ACCESS_KEY", "PGPASSWORD", "MYSQL_PWD", "GHTOKEN", "X-Amz-Signature"] {
            assert!(secret_name(name), "{name}");
        }
        for name in ["PATH", "TOKENIZERS_PARALLELISM", "token-file", "AUTH_URL", "AWS_ACCESS_KEY_ID", "KEYCHAIN_PATH", "HOME", "PUBLIC_KEY", "bearer_token_env_var", "PWD", "maxTokens", "bypass"] {
            assert!(!secret_name(name), "{name}");
        }
        assert_eq!(take_references("Bearer ${A}:${B:-x}${9}"), ("Bearer :x${9}".to_string(), vec!["A".to_string(), "B".to_string()]));
        assert!(refers_only("${TOKEN}") && refers_only("Bearer ${TOKEN}") && refers_only("${USER}:${PASS}"));
        assert!(!refers_only("Bearer abc") && !refers_only("x${TOKEN}") && !refers_only("plain"));
    }

    #[test]
    fn definitions_are_checked_for_what_each_agent_would_refuse() {
        let claude = |definition: Value| definition_problems(HomeAgent::Claude, &normalized_mcp(HomeAgent::Claude, &definition));
        let codex = |definition: Value| definition_problems(HomeAgent::Codex, &normalized_mcp(HomeAgent::Codex, &definition));
        assert!(claude(json!({ "command": "npx", "args": ["-y", "x"] })).is_empty(), "a command is stdio");
        assert_eq!(claude(json!({ "url": "https://x.example" })), ["It has a url but no type. Add \"type\": \"http\" (or \"sse\" or \"ws\")."]);
        assert_eq!(claude(json!({ "type": "http" })), ["It needs a url"]);
        assert_eq!(claude(json!({ "type": "carrier-pigeon", "url": "x" })), ["type should be stdio, http, sse or ws"]);
        assert_eq!(claude(json!({ "command": "npx", "args": "-y x" })), ["args should be a list of text"]);
        assert!(claude(json!({ "type": "streamable-http", "url": "https://x.example" })).is_empty());
        assert_eq!(claude(json!({ "command": "npx", "arg": ["-y"], "headers": {} })), ["Arbor doesn't know arg for Claude Code"], "an empty headers is dropped as Claude Code drops it");
        assert_eq!(claude(json!({ "type": "http", "url": "https://x.example", "env": { "A": "1" } })), ["env only go with a command"]);
        assert_eq!(claude(json!({ "command": "npx", "headers": { "A": "1" } })), ["headers only go with a url"]);

        assert!(codex(json!({ "command": "npx", "args": ["-y", "x"], "env_vars": ["A", { "name": "B", "source": "remote" }], "startup_timeout_sec": 20 })).is_empty());
        assert!(codex(json!({ "url": "https://x.example", "bearer_token_env_var": "T", "tools": { "search": { "approval_mode": "approve" } } })).is_empty());
        assert_eq!(codex(json!({ "args": ["x"] })), ["It needs a command or a url"]);
        assert_eq!(codex(json!({ "command": "x", "url": "y" })), ["It has both a command and a url; Codex takes one"]);
        assert_eq!(codex(json!({ "command": "x", "bearer_token_env_var": "T" })), ["bearer_token_env_var only go with a url"]);
        assert_eq!(codex(json!({ "url": "y", "env": { "A": "1" } })), ["env only go with a command"]);
        assert_eq!(codex(json!({ "command": "x", "env": { "HOME_DIR": "${HOME}" } })), ["Codex doesn't fill in ${VAR}, so env.HOME_DIR would get it as written. List the variable in env_vars instead."]);
        assert_eq!(codex(json!({ "command": "x", "env_vars": [{ "name": "A", "source": "moon" }] })), ["env_vars should list variable names, or { name, source } with source local or remote"]);
        assert_eq!(codex(json!({ "command": "x", "type": "stdio" })), ["Codex has no type. It tells a server it starts (a command) from one at a url."]);
        assert_eq!(codex(json!({ "command": "x", "env": { "A": null } })), ["env should be an object of text", "env.A can't be null, which config.toml can't hold"]);
        assert_eq!(codex(json!({ "command": "x", "startup_timeout_sec": "soon" })), ["startup_timeout_sec should be a number"]);
    }

    #[test]
    fn the_file_is_read_with_each_servers_problems_kept_to_it() {
        let read = registry(json!({
            "version": 1,
            "servers": {
                "context7": { "claude": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }, "codex": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } },
                "linear": {
                    "claude": { "type": "http", "url": "https://mcp.linear.app/mcp" },
                    "homes": ["~/.claude"],
                    "machines": { "ci-01": null, "cedar": { "claude": { "type": "sse", "url": "https://mcp.linear.app/sse" } } }
                },
                "leaky": { "claude": { "command": "npx", "env": { "GITHUB_TOKEN": "ghp_0123456789abcdefghijABCDEFGHIJ0123" } }, "color": "blue" },
                "-bad": {}
            }
        }));
        assert!(read.problems.is_empty());
        let names: Vec<&str> = read.servers.iter().map(|server| server.name.as_str()).collect();
        assert_eq!(names, ["-bad", "context7", "leaky", "linear"]);
        let linear = read.server("linear").unwrap();
        assert_eq!(linear.homes.as_deref(), Some(&["~/.claude".to_string()][..]));
        assert_eq!(linear.machines["ci-01"], [Wanted::Off, Wanted::Off]);
        assert!(matches!(&linear.machines["cedar"], [Wanted::Own(_), Wanted::Default]));
        assert_eq!(linear.wanted("mac", HomeAgent::Claude, "~/.claude").map(|(definition, own)| (definition["type"].clone(), own)), Some((json!("http"), false)));
        assert_eq!(linear.wanted("cedar", HomeAgent::Claude, "~/.claude").map(|(definition, own)| (definition["type"].clone(), own)), Some((json!("sse"), true)));
        assert!(linear.wanted("ci-01", HomeAgent::Claude, "~/.claude").is_none());
        assert!(linear.wanted("mac", HomeAgent::Claude, "~/.agent-app/homes/claude-proxy").is_none(), "kept to its homes");
        assert!(linear.wanted("mac", HomeAgent::Codex, "~/.codex").is_none(), "it has no Codex definition");
        let leaky = read.server("leaky").unwrap();
        assert_eq!(leaky.problems.len(), 2);
        assert!(leaky.problems.iter().any(|problem| problem.starts_with("claude: env.GITHUB_TOKEN looks like a secret")));
        assert!(leaky.problems.contains(&"Arbor doesn't know color".to_string()));
        assert!(!format!("{:?}", read.servers.iter().map(|server| &server.problems).collect::<Vec<_>>()).contains("ghp_"));
        assert_eq!(read.server("-bad").unwrap().problems.len(), 1);

        assert_eq!(read_registry(b"{ nope").problems, [format!("{MCP_FILE} isn't a JSON object Arbor can read")]);
        assert_eq!(registry(json!({ "version": 2, "servers": {} })).problems, [format!("{MCP_FILE} is a version this Arbor doesn't read. Update Arbor.")]);
        assert_eq!(registry(json!({ "servers": [] })).problems, [format!("servers in {MCP_FILE} should be an object of server names")]);
    }

    fn machine() -> MachineSetup {
        MachineSetup::with_homes(&[
            (HomeAgent::Claude, "~/.claude"),
            (HomeAgent::Claude, "~/.agent-app/homes/claude-proxy"),
            (HomeAgent::Codex, "~/.codex"),
            (HomeAgent::Shared, "~/.agents"),
        ])
        .with_home_dir("/Users/casey")
        // Written as Claude Code writes it: with the type and an empty env.
        .with_mcp("~/.claude", "context7", &json!({ "type": "stdio", "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": {} }))
        .with_mcp("~/.claude", "linear", &json!({ "type": "http", "url": "https://mcp.linear.app/sse" }))
        .with_mcp("~/.claude", "playwright", &json!({ "type": "stdio", "command": "npx", "args": ["@playwright/mcp"] }))
        .with_mcp("~/.codex", "context7", &json!({ "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "enabled": true }))
        .with_mcp("~/.codex", "odd.name", &json!({ "command": "x" }))
    }

    fn file() -> Value {
        json!({
            "version": 1,
            "servers": {
                "context7": { "claude": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }, "codex": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } },
                "linear": { "claude": { "type": "http", "url": "https://mcp.linear.app/mcp" }, "codex": { "url": "https://mcp.linear.app/mcp" } },
                "broken": { "claude": { "url": "https://x.example" } }
            }
        })
    }

    fn states(cells: &[RegistryCell]) -> Vec<(&str, &str, RegistryState, Option<RegistryBlock>)> {
        cells.iter().map(|cell| (cell.home.as_str(), cell.name.as_str(), cell.state, cell.blocked)).collect()
    }

    #[test]
    fn each_home_is_compared_with_the_repo_by_fingerprint() {
        let cells = machine_cells(&registry(file()), "mac", &machine());
        assert_eq!(
            states(&cells),
            [
                ("~/.claude", "broken", RegistryState::Add, Some(RegistryBlock::Broken)),
                ("~/.claude", "context7", RegistryState::Same, None),
                ("~/.claude", "linear", RegistryState::Update, None),
                ("~/.claude", "playwright", RegistryState::Extra, None),
                ("~/.agent-app/homes/claude-proxy", "broken", RegistryState::Add, Some(RegistryBlock::Broken)),
                ("~/.agent-app/homes/claude-proxy", "context7", RegistryState::Add, None),
                ("~/.agent-app/homes/claude-proxy", "linear", RegistryState::Add, None),
                ("~/.codex", "context7", RegistryState::Same, None),
                ("~/.codex", "linear", RegistryState::Add, None),
                ("~/.codex", "odd.name", RegistryState::Extra, Some(RegistryBlock::Name)),
            ],
            "the same server written differently is the same; the shared ~/.agents isn't a home for servers"
        );

        let mut own = file();
        own["servers"]["linear"]["machines"] = json!({ "mac": { "claude": { "type": "http", "url": "https://mcp.linear.app/sse" }, "codex": null } });
        own["servers"]["context7"]["homes"] = json!(["~/.claude", "~/.codex"]);
        let cells = machine_cells(&registry(own), "mac", &machine());
        let linear: Vec<(&str, RegistryState, bool)> = cells.iter().filter(|cell| cell.name == "linear").map(|cell| (cell.home.as_str(), cell.state, cell.own)).collect();
        assert_eq!(linear, [("~/.claude", RegistryState::Same, true), ("~/.agent-app/homes/claude-proxy", RegistryState::Add, true)]);
        assert!(!cells.iter().any(|cell| cell.name == "context7" && cell.home.starts_with("~/.t3")), "kept to its homes");

        // A machine's entry Arbor can't read isn't taken to keep the server off it.
        let mut odd = file();
        odd["servers"]["context7"]["machines"] = json!({ "mac": { "claude": "stdio" } });
        let odd = registry(odd);
        let cells = machine_cells(&odd, "mac", &machine());
        let context7: Vec<(&str, RegistryState, Option<RegistryBlock>)> = cells.iter().filter(|cell| cell.name == "context7").map(|cell| (cell.home.as_str(), cell.state, cell.blocked)).collect();
        assert_eq!(context7, [("~/.claude", RegistryState::Extra, Some(RegistryBlock::Broken)), ("~/.codex", RegistryState::Same, Some(RegistryBlock::Broken))]);
        let remove = McpChange { home: "~/.claude".into(), name: "context7".into(), action: McpAction::Remove };
        assert_eq!(plan(&odd, "mac", &machine(), vec![remove]).unwrap_err(), format!("context7 in ~/.claude: {}", RegistryBlock::Broken.message()));
    }

    #[test]
    fn a_shadow_home_leaves_its_servers_to_the_home_it_shares() {
        let shadow = MachineSetup::with_homes(&[(HomeAgent::Codex, "~/.codex"), (HomeAgent::Codex, "~/.agent-app/homes/codex-proxy")])
            .with_home_dir("/Users/casey")
            .with_shared("~/.agent-app/homes/codex-proxy", "~/.codex", &["config.toml", "skills"]);
        let cells = machine_cells(&registry(file()), "mac", &shadow);
        assert!(!cells.is_empty() && cells.iter().all(|cell| cell.home == "~/.codex"), "{:?}", states(&cells));
        let add = McpChange { home: "~/.agent-app/homes/codex-proxy".into(), name: "linear".into(), action: McpAction::Add };
        assert_eq!(plan(&registry(file()), "mac", &shadow, vec![add]).unwrap_err(), "Arbor can't set up linear in ~/.agent-app/homes/codex-proxy as it is");
    }

    #[test]
    fn home_folders_are_kept_as_tilde_and_given_back_as_each_machines() {
        assert_eq!(swap_home("/Users/casey/src/app", "/Users/casey", "~"), "~/src/app");
        assert_eq!(swap_home("--root=/Users/casey/src:/Users/casey/lib", "/Users/casey", "~"), "--root=~/src:~/lib");
        assert_eq!(swap_home("/Users/casey", "/Users/casey", "~"), "~");
        assert_eq!(swap_home("https://x.example/Users/casey/y", "/Users/casey", "~"), "https://x.example/Users/casey/y", "not where a path starts");
        assert_eq!(swap_home("/Users/caseyr/src", "/Users/casey", "~"), "/Users/caseyr/src");
        assert_eq!(swap_home("~/src and ~/lib", "~", "/home/casey"), "/home/casey/src and /home/casey/lib");
        assert_eq!(swap_home("~", "~", "/home/casey"), "/home/casey");
        assert_eq!(swap_home("a~/b", "~", "/home/casey"), "a~/b");
        assert_eq!(swap_home("~/src", "~", ""), "~/src", "a machine whose home folder isn't known");

        // Taken on a Mac, the same on Linux, and set up there with Linux's home folder.
        let mac = json!({ "command": "node", "args": ["/Users/casey/src/server/index.js", "--root=/Users/casey/src"] });
        let kept = with_texts(&normalized_mcp(HomeAgent::Claude, &mac), &|text| swap_home(text, "/Users/casey", "~"));
        assert_eq!(kept["args"], json!(["~/src/server/index.js", "--root=~/src"]));
        let registry = registry(json!({ "version": 1, "servers": { "server": { "claude": kept } } }));
        let linux = || MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude")]).with_home_dir("/home/casey");
        let there = linux().with_mcp("~/.claude", "server", &json!({ "type": "stdio", "command": "node", "args": ["/home/casey/src/server/index.js", "--root=/home/casey/src"] }));
        assert_eq!(states(&machine_cells(&registry, "linux", &there)), [("~/.claude", "server", RegistryState::Same, None)]);
        let add = McpChange { home: "~/.claude".into(), name: "server".into(), action: McpAction::Add };
        let planned = plan(&registry, "linux", &linux(), vec![add]).unwrap();
        assert_eq!(planned[0].definition.as_ref().map(|definition| definition["args"].clone()), Some(json!(["/home/casey/src/server/index.js", "--root=/home/casey/src"])));
    }

    #[test]
    fn a_plan_is_checked_against_the_last_scan() {
        let registry = registry(file());
        let change = |home: &str, name: &str, action: McpAction| McpChange { home: home.into(), name: name.into(), action };
        let planned = plan(
            &registry,
            "mac",
            &machine(),
            vec![
                change("~/.codex", "linear", McpAction::Add),
                change("~/.claude", "linear", McpAction::Update),
                change("~/.claude", "playwright", McpAction::Remove),
            ],
        )
        .unwrap();
        let shown: Vec<(&str, &str, &str, McpAction, bool)> =
            planned.iter().map(|change| (change.home.as_str(), change.rel.as_str(), change.name.as_str(), change.action, change.definition.is_some())).collect();
        assert_eq!(
            shown,
            [
                ("~/.claude", ".claude", "linear", McpAction::Update, true),
                ("~/.claude", ".claude", "playwright", McpAction::Remove, false),
                ("~/.codex", ".codex", "linear", McpAction::Add, true),
            ],
            "Claude Code's come first"
        );
        let scanned = machine();
        let seen: Vec<Option<&str>> = planned.iter().map(|change| change.seen.as_deref()).collect();
        let found = |home: &str, name: &str| scanned.home_servers(home).get(name).copied().flatten();
        assert_eq!(seen, [found("~/.claude", "linear"), found("~/.claude", "playwright"), None], "each as the scan found it, or not there");
        assert!(seen[0].is_some());
        let refused = |changes: Vec<McpChange>| plan(&registry, "mac", &machine(), changes).unwrap_err();
        assert_eq!(refused(vec![]), "There's nothing to change");
        assert_eq!(refused(vec![change("~/.claude", "context7", McpAction::Update)]), "Arbor can't update context7 in ~/.claude as it is");
        assert_eq!(refused(vec![change("~/.claude", "context7", McpAction::Remove)]), "Arbor can't remove context7 in ~/.claude as it is", "the repo has it there");
        assert_eq!(refused(vec![change("~/.claude", "broken", McpAction::Add)]), format!("broken in ~/.claude: {}", RegistryBlock::Broken.message()));
        assert_eq!(refused(vec![change("~/.codex", "odd.name", McpAction::Remove)]), format!("odd.name in ~/.codex: {}", RegistryBlock::Name.message()));
        assert_eq!(refused(vec![change("~/.agents", "context7", McpAction::Add)]), "Arbor can't set up context7 in ~/.agents as it is");
        assert_eq!(
            refused(vec![change("~/.codex", "linear", McpAction::Add), change("~/.codex", "linear", McpAction::Add)]),
            "linear in ~/.codex is in the changes twice"
        );
        let broken = read_registry(b"[]");
        assert_eq!(plan(&broken, "mac", &machine(), vec![change("~/.claude", "playwright", McpAction::Remove)]).unwrap_err(), broken.problems[0]);
        let view = registry_view(Some("a".repeat(40)), true, false, &broken, &[("mac".to_string(), machine())]);
        assert!(view.cells.is_empty() && !view.problems.is_empty(), "a file Arbor can't read says nothing about the homes");
    }

    #[test]
    fn a_server_changed_since_the_scan_is_left_alone() {
        let registry = registry(file());
        let change = |home: &str, name: &str, action: McpAction| McpChange { home: home.into(), name: name.into(), action };
        let changes = || vec![change("~/.claude", "linear", McpAction::Update), change("~/.claude", "playwright", McpAction::Remove), change("~/.codex", "linear", McpAction::Add)];
        let planned = plan(&registry, "mac", &machine(), changes()).unwrap();
        let homes = planned_homes(&planned);
        assert_eq!(homes, [(HomeAgent::Claude, ".claude".to_string()), (HomeAgent::Codex, ".codex".to_string())]);

        let playwright = json!({ "type": "stdio", "command": "npx", "args": ["@playwright/mcp"] });
        let as_scanned = BTreeMap::from([(0, json!({ "linear": { "type": "http", "url": "https://mcp.linear.app/sse" }, "playwright": playwright }).to_string().into_bytes())]);
        let (fresh, stale) = still_as_scanned(planned, &as_scanned, &homes, "/Users/casey").unwrap();
        assert_eq!(fresh.len(), 3, "nothing's changed since");
        assert!(stale.is_empty());

        // Since the scan, linear in ~/.claude got a header, and ~/.codex got a linear of its own.
        let since = BTreeMap::from([
            (0, json!({ "linear": { "type": "http", "url": "https://mcp.linear.app/sse", "headers": { "X-Team": "a" } }, "playwright": playwright }).to_string().into_bytes()),
            (1, b"[mcp_servers.linear]\nurl = \"https://mine.example/mcp\"\n".to_vec()),
        ]);
        let planned = plan(&registry, "mac", &machine(), changes()).unwrap();
        let (fresh, stale) = still_as_scanned(planned, &since, &homes, "/Users/casey").unwrap();
        assert_eq!(fresh.iter().map(|change| change.name.as_str()).collect::<Vec<_>>(), ["playwright"]);
        let stale: Vec<(&str, &str, McpOutcome)> = stale.iter().map(|result| (result.home.as_str(), result.name.as_str(), result.outcome)).collect();
        assert_eq!(stale, [("~/.claude", "linear", McpOutcome::Changed), ("~/.codex", "linear", McpOutcome::Changed)]);
        assert!(codex_writes(&fresh, &since, &homes).unwrap().is_empty(), "a Codex home with nothing left to change isn't written");
    }

    #[test]
    fn a_codex_config_changes_only_in_the_servers_tables() {
        let config = "# Codex\nmodel = \"gpt-5.5\"\n\n# Docs lookups\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"old\"]\n\n[mcp_servers.gone]\ncommand = \"x\"\n\n[profiles.fast]\nmodel = \"gpt-5.5-mini\"\n";
        let context7 = json!({ "args": ["-y", "@upstash/context7-mcp"], "command": "npx", "env_vars": ["C7_KEY"] });
        let linear = json!({ "url": "https://mcp.linear.app/mcp", "bearer_token_env_var": "LINEAR", "tools": { "search": { "approval_mode": "approve" } }, "startup_timeout_sec": 20 });
        let edited = edit_codex_config(config, &[("context7", Some(&context7)), ("gone", None), ("linear", Some(&linear))]).unwrap();
        assert_eq!(
            edited,
            "# Codex\nmodel = \"gpt-5.5\"\n\n# Docs lookups\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\nenv_vars = [\"C7_KEY\"]\n\n\
             [mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\nbearer_token_env_var = \"LINEAR\"\nstartup_timeout_sec = 20\n\n\
             [mcp_servers.linear.tools]\nsearch = { approval_mode = \"approve\" }\n\n[profiles.fast]\nmodel = \"gpt-5.5-mini\"\n"
        );
        let servers = file_servers(HomeAgent::Codex, Some(edited.as_bytes())).unwrap();
        assert_eq!(servers["context7"], context7, "it reads back as the repo defines it");
        assert_eq!(servers["linear"], linear);
        assert!(!servers.contains_key("gone"));

        let fresh = edit_codex_config("", &[("fs", Some(&json!({ "command": "npx", "env": { "ROOT": "/tmp" } })))]).unwrap();
        assert_eq!(fresh, "[mcp_servers.fs]\ncommand = \"npx\"\nenv = { ROOT = \"/tmp\" }\n");
        assert!(edit_codex_config("model = ", &[]).is_err());
        assert!(edit_codex_config("mcp_servers = 1\n", &[("x", None)]).is_err());
    }

    #[test]
    fn results_say_how_each_change_went() {
        let registry = registry(file());
        let change = |home: &str, name: &str, action: McpAction| McpChange { home: home.into(), name: name.into(), action };
        let planned = plan(
            &registry,
            "mac",
            &machine(),
            vec![
                change("~/.claude", "linear", McpAction::Update),
                change("~/.claude", "playwright", McpAction::Remove),
                change("~/.agent-app/homes/claude-proxy", "context7", McpAction::Add),
                change("~/.codex", "linear", McpAction::Add),
            ],
        )
        .unwrap();
        let writes = vec![CodexWrite { rel: ".codex".into(), before: "-".into(), content: String::new(), check: None }];
        let stdout = "R\t0\t1\treadd\tMCP server linear already exists in https://me:pw@x.example\nR\t1\t0\tremove\tRemoved MCP server playwright\nE\t0\tok\nE\t0\tback\n";
        let results: Vec<(&str, McpOutcome, String)> = parse_results(stdout, &planned, &writes).into_iter().map(|result| (Box::leak(result.name.into_boxed_str()) as &str, result.outcome, result.message)).collect();
        assert_eq!(
            results,
            [
                ("linear", McpOutcome::Removed, "MCP server linear already exists in https://x.example".to_string()),
                ("playwright", McpOutcome::Done, "Removed MCP server playwright".to_string()),
                ("context7", McpOutcome::Failed, "Arbor didn't hear how this went".to_string()),
                ("linear", McpOutcome::Failed, "Codex couldn't read config.toml with this change, so Arbor put the file back as it was".to_string()),
            ]
        );
        // Out to be replaced, and then nothing more.
        let cut = parse_results("R\t0\t0\ttaken\tRemoved MCP server linear\n", &planned[..1], &[]);
        assert_eq!((cut[0].outcome, cut[0].message.as_str()), (McpOutcome::Failed, "Taken out to be replaced, and Arbor didn't hear whether it was set up again. Scan again to see."));
        let whole = parse_results("R\t0\t0\ttaken\tRemoved\nR\t0\t0\treadd\tAdded\n", &planned[..1], &[]);
        assert_eq!(whole[0].outcome, McpOutcome::Done);
    }

    #[test]
    fn other_agents_take_the_claude_definition_in_their_own_shape() {
        let stdio = normalized_mcp(HomeAgent::Claude, &json!({ "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": { "C7_KEY": "${C7_KEY}" } }));
        let remote = json!({ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" } });
        assert_eq!(harness_definition(Harness::Pi, &stdio).unwrap(), stdio, "Pi reads Claude Code's shape");
        assert_eq!(harness_definition(Harness::Droid, &remote).unwrap(), remote, "so does Droid");
        assert_eq!(
            harness_definition(Harness::Amp, &stdio).unwrap(),
            json!({ "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": { "C7_KEY": "${C7_KEY}" } }),
            "Amp's has no type"
        );
        assert_eq!(harness_definition(Harness::Amp, &remote).unwrap(), json!({ "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" } }));
        assert_eq!(
            harness_definition(Harness::OpenCode, &stdio).unwrap(),
            json!({ "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"], "environment": { "C7_KEY": "{env:C7_KEY}" } })
        );
        assert_eq!(
            harness_definition(Harness::OpenCode, &remote).unwrap(),
            json!({ "type": "remote", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer {env:LINEAR_TOKEN}" } })
        );
        assert_eq!(opencode_references("a ${B} ${not valid} ${C"), "a {env:B} ${not valid} ${C");

        // What only Claude Code reads doesn't go across.
        let helper = json!({ "type": "http", "url": "https://x.example/mcp", "headersHelper": "~/bin/headers" });
        assert_eq!(harness_definition(Harness::Amp, &helper).unwrap_err(), "Amp has no headersHelper, so Arbor can't set it up there");
        assert_eq!(harness_definition(Harness::OpenCode, &json!({ "type": "ws", "url": "wss://x.example" })).unwrap_err(), "OpenCode can't reach a server over ws");
        assert_eq!(
            harness_definition(Harness::Pi, &json!({ "type": "http", "url": "https://${HOST:-x.example}/mcp" })).unwrap_err(),
            "Pi doesn't fill in ${VAR:-default}. Use ${VAR} alone."
        );
        assert_eq!(
            harness_definition(Harness::Droid, &json!({ "type": "stdio", "command": "x", "args": ["--key=${KEY}"] })).unwrap_err(),
            "Droid doesn't fill in ${VAR} in args. Pass it in env instead."
        );
        assert!(harness_definition(Harness::Pi, &json!({ "type": "stdio", "command": "x", "args": ["--key=${KEY}"] })).is_ok());
        assert!(harness_definition(Harness::PrimeAgent, &stdio).is_err());

        let read = registry(json!({ "version": 1, "servers": {
            "context7": { "claude": { "command": "npx" }, "agents": ["pi", "opencode", "pi"] },
            "helper": { "claude": helper, "agents": ["amp"] },
            "own": { "claude": { "command": "npx" }, "agents": ["droid"], "machines": { "mac": { "claude": { "command": "x", "args": ["${KEY}"] } } } },
            "prime": { "claude": { "command": "npx" }, "agents": ["prime-agent"] },
            "bad": { "claude": { "command": "npx" }, "agents": "pi" }
        } }));
        assert_eq!(read.server("context7").unwrap().agents, [Harness::Pi, Harness::OpenCode]);
        assert!(read.server("context7").unwrap().problems.is_empty());
        assert_eq!(read.server("helper").unwrap().problems, ["claude: Amp has no headersHelper, so Arbor can't set it up there"]);
        assert_eq!(read.server("own").unwrap().problems, ["machines.mac.claude: Droid doesn't fill in ${VAR} in args. Pass it in env instead."], "a machine's own is checked too");
        assert_eq!(read.server("prime").unwrap().problems, ["agents: Arbor doesn't set up MCP servers for prime-agent. It does for pi, droid, amp, opencode."]);
        assert_eq!(read.server("bad").unwrap().problems, ["agents should list agents by id, like \"pi\" or \"opencode\""]);
    }

    fn harness_machine() -> MachineSetup {
        MachineSetup::with_homes(&[(HomeAgent::Claude, "~/.claude")])
            .with_home_dir("/Users/casey")
            .with_harness_home(Harness::Pi, "~/.pi/agent")
            .with_harness_home(Harness::OpenCode, "~/.config/opencode")
            .with_harness_home(Harness::PrimeAgent, "~/.prime/agent")
            // As Arbor writes it for Pi.
            .with_harness_mcp("~/.pi/agent", "context7", &json!({ "type": "stdio", "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }))
            .with_harness_mcp("~/.pi/agent", "mine", &json!({ "command": "x" }))
            .with_harness_mcp("~/.config/opencode", "linear", &json!({ "type": "remote", "url": "https://old.example/mcp" }))
            .with_harness_mcp("~/.config/opencode", "gone", &json!({ "type": "local", "command": ["gone"] }))
            .with_harness_mcp("~/.prime/agent", "context7", &json!({ "command": "npx" }))
    }

    fn harness_file() -> Value {
        json!({ "version": 1, "servers": {
            "claudeonly": { "claude": { "command": "npx", "args": ["claude-only"] } },
            "context7": { "claude": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }, "agents": ["pi", "opencode"] },
            "gone": { "claude": null, "agents": ["opencode"] },
            "linear": { "claude": { "type": "http", "url": "https://mcp.linear.app/mcp" }, "agents": ["opencode"] },
            "mine": { "claude": { "command": "x" } }
        } })
    }

    #[test]
    fn other_agents_homes_have_only_what_the_repo_sends_them() {
        let cells = machine_cells(&registry(harness_file()), "mac", &harness_machine());
        let theirs: Vec<_> = states(&cells).into_iter().filter(|(home, ..)| *home != "~/.claude").collect();
        assert_eq!(
            theirs,
            [
                ("~/.pi/agent", "context7", RegistryState::Same, None),
                ("~/.config/opencode", "context7", RegistryState::Add, None),
                ("~/.config/opencode", "gone", RegistryState::Extra, None),
                ("~/.config/opencode", "linear", RegistryState::Update, None),
            ],
            "Pi's own mine isn't the repo's to take out, though the repo has one for Claude Code; Prime Agent isn't changed"
        );

        // Kept off a machine, it's taken out of the agents it's sent to there.
        let mut off = harness_file();
        off["servers"]["context7"]["machines"] = json!({ "mac": null });
        let cells = machine_cells(&registry(off), "mac", &harness_machine());
        assert!(cells.iter().any(|cell| cell.home == "~/.pi/agent" && cell.name == "context7" && cell.state == RegistryState::Extra));

        let change = |home: &str, name: &str, action: McpAction| McpChange { home: home.into(), name: name.into(), action };
        let registry = registry(harness_file());
        let planned = plan(
            &registry,
            "mac",
            &harness_machine(),
            vec![
                change("~/.config/opencode", "context7", McpAction::Add),
                change("~/.config/opencode", "linear", McpAction::Update),
                change("~/.config/opencode", "gone", McpAction::Remove),
            ],
        )
        .unwrap();
        assert!(planned.iter().all(|change| change.harness == Some(Harness::OpenCode) && change.agent == HomeAgent::Shared && change.rel == ".config/opencode"));
        assert_eq!(planned[0].definition, Some(json!({ "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"] })));
        assert_eq!((planned[0].seen.is_none(), planned[1].seen.is_some()), (true, true));
        let refused = |changes: Vec<McpChange>| plan(&registry, "mac", &harness_machine(), changes).unwrap_err();
        assert_eq!(refused(vec![change("~/.pi/agent", "mine", McpAction::Remove)]), "Arbor can't remove mine in ~/.pi/agent as it is");
        assert_eq!(refused(vec![change("~/.prime/agent", "context7", McpAction::Update)]), "Arbor can't update context7 in ~/.prime/agent as it is");

        // Written into the file as it was read, keeping the rest of it.
        let files = harness_files(&planned);
        assert_eq!(files, [HarnessFile { harness: Harness::OpenCode, rel: ".config/opencode".into(), file: "opencode.json", key: "mcp" }]);
        assert_eq!(files[0].shown(), "~/.config/opencode/opencode.json");
        let as_scanned = json!({
            "$schema": "https://opencode.ai/config.json",
            "theme": "system",
            "mcp": { "linear": { "type": "remote", "url": "https://old.example/mcp" }, "gone": { "type": "local", "command": ["gone"] }, "keep": { "type": "local", "command": ["k"] } }
        });
        let read = BTreeMap::from([(0, as_scanned.to_string().into_bytes())]);
        let (fresh, writes, left) = harness_writes(plan(&registry, "mac", &harness_machine(), vec![
            change("~/.config/opencode", "context7", McpAction::Add),
            change("~/.config/opencode", "linear", McpAction::Update),
            change("~/.config/opencode", "gone", McpAction::Remove),
        ]).unwrap(), &files, &read, "/Users/casey");
        assert!(left.is_empty(), "{left:?}");
        assert_eq!(fresh.len(), 3);
        let written: Value = serde_json::from_str(&writes[0].content).unwrap();
        assert_eq!(
            written,
            json!({
                "$schema": "https://opencode.ai/config.json",
                "theme": "system",
                "mcp": {
                    "context7": { "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"] },
                    "keep": { "type": "local", "command": ["k"] },
                    "linear": { "type": "remote", "url": "https://mcp.linear.app/mcp" }
                }
            })
        );
        assert_eq!(writes[0].before, cksum(&read[&0]));
        let done = harness_results("E\t0\tok\nK\t20260926T010203Z-00cc\n", &fresh, &files, &writes);
        assert!(done.iter().all(|result| result.outcome == McpOutcome::Done && result.backup.as_deref() == Some("20260926T010203Z-00cc")), "{done:?}");
        let late = harness_results("E\t0\tchanged\n", &fresh, &files, &writes);
        assert_eq!(late[0].message, "~/.config/opencode/opencode.json changed after Arbor read it, so nothing in it was changed. Scan and try again.");

        // A server changed there since the scan is left alone, and the rest still go in.
        let mut since = as_scanned.clone();
        since["mcp"]["linear"]["url"] = json!("https://mine.example/mcp");
        let read = BTreeMap::from([(0, since.to_string().into_bytes())]);
        let (fresh, writes, left) = harness_writes(planned, &files, &read, "/Users/casey");
        assert_eq!(fresh.iter().map(|change| change.name.as_str()).collect::<Vec<_>>(), ["context7", "gone"]);
        assert_eq!(left.iter().map(|result| (result.name.as_str(), result.outcome)).collect::<Vec<_>>(), [("linear", McpOutcome::Changed)]);
        assert_eq!(serde_json::from_str::<Value>(&writes[0].content).unwrap()["mcp"]["linear"]["url"], "https://mine.example/mcp");

        // A file with comments isn't JSON, so nothing in it is changed.
        let commented = BTreeMap::from([(0, b"{\n  // mine\n  \"mcp\": {}\n}\n".to_vec())]);
        let planned = plan(&registry, "mac", &harness_machine(), vec![change("~/.config/opencode", "context7", McpAction::Add)]).unwrap();
        let (fresh, writes, left) = harness_writes(planned, &files, &commented, "/Users/casey");
        assert!(fresh.is_empty() && writes.is_empty());
        assert_eq!((left[0].outcome, left[0].message.as_str()), (McpOutcome::Failed, "~/.config/opencode/opencode.json isn't JSON Arbor can read, so Arbor left it alone"));
    }

    #[cfg(unix)]
    mod scripts {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_home(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let home = std::env::temp_dir().join(format!("arbor-mcp-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&home).unwrap();
            home
        }

        /// A stand-in for an agent in ~/.local/bin, which comes first on the scripts' PATH, so the
        /// real one is never reached.
        fn fake(home: &Path, agent: &str, body: &str) {
            let path = home.join(".local/bin").join(agent);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn run(shell: &str, home: &Path, script: &str) -> std::process::Output {
            let mut command = tokio::process::Command::new(shell);
            command
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin")
                .env("CLAUDE_CONFIG_DIR", "/somewhere/else")
                .env("CODEX_HOME", "/somewhere/else")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            tokio::runtime::Runtime::new().unwrap().block_on(run_script(command, script, Duration::from_secs(20))).unwrap()
        }

        // Answers --help as a current Claude Code does, notes each other call (where it ran, the
        // home it was given and its words), and fails to add `flaky`.
        const CLAUDE: &str = r#"case "$*" in
  "mcp --help") printf 'Commands:\n  add-json [options] <name> <json>  Add a server\n  remove [options] <name>  Remove a server\n'; exit 0 ;;
  "mcp add-json --help") printf 'Options:\n  -s, --scope <scope>  Where\n'; exit 0 ;;
esac
printf '%s|%s|%s\n' "$PWD" "${CLAUDE_CONFIG_DIR:-}" "$*" >> "$HOME/calls"
case "$*" in
  *"add-json --scope user flaky"*) echo 'Error: Invalid configuration' >&2; exit 1 ;;
  *add-json*) echo "Added MCP server to user config"; exit 0 ;;
  *remove*) echo "Removed MCP server from user config"; exit 0 ;;
esac"#;

        // Shows a server only when config.toml doesn't say `broken`.
        const CODEX: &str = r#"case "$*" in
  "mcp --help") printf 'Commands:\n  list  List servers\n  get   Show a server\n'; exit 0 ;;
esac
printf '%s|%s\n' "${CODEX_HOME:-}" "$*" >> "$HOME/calls"
if grep -q broken "$CODEX_HOME/config.toml" 2>/dev/null; then echo 'Error loading config.toml' >&2; exit 1; fi
exit 0"#;

        fn planned(agent: HomeAgent, home: &str, name: &str, action: McpAction, definition: Option<Value>) -> Planned {
            Planned { home: home.into(), agent, harness: None, rel: home_place(home).unwrap().into(), name: name.into(), action, definition, seen: None }
        }

        #[test]
        fn claude_code_changes_run_through_its_own_command_in_each_home() {
            for shell in shells() {
                let home = temp_home(&format!("claude-{shell}"));
                fake(&home, "claude", CLAUDE);
                let context7 = json!({ "type": "stdio", "command": "npx", "args": ["-y", "it's"] });
                let planned = vec![
                    planned(HomeAgent::Claude, "~/.claude", "context7", McpAction::Add, Some(context7.clone())),
                    planned(HomeAgent::Claude, "~/.agent-app/homes/claude-proxy", "linear", McpAction::Update, Some(json!({ "type": "http", "url": "https://mcp.linear.app/mcp" }))),
                    planned(HomeAgent::Claude, "~/.claude", "playwright", McpAction::Remove, None),
                    planned(HomeAgent::Claude, "~/.claude", "flaky", McpAction::Update, Some(json!({ "type": "stdio", "command": "x" }))),
                ];
                let output = run(shell, &home, &apply_script(&new_stamp(), &planned, &[]));
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let results = parse_results(&String::from_utf8_lossy(&output.stdout), &planned, &[]);
                let outcomes: Vec<(&str, McpOutcome, &str)> = results.iter().map(|result| (result.name.as_str(), result.outcome, result.message.as_str())).collect();
                assert_eq!(
                    outcomes,
                    [
                        ("context7", McpOutcome::Done, "Added MCP server to user config"),
                        ("linear", McpOutcome::Done, "Added MCP server to user config"),
                        ("playwright", McpOutcome::Done, "Removed MCP server from user config"),
                        ("flaky", McpOutcome::Removed, "Error: Invalid configuration"),
                    ],
                    "{shell}"
                );
                let proxy = home.join(".agent-app/homes/claude-proxy").display().to_string();
                let calls = fs::read_to_string(home.join("calls")).unwrap();
                assert_eq!(
                    calls.lines().collect::<Vec<_>>(),
                    [
                        format!("/||mcp add-json --scope user context7 {}", context7),
                        format!("/|{proxy}|mcp remove --scope user linear"),
                        format!("/|{proxy}|mcp add-json --scope user linear {{\"type\":\"http\",\"url\":\"https://mcp.linear.app/mcp\"}}"),
                        "/||mcp remove --scope user playwright".to_string(),
                        "/||mcp remove --scope user flaky".to_string(),
                        "/||mcp add-json --scope user flaky {\"command\":\"x\",\"type\":\"stdio\"}".to_string(),
                    ],
                    "{shell}: ~/.claude is Claude Code's own, so it's given no other"
                );

                // A ~/.claude that keeps its own .claude.json is given to Claude Code as such, as the scan reads it there.
                fs::remove_file(home.join("calls")).unwrap();
                fs::create_dir_all(home.join(".claude")).unwrap();
                fs::write(home.join(".claude/.claude.json"), "{}").unwrap();
                let output = run(shell, &home, &apply_script(&new_stamp(), &planned[2..3], &[]));
                assert!(output.status.success());
                assert_eq!(fs::read_to_string(home.join("calls")).unwrap(), format!("/|{}|mcp remove --scope user playwright\n", home.join(".claude").display()));
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn a_claude_code_without_the_commands_is_never_given_them() {
            for shell in shells() {
                let home = temp_home(&format!("old-{shell}"));
                fake(&home, "claude", r#"printf '%s\n' "$*" >> "$HOME/calls"; printf 'Usage: claude [options] [prompt]\n'"#);
                let planned = vec![planned(HomeAgent::Claude, "~/.claude", "x", McpAction::Remove, None)];
                let output = run(shell, &home, &apply_script(&new_stamp(), &planned, &[]));
                assert_eq!(output.status.code(), Some(2), "{shell}");
                assert_eq!(failure_detail(&output), "This version of Claude Code can't change MCP servers for Arbor. Update it first.");
                assert!(fs::read_to_string(home.join("calls")).unwrap().lines().all(|line| line.ends_with("--help")));
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn another_agents_file_is_read_and_written_only_while_it_is_as_read() {
            for shell in shells() {
                let home = temp_home(&format!("harness-{shell}"));
                let dir = home.join(".config/opencode");
                fs::create_dir_all(&dir).unwrap();
                // Pi's home is there, without its file.
                fs::create_dir_all(home.join(".pi/agent")).unwrap();
                let before = "{\n  \"theme\": \"system\",\n  \"mcp\": {}\n}\n";
                fs::write(dir.join("opencode.json"), before).unwrap();
                let files = vec![
                    HarnessFile { harness: Harness::OpenCode, rel: ".config/opencode".into(), file: "opencode.json", key: "mcp" },
                    HarnessFile { harness: Harness::Pi, rel: ".pi/agent".into(), file: "mcp.json", key: "mcpServers" },
                ];
                let output = run(shell, &home, &harness_read_script(&files));
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let read = read_blocks(&String::from_utf8_lossy(&output.stdout)).unwrap();
                assert_eq!((read.get(&0).map(Vec::as_slice), read.get(&1)), (Some(before.as_bytes()), None), "{shell}: Pi has no file yet");

                let context7 = json!({ "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"] });
                let add = |harness: Harness, home: &str| Planned {
                    home: home.into(),
                    agent: HomeAgent::Shared,
                    harness: Some(harness),
                    rel: home_place(home).unwrap().into(),
                    name: "context7".into(),
                    action: McpAction::Add,
                    definition: Some(context7.clone()),
                    seen: None,
                };
                let planned = vec![add(Harness::OpenCode, "~/.config/opencode"), add(Harness::Pi, "~/.pi/agent")];
                let (fresh, writes, left) = harness_writes(planned, &files, &read, "/Users/casey");
                assert!(left.is_empty());
                let output = run(shell, &home, &harness_apply_script("20260926T010203Z-00cc", &files, &writes));
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let results = harness_results(&String::from_utf8_lossy(&output.stdout), &fresh, &files, &writes);
                assert!(results.iter().all(|result| result.outcome == McpOutcome::Done), "{shell}: {results:?}");
                let written: Value = serde_json::from_str(&fs::read_to_string(dir.join("opencode.json")).unwrap()).unwrap();
                assert_eq!((written["theme"].clone(), written["mcp"]["context7"].clone()), (json!("system"), context7.clone()), "{shell}");
                let pi: Value = serde_json::from_str(&fs::read_to_string(home.join(".pi/agent/mcp.json")).unwrap()).unwrap();
                assert_eq!(pi, json!({ "mcpServers": { "context7": context7 } }), "{shell}");
                assert_eq!(fs::read_to_string(home.join(".arbor/setup-backups/20260926T010203Z-00cc/edits/0")).unwrap(), before, "{shell}: the copy before is kept");

                // Changed after Arbor read it: left alone.
                let now = fs::read_to_string(dir.join("opencode.json")).unwrap();
                let output = run(shell, &home, &harness_apply_script("20260926T010204Z-00dd", &files, &writes[..1]));
                let results = harness_results(&String::from_utf8_lossy(&output.stdout), &fresh[..1], &files, &writes[..1]);
                assert_eq!(results[0].outcome, McpOutcome::Changed, "{shell}");
                assert_eq!(fs::read_to_string(dir.join("opencode.json")).unwrap(), now, "{shell}");
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn a_codex_config_is_written_only_while_it_is_as_read_and_put_back_if_codex_cant_read_it() {
            for shell in shells() {
                codex_writes_in(shell);
            }
        }

        fn codex_writes_in(shell: &str) {
            let home = temp_home(&format!("codex-{shell}"));
            fake(&home, "codex", CODEX);
            let codex = home.join(".codex");
            // A second home kept outside the home folder, named whole.
            let outside = temp_home(&format!("codex-{shell}-srv"));
            let proxy = outside.join("agents/codex");
            let proxy_home = proxy.display().to_string();
            let other = home.join(".codex-other");
            for dir in [&codex, &proxy, &other] {
                fs::create_dir_all(dir).unwrap();
            }
            let before = "model = \"gpt-5.5\"\n";
            fs::write(codex.join("config.toml"), before).unwrap();
            fs::set_permissions(codex.join("config.toml"), fs::Permissions::from_mode(0o640)).unwrap();
            fs::write(other.join("config.toml"), before).unwrap();

            let context7 = json!({ "command": "npx", "args": ["-y", "@upstash/context7-mcp"] });
            let planned = vec![
                planned(HomeAgent::Codex, "~/.codex", "context7", McpAction::Add, Some(context7.clone())),
                planned(HomeAgent::Codex, &proxy_home, "context7", McpAction::Add, Some(context7.clone())),
                planned(HomeAgent::Codex, "~/.codex-other", "context7", McpAction::Add, Some(json!({ "command": "broken" }))),
            ];
            let homes = vec![
                (HomeAgent::Codex, ".codex".to_string()),
                (HomeAgent::Codex, proxy_home.clone()),
                (HomeAgent::Codex, ".codex-other".to_string()),
            ];
            let mut files = BTreeMap::new();
            files.insert(0, before.as_bytes().to_vec());
            files.insert(2, before.as_bytes().to_vec());
            let mut writes = codex_writes(&planned, &files, &homes).unwrap();
            assert_eq!(writes[1].before, "-", "the proxy home has no config.toml yet");
            assert_eq!(writes[0].check.as_deref(), Some("context7"));
            // Something changes ~/.codex's config.toml after Arbor read it.
            writes[0].before = cksum(b"model = \"older\"\n");
            let output = run(shell, &home, &apply_script("20260926T010203Z-00aa", &planned, &writes));
            assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
            let results = parse_results(&String::from_utf8_lossy(&output.stdout), &planned, &writes);
            let outcomes: Vec<McpOutcome> = results.iter().map(|result| result.outcome).collect();
            assert_eq!(outcomes, [McpOutcome::Changed, McpOutcome::Done, McpOutcome::Failed], "{shell}");
            assert_eq!(fs::read_to_string(codex.join("config.toml")).unwrap(), before, "{shell}: changed since, so left alone");
            let written = fs::read_to_string(proxy.join("config.toml")).unwrap();
            assert_eq!(file_servers(HomeAgent::Codex, Some(written.as_bytes())).unwrap()["context7"], context7);
            assert_eq!(fs::metadata(proxy.join("config.toml")).unwrap().permissions().mode() & 0o777, 0o600, "{shell}: a new config.toml is private");
            assert_eq!(fs::read_to_string(other.join("config.toml")).unwrap(), before, "{shell}: Codex couldn't read it, so it went back");
            // Only the file that stayed changed is in the list of changes.
            let manifest = fs::read_to_string(home.join(".arbor/setup-backups/20260926T010203Z-00aa/manifest")).unwrap();
            let edited: Vec<&str> = manifest.lines().filter_map(|line| line.strip_prefix("E\t")).collect();
            assert_eq!(edited.len(), 1, "{shell}: {manifest}");
            assert!(edited[0].starts_with(&format!("1\t{}\t-\t", proxy.join("config.toml").display())), "{shell}: {manifest}");
            let calls = fs::read_to_string(home.join("calls")).unwrap();
            assert_eq!(
                calls.lines().collect::<Vec<_>>(),
                [format!("{}|mcp get context7", proxy.display()), format!("{}|mcp get context7", other.display())],
                "{shell}"
            );

            // Written while it's as read, keeping its mode and the copy before.
            writes[0].before = cksum(before.as_bytes());
            let output = run(shell, &home, &apply_script("20260926T010204Z-00bb", &planned[..1], &writes[..1]));
            assert!(output.status.success());
            assert_eq!(parse_results(&String::from_utf8_lossy(&output.stdout), &planned[..1], &writes[..1])[0].outcome, McpOutcome::Done);
            assert_eq!(fs::read_to_string(codex.join("config.toml")).unwrap(), writes[0].content);
            assert_eq!(fs::read_to_string(home.join(".arbor/setup-backups/20260926T010204Z-00bb/edits/0")).unwrap(), before);
            assert_eq!(fs::metadata(codex.join("config.toml")).unwrap().permissions().mode() & 0o777, 0o640);
            let _ = fs::remove_dir_all(&home);
            let _ = fs::remove_dir_all(&outside);
        }

        #[test]
        fn a_linked_config_is_written_where_it_leads() {
            for shell in shells() {
                let home = temp_home(&format!("linked-{shell}"));
                fake(&home, "codex", CODEX);
                fs::create_dir_all(home.join("dotfiles")).unwrap();
                fs::create_dir_all(home.join(".codex")).unwrap();
                let before = "model = \"gpt-5.5\"\n";
                fs::write(home.join("dotfiles/codex.toml"), before).unwrap();
                std::os::unix::fs::symlink(home.join("dotfiles/codex.toml"), home.join(".codex/config.toml")).unwrap();
                let planned = vec![planned(HomeAgent::Codex, "~/.codex", "fs", McpAction::Add, Some(json!({ "command": "npx" })))];
                let homes = vec![(HomeAgent::Codex, ".codex".to_string())];
                let files = BTreeMap::from([(0, before.as_bytes().to_vec())]);
                let writes = codex_writes(&planned, &files, &homes).unwrap();
                let output = run(shell, &home, &apply_script(&new_stamp(), &planned, &writes));
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                assert_eq!(parse_results(&String::from_utf8_lossy(&output.stdout), &planned, &writes)[0].outcome, McpOutcome::Done, "{shell}");
                assert!(fs::symlink_metadata(home.join(".codex/config.toml")).unwrap().file_type().is_symlink(), "{shell}: the link stays");
                assert_eq!(fs::read_to_string(home.join("dotfiles/codex.toml")).unwrap(), writes[0].content);
                let _ = fs::remove_dir_all(&home);
            }
        }

        #[test]
        fn a_homes_servers_are_read_on_the_machine() {
            for shell in shells() {
                let home = temp_home(&format!("read-{shell}"));
                fs::write(home.join(".claude.json"), r#"{"numStartups": 3, "history": ["SECRET prompt"], "mcpServers": {"linear": {"type": "http", "url": "https://mcp.linear.app/mcp"}}, "projects": {}}"#).unwrap();
                fs::create_dir_all(home.join(".claude")).unwrap();
                fs::create_dir_all(home.join(".codex")).unwrap();
                fs::write(home.join(".codex/config.toml"), "[mcp_servers.fs]\ncommand = \"npx\"\n").unwrap();
                let homes = [(HomeAgent::Claude, ".claude".to_string()), (HomeAgent::Codex, ".codex".to_string()), (HomeAgent::Codex, ".missing".to_string())];
                let mut script = format!("set -u\nexport LC_ALL=C\n{HELPERS}{EMIT_FUNCTIONS}");
                for (index, (agent, rel)) in homes.iter().enumerate() {
                    let dir = format!("\"$HOME\"/{}", shell_quote(rel));
                    script.push_str(&format!("printf 'N\\t{index}\\n'\n"));
                    match agent {
                        HomeAgent::Claude => script.push_str(&format!("claude_mcp {dir}\n")),
                        _ => script.push_str(&format!("emit_data config {dir}/config.toml\n")),
                    }
                }
                script.push_str("printf 'E\\n'\n");
                let output = run(shell, &home, &script);
                assert!(output.status.success(), "{shell}: {}", String::from_utf8_lossy(&output.stderr));
                let stdout = String::from_utf8_lossy(&output.stdout);
                let files = read_blocks(&stdout).unwrap();
                assert!(!String::from_utf8_lossy(&files[&0]).contains("SECRET"), "only mcpServers leaves the machine");
                assert_eq!(file_servers(HomeAgent::Claude, files.get(&0).map(Vec::as_slice)).unwrap()["linear"]["url"], "https://mcp.linear.app/mcp");
                assert_eq!(file_servers(HomeAgent::Codex, files.get(&1).map(Vec::as_slice)).unwrap()["fs"]["command"], "npx");
                assert!(!files.contains_key(&2));
                assert!(file_servers(HomeAgent::Codex, None).unwrap().is_empty());
                assert!(read_blocks("N\t0\n").is_err(), "a read that stopped short");
                let _ = fs::remove_dir_all(&home);
            }
        }
    }

    mod repo {
        use super::*;

        const IDENTITY: [&str; 4] = ["-c", "user.name=Arbor Test", "-c", "user.email=arbor@example.com"];

        fn temp_repo(name: &str) -> PathBuf {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let folder = std::env::temp_dir().join(format!("arbor-mcp-repo-{name}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&folder).unwrap();
            let status = std::process::Command::new("git").arg("-C").arg(&folder).args(["init", "--quiet"]).status().unwrap();
            assert!(status.success());
            folder
        }

        fn block<T>(future: impl std::future::Future<Output = T>) -> T {
            tokio::runtime::Runtime::new().unwrap().block_on(future)
        }

        fn log(folder: &Path) -> Vec<String> {
            let output = std::process::Command::new("git").arg("-C").arg(folder).args(["log", "--format=%s"]).output().unwrap();
            String::from_utf8_lossy(&output.stdout).lines().map(str::to_string).collect()
        }

        #[test]
        fn servers_are_taken_into_the_repo_as_a_commit_of_the_file_alone() {
            let folder = temp_repo("take");
            let (commit, found, _, read) = block(load_registry(&folder, None)).unwrap();
            assert_eq!((commit, found, read), (None, false, Registry::default()), "nothing committed yet");

            let linear = json!({ "type": "http", "url": "https://mcp.linear.app/mcp" });
            block(record_server(&folder, "linear", HomeAgent::Claude, "mac", "~/.claude", false, linear.clone(), &IDENTITY)).unwrap();
            let codex = json!({ "url": "https://mcp.linear.app/mcp" });
            block(record_server(&folder, "linear", HomeAgent::Codex, "mac", "~/.codex", false, codex.clone(), &IDENTITY)).unwrap();
            let sse = json!({ "type": "sse", "url": "https://mcp.linear.app/sse" });
            block(record_server(&folder, "linear", HomeAgent::Claude, "cedar", "~/.claude", true, sse.clone(), &IDENTITY)).unwrap();
            // Taking what the repo has already changes nothing.
            block(record_server(&folder, "linear", HomeAgent::Claude, "mac", "~/.claude", false, linear.clone(), &IDENTITY)).unwrap();
            assert_eq!(log(&folder), ["Take cedar's own MCP server linear", "Take MCP server linear from mac", "Take MCP server linear from mac"]);

            let (commit, found, uncommitted, read) = block(load_registry(&folder, None)).unwrap();
            assert!(commit.is_some() && found && !uncommitted);
            let server = read.server("linear").unwrap();
            assert!(server.problems.is_empty(), "{:?}", server.problems);
            assert_eq!(server.claude.as_ref(), Some(&linear));
            assert_eq!(server.codex.as_ref(), Some(&codex));
            assert_eq!(server.machines["cedar"], [Wanted::Own(sse), Wanted::Default]);
            let text = fs::read_to_string(folder.join(MCP_FILE)).unwrap();
            assert!(text.starts_with("{\n  \"servers\": {\n") && text.ends_with("}\n"), "{text}");

            // A machine it was kept off keeps the other agent off; taking the default brings it back.
            fs::write(folder.join(MCP_FILE), serde_json::to_string_pretty(&json!({ "version": 1, "servers": { "fs": { "claude": { "type": "stdio", "command": "a" }, "homes": ["~/.claude"], "machines": { "ci": null } } } })).unwrap()).unwrap();
            assert!(block(record_server(&folder, "fs", HomeAgent::Claude, "ci", "~/.claude", false, json!({ "type": "stdio", "command": "b" }), &IDENTITY)).unwrap_err().contains("aren't committed"));
            let commit = |message: &str| {
                let status = std::process::Command::new("git").arg("-C").arg(&folder).args(IDENTITY).args(["commit", "--quiet", "-am", message]).status().unwrap();
                assert!(status.success());
            };
            commit("By hand");
            block(record_server(&folder, "fs", HomeAgent::Claude, "ci", "~/.agent-app/homes/claude-proxy", false, json!({ "type": "stdio", "command": "b" }), &IDENTITY)).unwrap();
            let file: Value = serde_json::from_str(&fs::read_to_string(folder.join(MCP_FILE)).unwrap()).unwrap();
            assert_eq!(file["servers"]["fs"]["machines"], json!({ "ci": { "codex": null } }));
            assert_eq!(file["servers"]["fs"]["homes"], json!(["~/.claude", "~/.agent-app/homes/claude-proxy"]));
            assert_eq!(file["servers"]["fs"]["claude"]["command"], "b");

            // Removed from every machine, then put back from the history as it was, secrets' names and all.
            let before: Value = serde_json::from_str(&fs::read_to_string(folder.join(MCP_FILE)).unwrap()).unwrap();
            let mut file = before.clone();
            set_wanted(&mut file, "fs", None, McpWanted::Removed).unwrap();
            fs::write(folder.join(MCP_FILE), serde_json::to_string_pretty(&file).unwrap()).unwrap();
            commit("Remove MCP server fs from all machines");
            block(put_back_server(&folder, "fs", &IDENTITY)).unwrap();
            let after: Value = serde_json::from_str(&fs::read_to_string(folder.join(MCP_FILE)).unwrap()).unwrap();
            assert_eq!(after["servers"]["fs"], before["servers"]["fs"]);
            assert_eq!(log(&folder).first().map(String::as_str), Some("Put back MCP server fs"));
            // One that's defined already is left alone; one the history never defined can't come back.
            block(put_back_server(&folder, "fs", &IDENTITY)).unwrap();
            assert_eq!(log(&folder).first().map(String::as_str), Some("Put back MCP server fs"));
            assert!(block(put_back_server(&folder, "never", &IDENTITY)).unwrap_err().contains("no definition"));

            fs::write(folder.join(MCP_FILE), "{ not json").unwrap();
            commit("Broken");
            assert!(block(record_server(&folder, "fs", HomeAgent::Claude, "ci", "~/.claude", false, json!({}), &IDENTITY)).unwrap_err().contains("isn't JSON Arbor can read"));
            let (_, found, _, read) = block(load_registry(&folder, None)).unwrap();
            assert!(found && !read.problems.is_empty());
            let _ = fs::remove_dir_all(&folder);
        }
    }
}
