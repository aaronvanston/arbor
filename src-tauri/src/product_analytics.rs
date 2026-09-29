//! Product analytics: how Arbor itself is used and where it breaks, sent to
//! PostHog. Nothing to do with Agent telemetry
//! (usage/machine_health/telemetry.rs), which is the agents' own spend. Only
//! official releases send: the project key is built in from `ARBOR_POSTHOG_KEY`
//! when they're built, so a build from source sends nothing.
//!
//! Only this side talks to PostHog; the window hands events over through
//! `track_event` and `report_exception`, and both are closed shapes: a page is an
//! id, never a title or a param, and an error is its name, a scrubbed message and
//! the stack's frames. Account names, machine names, paths, prompts and session
//! content are never sent. Each install gets a random id of its own, never one
//! derived from an account, and PostHog is told not to build a person for it or
//! look its address up.
//!
//! Both kinds are on until turned off in Settings › Software, and the first
//! launch says so once. `DO_NOT_TRACK` or `ARBOR_TELEMETRY=0` turns everything off. Debug builds send nothing unless
//! `ARBOR_ANALYTICS_DEV=1`. Events wait in memory, at most `BUFFER_MAX`, and go
//! every `FLUSH_EVERY` and once more on quit. A panic is also written to disk, so
//! one that takes the app down is sent on the next launch.

use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

const SETTINGS_FILE: &str = "product-analytics.json";
const CRASH_FILE: &str = "product-analytics-crash.json";
/// PostHog's project key, built in by official releases only. It only lets events in, so it's fine in the app, as
/// PostHog's own SDKs have it.
const POSTHOG_KEY: &str = match option_env!("ARBOR_POSTHOG_KEY") {
    Some(key) => key,
    None => "",
};
const POSTHOG_HOST: &str = "https://us.i.posthog.com";
const BUFFER_MAX: usize = 1000;
const BATCH_MAX: usize = 50;
const FLUSH_EVERY: Duration = Duration::from_secs(30);
/// How long quitting waits for the last send.
const QUIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(3);
const MESSAGE_MAX: usize = 300;
const FRAMES_MAX: usize = 50;
/// A page or tab id: the app's own names, never anything a user typed.
const ID_MAX: usize = 40;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    usage: bool,
    crash_reports: bool,
    install_id: String,
    /// The first-launch note saying what's sent has been shown. Settings saved before the note came back read as
    /// shown, so only a new install sees it.
    notice_shown: bool,
    /// The version that last ran, so a launch can tell it was an update.
    last_version: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { usage: true, crash_reports: true, install_id: String::new(), notice_shown: true, last_version: String::new() }
    }
}

/// Settings › Software's usage data section.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductAnalyticsSettings {
    usage: bool,
    crash_reports: bool,
    notice_shown: bool,
    /// `DO_NOT_TRACK` or `ARBOR_TELEMETRY=0` is set, which turns both off whatever the switches say.
    blocked_by_env: bool,
    /// This build can send at all: an official release, which has the key. A build from source never sends.
    available: bool,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductAnalyticsInput {
    usage: bool,
    crash_reports: bool,
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn settings_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(SETTINGS_FILE))
}

fn crash_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(CRASH_FILE))
}

fn read_settings(path: &Path) -> Settings {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temp = path.with_file_name(format!(".{SETTINGS_FILE}.tmp.{}", std::process::id()));
    fs::write(&temp, format!("{text}\n")).map_err(|error| format!("Couldn't save {}: {error}", temp.display()))?;
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Couldn't save {}: {error}", path.display())
    })
}

/// Reads the settings and gives the install its id the first time.
fn load_settings() -> Result<Settings, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| "Usage data settings are locked".to_string())?;
    let path = settings_path()?;
    let mut settings = read_settings(&path);
    if settings.install_id.is_empty() {
        settings.install_id = new_install_id()?;
        settings.notice_shown = false;
        write_settings(&path, &settings)?;
    }
    Ok(settings)
}

/// A random id, like a UUID's 128 bits, that belongs to nothing but this install.
fn new_install_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("Couldn't make an install id: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn update_settings(change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| "Usage data settings are locked".to_string())?;
    let path = settings_path()?;
    let mut settings = read_settings(&path);
    change(&mut settings);
    write_settings(&path, &settings)?;
    Ok(settings)
}

