use super::*;
use ts_rs::TS;

/// Pushover's and Telegram's APIs. ntfy servers and webhooks come from the settings.
const PUSHOVER_API: &str = "https://api.pushover.net";
const TELEGRAM_API: &str = "https://api.telegram.org";
/// How much of a refusal's reason is kept; webhooks can answer with a whole HTML page.
const REFUSAL_DETAIL_MAX: usize = 200;
/// Shorter than any real token, so hiding one can't blank out ordinary words in a reason.
const SECRET_MIN_LEN: usize = 8;
/// Parts of a webhook URL this long are likely a token, which a server might echo on its own.
const URL_TOKEN_MIN_LEN: usize = 16;
/// Kept beside the app's config.toml rather than in the window's storage. Not in the Keychain:
/// every update re-signs the app, so macOS would ask again after each one and alerts sent while
/// you're away would fail.
const PHONE_ALERT_SECRETS_FILE: &str = "phone-alert-secrets.json";
/// Held while the file is read and rewritten, so two saves at once can't lose one.
static PHONE_ALERT_SECRETS_LOCK: Mutex<()> = Mutex::new(());

/// Where alerts go, as the window keeps it: the service and the settings that aren't secret.
/// Each send carries it, and the app fills in the secrets from its own file.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(tag = "service", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum PhoneAlertRoute {
    Ntfy { server: String, topic: String },
    Pushover,
    Telegram { chat_id: String },
    Webhook,
}

impl PhoneAlertRoute {
    fn with_secrets(self, secrets: &PhoneAlertSecrets) -> PhoneAlertTarget {
        match self {
            Self::Ntfy { server, topic } => PhoneAlertTarget::Ntfy {
                server,
                topic,
                token: secrets.ntfy_token.clone(),
            },
            Self::Pushover => PhoneAlertTarget::Pushover {
                user_key: secrets.pushover_user_key.clone(),
                app_token: secrets.pushover_app_token.clone(),
            },
            Self::Telegram { chat_id } => PhoneAlertTarget::Telegram {
                bot_token: secrets.telegram_bot_token.clone(),
                chat_id,
            },
            Self::Webhook => PhoneAlertTarget::Webhook { url: secrets.webhook_url.clone() },
        }
    }
}

/// Where Arbor's alerts go besides this Mac: the route with its secrets filled in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PhoneAlertTarget {
    Ntfy { server: String, topic: String, token: String },
    Pushover { user_key: String, app_token: String },
    Telegram { bot_token: String, chat_id: String },
    Webhook { url: String },
}

/// The phone alert settings that are secrets. Webhook URLs count, since they usually carry a
/// token. The window can save and clear them but never reads them back.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PhoneAlertSecrets {
    ntfy_token: String,
    pushover_user_key: String,
    pushover_app_token: String,
    telegram_bot_token: String,
    webhook_url: String,
}

impl PhoneAlertSecrets {
    fn slot(&mut self, secret: PhoneAlertSecret) -> &mut String {
        match secret {
            PhoneAlertSecret::NtfyToken => &mut self.ntfy_token,
            PhoneAlertSecret::PushoverUserKey => &mut self.pushover_user_key,
            PhoneAlertSecret::PushoverAppToken => &mut self.pushover_app_token,
            PhoneAlertSecret::TelegramBotToken => &mut self.telegram_bot_token,
            PhoneAlertSecret::WebhookUrl => &mut self.webhook_url,
        }
    }

    fn status(&self) -> PhoneAlertSecretStatus {
        let saved = |value: &str| !value.trim().is_empty();
        PhoneAlertSecretStatus {
            ntfy_token: saved(&self.ntfy_token),
            pushover_user_key: saved(&self.pushover_user_key),
            pushover_app_token: saved(&self.pushover_app_token),
            telegram_bot_token: saved(&self.telegram_bot_token),
            webhook_url: saved(&self.webhook_url),
        }
    }
}

/// Only which are saved, so a stray debug print can't give one away.
impl std::fmt::Debug for PhoneAlertSecrets {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_tuple("PhoneAlertSecrets").field(&self.status()).finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PhoneAlertSecret {
    NtfyToken,
    PushoverUserKey,
    PushoverAppToken,
    TelegramBotToken,
    WebhookUrl,
}

/// Which secrets are saved: all the window ever learns about them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneAlertSecretStatus {
    ntfy_token: bool,
    pushover_user_key: bool,
    pushover_app_token: bool,
    telegram_bot_token: bool,
    webhook_url: bool,
}

