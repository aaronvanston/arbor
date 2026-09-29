use super::*;

// Two entries cut down from https://github.com/router-for-me/CLIProxyAPI/releases.atom, escaping as GitHub sends it.
const CORE_RELEASES_ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1012087571/v7.3.17</id>
    <link rel="alternate" type="text/html" href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.3.17"/>
    <title>v7.3.17</title>
    <content type="html">
&lt;h2&gt;Linux release assets&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;&lt;code&gt;CLIProxyAPI_&amp;lt;version&amp;gt;_linux_&amp;lt;arch&amp;gt;.tar.gz&lt;/code&gt; is the default Linux build.&lt;/li&gt;
&lt;/ul&gt;
&lt;h2&gt;Changelog&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;fix(codex): send the ChatGPT routing hint native Codex sends (&lt;a class=&quot;commit-link&quot; href=&quot;https://github.com/router-for-me/CLIProxyAPI/commit/b97f71da0cf0cadac8b565d02ef9f567e0a52c6e&quot;&gt;&lt;tt&gt;b97f71d&lt;/tt&gt;&lt;/a&gt;)&lt;/li&gt;
&lt;li&gt;Merge pull request #6092 from router-for-me/xai (&lt;a class=&quot;commit-link&quot; href=&quot;https://github.com/router-for-me/CLIProxyAPI/commit/93cccc6b&quot;&gt;&lt;tt&gt;93cccc6&lt;/tt&gt;&lt;/a&gt;)&lt;/li&gt;
&lt;li&gt;fix(claude): align 2.1.280 fingerprint &amp;amp; thinking visibility (#6096) (&lt;a class=&quot;commit-link&quot; href=&quot;https://github.com/router-for-me/CLIProxyAPI/commit/f7c738da&quot;&gt;&lt;tt&gt;f7c738d&lt;/tt&gt;&lt;/a&gt;)&lt;/li&gt;
&lt;/ul&gt;
&lt;h2&gt;What's Changed&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;Enhance XAI response sanitization by &lt;a href=&quot;https://github.com/hkfires&quot;&gt;@hkfires&lt;/a&gt;&lt;/li&gt;
&lt;/ul&gt;
    </content>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.3.16"/>
    <title>v7.3.16</title>
    <content type="html">&lt;h2&gt;Changelog&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;fix(api): immediately close connections on stop (&lt;a href=&quot;x&quot;&gt;&lt;tt&gt;759c57c&lt;/tt&gt;&lt;/a&gt;)&lt;/li&gt;
&lt;/ul&gt;</content>
  </entry>
  <entry>
    <title>v7.3.15</title>
    <content type="html">&lt;p&gt;No changelog section.&lt;/p&gt;</content>
  </entry>
</feed>"#;

#[test]
fn core_release_notes_keep_the_changelog_as_plain_text_without_merges_or_hashes() {
    assert_eq!(
        release_notes_from_atom(CORE_RELEASES_ATOM),
        vec![
            ReleaseNotes {
                version: "v7.3.17".to_string(),
                summary: None,
                changes: vec![
                    "fix(codex): send the ChatGPT routing hint native Codex sends".to_string(),
                    "fix(claude): align 2.1.280 fingerprint & thinking visibility (#6096)".to_string(),
                ],
            },
            ReleaseNotes {
                version: "v7.3.16".to_string(),
                summary: None,
                changes: vec!["fix(api): immediately close connections on stop".to_string()],
            },
            ReleaseNotes { version: "v7.3.15".to_string(), summary: None, changes: Vec::new() },
        ]
    );
    // The first entry's tag still reads the same way it always has.
    assert_eq!(release_tag_from_atom(CORE_RELEASES_ATOM).as_deref(), Some("v7.3.17"));
}

#[test]
fn feed_notes_drop_bad_entries_one_at_a_time_and_are_capped() {
    let manifest = serde_json::json!([
        { "version": "0.3.59", "summary": "  Updates  show\nwhat changed.  ", "changes": ["Show release notes", "", 7] },
        { "version": "not-a-version", "changes": ["dropped"] },
        { "changes": ["no version"] },
        { "version": "0.3.58", "changes": "not a list" },
        { "version": "0.3.57", "changes": ["x".repeat(400)] },
    ]);
    let notes = release_notes_from_manifest(Some(&manifest));
    assert_eq!(notes.len(), 3);
    assert_eq!(
        notes[0],
        ReleaseNotes {
            version: "0.3.59".to_string(),
            summary: Some("Updates show what changed.".to_string()),
            changes: vec!["Show release notes".to_string()],
        }
    );
    assert_eq!(notes[1], ReleaseNotes { version: "0.3.58".to_string(), summary: None, changes: Vec::new() });
    assert_eq!(notes[2].changes[0].chars().count(), 300);
    assert!(notes[2].changes[0].ends_with('…'));

    let many = serde_json::Value::Array(
        (0..50)
            .map(|index| serde_json::json!({ "version": format!("0.3.{index}"), "changes": vec!["change"; 60] }))
            .collect(),
    );
    let notes = release_notes_from_manifest(Some(&many));
    assert_eq!(notes.len(), 30);
    assert!(notes.iter().all(|release| release.changes.len() == 40));

    assert!(release_notes_from_manifest(Some(&serde_json::json!("garbage"))).is_empty());
    assert!(release_notes_from_manifest(None).is_empty());
}

#[test]
fn a_manifest_with_or_without_notes_still_offers_the_update() {
    let without: PortableUpdateManifest = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "version": "0.3.59",
        "publishedAt": "2026-09-26T00:00:00Z",
        "releaseUrl": "http://127.0.0.1:8321/",
        "assets": {},
    }))
    .unwrap();
    assert!(without.releases.is_none());

    let garbage: PortableUpdateManifest = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "version": "0.3.59",
        "publishedAt": "2026-09-26T00:00:00Z",
        "releaseUrl": "http://127.0.0.1:8321/",
        "assets": {},
        "releases": "garbage",
    }))
    .unwrap();
    assert!(release_notes_from_manifest(garbage.releases.as_ref()).is_empty());
}

#[test]
fn release_notes_reach_the_webview_as_camel_case_without_an_empty_summary() {
    let notes = ReleaseNotes { version: "0.3.59".to_string(), summary: None, changes: vec!["Show release notes".to_string()] };
    assert_eq!(
        serde_json::to_value(&notes).unwrap(),
        serde_json::json!({ "version": "0.3.59", "changes": ["Show release notes"] })
    );
}