fn env_blocks(do_not_track: Option<&str>, arbor_telemetry: Option<&str>) -> bool {
    let set = |value: Option<&str>| value.map(str::trim).is_some_and(|value| !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false"));
    let off = |value: Option<&str>| value.map(str::trim).is_some_and(|value| value == "0" || value.eq_ignore_ascii_case("false") || value.eq_ignore_ascii_case("off"));
    set(do_not_track) || off(arbor_telemetry)
}

fn blocked_by_env() -> bool {
    env_blocks(env::var("DO_NOT_TRACK").ok().as_deref(), env::var("ARBOR_TELEMETRY").ok().as_deref())
}

/// Whether this build sends at all: a release build with a key, or a debug one asked to.
fn build_sends() -> bool {
    !POSTHOG_KEY.is_empty() && (!cfg!(debug_assertions) || env::var("ARBOR_ANALYTICS_DEV").is_ok_and(|value| value == "1"))
}

fn public_settings(settings: &Settings) -> ProductAnalyticsSettings {
    ProductAnalyticsSettings {
        usage: settings.usage,
        crash_reports: settings.crash_reports,
        notice_shown: settings.notice_shown,
        blocked_by_env: blocked_by_env(),
        available: build_sends(),
    }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Usage,
    Crash,
}

struct Queued {
    kind: Kind,
    event: serde_json::Value,
}

struct Sender {
    install_id: String,
    usage: AtomicBool,
    crash_reports: AtomicBool,
    queue: Mutex<VecDeque<Queued>>,
    /// Properties every event carries: versions and the machine's kind, nothing that names it.
    common: serde_json::Map<String, serde_json::Value>,
}

static SENDER: OnceLock<Sender> = OnceLock::new();

fn sender() -> Option<&'static Sender> {
    SENDER.get()
}

fn allowed(sender: &Sender, kind: Kind) -> bool {
    match kind {
        Kind::Usage => sender.usage.load(Ordering::Relaxed),
        Kind::Crash => sender.crash_reports.load(Ordering::Relaxed),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn queue(kind: Kind, name: &str, properties: serde_json::Map<String, serde_json::Value>) {
    let Some(sender) = sender() else { return };
    if !allowed(sender, kind) {
        return;
    }
    let mut all = sender.common.clone();
    all.extend(properties);
    all.insert("distinct_id".into(), sender.install_id.clone().into());
    let event = serde_json::json!({ "event": name, "properties": all, "timestamp": now_iso() });
    let Ok(mut queue) = sender.queue.lock() else { return };
    if queue.len() >= BUFFER_MAX {
        queue.pop_front();
    }
    queue.push_back(Queued { kind, event });
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !version.is_empty() {
            return version;
        }
    }
    String::new()
}

fn common_properties() -> serde_json::Map<String, serde_json::Value> {
    let os = match env::consts::OS {
        "macos" => "Mac OS X",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let mut map = serde_json::Map::new();
    map.insert("$process_person_profile".into(), false.into());
    map.insert("$geoip_disable".into(), true.into());
    map.insert("$lib".into(), "arbor".into());
    map.insert("$lib_version".into(), env!("CARGO_PKG_VERSION").into());
    map.insert("$os".into(), os.into());
    let version = os_version();
    if !version.is_empty() {
        map.insert("$os_version".into(), version.into());
    }
    map.insert("app_version".into(), env!("CARGO_PKG_VERSION").into());
    map.insert("arch".into(), env::consts::ARCH.into());
    map
}

/// Starts sending, with the launch (or update) as the first event and last run's crash if there was one.
/// Called once, before the app is built, so the panic hook is in place for everything after.
pub(crate) fn start() {
    install_panic_hook();
    if !build_sends() || blocked_by_env() {
        return;
    }
    let settings = match load_settings() {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("Usage data is off: {error}");
            return;
        }
    };
    let sender = Sender {
        install_id: settings.install_id.clone(),
        usage: AtomicBool::new(settings.usage),
        crash_reports: AtomicBool::new(settings.crash_reports),
        queue: Mutex::new(VecDeque::new()),
        common: common_properties(),
    };
    if SENDER.set(sender).is_err() {
        return;
    }

    let version = env!("CARGO_PKG_VERSION");
    if !settings.last_version.is_empty() && settings.last_version != version {
        let mut properties = serde_json::Map::new();
        properties.insert("from".into(), settings.last_version.clone().into());
        properties.insert("to".into(), version.into());
        queue(Kind::Usage, "app.updated", properties);
    }
    queue(Kind::Usage, "app.launched", serde_json::Map::new());
    if settings.last_version != version {
        let _ = update_settings(|settings| settings.last_version = version.to_string());
    }
    queue_saved_crash();
}

/// Sends what's waiting every `FLUSH_EVERY`. Started from the app's setup, once there's a runtime.
pub(crate) fn start_flushing(app: tauri::AppHandle) {
    if sender().is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(FLUSH_EVERY).await;
            flush(&app).await;
        }
    });
}

