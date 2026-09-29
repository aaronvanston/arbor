//! The Mac's region, so dates, times and numbers read the way System Settings has them.
//!
//! The web view's `navigator.language` follows the language list rather than the region, so an
//! English (US) language with an Australian region still reports "en-US". The interface text
//! stays English either way; only formatting follows what this returns.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemLocale {
    /// A BCP 47 tag such as "en-AU".
    locale: String,
    /// "h23" when the user wants 24-hour time, otherwise "h12".
    hour_cycle: &'static str,
}

/// Turns a Foundation identifier ("en_AU", "zh-Hans_CN@calendar=chinese") into a BCP 47 tag,
/// dropping the keywords after "@" since the web view only needs the language and region.
/// A region override ("en_US@rg=auzzzz", US English with Australia's formats) replaces the
/// language's own region, since formats are what the tag is for.
fn bcp47_tag(identifier: &str) -> Option<String> {
    let mut parts = identifier.splitn(2, '@');
    let base = parts.next().unwrap_or_default().trim();
    if base.is_empty()
        || !base.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return None;
    }
    match parts.next().and_then(region_override) {
        // The language (and script) is what comes before the region: "en", "zh-Hans".
        Some(region) => Some(format!(
            "{}-{region}",
            base.split('_').next().unwrap_or(base)
        )),
        None => Some(base.replace('_', "-")),
    }
}

/// The region in an `rg` keyword, whose value is a region with a subdivision suffix: "auzzzz"
/// is all of Australia, "001zzzz" the world.
fn region_override(keywords: &str) -> Option<String> {
    let value = keywords
        .split(';')
        .find_map(|keyword| keyword.trim().strip_prefix("rg="))?;
    let length = if value.starts_with(|character: char| character.is_ascii_digit()) {
        3
    } else {
        2
    };
    let region = value.get(..length)?;
    region
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
        .then(|| region.to_ascii_uppercase())
}

/// The hour field of the pattern macOS picks for the "j" skeleton: `H` (0-23) or `k` (1-24)
/// means a 24-hour clock. Quoted text is literal, so it's skipped.
fn hour_cycle(pattern: &str) -> &'static str {
    let mut quoted = false;
    for character in pattern.chars() {
        match character {
            '\'' => quoted = !quoted,
            'H' | 'k' if !quoted => return "h23",
            _ => {}
        }
    }
    "h12"
}

fn read_system_locale() -> Option<SystemLocale> {
    use objc2_foundation::{NSDateFormatter, NSLocale, NSString};

    // currentLocale carries the user's overrides, including the 24-hour time switch.
    let locale = NSLocale::currentLocale();
    let tag = bcp47_tag(&locale.localeIdentifier().to_string())?;
    let pattern = NSDateFormatter::dateFormatFromTemplate_options_locale(
        &NSString::from_str("j"),
        0,
        Some(&locale),
    )
    .map(|pattern| pattern.to_string())
    .unwrap_or_default();
    Some(SystemLocale {
        locale: tag,
        hour_cycle: hour_cycle(&pattern),
    })
}

#[tauri::command]
pub(crate) fn system_locale() -> Option<SystemLocale> {
    read_system_locale()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_foundation_identifiers_into_bcp47_tags() {
        assert_eq!(bcp47_tag("en_AU").as_deref(), Some("en-AU"));
        // An English (US) language in an Australian region formats the Australian way.
        assert_eq!(bcp47_tag("en_US@rg=auzzzz").as_deref(), Some("en-AU"));
        assert_eq!(
            bcp47_tag("en_US@calendar=gregorian;rg=nzzzzz").as_deref(),
            Some("en-NZ")
        );
        assert_eq!(bcp47_tag("en@rg=001zzzz").as_deref(), Some("en-001"));
        assert_eq!(bcp47_tag("en_AU@rg=").as_deref(), Some("en-AU"));
        assert_eq!(
            bcp47_tag("zh-Hans_CN@calendar=chinese").as_deref(),
            Some("zh-Hans-CN")
        );
        assert_eq!(bcp47_tag("en").as_deref(), Some("en"));
        assert_eq!(bcp47_tag(""), None);
        assert_eq!(bcp47_tag("@calendar=gregorian"), None);
        assert_eq!(bcp47_tag("en AU"), None);
    }

    #[test]
    fn reads_the_hour_cycle_from_the_j_pattern() {
        assert_eq!(hour_cycle("h a"), "h12");
        assert_eq!(hour_cycle("HH"), "h23");
        assert_eq!(hour_cycle("H"), "h23");
        assert_eq!(hour_cycle("k"), "h23");
        assert_eq!(hour_cycle("K a"), "h12");
        assert_eq!(hour_cycle("a h'H'"), "h12");
        assert_eq!(hour_cycle(""), "h12");
    }

    #[test]
    fn reads_a_tag_on_this_mac() {
        let locale = read_system_locale().expect("macOS always has a current locale");
        assert!(!locale.locale.is_empty() && !locale.locale.contains('_'));
        assert!(locale.hour_cycle == "h12" || locale.hour_cycle == "h23");
    }
}
