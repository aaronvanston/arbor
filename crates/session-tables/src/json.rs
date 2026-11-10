//! Taking fields out of a line. A parser removes each field it gives a column to, so what is left in the map when
//! it's done is exactly what no column holds.

use crate::Detail;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub(crate) type Fields = Map<String, Value>;

/// A string field, removed. A field of another type stays where it is.
pub(crate) fn string(fields: &mut Fields, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(Value::String(_)) => match fields.remove(key) {
            Some(Value::String(text)) => Some(text),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn number(fields: &mut Fields, key: &str) -> Option<u64> {
    let found = fields.get(key)?.as_u64()?;
    fields.remove(key);
    Some(found)
}

pub(crate) fn signed(fields: &mut Fields, key: &str) -> Option<i64> {
    let found = fields.get(key)?.as_i64()?;
    fields.remove(key);
    Some(found)
}

pub(crate) fn boolean(fields: &mut Fields, key: &str) -> Option<bool> {
    let found = fields.get(key)?.as_bool()?;
    fields.remove(key);
    Some(found)
}

pub(crate) fn object(fields: &mut Fields, key: &str) -> Option<Fields> {
    match fields.get(key) {
        Some(Value::Object(_)) => match fields.remove(key) {
            Some(Value::Object(found)) => Some(found),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn array(fields: &mut Fields, key: &str) -> Option<Vec<Value>> {
    match fields.get(key) {
        Some(Value::Array(_)) => match fields.remove(key) {
            Some(Value::Array(found)) => Some(found),
            _ => None,
        },
        _ => None,
    }
}

/// Puts what a parser didn't use of an object back under its key, so it reaches `rest`.
pub(crate) fn put_back(fields: &mut Fields, key: &str, left: Fields) {
    if !left.is_empty() {
        fields.insert(key.to_string(), Value::Object(left));
    }
}

pub(crate) fn chars(text: &str) -> u64 {
    text.chars().count() as u64
}

pub(crate) fn hash(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What tells one line from another, as the start of a hash of `parts`.
pub(crate) fn key(parts: &[&[u8]]) -> crate::LineKey {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    let hash = hasher.finalize();
    std::array::from_fn(|index| hash[index])
}

/// The text of a list of content items: each item's `text`, joined. Items without text stay in the list.
pub(crate) fn texts(items: &mut Vec<Value>) -> Option<String> {
    let mut found: Vec<String> = Vec::new();
    items.retain_mut(|item| match item {
        Value::String(text) => {
            found.push(std::mem::take(text));
            false
        }
        Value::Object(fields) if fields.get("text").is_some_and(Value::is_string) => {
            found.extend(string(fields, "text"));
            false
        }
        _ => true,
    });
    (!found.is_empty()).then(|| found.join("\n"))
}

/// Something large and opaque, as its size and hash.
pub(crate) fn sized(text: &str) -> Value {
    json!({ "bytes": text.len(), "sha256": hash(&[text]) })
}

/// Swaps what is large and opaque for its size and hash, wherever it sits: an image as a content block's
/// `{"type": "base64", "data": …}`, as a tool's own `{"base64": …}` or as a `data:` address, and thinking that was
/// encrypted.
fn shrink(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            let block = fields.get("type").and_then(Value::as_str) == Some("base64");
            let opaque: Vec<String> = fields
                .iter()
                .filter(|(key, value)| {
                    let Value::String(text) = value else { return false };
                    (block && key.as_str() == "data") || matches!(key.as_str(), "base64" | "encrypted_content") || (text.starts_with("data:") && text.get(..120).unwrap_or(text).contains(";base64,"))
                })
                .map(|(key, _)| key.clone())
                .collect();
            for key in opaque {
                if let Some(text) = string(fields, &key) {
                    fields.insert(format!("{key}_size"), sized(&text));
                }
            }
            fields.values_mut().for_each(shrink);
        }
        Value::Array(items) => items.iter_mut().for_each(shrink),
        _ => {}
    }
}

/// The numbers and yes-or-no values of a value, with the shape that holds them, or nothing.
fn numbers_only(value: Value) -> Option<Value> {
    match value {
        Value::Number(_) | Value::Bool(_) => Some(value),
        Value::Object(fields) => {
            let kept: Fields = fields.into_iter().filter_map(|(key, value)| Some((key, numbers_only(value)?))).collect();
            (!kept.is_empty()).then_some(Value::Object(kept))
        }
        Value::Array(items) => {
            let kept: Vec<Value> = items.into_iter().filter_map(numbers_only).collect();
            (!kept.is_empty()).then_some(Value::Array(kept))
        }
        Value::String(_) | Value::Null => None,
    }
}

/// Drops fields that are null: a field with nothing in it says no more than a field that isn't there.
fn drop_nulls(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|_, value| !value.is_null());
            fields.values_mut().for_each(drop_nulls);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_nulls),
        _ => {}
    }
}

/// What's left of a line, as the JSON for its `rest` column.
pub(crate) fn rest(detail: Detail, mut left: Value) -> Option<String> {
    shrink(&mut left);
    drop_nulls(&mut left);
    let left = match detail {
        Detail::Everything => left,
        Detail::Numbers => numbers_only(left)?,
    };
    match &left {
        Value::Object(fields) if fields.is_empty() => None,
        _ => serde_json::to_string(&left).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_field_of_the_wrong_type_is_left_for_rest() {
        let Value::Object(mut fields) = json!({ "a": 1, "b": "two", "c": { "d": true } }) else { unreachable!() };
        assert_eq!(string(&mut fields, "a"), None);
        assert_eq!(number(&mut fields, "b"), None);
        assert_eq!(string(&mut fields, "b").as_deref(), Some("two"));
        assert_eq!(rest(Detail::Everything, Value::Object(fields)).as_deref(), Some(r#"{"a":1,"c":{"d":true}}"#));
    }

    #[test]
    fn an_image_is_left_as_its_size_and_hash() {
        let left = rest(Detail::Everything, json!({ "content": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGVsbG8=" } }] })).unwrap();
        assert!(!left.contains("aGVsbG8="));
        assert!(left.contains(r#""media_type":"image/png""#) && left.contains(r#""bytes":8"#));
        let read = rest(Detail::Everything, json!({ "toolUseResult": { "type": "image", "file": { "base64": "aGVsbG8=", "originalSize": 5 } } })).unwrap();
        assert!(!read.contains("aGVsbG8=") && read.contains("base64_size") && read.contains(r#""originalSize":5"#));
        let pasted = rest(Detail::Everything, json!({ "content": [{ "type": "input_image", "image_url": "data:image/png;base64,aGVsbG8=", "detail": "auto" }, { "type": "encrypted_content", "encrypted_content": "ZW5j" }] })).unwrap();
        assert!(!pasted.contains("aGVsbG8=") && !pasted.contains("ZW5j") && pasted.contains("image_url_size") && pasted.contains(r#""detail":"auto""#));
    }

    #[test]
    fn numbers_detail_keeps_numbers_and_flags_and_drops_every_string() {
        let left = rest(Detail::Numbers, json!({ "durationMs": 12, "note": "hello", "nested": { "ok": true, "name": "x" }, "list": ["a", 3], "none": null }));
        assert_eq!(left.as_deref(), Some(r#"{"durationMs":12,"list":[3],"nested":{"ok":true}}"#));
        assert_eq!(rest(Detail::Numbers, json!({ "note": "hello" })), None);
    }
}