/// The last send, as the app quits.
pub(crate) fn flush_on_quit(app: &tauri::AppHandle) {
    if sender().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(QUIT_FLUSH_TIMEOUT, flush(&app)).await;
    });
}

async fn flush(app: &tauri::AppHandle) {
    let Some(sender) = sender() else { return };
    let proxy_url = app.state::<GuiConfigState>().snapshot().map(|config| config.proxy_url).unwrap_or_default();
    let Ok(client) = build_http_client_with_proxy(
        reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(20)),
        &proxy_url,
        "Couldn't make the usage data client",
    ) else {
        return;
    };
    loop {
        let batch: Vec<Queued> = {
            let Ok(mut queue) = sender.queue.lock() else { return };
            let take = queue.len().min(BATCH_MAX);
            queue.drain(..take).collect()
        };
        if batch.is_empty() {
            return;
        }
        let events: Vec<&serde_json::Value> = batch.iter().filter(|item| allowed(sender, item.kind)).map(|item| &item.event).collect();
        if events.is_empty() {
            continue;
        }
        let sent_crash = batch.iter().any(|item| item.kind == Kind::Crash);
        let body = serde_json::json!({ "api_key": POSTHOG_KEY, "batch": events });
        let sent = client
            .post(format!("{POSTHOG_HOST}/batch/"))
            .json(&body)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        if !sent {
            // Back to the front for the next try, keeping to the cap.
            if let Ok(mut queue) = sender.queue.lock() {
                for item in batch.into_iter().rev() {
                    if queue.len() >= BUFFER_MAX {
                        break;
                    }
                    queue.push_front(item);
                }
            }
            return;
        }
        if sent_crash {
            if let Ok(path) = crash_path() {
                let _ = fs::remove_file(path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Events from the window
// ---------------------------------------------------------------------------

/// What the window can send. A closed list: anything else can't be said.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum ProductEvent {
    /// A page, or one of its views, came on screen. Ids only, as `viewPageId` names them.
    #[serde(rename = "page.viewed")]
    PageViewed { page: String, tab: Option<String> },
    /// Something was done with one of Arbor's features. `kind` is an app id such as a provider or an alert kind,
    /// and `count` how many things it touched; never which ones.
    #[serde(rename = "feature.used")]
    FeatureUsed { feature: Feature, kind: Option<String>, count: Option<u32> },
}

/// The features `feature.used` can name.
#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Feature {
    AccountSignedIn,
    MachinesSaved,
    SyncApplied,
    SyncUndone,
    SkillsChanged,
    PluginsChanged,
    McpChanged,
    HooksChanged,
    WorktreesRemoved,
    NodeVersionsChanged,
    AlertSent,
    DigestExported,
    PaletteUsed,
    UpdateStarted,
    CoreStarted,
    CoreStopped,
    CoreRestarted,
    PricesSynced,
    AntiburnOpened,
}

impl Feature {
    fn as_str(self) -> &'static str {
        match self {
            Feature::AccountSignedIn => "account-signed-in",
            Feature::MachinesSaved => "machines-saved",
            Feature::SyncApplied => "sync-applied",
            Feature::SyncUndone => "sync-undone",
            Feature::SkillsChanged => "skills-changed",
            Feature::PluginsChanged => "plugins-changed",
            Feature::McpChanged => "mcp-changed",
            Feature::HooksChanged => "hooks-changed",
            Feature::WorktreesRemoved => "worktrees-removed",
            Feature::NodeVersionsChanged => "node-versions-changed",
            Feature::AlertSent => "alert-sent",
            Feature::DigestExported => "digest-exported",
            Feature::PaletteUsed => "palette-used",
            Feature::UpdateStarted => "update-started",
            Feature::CoreStarted => "core-started",
            Feature::CoreStopped => "core-stopped",
            Feature::CoreRestarted => "core-restarted",
            Feature::PricesSynced => "prices-synced",
            Feature::AntiburnOpened => "antiburn-opened",
        }
    }
}

fn is_app_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= ID_MAX && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b':')
}

