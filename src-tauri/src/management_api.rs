use super::{
    auth_dir_path_for_core, configure_background_command, core_install_dir, core_origin, core_own_logs_dir_path,
    current_core_tls_settings, is_hashed_management_secret_key, open_oauth_url_inner, path_to_string,
    truncate_for_error, GuiConfigFile, GuiConfigState, CORE_CONFIG_FILE,
};
use crate::command_error::{CommandError, CommandErrorKind};
use crate::usage::diagnostics::{self, CoreReply};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use std::{
    collections::HashMap,
    error::Error,
    fs,
    path::Path,
    process::{Command, Stdio},
    sync::LazyLock,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthStartResult {
    url: String,
    state: Option<String>,
    opened: bool,
    open_error: Option<String>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthStatusResult {
    status: String,
    error: Option<String>,
}

#[derive(Deserialize)]
struct OAuthStartApiResponse {
    url: Option<String>,
    state: Option<String>,
    error: Option<String>,
    #[serde(rename = "error_message")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct OAuthStatusApiResponse {
    status: Option<String>,
    error: Option<String>,
    #[serde(rename = "error_message")]
    error_message: Option<String>,
}

// Each field the webview leaves out reads as None.
#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub(crate) struct ManagementRequest {
    method: String,
    path: String,
    query: Option<HashMap<String, String>>,
    body: Option<serde_json::Value>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

#[tauri::command]
pub(crate) async fn management_request(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    request: ManagementRequest,
) -> Result<serde_json::Value, CommandError> {
    let config = gui_config_state.snapshot()?;
    let method = match request.method.trim().to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(CommandError::failed("Unsupported management API request method")),
    };
    let path = request.path.trim();
    if path.is_empty() || path.contains("://") || path.contains("..") {
        return Err(CommandError::failed("Invalid management API path"));
    }

    let client = management_http_client()?;
    let mut builder = client
        .request(method, management_endpoint(&config, path)?)
        .header("Authorization", management_authorization(&config)?);
    if let Some(timeout_ms) = request.timeout_ms {
        builder = builder.timeout(Duration::from_millis(timeout_ms.clamp(1_000, 120_000)));
    }
    if let Some(query) = request.query {
        builder = builder.query(&query);
    }
    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = send_management(builder)
        .await
        .map_err(|err| format_management_request_error("Management API request failed", &err))?;
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .map_err(|err| format_management_request_error("Failed to read management API response", &err))?;
        return Err(management_status_error(status.as_u16(), &text));
    }
    Ok(read_management_value(response).await?)
}

#[tauri::command]
pub(crate) async fn upload_auth_file(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
    data: Vec<u8>,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".json") {
        return Err("Credentials filename must end with .json".to_string());
    }

    let config = gui_config_state.snapshot()?;
    let client = management_http_client()?;
    let mut query = HashMap::new();
    query.insert("name".to_string(), name);
    let response = send_management(
        client
            .post(management_endpoint(&config, "auth-files")?)
            .header("Authorization", management_authorization(&config)?)
            .query(&query)
            .header("Content-Type", "application/json")
            .body(data),
    )
    .await
    .map_err(|err| format_management_request_error("Failed to upload credentials file", &err))?;
    read_management_value(response).await
}

#[tauri::command]
pub(crate) fn open_auth_files_directory(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    let config = gui_config_state.snapshot()?;
    let install_dir = core_install_dir()?;
    let auth_dir = auth_dir_path_for_core(&config.auth_dir, &install_dir);
    fs::create_dir_all(&auth_dir)
        .map_err(|error| format!("Failed to create credentials directory {}: {error}", path_to_string(&auth_dir)))?;
    open_directory_in_file_manager(&auth_dir)
}

#[tauri::command]
pub(crate) fn open_core_logs_directory(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    let config = gui_config_state.snapshot()?;
    let install_dir = core_install_dir()?;
    let logs_dir = core_own_logs_dir_path(&config.auth_dir, &install_dir);
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("Failed to create logs directory {}: {error}", path_to_string(&logs_dir)))?;

    open_directory_in_file_manager(&logs_dir)
}

/// Shows config.yaml in Finder, for fixing the line the core couldn't read.
#[tauri::command]
pub(crate) fn reveal_core_config_file() -> Result<(), String> {
    let path = core_install_dir()?.join(CORE_CONFIG_FILE);
    let mut command = Command::new("/usr/bin/open");
    command.arg("-R").arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    configure_background_command(&mut command);
    command
        .spawn()
        .map(crate::system_open::reap_when_done)
        .map_err(|error| format!("Failed to show {}: {error}", path_to_string(&path)))
}

