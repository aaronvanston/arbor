//! Claude Code's own telemetry, sent to Arbor: what each session spends,
//! split by the skill, plugin, MCP server and subagent that spent it, which
//! the proxy's requests can't say.
//!
//! Claude Code exports OpenTelemetry metrics when its settings ask it to.
//! Arbor listens for them over OTLP's HTTP/JSON, only once it's turned on,
//! and keeps two counters, cost and tokens, added up by hour. Only metrics are
//! asked for, never logs or traces, so no prompt, reply, command or tool input
//! is ever sent. Claude Code's tool-detail switch stays off, so it names the
//! user's own skills, and built-in and official plugins and MCP servers, and
//! sends the rest as "custom" or "third-party".
//!
//! Each machine gets its own token, sent as a bearer header and kept here
//! only as its SHA-256, which is also how a request's machine is known.
//! Setting a machine up writes the export settings into the env of each of
//! its Claude Code homes' settings.json, the careful way the reporter's hooks
//! go in (see attention.rs); taking it away removes only what Arbor wrote.

use super::attention::{edit_claude_env, edit_claude_settings, SettingsEdit};
use ts_rs::TS;
use super::guarded_writes::ChangeKind;
use super::setup::{covered_machine, rescan, HomeAgent, ItemKind};
use super::setup_sync::sha256_hex;
use super::*;
use flate2::read::GzDecoder;
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use crate::core_config::is_loopback_host;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const SETTINGS_FILE: &str = "agent-telemetry.json";
pub(crate) const AGENT_TELEMETRY_UPDATED_EVENT: &str = "agent-telemetry-updated";
const DEFAULT_PORT: u16 = 8319;
const TOKEN_PREFIX: &str = "arbor_";
const HEAD_MAX: usize = 16 * 1024;
const BODY_MAX: usize = 4 << 20;
const INFLATED_MAX: u64 = 32 << 20;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// A request's head has to arrive quickly: nothing is known about the sender until it has.
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a connection waits for one of the slots before it's dropped.
const SLOT_WAIT: Duration = Duration::from_secs(5);
const CONNECTIONS: usize = 16;
/// How often the receiver checks whether the proxy is still open to the network.
const NETWORK_CHECK: Duration = Duration::from_secs(10);
/// More data points than a minute of every session on a machine sends.
const POINTS_MAX: usize = 20_000;
const NAME_MAX: usize = 200;
const HOUR_MS: i64 = 60 * 60_000;
const KEPT_MS: i64 = 90 * 24 * HOUR_MS;
/// A point stamped further from now than this is put in the hour it arrived.
const CLOCK_SLACK_MS: i64 = 7 * 24 * HOUR_MS;
const GROUP_MAX: usize = 50;

const ENABLE: &str = "CLAUDE_CODE_ENABLE_TELEMETRY";
const METRICS_EXPORTER: &str = "OTEL_METRICS_EXPORTER";
const PROTOCOL: &str = "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL";
const ENDPOINT: &str = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
const HEADERS: &str = "OTEL_EXPORTER_OTLP_METRICS_HEADERS";
const TEMPORALITY: &str = "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE";
const INCLUDE_VERSION: &str = "OTEL_METRICS_INCLUDE_VERSION";
/// Every env entry setting a machine up writes.
const EXPORT_ENV: [&str; 7] = [ENABLE, METRICS_EXPORTER, PROTOCOL, ENDPOINT, HEADERS, TEMPORALITY, INCLUDE_VERSION];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    enabled: bool,
    port: u16,
    machines: Vec<Grant>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: false, port: DEFAULT_PORT, machines: Vec::new() }
    }
}

/// A machine that was given a token.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Grant {
    machine: String,
    token_sha256: String,
    since_ms: i64,
    /// The port its homes were told to send to.
    #[serde(default = "default_port")]
    port: u16,
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn settings_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(SETTINGS_FILE))
}

fn read_settings(path: &Path) -> Result<Settings, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("{} isn't valid: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(format!("Couldn't read {}: {error}", path.display())),
    }
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temp = path.with_file_name(format!(".{SETTINGS_FILE}.tmp.{}", std::process::id()));
    fs::write(&temp, format!("{text}\n")).map_err(|error| format!("Couldn't save {}: {error}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temp, path).map_err(|error| format!("Couldn't save {}: {error}", path.display()))
}

/// Reads, changes and saves the settings, one change at a time.
fn update_settings<T>(path: &Path, change: impl FnOnce(&mut Settings) -> Result<T, String>) -> Result<T, String> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = read_settings(path)?;
    let result = change(&mut settings)?;
    write_settings(path, &settings)?;
    Ok(result)
}

fn new_token() -> Result<String, String> {
    let mut random = [0_u8; 24];
    getrandom::fill(&mut random).map_err(|error| format!("Couldn't make a token: {error}"))?;
    Ok(format!("{TOKEN_PREFIX}{}", random.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

// ---------------------------------------------------------------------------
// The receiver
// ---------------------------------------------------------------------------

#[derive(Default)]
pub(crate) struct TelemetryState {
    inner: Mutex<Runtime>,
    /// One restart at a time, so two can't race for the port.
    restarts: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Runtime {
    stop: Option<CancellationToken>,
    /// The listener's task, which holds the port until it ends.
    serving: Option<tauri::async_runtime::JoinHandle<()>>,
    listening: Option<String>,
    error: Option<String>,
    /// Token hash to machine.
    grants: HashMap<String, String>,
    seen: HashMap<String, Seen>,
    pruned_at_ms: i64,
}

#[derive(Clone, Default)]
struct Seen {
    last_ms: i64,
    requests: u64,
    /// It sent running totals, which Arbor can't add up.
    cumulative: bool,
}

impl TelemetryState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Where the receiver listens: where the proxy does, so the machines that
/// reach the proxy can reach it too, and nothing else.
fn bind(port: u16, host: &str) -> std::io::Result<(std::net::TcpListener, String)> {
    if is_loopback_host(host) {
        return std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).map(|listener| (listener, format!("127.0.0.1:{port}")));
    }
    let address: IpAddr = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("the proxy's listen address {host} isn't an IP address")))?;
    if address.is_unspecified() {
        // An IPv6 socket takes IPv4 too on macOS; a Mac without IPv6 gets IPv4 alone.
        return std::net::TcpListener::bind((Ipv6Addr::UNSPECIFIED, port))
            .or_else(|_| std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)))
            .map(|listener| (listener, format!("*:{port}")));
    }
    std::net::TcpListener::bind((address, port)).map(|listener| (listener, std::net::SocketAddr::new(address, port).to_string()))
}

/// The address the proxy listens on, which the receiver follows.
fn listen_host(app: &tauri::AppHandle) -> String {
    app.state::<GuiConfigState>().snapshot().map(|config| config.host).unwrap_or_else(|_| "127.0.0.1".into())
}

