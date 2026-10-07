//! What the app needs from inside an account's credential file, read here so the file never reaches the webview.
//!
//! A credential file holds the account's tokens. The core hands the whole file out at `GET /auth-files/download`,
//! so only this module asks for it, and each command answers with the one thing its caller needs: what folding a
//! fresh login into an account's file did, an Antigravity project id, or the file's excluded models.
//! `management_request` refuses that path, so the webview can't fetch a file itself.

use crate::command_error::CommandError;
use crate::management_api::{
    format_management_request_error, management_authorization, management_endpoint, management_http_client,
    management_status_error, send_management, upload_auth_file_bytes,
};
use crate::{GuiConfigFile, GuiConfigState};
use serde::Serialize;
use serde_json::{Map, Value};
use ts_rs::TS;

type Credential = Map<String, Value>;

/// The core's path that answers with a whole credential file, tokens included.
const DOWNLOAD_PATH: &str = "auth-files/download";

/// Whether a management path asks the core for a credential file's contents.
pub(crate) fn reads_credential_contents(path: &str) -> bool {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty() && *segment != ".").collect();
    segments.join("/").eq_ignore_ascii_case(DOWNLOAD_PATH)
}

/// What folding a fresh login into an account's file did. Only names cross to the webview, never the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum ReauthFold {
    /// The login's tokens went into the account's file, which kept its settings, and `from` was deleted.
    Transplanted { from: String },
    /// Every login file records another workspace or organization than the account's, so nothing changed.
    OtherWorkspace,
}

/// Fields a re-login must never overwrite: the user's settings. Mirrors the core's own re-login preserve list.
const PRESERVED_FIELDS: [&str; 11] = [
    "priority",
    "disabled",
    "prefix",
    "websockets",
    "note",
    "proxy_url",
    "weight",
    "headers",
    "models",
    "thinking",
    "excluded_models",
];

/// Identity fields a credential file records about its account: the Codex workspace, the Claude organization and
/// user. The core's listing leaves them out, which is why folding reads the files.
const IDENTITY_FIELDS: [&str; 3] = ["account_id", "organization_uuid", "account_uuid"];

/// A field as text the way the webview reads listing fields: a trimmed string, number or boolean, else empty.
fn text_field(record: &Credential, key: &str) -> String {
    match record.get(key) {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// Whether two credential files name different accounts; a file that records no id never conflicts.
fn conflicting_identity(left: &Credential, right: &Credential) -> bool {
    IDENTITY_FIELDS.iter().any(|field| {
        let (left, right) = (text_field(left, field), text_field(right, field));
        !left.is_empty() && !right.is_empty() && left != right
    })
}

/// Fresh OAuth tokens laid over the existing file, keeping the existing file's settings.
fn merge_credential(existing: &Credential, fresh: &Credential) -> Credential {
    let mut merged = existing.clone();
    for (key, value) in fresh {
        merged.insert(key.clone(), value.clone());
    }
    for key in PRESERVED_FIELDS {
        if let Some(value) = existing.get(key) {
            merged.insert(key.to_string(), value.clone());
        }
    }
    merged
}

/// The first of `candidates` whose file agrees with `existing` about whose account it is.
fn agreeing_candidate<'a>(existing: &Credential, candidates: &'a [(String, Credential)]) -> Option<&'a (String, Credential)> {
    candidates.iter().find(|(_, content)| !conflicting_identity(existing, content))
}

fn credential_name(name: &str) -> Result<String, CommandError> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err(CommandError::failed("Invalid credential file name"));
    }
    Ok(name.to_string())
}

/// The core sends the file as JSON; an older core sent it as a JSON string.
fn credential_from_body(body: &str) -> Option<Credential> {
    match serde_json::from_str::<Value>(body).ok()? {
        Value::Object(record) => Some(record),
        Value::String(text) => match serde_json::from_str::<Value>(&text).ok()? {
            Value::Object(record) => Some(record),
            _ => None,
        },
        _ => None,
    }
}

/// The credential file's contents as the core holds them, or None when it isn't a JSON object.
async fn download_credential(config: &GuiConfigFile, name: &str) -> Result<Option<Credential>, CommandError> {
    let response = send_management(
        management_http_client()?
            .get(management_endpoint(config, DOWNLOAD_PATH)?)
            .header("Authorization", management_authorization(config)?)
            .query(&[("name", name)]),
    )
    .await
    .map_err(|error| format_management_request_error("Couldn't read the credential file", &error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format_management_request_error("Couldn't read the credential file", &error))?;
    if !status.is_success() {
        return Err(management_status_error(status.as_u16(), &body));
    }
    Ok(credential_from_body(&body))
}

async fn delete_credential(config: &GuiConfigFile, name: &str) -> Result<(), CommandError> {
    let response = send_management(
        management_http_client()?
            .delete(management_endpoint(config, "auth-files")?)
            .header("Authorization", management_authorization(config)?)
            .query(&[("name", name)]),
    )
    .await
    .map_err(|error| format_management_request_error("Couldn't remove the duplicate credential", &error))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(management_status_error(status.as_u16(), &body));
    }
    Ok(())
}