fn open_directory_in_file_manager(path: &Path) -> Result<(), String> {
    let mut command = Command::new("open");
    command.arg(path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    command
        .spawn()
        .map(crate::system_open::reap_when_done)
        .map_err(|error| format!("Failed to open directory {}: {error}", path_to_string(path)))
}

#[tauri::command]
pub(crate) async fn start_oauth_login(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
    browser: Option<String>,
) -> Result<OAuthStartResult, String> {
    let config = gui_config_state.snapshot()?;
    let provider_key = normalize_management_oauth_provider(&provider)?;
    let client = management_http_client()?;
    let mut request = client
        .get(management_endpoint(
            &config,
            &format!("{provider_key}-auth-url"),
        )?)
        .header("Authorization", management_authorization(&config)?);
    if management_oauth_uses_webui_callback(&provider_key) {
        request = request.query(&[("is_webui", "true")]);
    }
    let response = send_management(request)
        .await
        .map_err(|err| format_management_request_error("Failed to request OAuth login URL", &err))?;
    let payload = read_management_json::<OAuthStartApiResponse>(response).await?;
    if let Some(error) = payload
        .error
        .or(payload.error_message)
        .filter(|value| !value.trim().is_empty())
    {
        return Err(error);
    }
    let url = payload
        .url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Core did not return an OAuth login URL".to_string())?;
    let state = payload
        .state
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let (opened, open_error) = match open_oauth_url_inner(&app, &url, browser.as_deref()) {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error)),
    };

    Ok(OAuthStartResult {
        url,
        state,
        opened,
        open_error,
    })
}

#[tauri::command]
pub(crate) async fn get_oauth_status(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    state: String,
) -> Result<OAuthStatusResult, String> {
    let state = state.trim().to_string();
    if state.is_empty() {
        return Err("OAuth state must not be empty".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let client = management_http_client()?;
    let response = send_management(
        client
            .get(management_endpoint(&config, "get-auth-status")?)
            .header("Authorization", management_authorization(&config)?)
            .query(&[("state", state)]),
    )
    .await
    .map_err(|err| format_management_request_error("Failed to query OAuth status", &err))?;
    let payload = read_management_json::<OAuthStatusApiResponse>(response).await?;
    let status = payload
        .status
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "wait".to_string());
    Ok(OAuthStatusResult {
        status,
        error: payload
            .error
            .or(payload.error_message)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

#[tauri::command]
pub(crate) async fn submit_oauth_callback(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
    redirect_url: String,
) -> Result<(), String> {
    let redirect_url = redirect_url.trim().to_string();
    if redirect_url.is_empty() {
        return Err("Callback URL must not be empty".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let provider_key = normalize_management_oauth_provider(&provider)?;
    let client = management_http_client()?;
    let body = serde_json::json!({
        "provider": provider_key,
        "redirect_url": redirect_url,
    });
    let response = send_management(
        client
            .post(management_endpoint(&config, "oauth-callback")?)
            .header("Authorization", management_authorization(&config)?)
            .json(&body),
    )
    .await
    .map_err(|err| format_management_request_error("Failed to submit OAuth callback", &err))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read OAuth callback response", &err))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    Ok(())
}

/// Sends a request to the core's management API and notes in Diagnostics how long the core
/// took to answer and with what status. Every management request goes through here. Only the
/// method and the URL's path are noted, never its query, the headers or the body, and the time
/// is to the answer's status, before its body is read.
pub(crate) async fn send_management(request: reqwest::RequestBuilder) -> Result<reqwest::Response, reqwest::Error> {
    let (client, request) = request.build_split();
    let request = request?;
    let (method, path) = (request.method().to_string(), request.url().path().to_string());
    let started = Instant::now();
    let response = client.execute(request).await;
    let reply = match &response {
        Ok(response) => CoreReply::Status(response.status().as_u16()),
        Err(error) if error.is_timeout() => CoreReply::TimedOut,
        Err(_) => CoreReply::Unreachable,
    };
    diagnostics::record(diagnostics::core_call(&method, &path, started.elapsed(), reply));
    response
}

pub(crate) fn management_http_client() -> Result<reqwest::Client, String> {
    static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
        reqwest::Client::builder()
            // GUI-to-Core management traffic must always connect directly. Upstream
            // traffic still uses Core's proxy-url, and other GUI HTTP clients keep
            // their independently configured proxy behavior.
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            // Management requests target the configured local listener. This keeps
            // self-signed/private-CA certificates usable without weakening upstream clients.
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|err| format_management_request_error("Failed to create management API client", &err))
    });
    CLIENT.as_ref().cloned().map_err(Clone::clone)
}

pub(crate) fn format_management_request_error(
    action: &str,
    error: &(dyn Error + 'static),
) -> String {
    let mut messages = Vec::new();
    let mut current = Some(error);

    while let Some(error) = current {
        let message = error.to_string();
        if !message.is_empty()
            && messages
                .last()
                .map(|previous| previous != &message)
                .unwrap_or(true)
        {
            messages.push(message);
        }
        current = error.source();
    }

    if messages.is_empty() {
        action.to_string()
    } else {
        format!("{action}: {}", messages.join(": "))
    }
}

pub(crate) fn management_authorization(config: &GuiConfigFile) -> Result<String, String> {
    let secret_key = config.management_secret_key.trim();
    if secret_key.is_empty() || is_hashed_management_secret_key(secret_key) {
        return Err("Management API unavailable: no plaintext management key is available".to_string());
    }
    Ok(format!("Bearer {secret_key}"))
}

pub(crate) fn management_endpoint(config: &GuiConfigFile, path: &str) -> Result<String, String> {
    if config.port == 0 {
        return Err("Invalid core port".to_string());
    }
    let path = path.trim_start_matches('/');
    let origin = core_origin(
        &config.host,
        config.port,
        current_core_tls_settings()?.enabled,
    );
    Ok(format!("{origin}/v0/management/{path}"))
}

fn normalize_management_oauth_provider(provider: &str) -> Result<String, String> {
    let key = provider.trim().to_ascii_lowercase().replace('_', "-");
    let key = match key.as_str() {
        "claude" | "anthropic" => "anthropic".to_string(),
        "anti-gravity" => "antigravity".to_string(),
        "grok" | "x-ai" | "x.ai" => "xai".to_string(),
        other => other.to_string(),
    };
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid OAuth provider".to_string());
    }
    Ok(key)
}

fn management_oauth_uses_webui_callback(provider_key: &str) -> bool {
    matches!(provider_key, "codex" | "anthropic" | "antigravity" | "xai")
}

async fn read_management_json<T>(response: reqwest::Response) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read management API response", &err))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Err("Management API returned an empty response".to_string());
    }
    serde_json::from_str::<T>(&text).map_err(|err| {
        format!(
            "Failed to parse management API response: {err}; body={}",
            truncate_for_error(&text)
        )
    })
}

pub(crate) async fn read_management_value(
    response: reqwest::Response,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read management API response", &err))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(serde_json::Value::String(text)),
    }
}

