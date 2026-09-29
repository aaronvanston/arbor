use super::*;

const MAX_RELEASES: usize = 30;
const MAX_CORE_RELEASES: usize = 10;
const MAX_CHANGES: usize = 40;
const MAX_CHANGE_CHARS: usize = 300;
const MAX_SUMMARY_CHARS: usize = 500;

/// The notes the local feed's manifest carries for recent Arbor releases. Entries that don't make sense are dropped one
/// at a time, so bad notes never stop an update from being offered.
pub(crate) fn release_notes_from_manifest(value: Option<&serde_json::Value>) -> Vec<ReleaseNotes> {
    let Some(entries) = value.and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let version = entry.get("version")?.as_str()?.trim();
            semver::Version::parse(version.trim_start_matches('v')).ok()?;
            let summary = entry
                .get("summary")
                .and_then(serde_json::Value::as_str)
                .map(|summary| clip(summary, MAX_SUMMARY_CHARS))
                .filter(|summary| !summary.is_empty());
            let changes = entry
                .get("changes")
                .and_then(serde_json::Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(|change| clip(change, MAX_CHANGE_CHARS))
                        .filter(|change| !change.is_empty())
                        .take(MAX_CHANGES)
                        .collect()
                })
                .unwrap_or_default();
            Some(ReleaseNotes { version: version.to_string(), summary, changes })
        })
        .take(MAX_RELEASES)
        .collect()
}

/// The core's release notes from GitHub's releases Atom feed, newest first: each entry's Changelog list as plain text,
/// without merge commits or commit hashes. The feed's HTML stays here; the webview only gets text.
pub(crate) fn release_notes_from_atom(xml: &str) -> Vec<ReleaseNotes> {
    xml.split("<entry>")
        .skip(1)
        .filter_map(|entry| {
            let entry = entry.split_once("</entry>").map_or(entry, |(entry, _)| entry);
            let version = atom_entry_tag(entry)?;
            let content = entry.split_once("<content type=\"html\">")?.1.split_once("</content>")?.0;
            Some(ReleaseNotes { version, summary: None, changes: changelog_items(&decode_html_entities(content)) })
        })
        .take(MAX_CORE_RELEASES)
        .collect()
}

fn changelog_items(html: &str) -> Vec<String> {
    let Some(section) = section_after_heading(html, "changelog") else {
        return Vec::new();
    };
    section
        .split("<li>")
        .skip(1)
        .filter_map(|item| {
            let item = item.split_once("</li>").map_or(item, |(item, _)| item);
            let text = clip(&decode_html_entities(&strip_tags(item)), usize::MAX);
            let text = without_commit_hash(&text);
            (!text.is_empty() && !is_merge_commit(text)).then(|| clip(text, MAX_CHANGE_CHARS))
        })
        .take(MAX_CHANGES)
        .collect()
}

/// The HTML between the `<h2>` titled `title` (any case) and the next `<h2>`.
fn section_after_heading<'a>(html: &'a str, title: &str) -> Option<&'a str> {
    let mut rest = html;
    while let Some(start) = rest.find("<h2") {
        let after_open = &rest[start..];
        let heading_end = after_open.find("</h2>")?;
        let heading = &after_open[..heading_end];
        let body = &after_open[heading_end + "</h2>".len()..];
        if strip_tags(heading).trim().eq_ignore_ascii_case(title) {
            return Some(body.find("<h2").map_or(body, |next| &body[..next]));
        }
        rest = body;
    }
    None
}

fn strip_tags(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for character in html.chars() {
        match character {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    text
}

fn decode_html_entities(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let candidate = &rest[start..];
        let entity = candidate
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| decode_entity(&candidate[1..end]).map(|character| (character, end)));
        match entity {
            Some((character, end)) => {
                decoded.push(character);
                rest = &candidate[end + 1..];
            }
            None => {
                decoded.push('&');
                rest = &candidate[1..];
            }
        }
    }
    decoded.push_str(rest);
    decoded
}

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let code = match name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => name.strip_prefix('#')?.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// Drops the `(984aee8)` a changelog line ends with.
fn without_commit_hash(text: &str) -> &str {
    let Some(open) = text.strip_suffix(')').and_then(|rest| rest.rfind('(')) else {
        return text;
    };
    let hash = &text[open + 1..text.len() - 1];
    if (7..=40).contains(&hash.len()) && hash.chars().all(|character| character.is_ascii_hexdigit()) {
        text[..open].trim_end()
    } else {
        text
    }
}

fn is_merge_commit(text: &str) -> bool {
    ["Merge pull request", "Merge branch", "Merge commit", "Merge remote-tracking branch", "Merge tag"]
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

/// Whitespace collapsed to single spaces, cut to `max_chars` with an ellipsis.
fn clip(text: &str, max_chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let mut clipped = flat.chars().take(max_chars.saturating_sub(1)).collect::<String>();
    clipped.truncate(clipped.trim_end().len());
    clipped.push('…');
    clipped
}