/// Folds a fresh login into `target`, the account's existing credential file: the first of `candidates` (files the
/// sign-in wrote, best match first) whose file records the same workspace and organization as `target` gives its
/// tokens to `target`, which keeps its settings, and is then deleted. Never folds one account's login into another's.
#[tauri::command]
pub(crate) async fn fold_reauth_credential(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    target: String,
    candidates: Vec<String>,
) -> Result<ReauthFold, CommandError> {
    let config = gui_config_state.snapshot()?;
    let target = credential_name(&target)?;
    let existing = download_credential(&config, &target)
        .await?
        .ok_or_else(|| CommandError::failed(format!("{target} isn't a credential file Arbor can read")))?;
    let mut contents = Vec::new();
    for candidate in candidates {
        let candidate = credential_name(&candidate)?;
        if candidate == target {
            continue;
        }
        let content = download_credential(&config, &candidate)
            .await?
            .ok_or_else(|| CommandError::failed(format!("{candidate} isn't a credential file Arbor can read")))?;
        let agrees = !conflicting_identity(&existing, &content);
        contents.push((candidate, content));
        // Read no further than the first file that agrees: the rest stay unread.
        if agrees {
            break;
        }
    }
    let Some((fresh_name, fresh)) = agreeing_candidate(&existing, &contents) else {
        return Ok(ReauthFold::OtherWorkspace);
    };
    let merged = merge_credential(&existing, fresh);
    let mut text = serde_json::to_string_pretty(&Value::Object(merged))
        .map_err(|error| CommandError::failed(format!("Couldn't write the credential file: {error}")))?;
    text.push('\n');
    upload_auth_file_bytes(&config, &target, text.into_bytes()).await?;
    delete_credential(&config, fresh_name).await?;
    Ok(ReauthFold::Transplanted { from: fresh_name.clone() })
}

/// The Google Cloud project an Antigravity credential's quota is read against, from the file and the records
/// inside it.
fn project_id_in(file: &Credential) -> String {
    let mut records = vec![file];
    for key in ["metadata", "attributes", "installed", "web"] {
        if let Some(Value::Object(record)) = file.get(key) {
            records.push(record);
        }
    }
    records
        .into_iter()
        .flat_map(|record| ["project_id", "projectId", "gemini_virtual_project"].map(|key| text_field(record, key)))
        .find(|id| !id.is_empty())
        .unwrap_or_default()
}

/// The Antigravity project id recorded in a credential file, or "" when it records none.
#[tauri::command]
pub(crate) async fn get_auth_file_project_id(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
) -> Result<String, CommandError> {
    let config = gui_config_state.snapshot()?;
    let name = credential_name(&name)?;
    Ok(download_credential(&config, &name).await?.map(|file| project_id_in(&file)).unwrap_or_default())
}

/// The models a credential file keeps from its account, or why they can't be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AuthFileExcludedModels {
    /// The file's own rules, as written; none when it has none.
    Rules { rules: Vec<String> },
    /// The file isn't a JSON object.
    InvalidMetadata,
    /// The file's excluded models aren't a list of names.
    InvalidExclusions,
}

fn excluded_models_in(file: Option<&Credential>) -> AuthFileExcludedModels {
    let Some(file) = file else { return AuthFileExcludedModels::InvalidMetadata };
    // The core gives the canonical key precedence, an explicit empty list or null included.
    let rules = if file.contains_key("excluded_models") { file.get("excluded_models") } else { file.get("excluded-models") };
    match rules {
        None | Some(Value::Null) => AuthFileExcludedModels::Rules { rules: Vec::new() },
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .map_or(AuthFileExcludedModels::InvalidExclusions, |rules| AuthFileExcludedModels::Rules { rules }),
        Some(_) => AuthFileExcludedModels::InvalidExclusions,
    }
}