/// Starts the receiver as the settings say, stopping the one before.
pub(crate) async fn restart(app: &tauri::AppHandle) {
    let state = app.state::<TelemetryState>();
    let _one_at_a_time = state.restarts.lock().await;
    let previous = {
        let mut runtime = state.lock();
        if let Some(stop) = runtime.stop.take() {
            stop.cancel();
        }
        runtime.listening = None;
        runtime.error = None;
        runtime.serving.take()
    };
    // The old listener has to close before its port can be taken again.
    if let Some(previous) = previous {
        let _ = previous.await;
    }
    // Read only now, so a machine set up while the old listener closed isn't lost.
    let settings = settings_path().and_then(|path| read_settings(&path));
    let host = listen_host(app);
    let mut runtime = state.lock();
    let settings = match settings {
        Ok(settings) => settings,
        Err(error) => {
            runtime.error = Some(error);
            return;
        }
    };
    runtime.grants = settings.machines.iter().map(|grant| (grant.token_sha256.clone(), grant.machine.clone())).collect();
    if !settings.enabled {
        return;
    }
    let (listener, address) = match bind(settings.port, &host).and_then(|(listener, address)| listener.set_nonblocking(true).map(|()| (listener, address))) {
        Ok(bound) => bound,
        Err(error) => {
            runtime.error = Some(format!("Arbor couldn't listen on port {}: {error}", settings.port));
            return;
        }
    };
    let stop = CancellationToken::new();
    runtime.stop = Some(stop.clone());
    runtime.listening = Some(address);
    let app = app.clone();
    runtime.serving = Some(tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => serve(listener, host, app, stop).await,
            Err(error) => {
                let state = app.state::<TelemetryState>();
                let mut runtime = state.lock();
                runtime.listening = None;
                runtime.error = Some(format!("Arbor couldn't listen: {error}"));
            }
        }
    }));
}

/// Restarts the receiver from its own listener. A plain function, so the two
/// futures don't each hold the other.
fn restart_later(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move { restart(&app).await });
}

/// Takes the grants from the saved settings without listening again.
fn reload_grants(app: &tauri::AppHandle) {
    if let Ok(settings) = settings_path().and_then(|path| read_settings(&path)) {
        app.state::<TelemetryState>().lock().grants =
            settings.machines.iter().map(|grant| (grant.token_sha256.clone(), grant.machine.clone())).collect();
    }
}

enum Wake {
    Stop,
    Check,
    Accepted(std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>),
}

async fn serve(listener: tokio::net::TcpListener, host: String, app: tauri::AppHandle, stop: CancellationToken) {
    let slots = Arc::new(tokio::sync::Semaphore::new(CONNECTIONS));
    let mut check = tokio::time::interval(NETWORK_CHECK);
    check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let wake = tokio::select! {
            _ = stop.cancelled() => Wake::Stop,
            _ = check.tick() => Wake::Check,
            accepted = listener.accept() => Wake::Accepted(accepted),
        };
        let accepted = match wake {
            Wake::Stop => return,
            // The proxy's listen address changed in Settings › Network: listen where it now does.
            Wake::Check if listen_host(&app) != host => {
                drop(listener);
                restart_later(app);
                return;
            }
            Wake::Check => continue,
            Wake::Accepted(accepted) => accepted,
        };
        let Ok((mut stream, _)) = accepted else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        // Past a handful at once, a connection waits a little for a slot, then is dropped and its exporter tries again.
        let permit = tokio::select! {
            _ = stop.cancelled() => return,
            permit = tokio::time::timeout(SLOT_WAIT, slots.clone().acquire_owned()) => permit,
        };
        let Ok(Ok(permit)) = permit else {
            continue;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let status = match answer(&app, &mut stream).await {
                Ok(status) | Err(status) => status,
            };
            let _ = tokio::time::timeout(Duration::from_secs(5), stream.write_all(&reply(status))).await;
            let _ = stream.shutdown().await;
        });
    }
}

/// Reads a request and takes its metrics. Who sent it is settled from the head
/// alone, so a sender without a token never gets its body read.
async fn answer<S: AsyncRead + Unpin>(app: &tauri::AppHandle, stream: &mut S) -> Result<u16, u16> {
    let (mut request, rest) = tokio::time::timeout(HEAD_TIMEOUT, read_head(stream)).await.map_err(|_| 408_u16)??;
    let grants = app.state::<TelemetryState>().lock().grants.clone();
    let machine = authorize(&request, &grants)?;
    request.body = tokio::time::timeout(REQUEST_TIMEOUT, read_body(stream, &request, rest)).await.map_err(|_| 408_u16)??;
    Ok(receive(app, machine, &request).await)
}

async fn receive(app: &tauri::AppHandle, machine: String, request: &Request) -> u16 {
    let parsed = match accept(request) {
        Ok(parsed) => parsed,
        Err(status) => return status,
    };
    let now_ms = Local::now().timestamp_millis();
    let prune = {
        let state = app.state::<TelemetryState>();
        let mut runtime = state.lock();
        let due = now_ms - runtime.pruned_at_ms >= HOUR_MS;
        if due {
            runtime.pruned_at_ms = now_ms;
        }
        due
    };
    let points = parsed.points;
    let owner = machine.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        let mut connection = open_usage_database()?;
        record(&mut connection, &owner, &points, now_ms, prune)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if stored.is_err() {
        // The exporter sends it again after a 503.
        return 503;
    }
    {
        let state = app.state::<TelemetryState>();
        let mut runtime = state.lock();
        let seen = runtime.seen.entry(machine).or_default();
        seen.last_ms = now_ms;
        seen.requests += 1;
        seen.cumulative = parsed.cumulative;
    }
    let _ = app.emit(AGENT_TELEMETRY_UPDATED_EVENT, now_ms);
    200
}

// ---------------------------------------------------------------------------
// HTTP, just enough of it
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// Reads more into `buffer`, failing at the end of the stream.
async fn fill<R: AsyncRead + Unpin>(reader: &mut R, buffer: &mut Vec<u8>) -> Result<(), u16> {
    let mut chunk = [0_u8; 16 * 1024];
    let read = reader.read(&mut chunk).await.map_err(|_| 400_u16)?;
    if read == 0 {
        return Err(400);
    }
    buffer.extend_from_slice(&chunk[..read]);
    Ok(())
}

/// A request's head, and whatever of its body came in with it. The body is
/// read by `read_body` once the sender is known.
async fn read_head<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(Request, Vec<u8>), u16> {
    let mut buffer = Vec::with_capacity(8 * 1024);
    let head_end = loop {
        if let Some(at) = find(&buffer, b"\r\n\r\n") {
            break at;
        }
        if buffer.len() > HEAD_MAX {
            return Err(431);
        }
        fill(reader, &mut buffer).await?;
    };
    if head_end > HEAD_MAX {
        return Err(431);
    }
    let head = std::str::from_utf8(&buffer[..head_end]).map_err(|_| 400_u16)?;
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let method = start.next().unwrap_or_default().to_string();
    let path = start.next().unwrap_or_default().to_string();
    if method.is_empty() || !path.starts_with('/') {
        return Err(400);
    }
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();
    let rest = buffer.split_off(head_end + 4);
    Ok((Request { method, path, headers, body: Vec::new() }, rest))
}

/// The body, sized by Content-Length or sent in chunks, as Node sends a
/// streamed one.
async fn read_body<R: AsyncRead + Unpin>(reader: &mut R, request: &Request, mut rest: Vec<u8>) -> Result<Vec<u8>, u16> {
    let chunked = request.header("transfer-encoding").is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
    if chunked {
        return read_chunks(reader, rest).await;
    }
    let Some(length) = request.header("content-length") else {
        return Ok(Vec::new());
    };
    let length: usize = length.parse().map_err(|_| 400_u16)?;
    if length > BODY_MAX {
        return Err(413);
    }
    while rest.len() < length {
        fill(reader, &mut rest).await?;
    }
    rest.truncate(length);
    Ok(rest)
}