/// What the core said went wrong, from its `error` or `message` field.
fn management_error_reason(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let message = value
        .get("error")
        .and_then(|item| item.as_str())
        .or_else(|| value.get("message").and_then(|item| item.as_str()))?
        .trim();
    (!message.is_empty()).then(|| message.to_string())
}

/// The core answered `status`, with `body`.
fn management_status_error(status: u16, body: &str) -> CommandError {
    CommandError {
        kind: CommandErrorKind::Core,
        status: Some(status),
        reason: management_error_reason(body),
        message: format_management_error(status, body),
    }
}

fn format_management_error(status: u16, body: &str) -> String {
    if let Some(message) = management_error_reason(body) {
        return format!("Management API error ({status}): {message}");
    }
    let body = body.trim();
    if body.is_empty() {
        format!("Management API error ({status})")
    } else {
        format!("Management API error ({status}): {}", truncate_for_error(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_logs_dir_path;
    use std::path::PathBuf;

    #[test]
    fn a_core_that_answers_with_a_failure_gives_its_status_and_its_own_words() {
        let failed = management_status_error(502, r#"{"error":" request failed "}"#);
        assert_eq!((failed.kind, failed.status, failed.reason.as_deref()), (CommandErrorKind::Core, Some(502), Some("request failed")));
        assert_eq!(failed.message, "Management API error (502): request failed");
        let plain = management_status_error(500, "upstream exploded");
        assert_eq!((plain.status, plain.reason, plain.message.as_str()), (Some(500), None, "Management API error (500): upstream exploded"));
        let empty = management_status_error(404, "");
        assert_eq!((empty.reason, empty.message.as_str()), (None, "Management API error (404)"));
    }

    #[test]
    fn core_logs_follow_the_default_auth_directory() {
        let base_dir = PathBuf::from("test-base");
        let install_dir = base_dir.join("core");

        assert_eq!(
            core_logs_dir_path("../oauth", &install_dir),
            base_dir.join("oauth").join("logs")
        );
    }

    #[test]
    fn core_logs_follow_a_custom_auth_directory() {
        let install_dir = PathBuf::from("test-base").join("core");
        let auth_dir = PathBuf::from("custom-auth");

        assert_eq!(
            core_logs_dir_path(auth_dir.to_str().unwrap(), &install_dir),
            install_dir.join(auth_dir).join("logs")
        );
    }

    #[test]
    fn the_logs_folder_is_the_one_the_core_writes_its_own_logs_to() {
        let base_dir = std::env::temp_dir().join(format!("arbor-core-logs-{}", std::process::id()));
        let install_dir = base_dir.join("core");
        fs::create_dir_all(&install_dir).unwrap();

        // With no logs folder beside it, the core writes beside its credentials, and asking doesn't make one.
        assert_eq!(core_own_logs_dir_path("../oauth", &install_dir), base_dir.join("oauth").join("logs"));
        assert!(!install_dir.join("logs").exists());

        fs::create_dir_all(install_dir.join("logs")).unwrap();
        assert_eq!(core_own_logs_dir_path("../oauth", &install_dir), install_dir.join("logs"));

        fs::remove_dir_all(&base_dir).unwrap();
    }
}