#[tauri::command]
pub(crate) fn track_event(event: ProductEvent) {
    match event {
        ProductEvent::PageViewed { page, tab } => {
            if !is_app_id(&page) || tab.as_deref().is_some_and(|tab| !is_app_id(tab)) {
                return;
            }
            let mut properties = serde_json::Map::new();
            properties.insert("page".into(), page.into());
            if let Some(tab) = tab {
                properties.insert("tab".into(), tab.into());
            }
            queue(Kind::Usage, "page.viewed", properties);
        }
        ProductEvent::FeatureUsed { feature, kind, count } => {
            let mut properties = serde_json::Map::new();
            properties.insert("feature".into(), feature.as_str().into());
            if let Some(kind) = kind.filter(|kind| is_app_id(kind)) {
                properties.insert("kind".into(), kind.into());
            }
            if let Some(count) = count {
                properties.insert("count".into(), count.into());
            }
            queue(Kind::Usage, "feature.used", properties);
        }
    }
}

/// How often one operation's problems are sent: a machine that's asleep fails its health check every minute.
const CALL_PROBLEM_EVERY_MS: i64 = 60 * 60_000;

static CALL_PROBLEMS: Mutex<Option<HashMap<String, (i64, u32)>>> = Mutex::new(None);

/// Whether a problem goes now, with how many were held back since the last one that went.
fn admit_call_problem(problems: &mut HashMap<String, (i64, u32)>, key: String, now_ms: i64) -> Option<u32> {
    match problems.get_mut(&key) {
        Some((last, skipped)) if now_ms - *last < CALL_PROBLEM_EVERY_MS => {
            *skipped += 1;
            None
        }
        Some((last, skipped)) => {
            let repeats = *skipped;
            *last = now_ms;
            *skipped = 0;
            Some(repeats)
        }
        None => {
            problems.insert(key, (now_ms, 0));
            Some(0)
        }
    }
}

/// A call out that failed, timed out or was slow, from Diagnostics. Only its kind (machine or core), its fixed
/// operation name and how it went; never the machine. Each operation and outcome goes at most once an hour, with how
/// many more there were since the last one.
pub(crate) fn note_call_problem(kind: &str, operation: &str, outcome: &str, slow: bool, duration_ms: u64, now_ms: i64) {
    let Some(sender) = sender() else { return };
    if !allowed(sender, Kind::Usage) {
        return;
    }
    let key = format!("{kind}|{operation}|{outcome}|{slow}");
    let repeats = {
        let Ok(mut problems) = CALL_PROBLEMS.lock() else { return };
        match admit_call_problem(problems.get_or_insert_with(HashMap::new), key, now_ms) {
            Some(repeats) => repeats,
            None => return,
        }
    };
    let mut properties = serde_json::Map::new();
    properties.insert("call_kind".into(), kind.into());
    properties.insert("operation".into(), operation.chars().take(80).collect::<String>().into());
    properties.insert("outcome".into(), outcome.into());
    properties.insert("slow".into(), slow.into());
    properties.insert("duration_ms".into(), duration_ms.into());
    properties.insert("repeats_since_last".into(), repeats.into());
    queue(Kind::Usage, "call.problem", properties);
}

/// Where a window error was caught.
#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExceptionSource {
    /// The app's own boundary, which replaced the whole window.
    App,
    /// A page's boundary: the rest of the app carried on.
    Page,
    /// A background monitor's boundary, which starts it again.
    Monitor,
    /// `window.onerror`.
    Window,
    /// A promise nobody caught.
    Rejection,
}