/// The models a credential file keeps from its account (`excluded_models`).
#[tauri::command]
pub(crate) async fn get_auth_file_excluded_models(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
) -> Result<AuthFileExcludedModels, CommandError> {
    let config = gui_config_state.snapshot()?;
    let name = credential_name(&name)?;
    Ok(excluded_models_in(download_credential(&config, &name).await?.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(value: Value) -> Credential {
        match value {
            Value::Object(record) => record,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn only_the_download_path_is_refused() {
        for path in ["/auth-files/download", "auth-files/download", "//auth-files//download/", "/Auth-Files/Download?name=x", "./auth-files/download"] {
            assert!(reads_credential_contents(path), "{path}");
        }
        for path in ["/auth-files", "/auth-files/models", "/auth-files/fields", "/auth-files/download-log"] {
            assert!(!reads_credential_contents(path), "{path}");
        }
    }

    #[test]
    fn a_relogin_takes_the_new_tokens_and_keeps_the_files_settings() {
        let merged = merge_credential(
            &record(json!({ "type": "codex", "access_token": "old", "refresh_token": "old-r", "priority": 10, "disabled": true, "excluded_models": ["x"], "note": "keep" })),
            &record(json!({ "type": "codex", "access_token": "new", "refresh_token": "new-r", "id_token": "id", "priority": 0, "expired": "2027-01-01" })),
        );
        assert_eq!(
            Value::Object(merged),
            json!({
                "type": "codex", "access_token": "new", "refresh_token": "new-r", "id_token": "id", "expired": "2027-01-01",
                "priority": 10, "disabled": true, "excluded_models": ["x"], "note": "keep",
            }),
        );
    }

    #[test]
    fn a_setting_the_old_file_never_had_comes_from_the_login() {
        let merged = merge_credential(&record(json!({ "access_token": "old" })), &record(json!({ "access_token": "new", "priority": 3 })));
        assert_eq!(Value::Object(merged), json!({ "access_token": "new", "priority": 3 }));
    }

    #[test]
    fn a_login_to_another_workspace_or_organization_never_folds_into_the_account() {
        for (existing, signed_in) in [
            (json!({ "account_id": "ws-work" }), json!({ "account_id": "ws-team" })),
            (json!({ "account_uuid": "uuid-1", "organization_uuid": "org-work" }), json!({ "account_uuid": "uuid-1", "organization_uuid": "org-team" })),
        ] {
            assert!(conflicting_identity(&record(existing), &record(signed_in)));
        }
        // A file that records no id, or the same one, agrees.
        assert!(!conflicting_identity(&record(json!({ "type": "codex" })), &record(json!({ "account_id": "acct-1" }))));
        assert!(!conflicting_identity(&record(json!({ "account_id": "acct-1" })), &record(json!({ "account_id": " acct-1 " }))));
    }

    #[test]
    fn the_first_login_file_that_agrees_with_the_account_is_folded() {
        let existing = record(json!({ "account_id": "acct-1", "access_token": "old" }));
        let candidates = vec![
            ("codex-0000-team.json".to_string(), record(json!({ "account_id": "ws-team", "access_token": "team" }))),
            ("codex-abc-pro.json".to_string(), record(json!({ "account_id": "acct-1", "access_token": "new" }))),
        ];
        assert_eq!(agreeing_candidate(&existing, &candidates).map(|(name, _)| name.as_str()), Some("codex-abc-pro.json"));
        assert_eq!(agreeing_candidate(&existing, &candidates[..1]), None);
    }

    #[test]
    fn a_file_sent_as_a_json_string_reads_the_same() {
        let file = credential_from_body(r#""{\"project_id\":\"proj-1\"}""#).expect("object");
        assert_eq!(project_id_in(&file), "proj-1");
        assert_eq!(credential_from_body("[1]"), None);
        assert_eq!(credential_from_body("not json"), None);
    }

    #[test]
    fn the_project_id_comes_from_the_file_or_the_records_inside_it() {
        assert_eq!(project_id_in(&record(json!({ "projectId": " p-top " }))), "p-top");
        assert_eq!(project_id_in(&record(json!({ "metadata": { "project_id": "p-meta" } }))), "p-meta");
        assert_eq!(project_id_in(&record(json!({ "installed": { "gemini_virtual_project": "p-installed" } }))), "p-installed");
        assert_eq!(project_id_in(&record(json!({ "project_id": "", "web": { "project_id": "p-web" } }))), "p-web");
        assert_eq!(project_id_in(&record(json!({ "access_token": "secret" }))), "");
    }

    #[test]
    fn excluded_models_prefer_the_canonical_key_and_reject_anything_but_names() {
        let rules = |value: Value| excluded_models_in(Some(&record(value)));
        assert_eq!(rules(json!({ "excluded_models": ["gpt-6-luna"] })), AuthFileExcludedModels::Rules { rules: vec!["gpt-6-luna".into()] });
        assert_eq!(rules(json!({ "excluded-models": ["a"] })), AuthFileExcludedModels::Rules { rules: vec!["a".into()] });
        // An explicit empty list or null on the canonical key wins over the other spelling.
        assert_eq!(rules(json!({ "excluded_models": [], "excluded-models": ["a"] })), AuthFileExcludedModels::Rules { rules: vec![] });
        assert_eq!(rules(json!({ "excluded_models": null, "excluded-models": ["a"] })), AuthFileExcludedModels::Rules { rules: vec![] });
        assert_eq!(rules(json!({})), AuthFileExcludedModels::Rules { rules: vec![] });
        assert_eq!(rules(json!({ "excluded_models": "a" })), AuthFileExcludedModels::InvalidExclusions);
        assert_eq!(rules(json!({ "excluded_models": ["a", 1] })), AuthFileExcludedModels::InvalidExclusions);
        assert_eq!(excluded_models_in(None), AuthFileExcludedModels::InvalidMetadata);
    }

    #[test]
    fn what_crosses_to_the_webview_is_names_and_kinds_only() {
        assert_eq!(serde_json::to_value(ReauthFold::Transplanted { from: "codex-abc.json".into() }).unwrap(), json!({ "kind": "transplanted", "from": "codex-abc.json" }));
        assert_eq!(serde_json::to_value(ReauthFold::OtherWorkspace).unwrap(), json!({ "kind": "other-workspace" }));
        assert_eq!(serde_json::to_value(AuthFileExcludedModels::InvalidMetadata).unwrap(), json!({ "kind": "invalidMetadata" }));
    }
}