async fn read_chunks<R: AsyncRead + Unpin>(reader: &mut R, mut buffer: Vec<u8>) -> Result<Vec<u8>, u16> {
    let mut body = Vec::new();
    loop {
        let line_end = loop {
            if let Some(at) = find(&buffer, b"\r\n") {
                break at;
            }
            if buffer.len() > 1024 {
                return Err(400);
            }
            fill(reader, &mut buffer).await?;
        };
        let line = std::str::from_utf8(&buffer[..line_end]).map_err(|_| 400_u16)?;
        let size = usize::from_str_radix(line.split(';').next().unwrap_or_default().trim(), 16).map_err(|_| 400_u16)?;
        buffer.drain(..line_end + 2);
        if size == 0 {
            // Trailers, if any, end with an empty line.
            loop {
                if buffer.starts_with(b"\r\n") {
                    return Ok(body);
                }
                if let Some(at) = find(&buffer, b"\r\n") {
                    buffer.drain(..at + 2);
                    continue;
                }
                if buffer.len() > 1024 {
                    return Err(400);
                }
                fill(reader, &mut buffer).await?;
            }
        }
        // Compared this way round, a huge chunk size can't overflow.
        if size > BODY_MAX - body.len() {
            return Err(413);
        }
        while buffer.len() < size + 2 {
            fill(reader, &mut buffer).await?;
        }
        body.extend_from_slice(&buffer[..size]);
        buffer.drain(..size + 2);
    }
}

fn reply(status: u16) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    // An empty ExportMetricsServiceResponse: everything was taken.
    let body = if status == 200 { "{}" } else { "" };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Whose metrics these are, from the head alone, or the status to refuse them with.
fn authorize(request: &Request, grants: &HashMap<String, String>) -> Result<String, u16> {
    if request.path.split('?').next() != Some("/v1/metrics") {
        return Err(404);
    }
    if request.method != "POST" {
        return Err(405);
    }
    let token = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| token.starts_with(TOKEN_PREFIX))
        .ok_or(401_u16)?;
    grants.get(&sha256_hex(token.as_bytes())).cloned().ok_or(401_u16)
}

/// What a request from a known machine holds, or the status to refuse it with.
fn accept(request: &Request) -> Result<Parsed, u16> {
    if !request.header("content-type").unwrap_or_default().to_ascii_lowercase().starts_with("application/json") {
        return Err(415);
    }
    let inflated;
    let body: &[u8] = match request.header("content-encoding").map(|value| value.trim().to_ascii_lowercase()).as_deref() {
        None | Some("") | Some("identity") => &request.body,
        Some("gzip") => {
            let mut out = Vec::new();
            GzDecoder::new(request.body.as_slice()).take(INFLATED_MAX + 1).read_to_end(&mut out).map_err(|_| 400_u16)?;
            if out.len() as u64 > INFLATED_MAX {
                return Err(413);
            }
            inflated = out;
            &inflated
        }
        Some(_) => return Err(415),
    };
    parse_metrics(body).map_err(|_| 400_u16)
}

// ---------------------------------------------------------------------------
// OTLP metrics
// ---------------------------------------------------------------------------

/// The names a point is added up by. Empty means Claude Code didn't say.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct Key {
    session: String,
    version: String,
    model: String,
    source: String,
    agent: String,
    skill: String,
    plugin: String,
    marketplace: String,
    mcp_server: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Point {
    at_ms: Option<i64>,
    key: Key,
    cost: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,
}

#[derive(Debug, Default, PartialEq)]
struct Parsed {
    points: Vec<Point>,
    cumulative: bool,
}

/// A name as it's kept: no control characters, and not too long.
fn clean(value: &str) -> String {
    value.chars().filter(|character| !character.is_control()).take(NAME_MAX).collect::<String>().trim().to_string()
}

/// The attributes kept, and nothing else: no account, email, organization or terminal.
fn attribute_text(attributes: &Value, into: &mut HashMap<&'static str, String>) {
    const KEPT: [&str; 10] = [
        "session.id",
        "app.version",
        "model",
        "query_source",
        "agent.name",
        "skill.name",
        "plugin.name",
        "marketplace.name",
        "mcp_server.name",
        "type",
    ];
    for attribute in attributes.as_array().into_iter().flatten() {
        let Some(name) = attribute.get("key").and_then(Value::as_str) else {
            continue;
        };
        let Some(kept) = KEPT.iter().find(|kept| **kept == name) else {
            continue;
        };
        if let Some(text) = attribute.pointer("/value/stringValue").and_then(Value::as_str) {
            into.insert(kept, clean(text));
        }
    }
}