impl ExceptionSource {
    fn as_str(self) -> &'static str {
        match self {
            ExceptionSource::App => "app",
            ExceptionSource::Page => "page",
            ExceptionSource::Monitor => "monitor",
            ExceptionSource::Window => "window",
            ExceptionSource::Rejection => "rejection",
        }
    }

    /// A boundary showed something in its place; the others went on around it.
    fn handled(self) -> bool {
        !matches!(self, ExceptionSource::Window | ExceptionSource::Rejection)
    }
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExceptionReport {
    source: ExceptionSource,
    name: String,
    message: String,
    stack: String,
    page: Option<String>,
    /// `globalThis._posthogChunkIds` as the release build's inject step left it: a stack from inside each bundle
    /// file, keyed to that file's chunk id, which is how PostHog finds the source map for a frame.
    #[ts(optional)]
    chunk_ids: Option<HashMap<String, String>>,
}

#[tauri::command]
pub(crate) fn report_exception(report: ExceptionReport) {
    let chunks = chunk_ids_by_file(report.chunk_ids.as_ref());
    let frames: Vec<serde_json::Value> = parse_js_stack(&report.stack)
        .into_iter()
        .map(|frame| {
            let mut value = serde_json::json!({
                "platform": "web:javascript",
                "filename": frame.file,
                "function": frame.function,
                "lineno": frame.line,
                "colno": frame.column,
                "in_app": frame.in_app,
            });
            if let Some(chunk) = chunks.get(&frame.file) {
                value["chunk_id"] = chunk.clone().into();
            }
            value
        })
        .collect();
    let mut properties = exception_properties(&report.name, &report.message, report.source.handled(), frames);
    properties.insert("source".into(), report.source.as_str().into());
    if let Some(page) = report.page.filter(|page| is_app_id(page)) {
        properties.insert("page".into(), page.into());
    }
    queue(Kind::Crash, "$exception", properties);
}

/// Each bundle file's chunk id, by the file as frames name it. A chunk id is a UUID, so anything else is left out.
fn chunk_ids_by_file(chunk_ids: Option<&HashMap<String, String>>) -> HashMap<String, String> {
    let mut files = HashMap::new();
    for (stack, chunk) in chunk_ids.into_iter().flatten().take(500) {
        if chunk.len() > 64 || !chunk.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
            continue;
        }
        // The stack was taken inside the file, so its last frame from the app is the file.
        if let Some(frame) = parse_js_stack(stack).into_iter().rev().find(|frame| frame.in_app) {
            files.insert(frame.file, chunk.clone());
        }
    }
    files
}

fn exception_properties(name: &str, message: &str, handled: bool, frames: Vec<serde_json::Value>) -> serde_json::Map<String, serde_json::Value> {
    let name = scrub(name);
    let name = if name.is_empty() { "Error".to_string() } else { name.chars().take(80).collect() };
    let mut exception = serde_json::json!({
        "type": name,
        "value": scrub(message),
        "mechanism": { "handled": handled, "synthetic": false },
    });
    if !frames.is_empty() {
        // PostHog wants the innermost frame last.
        let frames: Vec<_> = frames.into_iter().rev().collect();
        exception["stacktrace"] = serde_json::json!({ "type": "raw", "frames": frames });
    }
    let mut map = serde_json::Map::new();
    map.insert("$exception_list".into(), serde_json::json!([exception]));
    map.insert("$exception_level".into(), "error".into());
    map
}

#[derive(Debug, PartialEq)]
struct Frame {
    function: String,
    file: String,
    line: Option<u32>,
    column: Option<u32>,
    in_app: bool,
}