fn phone_alert_secrets_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(PHONE_ALERT_SECRETS_FILE))
}

/// The saved secrets, or none before the first is saved.
fn read_phone_alert_secrets(path: &Path) -> Result<PhoneAlertSecrets, String> {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(PhoneAlertSecrets::default()),
        Err(error) => {
            return Err(format!("Couldn’t read the saved alert secrets in {}: {error}", path_to_string(path)));
        }
    };
    // serde's reason can quote the file, so it's left out.
    serde_json::from_slice(&content).map_err(|_| {
        format!(
            "The saved alert secrets in {} can’t be read. Delete the file and enter them again.",
            path_to_string(path)
        )
    })
}

/// Written to a temporary file only you can read, then moved over the old one, so the file is
/// never half written or open to other users.
fn write_phone_alert_secrets(path: &Path, secrets: &PhoneAlertSecrets) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let content = serde_json::to_vec_pretty(secrets)
        .map_err(|error| format!("Failed to serialize the alert secrets: {error}"))?;
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create {}: {error}", path_to_string(directory)))?;
    let temporary = directory.join(format!(
        ".{PHONE_ALERT_SECRETS_FILE}.tmp.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        // Exactly 0600, whatever the umask.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&content)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomically(&temporary, path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Couldn't save the alert secrets to {}: {error}", path_to_string(path)));
    }
    Ok(())
}

fn save_phone_alert_secret(
    path: &Path,
    secret: PhoneAlertSecret,
    value: &str,
) -> Result<PhoneAlertSecretStatus, String> {
    let _guard = PHONE_ALERT_SECRETS_LOCK
        .lock()
        .map_err(|_| "The alert secrets lock is poisoned".to_string())?;
    let mut secrets = read_phone_alert_secrets(path)?;
    *secrets.slot(secret) = value.trim().to_string();
    write_phone_alert_secrets(path, &secrets)?;
    Ok(secrets.status())
}

/// Which phone alert secrets are saved. Their values stay in the app.
#[tauri::command]
pub(crate) fn get_phone_alert_secrets() -> Result<PhoneAlertSecretStatus, String> {
    Ok(read_phone_alert_secrets(&phone_alert_secrets_path()?)?.status())
}

/// Saves one secret, or clears it when the value is empty, and says which are saved now.
#[tauri::command]
pub(crate) fn set_phone_alert_secret(
    secret: PhoneAlertSecret,
    value: String,
) -> Result<PhoneAlertSecretStatus, String> {
    save_phone_alert_secret(&phone_alert_secrets_path()?, secret, &value)
}

impl PhoneAlertTarget {
    fn service_name(&self) -> &'static str {
        match self {
            Self::Ntfy { .. } => "ntfy",
            Self::Pushover { .. } => "Pushover",
            Self::Telegram { .. } => "Telegram",
            Self::Webhook { .. } => "The webhook",
        }
    }

    /// What a refusal's reason mustn't repeat, longest first: the secrets, and for a webhook the
    /// parts of its URL a server might echo, such as its path in a 404 page.
    fn secret_values(&self) -> Vec<String> {
        let mut values: Vec<String> = match self {
            Self::Ntfy { token, .. } => vec![token.clone()],
            Self::Pushover { user_key, app_token } => vec![user_key.clone(), app_token.clone()],
            Self::Telegram { bot_token, .. } => {
                let secret = bot_token.split_once(':').map(|(_, secret)| secret.to_string());
                std::iter::once(bot_token.clone()).chain(secret).collect()
            }
            Self::Webhook { url } => {
                let mut values = vec![url.clone()];
                if let Ok(parsed) = reqwest::Url::parse(url.trim()) {
                    let query = parsed.query().map(str::to_string);
                    values.push(parsed.as_str().to_string());
                    values.extend(query.as_ref().map(|query| format!("{}?{query}", parsed.path())));
                    values.push(parsed.path().to_string());
                    values.extend(query);
                    let segments = parsed.path_segments().into_iter().flatten().map(str::to_string);
                    let query_values = parsed.query_pairs().map(|(_, value)| value.into_owned());
                    values.extend(
                        segments
                            .chain(query_values)
                            .filter(|value| value.chars().count() >= URL_TOKEN_MIN_LEN),
                    );
                }
                values
            }
        };
        values = values
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| value.chars().count() >= SECRET_MIN_LEN)
            .collect();
        values.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        values.dedup();
        values
    }
}

