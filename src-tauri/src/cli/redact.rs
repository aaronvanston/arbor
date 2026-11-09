//! Keeping secrets out of everything the socket sends. The window may see a client key or the management key to show
//! or copy it; a terminal, a script's log or an agent's context is somewhere they'd stay, so every answer and event is
//! walked before it leaves and anything that looks like a secret is replaced.

use serde_json::Value;

/// What a hidden value reads as.
pub(crate) const HIDDEN: &str = "[hidden]";

/// Whether a field's name says it holds a secret. Counts like `inputTokens` are numbers and stay; only text is hidden.
fn secret_field(name: &str) -> bool {
    let name = name.to_ascii_lowercase().replace(['_', '-'], "");
    name.contains("secret")
        || name.contains("password")
        || name.contains("passphrase")
        || name.contains("authorization")
        || name.contains("cookie")
        || name.contains("privatekey")
        || name.ends_with("token")
        || name.ends_with("apikey")
        || name.ends_with("apikeys")
        || name == "key"
        || name == "keys"
        || name == "bearer"
}

/// Text that is a key whatever field it's in: the core's client keys and the providers' own.
fn looks_like_key(text: &str) -> bool {
    let text = text.trim();
    ["sk-", "sk_", "xai-", "AIza", "ghp_", "gho_", "github_pat_", "Bearer "]
        .iter()
        .any(|prefix| text.starts_with(prefix) && text.len() >= prefix.len() + 12)
}

/// The prefixes a key starts with, wherever in a text it sits.
const KEY_STARTS: [&str; 7] = ["sk-", "sk_", "xai-", "AIza", "ghp_", "gho_", "github_pat_"];

/// Text with anything that looks like a key inside it replaced by [`HIDDEN`]: a command an agent ran, or a file it
/// read, can hold one in the middle of a line. Only a prefix followed by a dozen or more of a key's own characters
/// goes, so words that merely start the same way stay.
pub(crate) fn masked(text: &str) -> String {
    let of_key = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        // A key starts a word: `task-` holds `sk-` and is no key.
        let starts_word = out.chars().next_back().is_none_or(|before| !of_key(before));
        let found = KEY_STARTS.iter().find(|start| starts_word && rest.starts_with(**start)).and_then(|start| {
            let run = rest[start.len()..].chars().take_while(|c| of_key(*c)).count();
            (run >= 12).then_some(start.len() + run)
        });
        match found {
            Some(length) => {
                out.push_str(HIDDEN);
                rest = &rest[length..];
            }
            None => {
                let next = rest.chars().next().map_or(1, char::len_utf8);
                out.push_str(&rest[..next]);
                rest = &rest[next..];
            }
        }
    }
    out
}

fn hide_text(value: &mut Value) {
    match value {
        Value::String(text) if !text.is_empty() => *text = HIDDEN.into(),
        Value::Array(items) => items.iter_mut().for_each(hide_text),
        _ => {}
    }
}

/// The value with every secret replaced by [`HIDDEN`].
pub(crate) fn redacted(mut value: Value) -> Value {
    walk(&mut value);
    value
}

fn walk(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (name, field) in fields.iter_mut() {
                if secret_field(name) {
                    hide_text(field);
                }
                walk(field);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(walk),
        Value::String(text) if looks_like_key(text) => *text = HIDDEN.into(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn secrets_go_and_counts_stay() {
        let answer = json!({
            "managementSecretKey": "abc123",
            "apiKeys": ["first-key", "second-key"],
            "clients": [{ "key": "c3a5f1e2", "name": "cam-mbp" }],
            "access_token": "eyJhbGciOi",
            "inputTokens": 1200,
            "totalTokens": 3400,
            "note": "sk-proj-abcdefghijklmnopqrstu",
            "message": "sk-",
        });
        assert_eq!(
            redacted(answer),
            json!({
                "managementSecretKey": HIDDEN,
                "apiKeys": [HIDDEN, HIDDEN],
                "clients": [{ "key": HIDDEN, "name": "cam-mbp" }],
                "access_token": HIDDEN,
                "inputTokens": 1200,
                "totalTokens": 3400,
                "note": HIDDEN,
                "message": "sk-",
            })
        );
    }

    #[test]
    fn a_key_in_the_middle_of_text_is_hidden_and_the_words_around_it_stay() {
        assert_eq!(masked("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu && run"), "export OPENAI_API_KEY=[hidden] && run");
        assert_eq!(masked("curl -H 'Authorization: Bearer ghp_abcdefghijklmnop1234' https://x"), "curl -H 'Authorization: Bearer [hidden]' https://x");
        assert_eq!(masked("two: xai-abcdefghijklmnop, AIzaSyA1234567890abcdef."), "two: [hidden], [hidden].");
        // Words that only start the same way, a prefix inside a word, and a prefix with too little after it.
        for plain in ["a task-list-with-many-parts here", "sk-short", "the disk-usage-report-2026-10", "héllo sk- wörld", ""] {
            assert_eq!(masked(plain), plain);
        }
    }

    #[test]
    fn an_empty_or_missing_secret_stays_as_it_is() {
        assert_eq!(redacted(json!({ "secret": "", "token": null })), json!({ "secret": "", "token": null }));
    }
}