/// Reads WebKit's `fn@url:line:col` frames and Chromium's `at fn (url:line:col)`, keeping only the app's own
/// file names: a frame from anywhere else is kept with its name dropped.
fn parse_js_stack(stack: &str) -> Vec<Frame> {
    stack
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let (function, location) = if let Some(rest) = line.strip_prefix("at ") {
                match rest.rfind(" (") {
                    Some(at) if rest.ends_with(')') => (&rest[..at], &rest[at + 2..rest.len() - 1]),
                    _ => ("", rest),
                }
            } else if let Some(at) = line.find('@') {
                (&line[..at], &line[at + 1..])
            } else {
                return None;
            };
            let (file, line_no, column) = split_location(location);
            if file.is_empty() || file == "[native code]" {
                return None;
            }
            let in_app = is_app_file(file);
            Some(Frame {
                function: function.chars().filter(|c| !c.is_control()).take(120).collect(),
                file: if in_app { app_file_name(file) } else { "<other>".to_string() },
                line: line_no,
                column,
                in_app,
            })
        })
        .take(FRAMES_MAX)
        .collect()
}

fn split_location(location: &str) -> (&str, Option<u32>, Option<u32>) {
    fn trailing_number(text: &str) -> Option<(&str, u32)> {
        let at = text.rfind(':')?;
        let digits = &text[at + 1..];
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        Some((&text[..at], digits.parse().ok()?))
    }
    match trailing_number(location) {
        Some((rest, last)) => match trailing_number(rest) {
            Some((file, line)) => (file, Some(line), Some(last)),
            None => (rest, Some(last), None),
        },
        None => (location, None, None),
    }
}

/// The app's bundle as the webview loads it, or the dev server's.
fn is_app_file(file: &str) -> bool {
    file.starts_with("tauri://localhost/") || file.starts_with("http://tauri.localhost/") || file.starts_with("http://127.0.0.1:") || file.starts_with("http://localhost:")
}

/// Keeps the path inside the bundle, without the host or query: `/assets/index-abc.js`.
fn app_file_name(file: &str) -> String {
    let after_scheme = file.split_once("://").map_or(file, |(_, rest)| rest);
    let path = after_scheme.find('/').map_or("", |at| &after_scheme[at..]);
    path.split(['?', '#']).next().unwrap_or("").chars().take(200).collect()
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/// Takes out of an error's text what could name the user or their things: home paths, emails, addresses,
/// long ids and tokens. Messages still say what went wrong, just not whose.
pub(crate) fn scrub(text: &str) -> String {
    let home = env::var("HOME").unwrap_or_default();
    scrub_with_home(text, &home)
}

fn scrub_with_home(text: &str, home: &str) -> String {
    let mut text = text.replace(['\r', '\n', '\t'], " ");
    if home.len() > 1 {
        text = text.replace(home, "~");
    }
    let words: Vec<String> = text.split(' ').map(scrub_word).collect();
    let text = words.join(" ");
    let mut out: String = text.chars().take(MESSAGE_MAX).collect();
    if text.chars().count() > MESSAGE_MAX {
        out.push('…');
    }
    out
}

fn scrub_word(word: &str) -> String {
    // Keep punctuation around a word, so "(user@example.com)" stays "(<email>)".
    let start = word.find(|c: char| c.is_alphanumeric() || c == '/' || c == '~').unwrap_or(word.len());
    let end = word.rfind(|c: char| c.is_alphanumeric()).map_or(start, |at| at + word[at..].chars().next().map_or(1, char::len_utf8));
    if start >= end {
        return word.to_string();
    }
    let (before, core, after) = (&word[..start], &word[start..end], &word[end..]);
    let replaced = if core.contains('@') && core.contains('.') && !core.contains("://") {
        "<email>".to_string()
    } else if is_ipv4(core) || (core.matches(':').count() >= 2 && core.chars().all(|c| c.is_ascii_hexdigit() || c == ':')) {
        "<ip>".to_string()
    } else if let Some(rest) = core.strip_prefix("/Users/").or_else(|| core.strip_prefix("/home/")) {
        match rest.split_once('/') {
            Some((_, path)) => format!("~/{path}"),
            None => "~".to_string(),
        }
    } else if looks_secret(core) {
        "<id>".to_string()
    } else {
        core.to_string()
    };
    format!("{before}{replaced}{after}")
}

fn is_ipv4(text: &str) -> bool {
    let host = text.rsplit_once(':').filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit())).map_or(text, |(host, _)| host);
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts.iter().all(|part| !part.is_empty() && part.len() <= 3 && part.parse::<u8>().is_ok())
}