/// A number as OTLP's JSON writes one: a number, or a 64-bit one as text.
fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn parse_metrics(body: &[u8]) -> Result<Parsed, String> {
    let root: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    let mut parsed = Parsed::default();
    for resource in root.get("resourceMetrics").and_then(Value::as_array).into_iter().flatten() {
        let mut shared = HashMap::new();
        attribute_text(resource.pointer("/resource/attributes").unwrap_or(&Value::Null), &mut shared);
        let scopes = resource.get("scopeMetrics").or_else(|| resource.get("instrumentationLibraryMetrics"));
        for scope in scopes.and_then(Value::as_array).into_iter().flatten() {
            for metric in scope.get("metrics").and_then(Value::as_array).into_iter().flatten() {
                let cost = match metric.get("name").and_then(Value::as_str) {
                    Some("claude_code.cost.usage") => true,
                    Some("claude_code.token.usage") => false,
                    _ => continue,
                };
                let Some(sum) = metric.get("sum") else {
                    continue;
                };
                let cumulative = match sum.get("aggregationTemporality") {
                    Some(Value::Number(number)) => number.as_u64() == Some(2),
                    Some(Value::String(text)) => text.ends_with("CUMULATIVE"),
                    _ => false,
                };
                if cumulative {
                    parsed.cumulative = true;
                    continue;
                }
                for point in sum.get("dataPoints").and_then(Value::as_array).into_iter().flatten() {
                    let Some(value) = number(point.get("asDouble")).or_else(|| number(point.get("asInt"))) else {
                        continue;
                    };
                    if !value.is_finite() || value <= 0.0 {
                        continue;
                    }
                    let mut names = shared.clone();
                    attribute_text(point.get("attributes").unwrap_or(&Value::Null), &mut names);
                    let mut take = |name: &str| names.remove(name).unwrap_or_default();
                    let mut entry = Point {
                        at_ms: number(point.get("timeUnixNano")).map(|nanos| (nanos / 1_000_000.0) as i64),
                        key: Key {
                            session: take("session.id"),
                            version: take("app.version"),
                            model: take("model"),
                            source: take("query_source"),
                            agent: take("agent.name"),
                            skill: take("skill.name"),
                            plugin: take("plugin.name"),
                            marketplace: take("marketplace.name"),
                            mcp_server: take("mcp_server.name"),
                        },
                        ..Point::default()
                    };
                    if cost {
                        entry.cost = value;
                    } else {
                        match take("type").as_str() {
                            "input" => entry.input = value,
                            "output" => entry.output = value,
                            "cacheRead" => entry.cache_read = value,
                            "cacheCreation" => entry.cache_creation = value,
                            _ => continue,
                        }
                    }
                    parsed.points.push(entry);
                    if parsed.points.len() > POINTS_MAX {
                        return Err("too many data points".into());
                    }
                }
            }
        }
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn hour_of(at_ms: Option<i64>, now_ms: i64) -> i64 {
    let at = at_ms.filter(|at| (at - now_ms).abs() <= CLOCK_SLACK_MS).unwrap_or(now_ms);
    at - at.rem_euclid(HOUR_MS)
}

/// Adds the points to their hours. Returns how many hour rows changed.
fn record(connection: &mut Connection, machine: &str, points: &[Point], now_ms: i64, prune: bool) -> Result<usize, String> {
    let mut hours: BTreeMap<(i64, &Key), [f64; 5]> = BTreeMap::new();
    for point in points {
        let sums = hours.entry((hour_of(point.at_ms, now_ms), &point.key)).or_default();
        for (sum, value) in sums.iter_mut().zip([point.cost, point.input, point.output, point.cache_read, point.cache_creation]) {
            *sum += value;
        }
    }
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO usage_agent_telemetry (hour_ms, machine, session_id, version, model, source, agent, skill, plugin, marketplace, mcp_server,
                    cost, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT DO UPDATE SET
                    cost = cost + excluded.cost,
                    input_tokens = input_tokens + excluded.input_tokens,
                    output_tokens = output_tokens + excluded.output_tokens,
                    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
                    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens",
            )
            .map_err(|error| error.to_string())?;
        for ((hour, key), [cost, input, output, cache_read, cache_creation]) in &hours {
            insert
                .execute(params![
                    hour,
                    machine,
                    key.session,
                    key.version,
                    key.model,
                    key.source,
                    key.agent,
                    key.skill,
                    key.plugin,
                    key.marketplace,
                    key.mcp_server,
                    cost,
                    input,
                    output,
                    cache_read,
                    cache_creation
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    if prune {
        transaction
            .execute("DELETE FROM usage_agent_telemetry WHERE hour_ms < ?1", params![now_ms - KEPT_MS])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(hours.len())
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spend {
    pub(crate) cost: f64,
    pub(crate) input_tokens: f64,
    pub(crate) output_tokens: f64,
    pub(crate) cache_read_tokens: f64,
    pub(crate) cache_creation_tokens: f64,
    pub(crate) sessions: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpendGroup {
    pub(crate) name: String,
    #[serde(flatten)]
    pub(crate) spend: Spend,
}

/// What Claude Code spent over a time, split every way it says.
#[derive(Clone, Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelemetryBreakdown {
    pub(crate) total: Spend,
    pub(crate) machines: Vec<SpendGroup>,
    pub(crate) skills: Vec<SpendGroup>,
    pub(crate) plugins: Vec<SpendGroup>,
    pub(crate) mcp_servers: Vec<SpendGroup>,
    pub(crate) agents: Vec<SpendGroup>,
    pub(crate) sources: Vec<SpendGroup>,
    pub(crate) models: Vec<SpendGroup>,
    pub(crate) versions: Vec<SpendGroup>,
    pub(crate) first_hour_ms: Option<i64>,
    pub(crate) last_hour_ms: Option<i64>,
}

const SPEND: &str =
    "SUM(cost), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), COUNT(DISTINCT NULLIF(session_id, ''))";
/// Hours that end after `from` and start before `to`, on one machine or all.
const WITHIN: &str = "hour_ms > ?1 - 3600000 AND hour_ms < ?2 AND (?3 IS NULL OR machine = ?3)";

fn spend(row: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<Spend> {
    Ok(Spend {
        cost: row.get::<_, Option<f64>>(at)?.unwrap_or_default(),
        input_tokens: row.get::<_, Option<f64>>(at + 1)?.unwrap_or_default(),
        output_tokens: row.get::<_, Option<f64>>(at + 2)?.unwrap_or_default(),
        cache_read_tokens: row.get::<_, Option<f64>>(at + 3)?.unwrap_or_default(),
        cache_creation_tokens: row.get::<_, Option<f64>>(at + 4)?.unwrap_or_default(),
        sessions: row.get::<_, i64>(at + 5)?.max(0) as u64,
    })
}

fn breakdown(connection: &Connection, from_ms: i64, to_ms: i64, machine: Option<&str>) -> Result<TelemetryBreakdown, String> {
    let error = |error: rusqlite::Error| error.to_string();
    let (total, first_hour_ms, last_hour_ms) = connection
        .query_row(&format!("SELECT {SPEND}, MIN(hour_ms), MAX(hour_ms) FROM usage_agent_telemetry WHERE {WITHIN}"), params![from_ms, to_ms, machine], |row| {
            Ok((spend(row, 0)?, row.get::<_, Option<i64>>(6)?, row.get::<_, Option<i64>>(7)?))
        })
        .map_err(error)?;
    // Columns come from this list only, never from the caller.
    let group = |column: &str, named_only: bool| -> Result<Vec<SpendGroup>, String> {
        let named = if named_only { format!(" AND {column} <> ''") } else { String::new() };
        let mut statement = connection
            .prepare(&format!(
                "SELECT {column}, {SPEND} FROM usage_agent_telemetry WHERE {WITHIN}{named} GROUP BY {column} ORDER BY SUM(cost) DESC, SUM(input_tokens + output_tokens) DESC LIMIT {GROUP_MAX}"
            ))
            .map_err(error)?;
        let rows = statement
            .query_map(params![from_ms, to_ms, machine], |row| Ok(SpendGroup { name: row.get(0)?, spend: spend(row, 1)? }))
            .map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    };
    Ok(TelemetryBreakdown {
        total,
        machines: group("machine", false)?,
        skills: group("skill", true)?,
        plugins: group("plugin", true)?,
        mcp_servers: group("mcp_server", true)?,
        agents: group("agent", true)?,
        sources: group("source", false)?,
        models: group("model", true)?,
        versions: group("version", true)?,
        first_hour_ms,
        last_hour_ms,
    })
}

/// The last hour each machine sent something in.
fn last_hours(connection: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut statement = connection
        .prepare("SELECT machine, MAX(hour_ms) FROM usage_agent_telemetry GROUP BY machine")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>().map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// A machine's settings
// ---------------------------------------------------------------------------

/// Where a machine's Claude Code sends its metrics, and with what.
struct Export {
    token: String,
    port: u16,
    /// This Mac: loopback works, and is what its agents use.
    local: bool,
    /// The core's port. A base URL on it is this Mac as the machine reaches it.
    core_port: Option<u16>,
    /// This Mac's address for a machine whose agents don't say.
    fallback: Option<String>,
}

/// This Mac's address for another machine: the one the proxy listens on, or
/// its LAN address when it listens on all of them.
pub(super) fn remote_address(host: &str) -> Option<String> {
    let address: IpAddr = host.trim_start_matches('[').trim_end_matches(']').parse().ok()?;
    if address.is_unspecified() {
        return crate::core_config::detect_lan_ipv4().map(|address| address.to_string());
    }
    Some(match address {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => format!("[{address}]"),
    })
}

/// The host and port in a URL like http://host:8317/v1.
fn url_host(url: &str) -> Option<(String, Option<u16>)> {
    let rest = url.trim().split_once("://").map_or(url.trim(), |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    if let Some(inside) = authority.strip_prefix('[') {
        let (host, after) = inside.split_once(']')?;
        let port = after.strip_prefix(':').and_then(|port| port.parse().ok());
        return Some((format!("[{host}]"), port));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()),
        None => (authority, None),
    };
    (!host.is_empty()).then(|| (host.to_string(), port))
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.starts_with("127.") || host == "[::1]"
}

fn env_value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
}

fn set_env(env: &mut Vec<(String, String)>, name: &str, value: String) {
    match env.iter_mut().find(|(key, _)| key == name) {
        Some((_, current)) => *current = value,
        None => env.push((name.to_string(), value)),
    }
}

/// Whether this env entry is one Arbor writes, still set as Arbor sets it.
fn arbor_wrote(key: &str, value: &str) -> bool {
    match key {
        METRICS_EXPORTER => value == "otlp",
        PROTOCOL => value == "http/json",
        TEMPORALITY => value == "delta",
        INCLUDE_VERSION => value == "true",
        // Arbor's own endpoint and token, since the export is Arbor's.
        ENDPOINT | HEADERS => true,
        _ => false,
    }
}

/// Whether a settings env entry is the per-machine part of Arbor's telemetry:
/// each machine has its own token, and this Mac its own endpoint, so Setup
/// compares them as one setting rather than as drift.
pub(super) fn per_machine_telemetry(env: &serde_json::Map<String, Value>, name: &str) -> bool {
    (name == HEADERS || name == ENDPOINT)
        && env.get(HEADERS).and_then(Value::as_str).is_some_and(|headers| headers.starts_with(&format!("Authorization=Bearer {TOKEN_PREFIX}")))
}

/// Whether the metrics export in this env is the one Arbor wrote.
fn is_ours(env: &[(String, String)]) -> bool {
    env_value(env, HEADERS).is_some_and(|headers| headers.starts_with(&format!("Authorization=Bearer {TOKEN_PREFIX}")))
}

/// The settings with Arbor's metrics export written in, or taken out when
/// `export` is None. Records the endpoint each file is given.
fn telemetry_settings(content: Option<&str>, export: Option<&Export>, endpoints: &Mutex<BTreeSet<String>>) -> Result<Option<String>, String> {
    edit_claude_env(content, |env| {
        let ours = is_ours(env);
        let Some(export) = export else {
            if !ours {
                return Ok(());
            }
            // Only what still holds the value Arbor wrote comes out; the user's own choices stay.
            env.retain(|(key, value)| !arbor_wrote(key, value));
            // Telemetry stays on for logs or traces the user sends elsewhere.
            let others = ["OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER"]
                .iter()
                .any(|name| env_value(env, name).is_some_and(|value| !value.trim().is_empty() && value.trim() != "none"));
            if !others {
                env.retain(|(key, value)| !(key == ENABLE && value == "1"));
            }
            return Ok(());
        };
        let elsewhere = env_value(env, METRICS_EXPORTER).is_some_and(|value| !value.trim().is_empty() && value.trim() != "none")
            || env_value(env, ENDPOINT).is_some();
        if elsewhere && !ours {
            return Err("Its Claude Code already sends its metrics somewhere else, so Arbor left it alone".into());
        }
        let base = env_value(env, "ANTHROPIC_BASE_URL").and_then(url_host);
        let host = base
            .filter(|(host, port)| (export.local || !is_loopback(host)) && export.core_port.is_some() && *port == export.core_port)
            .map(|(host, _)| host)
            .or_else(|| export.fallback.clone())
            .ok_or_else(|| "Arbor doesn't know how this machine reaches this Mac. Point its agents at Arbor first.".to_string())?;
        let endpoint = format!("http://{host}:{}/v1/metrics", export.port);
        endpoints.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(endpoint.clone());
        set_env(env, ENABLE, "1".into());
        set_env(env, METRICS_EXPORTER, "otlp".into());
        set_env(env, PROTOCOL, "http/json".into());
        set_env(env, ENDPOINT, endpoint);
        set_env(env, HEADERS, format!("Authorization=Bearer {}", export.token));
        set_env(env, TEMPORALITY, "delta".into());
        set_env(env, INCLUDE_VERSION, "true".into());
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachineTelemetry {
    machine: String,
    since_ms: i64,
    last_ms: Option<i64>,
    /// Requests since Arbor started.
    requests: u64,
    cumulative: bool,
    /// The port its homes send to, when that isn't where Arbor listens now.
    stale_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelemetryStatus {
    enabled: bool,
    port: u16,
    /// Where it listens, like *:8319, or None when it isn't.
    listening: Option<String>,
    error: Option<String>,
    /// Whether other machines can reach it: the proxy is open to the network.
    lan: bool,
    machines: Vec<MachineTelemetry>,
}

fn status(app: &tauri::AppHandle) -> Result<TelemetryStatus, String> {
    let settings = read_settings(&settings_path()?)?;
    let last = open_usage_database().and_then(|connection| last_hours(&connection)).unwrap_or_default();
    let state = app.state::<TelemetryState>();
    let runtime = state.lock();
    // A machine can hold two tokens while one of its homes hasn't taken the new one.
    let mut machines: Vec<MachineTelemetry> = Vec::new();
    for grant in &settings.machines {
        if let Some(entry) = machines.iter_mut().find(|entry| entry.machine == grant.machine) {
            entry.since_ms = entry.since_ms.min(grant.since_ms);
            // The newest grant says where its homes were last told to send.
            entry.stale_port = (grant.port != settings.port).then_some(grant.port);
            continue;
        }
        let seen = runtime.seen.get(&grant.machine).cloned().unwrap_or_default();
        let stored = last.get(&grant.machine).copied();
        machines.push(MachineTelemetry {
            machine: grant.machine.clone(),
            since_ms: grant.since_ms,
            last_ms: (seen.last_ms > 0).then_some(seen.last_ms).or(stored),
            requests: seen.requests,
            cumulative: seen.cumulative,
            stale_port: (grant.port != settings.port).then_some(grant.port),
        });
    }
    Ok(TelemetryStatus {
        enabled: settings.enabled,
        port: settings.port,
        listening: runtime.listening.clone(),
        error: runtime.error.clone(),
        lan: !is_loopback_host(&listen_host(app)),
        machines,
    })
}

#[tauri::command]
pub(crate) async fn get_agent_telemetry(app: tauri::AppHandle) -> Result<TelemetryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.map_err(|error| error.to_string())?
}

/// Turns the receiver on or off, on a port of its own.
#[tauri::command]
pub(crate) async fn set_agent_telemetry(app: tauri::AppHandle, enabled: bool, port: u16) -> Result<TelemetryStatus, String> {
    if port < 1024 {
        return Err("Pick a port from 1024 up".into());
    }
    let core_port = app.state::<GuiConfigState>().snapshot().map(|config| config.port).ok();
    if core_port == Some(port) {
        return Err("That's the proxy's port. Pick another".into());
    }
    update_settings(&settings_path()?, |settings| {
        settings.enabled = enabled;
        settings.port = port;
        Ok(())
    })?;
    restart(&app).await;
    let _ = app.emit(AGENT_TELEMETRY_UPDATED_EVENT, Local::now().timestamp_millis());
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.map_err(|error| error.to_string())?
}

/// What setting a machine up did, or would do.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelemetrySetup {
    /// Where its homes send their metrics.
    endpoints: Vec<String>,
    files: Vec<SettingsEdit>,
}

/// Sets Claude Code up to send its metrics to Arbor in every home on a
/// machine, with a new token, or takes that away. `plan` only says what would
/// change. Afterward the machine is scanned again.
#[tauri::command]
pub(crate) async fn set_machine_telemetry(
    app: tauri::AppHandle,
    state: tauri::State<'_, MachineHealthState>,
    machine: String,
    enabled: bool,
    plan: Option<bool>,
) -> Result<TelemetrySetup, String> {
    let (target, homes) = {
        let inner = state.lock();
        let (target, setup) = covered_machine(&inner, &machine)?;
        let homes: Vec<String> = setup
            .agent_homes()
            .into_iter()
            .filter(|(agent, _)| *agent == HomeAgent::Claude)
            .map(|(_, path)| path.to_string())
            .collect();
        // Claude Code goes by the policy's telemetry settings whatever a home says, so Arbor doesn't write its own.
        if enabled {
            setup.leave_to_policy(&machine, ItemKind::Env, &EXPORT_ENV)?;
        }
        (target, homes)
    };
    if homes.is_empty() {
        return Err(format!("Arbor hasn't found a Claude Code home on {machine}. Scan it on Sync first."));
    }
    let path = settings_path()?;
    let settings = read_settings(&path)?;
    if enabled && !settings.enabled {
        return Err("Turn on Arbor's receiver in Settings › Machines first".into());
    }
    let host_address = listen_host(&app);
    let local = target.is_local();
    if enabled && !local && is_loopback_host(&host_address) {
        return Err("Arbor only listens on this Mac, so another machine can't send to it. Set Custom Listen IP to 0.0.0.0 in Settings › Network first.".into());
    }
    let write = plan != Some(true);
    let token = new_token()?;
    let export = enabled.then(|| Export {
        token: token.clone(),
        port: settings.port,
        local,
        core_port: app.state::<GuiConfigState>().snapshot().map(|config| config.port).ok(),
        fallback: if local { Some("127.0.0.1".into()) } else { remote_address(&host_address) },
    });
    let endpoints = Mutex::new(BTreeSet::new());
    let files = edit_claude_settings(|| &target, &homes, ChangeKind::Telemetry, |content: Option<&str>| telemetry_settings(content, export.as_ref(), &endpoints), write).await?;
    if write {
        let written = files.iter().any(|file| file.written);
        let failed = files.iter().any(|file| file.error.is_some());
        let now_ms = Local::now().timestamp_millis();
        update_settings(&path, |settings| {
            let since_ms = settings.machines.iter().filter(|grant| grant.machine == machine).map(|grant| grant.since_ms).min().unwrap_or(now_ms);
            // A home that couldn't be changed keeps sending with the token it has, so that one stays good until
            // every home has been changed.
            if !failed {
                settings.machines.retain(|grant| grant.machine != machine);
            }
            if enabled && written {
                settings.machines.push(Grant { machine: machine.clone(), token_sha256: sha256_hex(token.as_bytes()), since_ms, port: settings.port });
            }
            Ok(())
        })?;
        reload_grants(&app);
        if !enabled && !failed {
            app.state::<TelemetryState>().lock().seen.remove(&machine);
        }
        rescan(&app, &machine);
        let _ = app.emit(AGENT_TELEMETRY_UPDATED_EVENT, now_ms);
    }
    Ok(TelemetrySetup { endpoints: endpoints.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()).into_iter().collect(), files })
}

#[tauri::command]
pub(crate) async fn get_agent_telemetry_breakdown(from_ms: i64, to_ms: i64, machine: Option<String>) -> Result<TelemetryBreakdown, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open_usage_database()?;
        breakdown(&connection, from_ms, to_ms, machine.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    fn attribute(key: &str, value: &str) -> Value {
        serde_json::json!({ "key": key, "value": { "stringValue": value } })
    }

    /// A request like Claude Code's: resource attributes, a cost point and two token points, one with a skill.
    fn payload(temporality: Value) -> Vec<u8> {
        let nanos = (NOW * 1_000_000).to_string();
        serde_json::json!({
            "resourceMetrics": [{
                "resource": { "attributes": [attribute("service.name", "claude-code"), attribute("app.version", "2.1.290"), attribute("user.email", "someone@example.com")] },
                "scopeMetrics": [{
                    "scope": { "name": "com.anthropic.claude_code" },
                    "metrics": [
                        { "name": "claude_code.cost.usage", "unit": "USD", "sum": { "aggregationTemporality": temporality, "isMonotonic": true, "dataPoints": [
                            { "attributes": [attribute("session.id", "s-1"), attribute("model", "claude-opus-5-5"), attribute("query_source", "main"), attribute("skill.name", "pdf"), attribute("user.account_uuid", "acct")], "timeUnixNano": nanos, "asDouble": 0.25 }
                        ] } },
                        { "name": "claude_code.token.usage", "unit": "tokens", "sum": { "aggregationTemporality": 1, "dataPoints": [
                            { "attributes": [attribute("session.id", "s-1"), attribute("model", "claude-opus-5-5"), attribute("query_source", "main"), attribute("skill.name", "pdf"), attribute("type", "input")], "timeUnixNano": nanos, "asDouble": 1200 },
                            { "attributes": [attribute("session.id", "s-1"), attribute("model", "claude-opus-5-5"), attribute("query_source", "subagent"), attribute("agent.name", "custom"), attribute("mcp_server.name", "custom"), attribute("type", "output")], "timeUnixNano": nanos, "asInt": "300" },
                            { "attributes": [attribute("session.id", "s-1"), attribute("type", "input")], "asDouble": 0 }
                        ] } },
                        { "name": "claude_code.session.count", "sum": { "dataPoints": [{ "asInt": 1 }] } }
                    ]
                }]
            }]
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn only_the_cost_and_token_counters_are_kept_with_their_names() {
        let parsed = parse_metrics(&payload(serde_json::json!(1))).unwrap();
        assert!(!parsed.cumulative);
        assert_eq!(parsed.points.len(), 3);
        let cost = &parsed.points[0];
        assert_eq!((cost.cost, cost.at_ms), (0.25, Some(NOW)));
        assert_eq!(
            cost.key,
            Key {
                session: "s-1".into(),
                version: "2.1.290".into(),
                model: "claude-opus-5-5".into(),
                source: "main".into(),
                skill: "pdf".into(),
                ..Key::default()
            }
        );
        assert_eq!(parsed.points[1].input, 1200.0);
        assert_eq!((parsed.points[2].output, parsed.points[2].key.agent.as_str(), parsed.points[2].key.mcp_server.as_str()), (300.0, "custom", "custom"));
    }

    #[test]
    fn nothing_about_the_account_or_person_is_kept() {
        let parsed = parse_metrics(&payload(serde_json::json!(1))).unwrap();
        let kept = format!("{:?}", parsed.points);
        for private in ["someone@example.com", "acct", "claude-code\""] {
            assert!(!kept.contains(private), "{private} was kept");
        }
    }

    #[test]
    fn running_totals_are_noticed_and_not_added_up() {
        let parsed = parse_metrics(&payload(serde_json::json!("AGGREGATION_TEMPORALITY_CUMULATIVE"))).unwrap();
        assert!(parsed.cumulative);
        assert_eq!(parsed.points.len(), 2, "only the delta token points");
        assert!(parse_metrics(b"not json").is_err());
        assert_eq!(parse_metrics(b"{}").unwrap(), Parsed::default());
    }

    fn request(headers: &[(&str, &str)], body: Vec<u8>) -> Request {
        Request {
            method: "POST".into(),
            path: "/v1/metrics".into(),
            headers: headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
            body,
        }
    }

    #[test]
    fn a_request_is_taken_only_with_a_machine_s_token() {
        let token = "arbor_0123456789abcdef";
        let grants = HashMap::from([(sha256_hex(token.as_bytes()), "cedar-02".to_string())]);
        let good = [("Authorization", "Bearer arbor_0123456789abcdef"), ("Content-Type", "application/json")];
        let taken = request(&good, payload(serde_json::json!(1)));
        assert_eq!(authorize(&taken, &grants).unwrap(), "cedar-02");
        assert_eq!(accept(&taken).unwrap().points.len(), 3);

        let wrong = [("Authorization", "Bearer arbor_nope"), ("Content-Type", "application/json")];
        assert_eq!(authorize(&request(&wrong, Vec::new()), &grants).unwrap_err(), 401);
        assert_eq!(authorize(&request(&[("Content-Type", "application/json")], Vec::new()), &grants).unwrap_err(), 401);
        let protobuf = [("Authorization", "Bearer arbor_0123456789abcdef"), ("Content-Type", "application/x-protobuf")];
        assert_eq!(accept(&request(&protobuf, Vec::new())).unwrap_err(), 415);
        let mut elsewhere = request(&good, Vec::new());
        elsewhere.path = "/v1/logs".into();
        assert_eq!(authorize(&elsewhere, &grants).unwrap_err(), 404);
        let mut read = request(&good, Vec::new());
        read.method = "GET".into();
        assert_eq!(authorize(&read, &grants).unwrap_err(), 405);
        assert_eq!(accept(&request(&good, b"{broken".to_vec())).unwrap_err(), 400);
    }

    #[test]
    fn a_gzipped_body_is_read() {
        use flate2::write::GzEncoder;
        use std::io::Write;
        let token = "arbor_gz";
        let grants = HashMap::from([(sha256_hex(token.as_bytes()), "mbp".to_string())]);
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&payload(serde_json::json!(1))).unwrap();
        let headers = [("Authorization", "Bearer arbor_gz"), ("Content-Type", "application/json"), ("Content-Encoding", "gzip")];
        let zipped = request(&headers, encoder.finish().unwrap());
        assert_eq!(authorize(&zipped, &grants).unwrap(), "mbp");
        assert_eq!(accept(&zipped).unwrap().points.len(), 3);
    }

    async fn read_request<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Request, u16> {
        let (mut request, rest) = read_head(reader).await?;
        request.body = read_body(reader, &request, rest).await?;
        Ok(request)
    }

    fn read(bytes: &[u8]) -> Result<Request, u16> {
        let mut reader = bytes;
        tokio::runtime::Runtime::new().unwrap().block_on(read_request(&mut reader))
    }

    #[test]
    fn bodies_sent_with_a_length_or_in_chunks_are_read_whole() {
        let sized = read(b"POST /v1/metrics HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello").unwrap();
        assert_eq!((sized.method.as_str(), sized.path.as_str(), sized.body.as_slice()), ("POST", "/v1/metrics", &b"hello"[..]));
        assert_eq!(sized.header("host"), Some("x"));
        let chunked = read(b"POST /v1/metrics HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5;x=y\r\nhello\r\n6\r\n world\r\n0\r\nTrailer: z\r\n\r\n").unwrap();
        assert_eq!(chunked.body, b"hello world");
        assert_eq!(read(b"POST /v1/metrics HTTP/1.1\r\nContent-Length: 9999999999\r\n\r\n").unwrap_err(), 413);
        assert_eq!(read(b"POST /v1/metrics HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort").unwrap_err(), 400);
        assert_eq!(read(b"garbage\r\n\r\n").unwrap_err(), 400);
        // A chunk size near usize::MAX is refused, not added up.
        assert_eq!(read(b"POST /v1/metrics HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nX\r\nfffffffffffffffe\r\n").unwrap_err(), 413);
    }

    #[test]
    fn a_real_socket_gets_an_answer() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let status = match read_request(&mut stream).await {
                    Ok(request) => if request.body == b"{}" { 200 } else { 400 },
                    Err(status) => status,
                };
                stream.write_all(&reply(status)).await.unwrap();
                stream.shutdown().await.unwrap();
            });
            let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
            client.write_all(b"POST /v1/metrics HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n").await.unwrap();
            let mut answer = String::new();
            client.read_to_string(&mut answer).await.unwrap();
            server.await.unwrap();
            assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
            assert!(answer.ends_with("\r\n\r\n{}"));
        });
    }

    fn memory() -> Connection {
        let connection = crate::usage::schema::test_database();
        connection
    }

    #[test]
    fn points_add_up_by_hour_and_split_every_way() {
        let mut connection = memory();
        let parsed = parse_metrics(&payload(serde_json::json!(1))).unwrap();
        record(&mut connection, "cedar-02", &parsed.points, NOW, false).unwrap();
        record(&mut connection, "cedar-02", &parsed.points, NOW, false).unwrap();
        record(&mut connection, "mbp", &parsed.points[..1], NOW, false).unwrap();

        let all = breakdown(&connection, NOW - HOUR_MS, NOW + HOUR_MS, None).unwrap();
        assert!((all.total.cost - 0.75).abs() < 1e-9);
        assert_eq!((all.total.input_tokens, all.total.output_tokens, all.total.sessions), (2400.0, 600.0, 1));
        assert_eq!(all.machines.iter().map(|group| group.name.as_str()).collect::<Vec<_>>(), ["cedar-02", "mbp"]);
        assert_eq!(all.skills.len(), 1);
        assert!((all.skills[0].spend.cost - 0.75).abs() < 1e-9);
        assert_eq!(all.mcp_servers.iter().map(|group| group.name.as_str()).collect::<Vec<_>>(), ["custom"]);
        assert_eq!(all.sources.iter().map(|group| group.name.as_str()).collect::<Vec<_>>(), ["main", "subagent"]);
        assert_eq!(all.versions[0].name, "2.1.290");

        let one = breakdown(&connection, NOW - HOUR_MS, NOW + HOUR_MS, Some("mbp")).unwrap();
        assert!((one.total.cost - 0.25).abs() < 1e-9);
        let before = breakdown(&connection, NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, None).unwrap();
        assert_eq!(before.total, Spend::default());
        assert_eq!(last_hours(&connection).unwrap().get("mbp"), Some(&hour_of(Some(NOW), NOW)));
    }

    #[test]
    fn old_hours_go_and_a_wild_clock_lands_in_the_hour_it_arrived() {
        let mut connection = memory();
        let old = Point { at_ms: Some(NOW - KEPT_MS - HOUR_MS), cost: 1.0, ..Point::default() };
        // Stamped far off, so it's put in now's hour, which a prune keeps.
        record(&mut connection, "mbp", &[old], NOW - KEPT_MS, false).unwrap();
        let wild = Point { at_ms: Some(NOW + 30 * 24 * HOUR_MS), cost: 2.0, ..Point::default() };
        record(&mut connection, "mbp", &[wild], NOW, true).unwrap();
        let rows: i64 = connection.query_row("SELECT COUNT(*) FROM usage_agent_telemetry", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert_eq!(hour_of(Some(NOW + 30 * 24 * HOUR_MS), NOW), NOW - NOW.rem_euclid(HOUR_MS));
    }

    fn export(local: bool, fallback: Option<&str>) -> Export {
        Export { token: "arbor_t0k3n".into(), port: 8319, local, core_port: Some(8317), fallback: fallback.map(str::to_string) }
    }

    fn apply(content: Option<&str>, export: Option<&Export>) -> (Result<Option<String>, String>, Vec<String>) {
        let endpoints = Mutex::new(BTreeSet::new());
        let result = telemetry_settings(content, export, &endpoints);
        (result, endpoints.into_inner().unwrap().into_iter().collect())
    }

    #[test]
    fn a_home_is_pointed_at_this_mac_the_way_its_agents_reach_it() {
        let settings = "{\n  \"model\": \"opus\",\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"http://cam-mbp.tail1234.ts.net:8317\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"secret\"\n  }\n}\n";
        let (result, endpoints) = apply(Some(settings), Some(&export(false, Some("192.168.1.20"))));
        let written = result.unwrap().unwrap();
        assert_eq!(endpoints, ["http://cam-mbp.tail1234.ts.net:8319/v1/metrics"]);
        let value: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(value["model"], "opus");
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
        assert_eq!(value["env"][ENABLE], "1");
        assert_eq!(value["env"][PROTOCOL], "http/json");
        assert_eq!(value["env"][HEADERS], "Authorization=Bearer arbor_t0k3n");
        assert!(value["env"].get("OTEL_LOGS_EXPORTER").is_none(), "logs are never asked for");
        assert!(value["env"].get("OTEL_LOG_TOOL_DETAILS").is_none());
        // The keys it had keep their place, in front of Arbor's.
        let at = |key: &str| written.find(key).unwrap();
        assert!(at("\"model\"") < at("\"env\"") && at("ANTHROPIC_BASE_URL") < at("ANTHROPIC_AUTH_TOKEN") && at("ANTHROPIC_AUTH_TOKEN") < at(ENABLE));

        // A base URL on loopback or on another port isn't this Mac as the machine sees it.
        let tunnel = "{\"env\":{\"ANTHROPIC_BASE_URL\":\"http://127.0.0.1:8317\"}}";
        assert_eq!(apply(Some(tunnel), Some(&export(false, Some("192.168.1.20")))).1, ["http://192.168.1.20:8319/v1/metrics"]);
        assert_eq!(apply(Some(tunnel), Some(&export(true, Some("127.0.0.1")))).1, ["http://127.0.0.1:8319/v1/metrics"]);
        let gateway = "{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://gateway.example.com/v1\"}}";
        assert_eq!(apply(Some(gateway), Some(&export(false, Some("192.168.1.20")))).1, ["http://192.168.1.20:8319/v1/metrics"]);
        assert!(apply(None, Some(&export(false, None))).0.unwrap_err().contains("reaches this Mac"));
    }

    #[test]
    fn someone_else_s_exporter_is_left_alone_and_arbor_s_own_is_replaced() {
        let theirs = "{\"env\":{\"CLAUDE_CODE_ENABLE_TELEMETRY\":\"1\",\"OTEL_METRICS_EXPORTER\":\"otlp\",\"OTEL_EXPORTER_OTLP_ENDPOINT\":\"http://collector:4318\"}}";
        assert!(apply(Some(theirs), Some(&export(true, Some("127.0.0.1")))).0.unwrap_err().contains("somewhere else"));
        assert_eq!(apply(Some(theirs), None).0.unwrap(), None, "taking Arbor's away leaves theirs");

        let (first, _) = apply(None, Some(&export(true, Some("127.0.0.1"))));
        let first = first.unwrap().unwrap();
        let mut again = export(true, Some("127.0.0.1"));
        again.token = "arbor_n3w".into();
        let replaced = apply(Some(&first), Some(&again)).0.unwrap().unwrap();
        assert!(replaced.contains("Bearer arbor_n3w") && !replaced.contains("arbor_t0k3n"));
        assert_eq!(apply(Some(&replaced), Some(&again)).0.unwrap(), None, "already right");
    }

    #[test]
    fn taking_it_away_removes_only_what_arbor_wrote() {
        let before = "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"http://127.0.0.1:8317\"\n  }\n}\n";
        let on = apply(Some(before), Some(&export(true, Some("127.0.0.1")))).0.unwrap().unwrap();
        assert_eq!(apply(Some(&on), None).0.unwrap().unwrap(), before);
        let fresh = apply(None, Some(&export(true, Some("127.0.0.1")))).0.unwrap().unwrap();
        assert_eq!(apply(Some(&fresh), None).0.unwrap().unwrap(), "{}\n");
        // Logs sent elsewhere keep telemetry on.
        let with_logs = on.replace("\"ANTHROPIC_BASE_URL\"", "\"OTEL_LOGS_EXPORTER\": \"otlp\",\n    \"ANTHROPIC_BASE_URL\"");
        let off: Value = serde_json::from_str(&apply(Some(&with_logs), None).0.unwrap().unwrap()).unwrap();
        assert_eq!(off["env"][ENABLE], "1");
        assert!(off["env"].get(ENDPOINT).is_none());
        // A value the user changed after Arbor set it is theirs now, and stays.
        let changed = on.replace("\"OTEL_METRICS_INCLUDE_VERSION\": \"true\"", "\"OTEL_METRICS_INCLUDE_VERSION\": \"false\"");
        let kept: Value = serde_json::from_str(&apply(Some(&changed), None).0.unwrap().unwrap()).unwrap();
        assert_eq!(kept["env"][INCLUDE_VERSION], "false");
        assert!(kept["env"].get(HEADERS).is_none() && kept["env"].get(METRICS_EXPORTER).is_none());
    }

    #[test]
    fn a_machine_reaches_this_mac_where_the_proxy_listens() {
        assert_eq!(remote_address("100.64.1.2").as_deref(), Some("100.64.1.2"));
        assert_eq!(remote_address("fd7a::1").as_deref(), Some("[fd7a::1]"));
        assert_eq!(remote_address("not an address"), None);
    }

    #[test]
    fn the_receiver_listens_where_the_proxy_does() {
        let (listener, address) = bind(0, "127.0.0.1").unwrap();
        assert!(listener.local_addr().unwrap().ip().is_loopback());
        assert_eq!(address, "127.0.0.1:0");
        let (listener, _) = bind(0, "localhost").unwrap();
        assert!(listener.local_addr().unwrap().ip().is_loopback());
        assert!(bind(0, "somewhere").is_err());
    }

    #[test]
    fn setup_compares_arbor_s_token_and_endpoint_as_one_setting() {
        let ours: serde_json::Map<String, Value> = serde_json::from_str(r#"{"OTEL_EXPORTER_OTLP_METRICS_HEADERS":"Authorization=Bearer arbor_x","OTEL_EXPORTER_OTLP_METRICS_ENDPOINT":"http://1.2.3.4:8319/v1/metrics"}"#).unwrap();
        assert!(per_machine_telemetry(&ours, HEADERS) && per_machine_telemetry(&ours, ENDPOINT));
        assert!(!per_machine_telemetry(&ours, "ANTHROPIC_BASE_URL"));
        let theirs: serde_json::Map<String, Value> = serde_json::from_str(r#"{"OTEL_EXPORTER_OTLP_METRICS_HEADERS":"x-api-key=1","OTEL_EXPORTER_OTLP_METRICS_ENDPOINT":"http://collector"}"#).unwrap();
        assert!(!per_machine_telemetry(&theirs, HEADERS) && !per_machine_telemetry(&theirs, ENDPOINT));
    }

    #[test]
    fn urls_give_their_host_and_port() {
        assert_eq!(url_host("http://mbp.local:8317/v1"), Some(("mbp.local".into(), Some(8317))));
        assert_eq!(url_host("https://user:pw@gateway.example.com"), Some(("gateway.example.com".into(), None)));
        assert_eq!(url_host("http://[fd7a::1]:8317"), Some(("[fd7a::1]".into(), Some(8317))));
        assert_eq!(url_host("http://"), None);
    }

    #[test]
    fn saved_settings_hold_only_token_hashes() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("arbor-telemetry-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE);
        assert_eq!(read_settings(&path).unwrap(), Settings::default());
        let token = new_token().unwrap();
        assert!(token.starts_with(TOKEN_PREFIX) && token.len() == TOKEN_PREFIX.len() + 48);
        update_settings(&path, |settings| {
            settings.enabled = true;
            settings.machines.push(Grant { machine: "mbp".into(), token_sha256: sha256_hex(token.as_bytes()), since_ms: NOW, port: 8319 });
            Ok(())
        })
        .unwrap();
        let saved = fs::read_to_string(&path).unwrap();
        assert!(!saved.contains(&token));
        assert_eq!(read_settings(&path).unwrap().machines.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