/// `text` with each of `secrets` hidden.
fn without_secrets(text: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .fold(text.to_string(), |text, secret| text.replace(secret.as_str(), "…"))
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneAlert {
    title: String,
    body: String,
    /// What raised the alert, such as `machineDown`. Webhooks get it as is.
    kind: String,
    /// A problem that wants attention now, such as a machine going down.
    urgent: bool,
}

/// The services with fixed addresses, so tests can point them at a local server.
pub(crate) struct PhoneAlertApis<'a> {
    pushover: &'a str,
    telegram: &'a str,
}

const PHONE_ALERT_APIS: PhoneAlertApis<'static> = PhoneAlertApis {
    pushover: PUSHOVER_API,
    telegram: TELEGRAM_API,
};

/// Redirects aren't followed: a moved endpoint is reported rather than sent the alert, and
/// an ntfy token never follows one to another host.
fn phone_alert_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
}

/// Sends one alert through the chosen service with the saved secrets, using the core's proxy
/// setting like the app's other requests.
#[tauri::command]
pub(crate) async fn send_phone_alert(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    route: PhoneAlertRoute,
    alert: PhoneAlert,
) -> Result<(), String> {
    let target = route.with_secrets(&read_phone_alert_secrets(&phone_alert_secrets_path()?)?);
    let proxy_url = gui_config_state.snapshot()?.proxy_url;
    let client = build_http_client_with_proxy(
        phone_alert_client_builder(),
        &proxy_url,
        "Failed to create the alert client",
    )?;
    deliver_phone_alert(&client, &target, &alert, &PHONE_ALERT_APIS).await
}

pub(crate) async fn deliver_phone_alert(
    client: &reqwest::Client,
    target: &PhoneAlertTarget,
    alert: &PhoneAlert,
    apis: &PhoneAlertApis<'_>,
) -> Result<(), String> {
    let service = target.service_name();
    let response = phone_alert_request(client, target, alert, apis)?
        .send()
        .await
        // The URL can hold a Telegram bot token, so it stays out of the message.
        .map_err(|error| format_management_request_error(&format!("Couldn't reach {service}"), &error.without_url()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    // The reason ends up on screen and in the alert history, so it's kept clear of the secrets.
    let detail = if status.is_redirection() {
        response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|location| location.to_str().ok())
            .map(redirect_detail)
            .unwrap_or_default()
    } else {
        refusal_detail(
            &response.text().await.unwrap_or_default(),
            &target.secret_values(),
        )
    };
    Err(if detail.is_empty() {
        format!("{service} refused the alert (HTTP {})", status.as_u16())
    } else {
        format!("{service} refused the alert (HTTP {}): {detail}", status.as_u16())
    })
}

fn phone_alert_request(
    client: &reqwest::Client,
    target: &PhoneAlertTarget,
    alert: &PhoneAlert,
    apis: &PhoneAlertApis<'_>,
) -> Result<reqwest::RequestBuilder, String> {
    let text = format!("{}\n{}", alert.title, alert.body);
    match target {
        PhoneAlertTarget::Ntfy { server, topic, token } => {
            let server = http_url(server, "ntfy server")?;
            let topic = topic.trim();
            if !is_ntfy_topic(topic) {
                return Err("An ntfy topic is 1 to 64 letters, digits, dashes or underscores".to_string());
            }
            // Published as JSON to the server's root, so titles needn't fit in a header.
            let request = client.post(server).json(&serde_json::json!({
                "topic": topic,
                "title": alert.title,
                "message": alert.body,
                // ntfy's "high" gets a longer vibration and a pop-over on Android.
                "priority": if alert.urgent { 4 } else { 3 },
            }));
            let token = token.trim();
            Ok(if token.is_empty() { request } else { request.bearer_auth(token) })
        }
        PhoneAlertTarget::Pushover { user_key, app_token } => {
            let (user_key, app_token) = (user_key.trim(), app_token.trim());
            if user_key.is_empty() || app_token.is_empty() {
                return Err("Pushover needs your user key and an application's API token".to_string());
            }
            // Normal priority either way: Pushover's high priority breaks through quiet hours.
            Ok(client
                .post(format!("{}/1/messages.json", apis.pushover))
                .json(&serde_json::json!({
                    "token": app_token,
                    "user": user_key,
                    "title": alert.title,
                    "message": alert.body,
                })))
        }
        PhoneAlertTarget::Telegram { bot_token, chat_id } => {
            let (bot_token, chat_id) = (bot_token.trim(), chat_id.trim());
            if bot_token.is_empty() {
                return Err("Telegram needs a bot token from @BotFather".to_string());
            }
            if !is_telegram_bot_token(bot_token) {
                return Err("A Telegram bot token looks like 123456789:AAE…, as @BotFather gives it".to_string());
            }
            if chat_id.is_empty() {
                return Err("Telegram needs the id of the chat to send to".to_string());
            }
            Ok(client
                .post(format!("{}/bot{bot_token}/sendMessage", apis.telegram))
                .json(&serde_json::json!({
                    "chat_id": chat_id,
                    "text": text,
                    "disable_web_page_preview": true,
                })))
        }
        PhoneAlertTarget::Webhook { url } => {
            if url.trim().is_empty() {
                return Err("The webhook needs a URL".to_string());
            }
            let url = http_url(url, "webhook URL")?;
            Ok(client.post(url).json(&serde_json::json!({
                "source": "arbor",
                "kind": alert.kind,
                "title": alert.title,
                "body": alert.body,
                "urgent": alert.urgent,
                "sentAt": chrono::Utc::now().to_rfc3339(),
                // What Slack and Discord incoming webhooks read, so they work as they are.
                "text": text,
                "content": text,
            })))
        }
    }
}

/// Where a redirect points, as far as the host: a webhook's new address often carries its token.
fn redirect_detail(location: &str) -> String {
    match reqwest::Url::parse(location) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => match url.host_str() {
            Some(host) => {
                let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
                format!("moved to {}://{host}{port}", url.scheme())
            }
            None => "moved".to_string(),
        },
        // A path on the same server, or something odd: either way, only that it moved.
        _ => "moved".to_string(),
    }
}