/// A long run of letters and digits with both in it: a key, a token or an id.
fn looks_secret(text: &str) -> bool {
    text.split(['/', '=', ':', ',', '"', '\'']).any(|part| {
        part.len() >= 20
            && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && part.chars().any(|c| c.is_ascii_digit())
            && part.chars().any(|c| c.is_ascii_alphabetic())
    })
}

// ---------------------------------------------------------------------------
// Panics
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedCrash {
    message: String,
    file: String,
    line: u32,
    thread: String,
    version: String,
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let (file, line) = info.location().map_or((String::new(), 0), |location| (location.file().to_string(), location.line()));
        let crash = SavedCrash {
            message: scrub(&message),
            file: scrub(&file),
            line,
            thread: std::thread::current().name().unwrap_or("unnamed").chars().take(60).collect(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let Some(sender) = sender() else { return };
        if !allowed(sender, Kind::Crash) {
            return;
        }
        // On disk too, in case this panic is the end of the app; a send that gets through removes it.
        if let (Ok(path), Ok(text)) = (crash_path(), serde_json::to_string(&crash)) {
            let _ = fs::write(path, text);
        }
        queue(Kind::Crash, "$exception", panic_properties(&crash));
    }));
}

fn panic_properties(crash: &SavedCrash) -> serde_json::Map<String, serde_json::Value> {
    let frames = vec![serde_json::json!({
        "platform": "custom",
        "lang": "rust",
        "filename": crash.file,
        "function": "",
        "lineno": crash.line,
        "in_app": true,
    })];
    let mut properties = exception_properties("Rust panic", &crash.message, false, frames);
    properties.insert("source".into(), "rust".into());
    properties.insert("thread".into(), crash.thread.clone().into());
    properties.insert("crashed_version".into(), crash.version.clone().into());
    properties
}

fn queue_saved_crash() {
    let Ok(path) = crash_path() else { return };
    let Some(crash) = fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<SavedCrash>(&text).ok()) else {
        let _ = fs::remove_file(&path);
        return;
    };
    queue(Kind::Crash, "$exception", panic_properties(&crash));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn get_product_analytics() -> Result<ProductAnalyticsSettings, String> {
    Ok(public_settings(&load_settings()?))
}

#[tauri::command]
pub(crate) fn set_product_analytics(settings: ProductAnalyticsInput) -> Result<ProductAnalyticsSettings, String> {
    let saved = update_settings(|current| {
        current.usage = settings.usage;
        current.crash_reports = settings.crash_reports;
    })?;
    if let Some(sender) = sender() {
        sender.usage.store(saved.usage, Ordering::Relaxed);
        sender.crash_reports.store(saved.crash_reports, Ordering::Relaxed);
        // What's waiting of a kind just turned off doesn't go either.
        if let Ok(mut queue) = sender.queue.lock() {
            queue.retain(|item| allowed(sender, item.kind));
        }
    }
    if !saved.crash_reports {
        if let Ok(path) = crash_path() {
            let _ = fs::remove_file(path);
        }
    }
    Ok(public_settings(&saved))
}

