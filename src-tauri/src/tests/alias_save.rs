use super::support::*;
use super::*;

const CURRENT: &str = "oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: my-alias\n      fork: true\npayload:\n  override:\n    - models: [{name: my-alias, protocol: codex}]\n      params: {reasoning.effort: high}\n";

fn yaml_json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

/// A config.yaml of its own in a temporary folder.
fn core_file(name: &str, content: &str) -> (PathBuf, PathBuf) {
    let home = agent_test_home(name);
    let path = home.join("config.yaml");
    fs::write(&path, content).unwrap();
    (home, path)
}

#[test]
fn alias_save_rejects_loss_of_api_access_before_any_write() {
    let initial = format!("{CURRENT}codex-api-key:\n  - api-key: test-key\n    base-url: https://example.test\n    models: [{{name: model-a}}]\nopenai-compatibility:\n  - name: preserved\n    disabled: true\n    api-key-entries: [{{api-key: other-test-key}}]\n    models: [{{name: model-b}}]\n");
    let (home, path) = core_file("alias-api-access", &initial);
    for section in ["codex-api-key", "openai-compatibility"] {
        for mode in ["missing", "empty", "credential"] {
            let mut corrupted = yaml_json(&initial);
            match mode {
                "missing" => {
                    corrupted.as_object_mut().unwrap().remove(section);
                }
                "empty" => corrupted[section] = serde_json::json!([]),
                _ => {
                    corrupted[section][0]
                        .as_object_mut()
                        .unwrap()
                        .retain(|key, _| !key.starts_with("api-key"));
                }
            }
            let error = write_alias_config_changes_at(&path, &initial, &serde_norway::to_string(&corrupted).unwrap())
                .unwrap_err();
            assert!(error.contains(&format!("({section})")), "accepted provider loss: {section}/{mode}");
            assert_eq!(fs::read_to_string(&path).unwrap(), initial);
        }
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn alias_save_leaves_a_file_changed_since_it_was_read_alone() {
    let changed = format!("{CURRENT}debug: true\n");
    let (home, path) = core_file("alias-stale", &changed);
    let error = write_alias_config_changes_at(&path, CURRENT, &CURRENT.replace("my-alias", "renamed")).unwrap_err();
    assert!(error.contains("changed while saving"), "{error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), changed);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn alias_save_writes_alias_and_payload_changes_in_one_write() {
    for updated in [
        CURRENT.replace("my-alias", "renamed"),
        CURRENT.replacen("my-alias", "renamed", 1),
        CURRENT.replace("high", "low"),
    ] {
        let (home, path) = core_file("alias-write", CURRENT);
        let write = write_alias_config_changes_at(&path, CURRENT, &updated).unwrap().unwrap();
        assert_eq!(write.previous, CURRENT);
        let saved = fs::read_to_string(&path).unwrap();
        assert_eq!(saved, write.written);
        // Only the change: no defaults filled in, as the core's own alias endpoint does when it rewrites the file.
        assert_eq!(yaml_json(&saved), yaml_json(&updated));
        fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn alias_save_into_a_v8_file_keeps_its_layout_and_comments() {
    let file = "config-version: 8\n# The owner's note\noauth:\n  # Aliases for OAuth models\n  model-alias:\n    codex:\n      - name: gpt-test\n        alias: my-alias\n        fork: true\nrouting:\n  strategy: fill-first\n";
    let (home, path) = core_file("alias-v8", file);
    let current = read_core_config_view_of(file);
    let updated = current.replace("my-alias", "renamed");
    write_alias_config_changes_at(&path, &current, &updated).unwrap().unwrap();
    let saved = fs::read_to_string(&path).unwrap();
    assert!(saved.contains("# The owner's note"), "{saved}");
    assert!(saved.contains("# Aliases for OAuth models"), "{saved}");
    let document = yaml_json(&saved);
    assert_eq!(document["oauth"]["model-alias"]["codex"][0]["alias"], "renamed");
    assert!(document.get("oauth-model-alias").is_none(), "{saved}");
    assert_eq!(document["routing"]["strategy"], "fill-first");
    fs::remove_dir_all(home).unwrap();
}

fn read_core_config_view_of(file: &str) -> String {
    core_v8_yaml_to_legacy_view(file).unwrap()
}

#[test]
fn alias_saves_at_the_same_time_take_turns_and_the_stale_one_is_refused() {
    let (home, path) = core_file("alias-concurrent", CURRENT);
    let saves: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|name| {
            let path = path.clone();
            std::thread::spawn(move || {
                let updated = CURRENT.replace("my-alias", name);
                write_alias_config_changes_at(&path, CURRENT, &updated).map(|write| (name, write.is_some()))
            })
        })
        .collect();
    let results: Vec<_> = saves.into_iter().map(|save| save.join().unwrap()).collect();
    let saved: Vec<_> = results.iter().filter_map(|result| result.as_ref().ok()).collect();
    assert_eq!(saved.len(), 1, "{results:?}");
    let (winner, _) = saved[0];
    assert_eq!(yaml_json(&fs::read_to_string(&path).unwrap()), yaml_json(&CURRENT.replace("my-alias", winner)));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn alias_save_without_changes_writes_nothing() {
    let (home, path) = core_file("alias-unchanged", CURRENT);
    for updated in [CURRENT.to_string(), format!("# comment only\n{CURRENT}")] {
        assert!(write_alias_config_changes_at(&path, CURRENT, &updated).unwrap().is_none());
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), CURRENT);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_change_the_core_could_not_load_is_taken_back_out_unless_the_file_moved_on() {
    let (home, path) = core_file("alias-undo", CURRENT);
    let updated = CURRENT.replace("my-alias", "renamed");
    let write = write_alias_config_changes_at(&path, CURRENT, &updated).unwrap().unwrap();
    assert!(undo_config_write_at(&path, &write).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), CURRENT);

    let write = write_alias_config_changes_at(&path, CURRENT, &updated).unwrap().unwrap();
    let moved_on = format!("{}debug: true\n", write.written);
    fs::write(&path, &moved_on).unwrap();
    assert!(!undo_config_write_at(&path, &write).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), moved_on);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn alias_create_and_delete_round_trip_through_the_file() {
    let initial = "codex-api-key:\n  - api-key: test-key\n    base-url: https://example.test\n    models: [{name: model-a}]\n";
    let (home, path) = core_file("alias-round-trip", initial);
    let source = resolved_alias_sources(initial, &[], &test_agent_models(&["model-a"]), false)
        .unwrap()
        .remove(0);
    let created = add_model_alias_to_yaml(initial, &source, "model-a-high", "high", true).unwrap();
    write_alias_config_changes_at(&path, initial, &created).unwrap();
    let current = read_core_config_view_of(&fs::read_to_string(&path).unwrap());
    assert_eq!(thinking_aliases_from_yaml(&current).unwrap()[0].effort.as_deref(), Some("high"));
    let deleted = remove_thinking_alias_from_yaml(&current, "model-a-high").unwrap();
    write_alias_config_changes_at(&path, &current, &deleted).unwrap();
    assert_eq!(yaml_json(&fs::read_to_string(&path).unwrap()), yaml_json(initial));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn alias_write_guard_allows_model_list_changes_only() {
    let current = "debug: false\ncodex-api-key:\n  - api-key: codex-secret\n    base-url: https://example.test\n    headers: {X-Team: core}\n    models: [{name: model-a}]\nopenai-compatibility:\n  - name: relay\n    api-key-entries: [{api-key: relay-secret}]\n    models: [{name: model-b}]\n";
    let allowed = current
        .replace(
            "[{name: model-a}]",
            "[{name: model-a}, {name: model-a, alias: model-a-fast}]",
        )
        .replace("[{name: model-b}]", "[]")
        .replace("debug: false", "debug: true");
    validate_alias_api_access_preserved(current, &allowed).unwrap();
    for (from, to) in [
        ("codex-secret", "changed-secret"),
        ("https://example.test", "https://changed.test"),
        ("X-Team: core", "X-Team: other"),
        ("name: relay", "name: renamed"),
        ("[{api-key: relay-secret}]", "[]"),
    ] {
        let error =
            validate_alias_api_access_preserved(current, &current.replace(from, to)).unwrap_err();
        assert!(error.contains("write rejected"), "{from}: {error}");
    }
}

#[test]
fn alias_write_guard_protects_sections_without_alias_models() {
    for section in ["vertex-api-key", "xai-api-key", "interactions-api-key"] {
        let current =
            format!("{section}:\n  - api-key: test-key\n    models: [{{name: model-a}}]\n");
        let updated = current.replace(
            "[{name: model-a}]",
            "[{name: model-a}, {name: model-a, alias: extra}]",
        );
        assert_eq!(
            validate_alias_api_access_preserved(&current, &updated).unwrap_err(),
            format!(
                "The alias update would change API access configuration ({section}); write rejected"
            )
        );
        validate_alias_api_access_preserved(&current, &current).unwrap();
    }
}

#[test]
fn alias_write_guard_treats_missing_null_and_empty_sections_alike() {
    for (current, updated) in [
        ("debug: true\n", "debug: true\ncodex-api-key: []\n"),
        ("codex-api-key:\n", "debug: true\n"),
        ("xai-api-key: []\n", "{}\n"),
    ] {
        validate_alias_api_access_preserved(current, updated).unwrap();
        validate_alias_api_access_preserved(updated, current).unwrap();
    }
    assert!(validate_alias_api_access_preserved(
        "debug: true\n",
        "claude-api-key:\n  - api-key: test-key\n"
    )
    .is_err());
    assert_eq!(
        validate_alias_api_access_preserved("codex-api-key: {api-key: test-key}\n", "{}\n")
            .unwrap_err(),
        "codex-api-key must be an array; alias save rejected"
    );
}

#[test]
fn alias_write_keeps_block_scalars_that_look_like_yaml_lists() {
    // The block scalar holds text that looks like an unindented YAML list; the
    // sequence re-indenting pass must leave it exactly as written.
    let input = "notes: |\n  Steps:\n  - one\n  - two\nopenai-compatibility:\n  - name: relay\n    base-url: https://example.test\n    models:\n      - name: model-a\n";
    let source = resolved_alias_sources(input, &[], &test_agent_models(&["model-a"]), false)
        .unwrap()
        .remove(0);
    let updated = add_model_alias_to_yaml(input, &source, "model-a-alias", "", false).unwrap();
    let updated = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();
    assert_eq!(updated["notes"].as_str(), Some("Steps:\n- one\n- two\n"));
    assert_eq!(
        updated["openai-compatibility"][0]["models"][1]["alias"].as_str(),
        Some("model-a-alias")
    );
}

#[test]
fn alias_write_rejects_rendering_that_would_change_other_values() {
    let expected = serde_norway::from_str::<serde_norway::Value>(
        "notes: \"Steps:\\n- one\\n\"\ndebug: true\n",
    )
    .unwrap();
    ensure_rendered_core_yaml_matches("notes: |\n  Steps:\n  - one\ndebug: true\n", &expected)
        .unwrap();
    assert_eq!(
        ensure_rendered_core_yaml_matches(
            "notes: |\n  Steps:\n    - one\ndebug: true\n",
            &expected
        )
        .unwrap_err(),
        "Updated core configuration does not match expected values (path: notes); write rejected"
    );
}

#[test]
fn sequence_reindenting_leaves_block_scalar_text_alone() {
    let cases = [
        (
            "notes: |\n  Steps:\n  - one\nitems:\n- a\n- b\n",
            "notes: |\n  Steps:\n  - one\nitems:\n  - a\n  - b\n",
        ),
        (
            "rules:\n- name: x\n  text: >-\n    Rules:\n    - short\n\n    Done:\n    - yes\n- name: y\n",
            "rules:\n  - name: x\n    text: >-\n      Rules:\n      - short\n\n      Done:\n      - yes\n  - name: y\n",
        ),
        (
            "list:\n- |2 # keep\n  Heading:\n  - item\ntail:\n- z\n",
            "list:\n  - |2 # keep\n    Heading:\n    - item\ntail:\n  - z\n",
        ),
        (
            "prompt: |+\n  Plan:\n  - first\n\nafter: 1\n",
            "prompt: |+\n  Plan:\n  - first\n\nafter: 1\n",
        ),
    ];
    for (input, expected) in cases {
        let rendered = indent_indentationless_yaml_sequences(input);
        assert_eq!(rendered, expected);
        assert_eq!(
            serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap(),
            serde_norway::from_str::<serde_norway::Value>(input).unwrap()
        );
    }
}