fn http_url(value: &str, what: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| format!("The {what} isn't a valid URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(format!("The {what} must start with http:// or https://"));
    }
    Ok(url)
}

/// ntfy's own rule for topic names.
fn is_ntfy_topic(topic: &str) -> bool {
    (1..=64).contains(&topic.len())
        && topic
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The bot's numeric id, a colon, then the secret. It goes into the request path, so nothing else passes.
fn is_telegram_bot_token(token: &str) -> bool {
    token.split_once(':').is_some_and(|(id, secret)| {
        !id.is_empty()
            && id.bytes().all(|byte| byte.is_ascii_digit())
            && !secret.is_empty()
            && secret
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

/// Why a service refused: ntfy answers `{"error": …}`, Pushover `{"errors": […]}` and
/// Telegram `{"description": …}`. Anything else is shown as it came, cut short. Secrets are hidden
/// before it's cut, so none is left half shown.
fn refusal_detail(body: &str, secrets: &[String]) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            if let Some(errors) = value.get("errors").and_then(|errors| errors.as_array()) {
                let errors: Vec<&str> = errors.iter().filter_map(|error| error.as_str()).collect();
                return (!errors.is_empty()).then(|| errors.join("; "));
            }
            value
                .get("description")
                .or_else(|| value.get("error"))
                .and_then(|detail| detail.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.split_whitespace().collect::<Vec<_>>().join(" "));
    let detail = without_secrets(&detail, secrets);
    if detail.chars().count() > REFUSAL_DETAIL_MAX {
        format!("{}…", detail.chars().take(REFUSAL_DETAIL_MAX - 1).collect::<String>().trim_end())
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;

    struct Captured {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Captured {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(header, _)| header == name)
                .map(|(_, value)| value.as_str())
        }

        fn json(&self) -> serde_json::Value {
            serde_json::from_str(&self.body).unwrap()
        }
    }

    /// A stand-in for the services: answers each request in turn with the given status and
    /// body, and hands the request back.
    fn serve(responses: Vec<(u16, &'static str)>) -> (String, mpsc::Receiver<Captured>) {
        serve_with_headers(responses.into_iter().map(|(status, body)| (status, "", body)).collect())
    }

    /// As `serve`, with extra header lines, each ending in CRLF, on each answer.
    fn serve_with_headers(
        responses: Vec<(u16, &'static str, &'static str)>,
    ) -> (String, mpsc::Receiver<Captured>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for (status, headers, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let _ = sender.send(read_request(&mut stream));
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        (base, receiver)
    }

    fn read_request(stream: &mut std::net::TcpStream) -> Captured {
        let mut data = Vec::new();
        let mut buffer = [0; 4096];
        let head_end = loop {
            if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                break data.len();
            }
            data.extend_from_slice(&buffer[..read]);
        };
        let head = String::from_utf8_lossy(&data[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next().unwrap_or_default().split_whitespace();
        let method = request_line.next().unwrap_or_default().to_string();
        let path = request_line.next().unwrap_or_default().to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let length = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse::<usize>().ok())
            .unwrap_or(0);
        while data.len() < head_end + length {
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            data.extend_from_slice(&buffer[..read]);
        }
        Captured {
            method,
            path,
            headers,
            body: String::from_utf8_lossy(&data[head_end..]).to_string(),
        }
    }

    fn alert(urgent: bool) -> PhoneAlert {
        PhoneAlert {
            title: "Cedar 01 is unreachable".to_string(),
            body: "No answer for 6 min · ssh: connect to host cedar-01 port 22".to_string(),
            kind: "machineDown".to_string(),
            urgent,
        }
    }

    fn send(target: &PhoneAlertTarget, alert: &PhoneAlert, apis: &PhoneAlertApis<'_>) -> Result<(), String> {
        let client = phone_alert_client_builder().no_proxy().build().unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(deliver_phone_alert(&client, target, alert, apis))
    }

    fn ntfy(server: &str, topic: &str, token: &str) -> PhoneAlertTarget {
        PhoneAlertTarget::Ntfy {
            server: server.to_string(),
            topic: topic.to_string(),
            token: token.to_string(),
        }
    }

    const NOWHERE: PhoneAlertApis<'static> = PhoneAlertApis {
        pushover: "http://127.0.0.1:9",
        telegram: "http://127.0.0.1:9",
    };

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("arbor-phone-{name}-{}-{stamp}", std::process::id()))
    }

    fn saved_secrets() -> PhoneAlertSecrets {
        PhoneAlertSecrets {
            ntfy_token: "tk_secret".to_string(),
            pushover_user_key: "u_secret".to_string(),
            pushover_app_token: "a_secret".to_string(),
            telegram_bot_token: "123:bot_secret".to_string(),
            webhook_url: "https://hooks.example/T0/secret".to_string(),
        }
    }

    fn route(value: serde_json::Value) -> PhoneAlertRoute {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn routes_from_the_window_are_filled_with_the_saved_secrets() {
        let secrets = saved_secrets();
        assert_eq!(
            route(serde_json::json!({ "service": "ntfy", "server": "https://ntfy.sh", "topic": "arbor-x" })).with_secrets(&secrets),
            ntfy("https://ntfy.sh", "arbor-x", "tk_secret")
        );
        assert_eq!(
            route(serde_json::json!({ "service": "pushover" })).with_secrets(&secrets),
            PhoneAlertTarget::Pushover { user_key: "u_secret".to_string(), app_token: "a_secret".to_string() }
        );
        assert_eq!(
            route(serde_json::json!({ "service": "telegram", "chatId": "42" })).with_secrets(&secrets),
            PhoneAlertTarget::Telegram { bot_token: "123:bot_secret".to_string(), chat_id: "42".to_string() }
        );
        // A URL from the window isn't used: only the saved one is.
        assert_eq!(
            route(serde_json::json!({ "service": "webhook", "url": "https://elsewhere.example" })).with_secrets(&secrets),
            PhoneAlertTarget::Webhook { url: "https://hooks.example/T0/secret".to_string() }
        );
        // Nothing saved yet: the send is refused before anything goes out.
        let target = route(serde_json::json!({ "service": "webhook" })).with_secrets(&PhoneAlertSecrets::default());
        assert_eq!(send(&target, &alert(false), &NOWHERE), Err("The webhook needs a URL".to_string()));
    }

    #[test]
    fn secrets_round_trip_through_their_file_and_only_their_status_is_shown() {
        let dir = temp_dir("round-trip");
        let path = dir.join("nested").join(PHONE_ALERT_SECRETS_FILE);
        assert_eq!(read_phone_alert_secrets(&path).unwrap(), PhoneAlertSecrets::default());

        let status = save_phone_alert_secret(&path, PhoneAlertSecret::NtfyToken, " tk_secret ").unwrap();
        assert_eq!(status, PhoneAlertSecretStatus { ntfy_token: true, ..Default::default() });
        let status = save_phone_alert_secret(&path, PhoneAlertSecret::WebhookUrl, "https://hooks.example/T0/secret").unwrap();
        assert_eq!(status, PhoneAlertSecretStatus { ntfy_token: true, webhook_url: true, ..Default::default() });
        let secrets = read_phone_alert_secrets(&path).unwrap();
        assert_eq!(secrets.ntfy_token, "tk_secret");
        assert_eq!(secrets.webhook_url, "https://hooks.example/T0/secret");

        // Empty clears.
        let status = save_phone_alert_secret(&path, PhoneAlertSecret::NtfyToken, "  ").unwrap();
        assert_eq!(status, PhoneAlertSecretStatus { webhook_url: true, ..Default::default() });
        assert_eq!(read_phone_alert_secrets(&path).unwrap().ntfy_token, "");

        // What goes back to the window, and any debug print, holds no values.
        let shown = format!(
            "{} {:?}",
            serde_json::to_string(&saved_secrets().status()).unwrap(),
            saved_secrets()
        );
        assert!(!shown.contains("secret"), "{shown}");
        assert_eq!(
            serde_json::to_value(PhoneAlertSecretStatus { pushover_app_token: true, ..Default::default() }).unwrap(),
            serde_json::json!({
                "ntfyToken": false, "pushoverUserKey": false, "pushoverAppToken": true,
                "telegramBotToken": false, "webhookUrl": false,
            })
        );

        // No temporary files are left behind.
        let names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, [PHONE_ALERT_SECRETS_FILE]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_secrets_file_is_only_readable_by_you() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("permissions");
        let path = dir.join(PHONE_ALERT_SECRETS_FILE);
        save_phone_alert_secret(&path, PhoneAlertSecret::TelegramBotToken, "123:bot_secret").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        // A file someone opened up is closed again on the next save.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        save_phone_alert_secret(&path, PhoneAlertSecret::PushoverUserKey, "u_secret").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(read_phone_alert_secrets(&path).unwrap().telegram_bot_token, "123:bot_secret");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_damaged_secrets_file_is_reported_without_what_is_in_it() {
        let dir = temp_dir("damaged");
        let path = dir.join(PHONE_ALERT_SECRETS_FILE);
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, r#""tk_secret""#).unwrap();
        let error = read_phone_alert_secrets(&path).unwrap_err();
        assert!(error.contains("can't be read"), "{error}");
        assert!(!error.contains("tk_secret"), "{error}");
        // Nor is it overwritten, which would lose the others.
        assert!(save_phone_alert_secret(&path, PhoneAlertSecret::NtfyToken, "new").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), r#""tk_secret""#);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ntfy_alerts_are_published_as_json_with_the_token_when_there_is_one() {
        let (base, requests) = serve(vec![(200, r#"{"id":"a1"}"#), (200, r#"{"id":"a2"}"#)]);

        send(&ntfy(&format!("{base}/"), " arbor-alerts_7 ", " tk_secret "), &alert(true), &NOWHERE).unwrap();
        let request = requests.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/"));
        assert_eq!(request.header("authorization"), Some("Bearer tk_secret"));
        assert_eq!(
            request.json(),
            serde_json::json!({
                "topic": "arbor-alerts_7",
                "title": "Cedar 01 is unreachable",
                "message": "No answer for 6 min · ssh: connect to host cedar-01 port 22",
                "priority": 4,
            })
        );

        send(&ntfy(&base, "arbor-alerts", ""), &alert(false), &NOWHERE).unwrap();
        let request = requests.recv().unwrap();
        assert_eq!(request.header("authorization"), None);
        assert_eq!(request.json()["priority"], 3);
    }

    #[test]
    fn pushover_and_telegram_get_their_own_api_shapes() {
        let (base, requests) = serve(vec![(200, r#"{"status":1}"#), (200, r#"{"ok":true}"#)]);
        let apis = PhoneAlertApis { pushover: &base, telegram: &base };

        let pushover = PhoneAlertTarget::Pushover {
            user_key: " uQiRzpo4DXghDmr9QzzfQu27cmVRsG ".to_string(),
            app_token: "azGDORePK8gMaC0QOYAMyEEuzJnyUi".to_string(),
        };
        send(&pushover, &alert(true), &apis).unwrap();
        let request = requests.recv().unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/1/messages.json"));
        assert_eq!(
            request.json(),
            serde_json::json!({
                "token": "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
                "user": "uQiRzpo4DXghDmr9QzzfQu27cmVRsG",
                "title": "Cedar 01 is unreachable",
                "message": "No answer for 6 min · ssh: connect to host cedar-01 port 22",
            })
        );

        let telegram = PhoneAlertTarget::Telegram {
            bot_token: "123456789:AAE-x_9".to_string(),
            chat_id: "-1001234".to_string(),
        };
        send(&telegram, &alert(false), &apis).unwrap();
        let request = requests.recv().unwrap();
        assert_eq!(request.path, "/bot123456789:AAE-x_9/sendMessage");
        assert_eq!(
            request.json(),
            serde_json::json!({
                "chat_id": "-1001234",
                "text": "Cedar 01 is unreachable\nNo answer for 6 min · ssh: connect to host cedar-01 port 22",
                "disable_web_page_preview": true,
            })
        );
    }

    #[test]
    fn webhooks_get_the_alert_and_the_fields_slack_and_discord_read() {
        let (base, requests) = serve(vec![(204, "")]);
        let webhook = PhoneAlertTarget::Webhook { url: format!("{base}/hooks/arbor?source=mac") };
        send(&webhook, &alert(true), &NOWHERE).unwrap();
        let request = requests.recv().unwrap();
        assert_eq!(request.path, "/hooks/arbor?source=mac");
        assert_eq!(request.header("content-type"), Some("application/json"));
        let body = request.json();
        let text = "Cedar 01 is unreachable\nNo answer for 6 min · ssh: connect to host cedar-01 port 22";
        assert_eq!(body["source"], "arbor");
        assert_eq!(body["kind"], "machineDown");
        assert_eq!(body["title"], "Cedar 01 is unreachable");
        assert_eq!(body["urgent"], true);
        assert_eq!((body["text"].as_str(), body["content"].as_str()), (Some(text), Some(text)));
        assert!(chrono::DateTime::parse_from_rfc3339(body["sentAt"].as_str().unwrap()).is_ok());
    }

    #[test]
    fn refusals_name_the_service_and_its_reason() {
        let (base, _requests) = serve(vec![
            (403, r#"{"code":40301,"http":403,"error":"forbidden","link":"https://ntfy.sh/docs/publish/#authentication"}"#),
            (400, r#"{"user":"invalid","errors":["user identifier is not a valid user, group, or subscribed user key"],"status":0}"#),
            (401, r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#),
            (500, "<html>\n  <body>Internal   error</body>\n</html>"),
            (301, ""),
        ]);
        let apis = PhoneAlertApis { pushover: &base, telegram: &base };

        assert_eq!(
            send(&ntfy(&base, "arbor", ""), &alert(false), &apis),
            Err("ntfy refused the alert (HTTP 403): forbidden".to_string())
        );
        let pushover = PhoneAlertTarget::Pushover { user_key: "u".to_string(), app_token: "a".to_string() };
        assert_eq!(
            send(&pushover, &alert(false), &apis),
            Err("Pushover refused the alert (HTTP 400): user identifier is not a valid user, group, or subscribed user key".to_string())
        );
        let telegram = PhoneAlertTarget::Telegram { bot_token: "1:secret".to_string(), chat_id: "2".to_string() };
        assert_eq!(
            send(&telegram, &alert(false), &apis),
            Err("Telegram refused the alert (HTTP 401): Unauthorized".to_string())
        );
        let webhook = PhoneAlertTarget::Webhook { url: format!("{base}/hook") };
        assert_eq!(
            send(&webhook, &alert(false), &apis),
            Err("The webhook refused the alert (HTTP 500): <html> <body>Internal error</body> </html>".to_string())
        );
        // A redirect isn't followed.
        assert_eq!(
            send(&webhook, &alert(false), &apis),
            Err("The webhook refused the alert (HTTP 301)".to_string())
        );
    }

    #[test]
    fn refusals_never_repeat_a_secret_the_server_sends_back() {
        let (base, _requests) = serve_with_headers(vec![
            // An http:// webhook sent on to https://, token and all.
            (301, "Location: https://hooks.example/api/webhooks/1/Zx8kQ2mNf7Lp4RtYw9\r\n", ""),
            // A 404 page that names the path it wasn't sent to.
            (404, "", "<pre>Cannot POST /api/webhooks/1/Zx8kQ2mNf7Lp4RtYw9</pre>"),
            (400, "", r#"{"error":"unknown webhook token Zx8kQ2mNf7Lp4RtYw9"}"#),
            (302, "Location: /api/webhooks/2/Zx8kQ2mNf7Lp4RtYw9\r\n", ""),
            (401, "", r#"{"error":"token tk_AgQdq7mVBCQ2pfTSk7fgHvlZQJLCn is not valid"}"#),
        ]);
        let webhook = PhoneAlertTarget::Webhook {
            url: format!("{base}/api/webhooks/1/Zx8kQ2mNf7Lp4RtYw9"),
        };
        let refusals = [
            "The webhook refused the alert (HTTP 301): moved to https://hooks.example",
            "The webhook refused the alert (HTTP 404): <pre>Cannot POST …</pre>",
            "The webhook refused the alert (HTTP 400): unknown webhook token …",
            "The webhook refused the alert (HTTP 302): moved",
        ];
        for expected in refusals {
            assert_eq!(send(&webhook, &alert(false), &NOWHERE), Err(expected.to_string()));
        }
        let ntfy = ntfy(&base, "arbor", "tk_AgQdq7mVBCQ2pfTSk7fgHvlZQJLCn");
        assert_eq!(
            send(&ntfy, &alert(false), &NOWHERE),
            Err("ntfy refused the alert (HTTP 401): token … is not valid".to_string())
        );
    }

    #[test]
    fn a_secret_is_hidden_wherever_it_is_and_short_words_are_left_alone() {
        let webhook = PhoneAlertTarget::Webhook {
            url: " https://hooks.example/services/T0/B0/XXXXXXXXXXXXXXXXXXXXXXXX?key=kkkkkkkkkkkkkkkkkkkk ".to_string(),
        };
        let secrets = webhook.secret_values();
        assert_eq!(
            without_secrets(
                "at https://hooks.example/services/T0/B0/XXXXXXXXXXXXXXXXXXXXXXXX?key=kkkkkkkkkkkkkkkkkkkk, \
                 /services/T0/B0/XXXXXXXXXXXXXXXXXXXXXXXX?key=kkkkkkkkkkkkkkkkkkkk, \
                 /services/T0/B0/XXXXXXXXXXXXXXXXXXXXXXXX, XXXXXXXXXXXXXXXXXXXXXXXX and kkkkkkkkkkkkkkkkkkkk",
                &secrets
            ),
            "at …, …, …, … and …"
        );
        // Nothing short enough to be an ordinary word is hidden.
        assert!(secrets.iter().all(|secret| secret.chars().count() >= SECRET_MIN_LEN), "{secrets:?}");
        let pushover = PhoneAlertTarget::Pushover { user_key: "u".to_string(), app_token: "a".to_string() };
        assert!(pushover.secret_values().is_empty());
        let telegram = PhoneAlertTarget::Telegram {
            bot_token: "123456789:AAEsecretpart".to_string(),
            chat_id: "42".to_string(),
        };
        assert_eq!(without_secrets("bot AAEsecretpart", &telegram.secret_values()), "bot …");
    }

    #[test]
    fn unreachable_services_are_reported_without_the_bot_token() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{closed}");
        let apis = PhoneAlertApis { pushover: &base, telegram: &base };
        let telegram = PhoneAlertTarget::Telegram {
            bot_token: "123456789:AAEsecretpart".to_string(),
            chat_id: "42".to_string(),
        };
        let error = send(&telegram, &alert(false), &apis).unwrap_err();
        assert!(error.starts_with("Couldn't reach Telegram"), "{error}");
        assert!(!error.contains("secretpart"), "{error}");
    }

    #[test]
    fn settings_are_checked_before_anything_is_sent() {
        let cases = [
            (ntfy("https://ntfy.sh", "has spaces", ""), "An ntfy topic is 1 to 64"),
            (ntfy("https://ntfy.sh", &"a".repeat(65), ""), "An ntfy topic is 1 to 64"),
            (ntfy("ntfy.sh", "arbor", ""), "The ntfy server isn't a valid URL"),
            (ntfy("ftp://ntfy.sh", "arbor", ""), "The ntfy server must start with http:// or https://"),
            (
                PhoneAlertTarget::Pushover { user_key: "u".to_string(), app_token: " ".to_string() },
                "Pushover needs your user key",
            ),
            (
                PhoneAlertTarget::Telegram { bot_token: "123:abc/../x".to_string(), chat_id: "1".to_string() },
                "A Telegram bot token looks like",
            ),
            (
                PhoneAlertTarget::Telegram { bot_token: " ".to_string(), chat_id: "1".to_string() },
                "Telegram needs a bot token",
            ),
            (
                PhoneAlertTarget::Telegram { bot_token: "123:abc".to_string(), chat_id: " ".to_string() },
                "Telegram needs the id of the chat",
            ),
            (PhoneAlertTarget::Webhook { url: "javascript:alert(1)".to_string() }, "The webhook URL must start with"),
        ];
        for (target, expected) in cases {
            let error = send(&target, &alert(false), &NOWHERE).unwrap_err();
            assert!(error.starts_with(expected), "{error}");
        }
    }
}