#[tauri::command]
pub(crate) fn mark_product_analytics_notice_shown() -> Result<ProductAnalyticsSettings, String> {
    Ok(public_settings(&update_settings(|settings| settings.notice_shown = true)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_saved_before_the_first_launch_note_read_as_shown() {
        let saved = r#"{"usage":true,"crashReports":true,"installId":"5f1e","lastVersion":"0.3.198"}"#;
        assert!(serde_json::from_str::<Settings>(saved).unwrap().notice_shown, "an install that already ran never sees it");
    }

    #[test]
    fn env_turns_it_off() {
        assert!(!env_blocks(None, None));
        assert!(env_blocks(Some("1"), None));
        assert!(env_blocks(Some("true"), None));
        assert!(!env_blocks(Some("0"), None));
        assert!(!env_blocks(Some(""), None));
        assert!(env_blocks(None, Some("0")));
        assert!(env_blocks(None, Some("false")));
        assert!(!env_blocks(None, Some("1")));
    }

    #[test]
    fn scrubs_what_names_the_owner() {
        let home = "/Users/casey";
        assert_eq!(
            scrub_with_home("Couldn't read /Users/casey/.claude/settings.json: denied", home),
            "Couldn't read ~/.claude/settings.json: denied"
        );
        assert_eq!(scrub_with_home("open /Users/someone/x failed", home), "open ~/x failed");
        assert_eq!(scrub_with_home("account (me@example.com) paused", home), "account (<email>) paused");
        assert_eq!(scrub_with_home("connect 192.168.1.20:22 refused", home), "connect <ip> refused");
        assert_eq!(scrub_with_home("key sk-ant-abc123def456ghi789jkl rejected", home), "key <id> rejected");
        assert_eq!(scrub_with_home("Cannot read properties of undefined", home), "Cannot read properties of undefined");
        assert_eq!(scrub_with_home("line one\nline two", home), "line one line two");
        let long = "x ".repeat(400);
        assert!(scrub_with_home(&long, home).chars().count() <= MESSAGE_MAX + 1);
    }

    #[test]
    fn reads_webkit_and_chromium_stacks() {
        let webkit = "render@tauri://localhost/assets/index-Ab12.js:12:3456\n@tauri://localhost/assets/index-Ab12.js?v=1:1:20\nforEach@[native code]\nx@https://example.com/a.js:1:2";
        let frames = parse_js_stack(webkit);
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], Frame { function: "render".into(), file: "/assets/index-Ab12.js".into(), line: Some(12), column: Some(3456), in_app: true });
        assert_eq!(frames[1].file, "/assets/index-Ab12.js");
        assert_eq!(frames[2].file, "<other>");
        assert!(!frames[2].in_app);

        let chromium = "TypeError: boom\n    at Home (http://127.0.0.1:1421/src/pages/Home.tsx:40:7)\n    at http://127.0.0.1:1421/src/main.tsx:5:1";
        let frames = parse_js_stack(chromium);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].function, "Home");
        assert_eq!(frames[0].file, "/src/pages/Home.tsx");
        assert_eq!(frames[0].line, Some(40));
        assert_eq!(frames[1].function, "");
    }

    #[test]
    fn frames_get_their_files_chunk_ids() {
        let ids = HashMap::from([
            ("Error\n    at tauri://localhost/assets/index-Ab12.js:1:99".to_string(), "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f".to_string()),
            ("Error\n    at tauri://localhost/assets/vendor-Cd34.js:1:5".to_string(), "not a uuid!".to_string()),
        ]);
        let files = chunk_ids_by_file(Some(&ids));
        assert_eq!(files.get("/assets/index-Ab12.js").map(String::as_str), Some("0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f"));
        assert_eq!(files.len(), 1);
        assert!(chunk_ids_by_file(None).is_empty());
    }

    #[test]
    fn only_app_ids_pass() {
        assert!(is_app_id("settings:software"));
        assert!(is_app_id("usage"));
        assert!(!is_app_id(""));
        assert!(!is_app_id("Home"));
        assert!(!is_app_id("/Users/x"));
        assert!(!is_app_id(&"a".repeat(ID_MAX + 1)));
    }

    #[test]
    fn a_call_problem_goes_once_an_hour_with_its_repeats() {
        let mut problems = HashMap::new();
        assert_eq!(admit_call_problem(&mut problems, "a".into(), 0), Some(0));
        assert_eq!(admit_call_problem(&mut problems, "a".into(), 1_000), None);
        assert_eq!(admit_call_problem(&mut problems, "a".into(), 2_000), None);
        assert_eq!(admit_call_problem(&mut problems, "b".into(), 2_000), Some(0));
        assert_eq!(admit_call_problem(&mut problems, "a".into(), CALL_PROBLEM_EVERY_MS), Some(2));
        assert_eq!(admit_call_problem(&mut problems, "a".into(), CALL_PROBLEM_EVERY_MS + 1), None);
    }

    #[test]
    fn exceptions_have_posthogs_shape() {
        let properties = exception_properties("TypeError", "x is undefined", true, vec![serde_json::json!({ "lineno": 1 }), serde_json::json!({ "lineno": 2 })]);
        let exception = &properties["$exception_list"][0];
        assert_eq!(exception["type"], "TypeError");
        assert_eq!(exception["mechanism"]["handled"], true);
        // Innermost last.
        assert_eq!(exception["stacktrace"]["frames"][1]["lineno"], 1);
    }
}
