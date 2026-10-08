//! Arbor's own page for the browser at the end of a provider's sign-in.
//!
//! Claude, Codex and Antigravity send the browser back to a fixed localhost port registered with
//! the provider. Asked with `is_webui`, the core listens there itself and redirects to a bare page
//! of its own that says "successful" before the sign-in has even been checked. Instead Arbor
//! listens on that port, hands the code to the core through the management API (the same way as a
//! pasted callback link), and answers with a page that follows the sign-in to its real end. The
//! code and state stay in Rust and never reach the webview. When the port is taken, the sign-in
//! goes through the core's listener as before.

use crate::management_api::{fetch_oauth_status, post_oauth_callback};
use crate::GuiConfigFile;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// Where a provider sends the browser back to, as registered with the provider.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CallbackRoute {
    provider: &'static str,
    name: &'static str,
    port: u16,
    path: &'static str,
    icon: &'static str,
}

const ROUTES: &[CallbackRoute] = &[
    CallbackRoute {
        provider: "anthropic",
        name: "Claude",
        port: 54545,
        path: "/callback",
        icon: include_str!("../../src/assets/icons/claude.svg"),
    },
    CallbackRoute {
        provider: "codex",
        name: "Codex",
        port: 1455,
        path: "/auth/callback",
        icon: include_str!("../../src/assets/icons/codex.svg"),
    },
    CallbackRoute {
        provider: "antigravity",
        name: "Antigravity",
        port: 51121,
        path: "/oauth-callback",
        icon: include_str!("../../src/assets/icons/antigravity.svg"),
    },
];

const PAGE_TEMPLATE: &str = include_str!("oauth_callback.html");
/// Where the browser lands after its callback is taken, so the code leaves the address bar and
/// history, and reloading doesn't send it again.
const PAGE_PATH: &str = "/sign-in";
const STATUS_PATH: &str = "/status";
/// The core gives up on a callback after five minutes; this outlasts that.
const LIFETIME: Duration = Duration::from_secs(10 * 60);
/// How long the page can still read a settled result before the port is given back.
const SETTLED_GRACE: Duration = Duration::from_secs(2 * 60);
const STATUS_INTERVAL: Duration = Duration::from_secs(2);
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const HEAD_MAX: usize = 16 * 1024;
const CONNECTIONS: usize = 8;

pub(crate) fn route(provider_key: &str) -> Option<&'static CallbackRoute> {
    ROUTES.iter().find(|route| route.provider == provider_key)
}

/// The listeners for one route, on 127.0.0.1 and, when it can, ::1, since a browser may resolve
/// `localhost` to either.
pub(crate) struct Bound {
    route: &'static CallbackRoute,
    listeners: Vec<tokio::net::TcpListener>,
}

/// One running listener per port, so a new sign-in takes over from an earlier one's.
static ACTIVE: LazyLock<Mutex<HashMap<u16, (u64, CancellationToken)>>> = LazyLock::new(Default::default);
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Takes the route's port, stopping an earlier sign-in's listener first. None when something else
/// holds it, such as a provider's own CLI mid-login.
pub(crate) async fn bind(route: &'static CallbackRoute) -> Option<Bound> {
    let earlier = ACTIVE.lock().ok().and_then(|mut active| active.remove(&route.port));
    if let Some((_, stop)) = earlier {
        stop.cancel();
    }
    // A stopped listener lets go of its port as its task ends, a moment after the cancel.
    for _ in 0..20 {
        if let Ok(listener) = listen((Ipv4Addr::LOCALHOST, route.port).into()) {
            let mut listeners = vec![listener];
            if let Ok(listener) = listen((Ipv6Addr::LOCALHOST, route.port).into()) {
                listeners.push(listener);
            }
            return Some(Bound { route, listeners });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

fn listen(address: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let listener = std::net::TcpListener::bind(address)?;
    listener.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(listener)
}

/// Serves the page for the sign-in with `state` until it settles, a newer sign-in takes the
/// port, or `LIFETIME` passes.
pub(crate) fn serve(bound: Bound, state: String, config: GuiConfigFile) {
    let session = Arc::new(Session::new(bound.route, state, Core::Management(Box::new(config))));
    let stop = CancellationToken::new();
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut active) = ACTIVE.lock() {
        active.insert(bound.route.port, (id, stop.clone()));
    }
    let slots = Arc::new(tokio::sync::Semaphore::new(CONNECTIONS));
    for listener in bound.listeners {
        tauri::async_runtime::spawn(accept(listener, session.clone(), slots.clone(), stop.clone()));
    }
    let port = bound.route.port;
    tauri::async_runtime::spawn(async move {
        watch(&session, &stop).await;
        stop.cancel();
        if let Ok(mut active) = ACTIVE.lock() {
            if active.get(&port).is_some_and(|(active_id, _)| *active_id == id) {
                active.remove(&port);
            }
        }
    });
}

async fn accept(
    listener: tokio::net::TcpListener,
    session: Arc<Session>,
    slots: Arc<tokio::sync::Semaphore>,
    stop: CancellationToken,
) {
    loop {
        let accepted = tokio::select! {
            _ = stop.cancelled() => return,
            accepted = listener.accept() => accepted,
        };
        let Ok((mut stream, _)) = accepted else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            answer(&session, &mut stream).await;
        });
    }
}

/// Follows the core's status for the sign-in, ending once it settled and the page had time to
/// read it. A sign-in canceled in Arbor settles as an error, so its port is given back at once.
async fn watch(session: &Session, stop: &CancellationToken) {
    let started = Instant::now();
    let mut settled_at: Option<Instant> = None;
    loop {
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tokio::time::sleep(STATUS_INTERVAL) => {}
        }
        if started.elapsed() > LIFETIME {
            return;
        }
        if let Some(at) = settled_at {
            if at.elapsed() > SETTLED_GRACE {
                return;
            }
            continue;
        }
        let Ok(status) = session.core.status(&session.state).await else {
            continue;
        };
        let settled = status != Status::Waiting;
        let delivered = {
            let Ok(mut outcome) = session.outcome.lock() else { return };
            outcome.status = status;
            outcome.delivered
        };
        if settled {
            if !delivered {
                return;
            }
            settled_at = Some(Instant::now());
        }
    }
}

// ---------------------------------------------------------------------------
// The sign-in, and what the core says about it
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum Status {
    #[default]
    Waiting,
    Ok,
    Failed(String),
}

#[derive(Debug, Default)]
struct Outcome {
    status: Status,
    delivered: bool,
    /// Why the sign-in failed before the core could check it, shown at once.
    failed: Option<String>,
}

enum Core {
    Management(Box<GuiConfigFile>),
    #[cfg(test)]
    Fake(Mutex<tests::FakeCore>),
}

impl Core {
    async fn deliver(&self, provider: &str, state: &str, code: &str, error: &str) -> Result<(), String> {
        match self {
            Self::Management(config) => post_oauth_callback(
                config,
                serde_json::json!({ "provider": provider, "state": state, "code": code, "error": error }),
            )
            .await,
            #[cfg(test)]
            Self::Fake(fake) => fake.lock().unwrap().deliver(code, error),
        }
    }

    async fn status(&self, state: &str) -> Result<Status, String> {
        match self {
            Self::Management(config) => fetch_oauth_status(config, state).await.map(|result| {
                match result.status.as_str() {
                    "ok" => Status::Ok,
                    "error" => Status::Failed(short_reason(result.error.as_deref().unwrap_or_default())),
                    _ => Status::Waiting,
                }
            }),
            #[cfg(test)]
            Self::Fake(fake) => Ok(fake.lock().unwrap().status.clone()),
        }
    }
}

struct Session {
    route: &'static CallbackRoute,
    state: String,
    core: Core,
    outcome: Mutex<Outcome>,
}

impl Session {
    fn new(route: &'static CallbackRoute, state: String, core: Core) -> Self {
        Self { route, state, core, outcome: Mutex::new(Outcome::default()) }
    }
}

// ---------------------------------------------------------------------------
// HTTP, just enough of it
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
struct Reply {
    status: u16,
    content_type: &'static str,
    location: Option<String>,
    body: String,
}

impl Reply {
    fn page(status: u16, body: String) -> Self {
        Self { status, content_type: "text/html; charset=utf-8", location: None, body }
    }

    fn redirect(location: &str) -> Self {
        Self { status: 303, content_type: "text/plain; charset=utf-8", location: Some(location.to_string()), body: String::new() }
    }

    fn not_found() -> Self {
        Self { status: 404, content_type: "text/plain; charset=utf-8", location: None, body: "Not found".to_string() }
    }

    fn bytes(&self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            303 => "See Other",
            400 => "Bad Request",
            404 => "Not Found",
            405 => "Method Not Allowed",
            _ => "Error",
        };
        let mut head = format!(
            "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
             Referrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n\
             Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'\r\n\
             Connection: close\r\n",
            self.status,
            self.content_type,
            self.body.len(),
        );
        if let Some(location) = &self.location {
            head.push_str(&format!("Location: {location}\r\n"));
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(self.body.as_bytes());
        bytes
    }
}

async fn answer<S: AsyncRead + AsyncWrite + Unpin>(session: &Session, stream: &mut S) {
    let reply = match tokio::time::timeout(HEAD_TIMEOUT, read_request_line(stream)).await {
        Ok(Some((method, target))) => respond(session, &method, &target).await,
        _ => return,
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.write_all(&reply.bytes())).await;
    let _ = stream.shutdown().await;
}

/// The method and target of a request, from its head. The rest of the head isn't needed.
async fn read_request_line<R: AsyncRead + Unpin>(reader: &mut R) -> Option<(String, String)> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 2048];
    while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        if buffer.len() > HEAD_MAX {
            return None;
        }
        let read = reader.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let line = buffer.split(|byte| *byte == b'\n').next()?;
    let mut parts = std::str::from_utf8(line).ok()?.trim_end().split(' ');
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

async fn respond(session: &Session, method: &str, target: &str) -> Reply {
    if method != "GET" {
        return Reply { status: 405, ..Reply::not_found() };
    }
    let Ok(url) = reqwest::Url::parse(&format!("http://localhost{target}")) else {
        return Reply::not_found();
    };
    match url.path() {
        path if path == session.route.path => take_callback(session, &url).await,
        PAGE_PATH => Reply::page(200, page(session)),
        STATUS_PATH => status_reply(session),
        _ => Reply::not_found(),
    }
}

/// Hands the provider's answer to the core once, then sends the browser on to the page.
async fn take_callback(session: &Session, url: &reqwest::Url) -> Reply {
    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let read = |key: &str| query.get(key).map(|value| value.trim().to_string()).unwrap_or_default();
    let (state, code) = (read("state"), read("code"));
    let error = Some(read("error")).filter(|value| !value.is_empty()).unwrap_or_else(|| read("error_description"));
    if state != session.state {
        let failed = "This link is from an earlier sign-in. Start the sign-in again in Arbor.";
        return Reply::page(400, render(session.route, "failed", Some(failed)));
    }
    if session.outcome.lock().map(|outcome| outcome.delivered).unwrap_or(true) {
        return Reply::redirect(PAGE_PATH);
    }
    if code.is_empty() && error.is_empty() {
        return Reply::page(400, render(session.route, "failed", Some("The provider didn't send a sign-in code. Try again in Arbor.")));
    }
    let delivered = session.core.deliver(session.route.provider, &session.state, &code, &error).await;
    if let Ok(mut outcome) = session.outcome.lock() {
        outcome.delivered = true;
        outcome.failed = if !error.is_empty() {
            Some(provider_error(&error))
        } else {
            delivered.err().map(|reason| format!("Arbor couldn't finish the sign-in: {reason}"))
        };
    }
    Reply::redirect(PAGE_PATH)
}

/// The readable start of the core's reason. A failed token exchange carries the provider's whole
/// JSON reply after it, which means nothing on the page and could say more than it should.
fn short_reason(reason: &str) -> String {
    let end = reason.find(['{', '\n']).unwrap_or(reason.len());
    let short: String = reason[..end].trim().trim_end_matches(':').trim().chars().take(160).collect();
    if short.is_empty() { "Authentication failed".to_string() } else { short }
}

fn provider_error(error: &str) -> String {
    match error {
        "access_denied" => "The sign-in was canceled on the provider's page.".to_string(),
        other => format!("The provider said: {other}"),
    }
}

fn status_reply(session: &Session) -> Reply {
    let (status, error) = match session.outcome.lock() {
        Ok(outcome) => match (&outcome.failed, &outcome.status) {
            (Some(failed), _) => ("error", Some(failed.clone())),
            (None, Status::Failed(reason)) => ("error", Some(reason.clone())),
            (None, Status::Ok) => ("ok", None),
            (None, Status::Waiting) => ("wait", None),
        },
        Err(_) => ("wait", None),
    };
    let body = serde_json::json!({ "status": status, "error": error }).to_string();
    Reply { status: 200, content_type: "application/json", location: None, body }
}

fn page(session: &Session) -> String {
    let Ok(outcome) = session.outcome.lock() else {
        return render(session.route, "unknown", None);
    };
    match (&outcome.failed, &outcome.status) {
        (Some(failed), _) | (None, Status::Failed(failed)) => render(session.route, "failed", Some(failed)),
        (None, Status::Ok) => render(session.route, "done", None),
        (None, Status::Waiting) if outcome.delivered => render(session.route, "finishing", None),
        // Opened by hand before the provider sent the browser back.
        (None, Status::Waiting) => render(session.route, "unknown", None),
    }
}

#[derive(Serialize)]
struct PageData<'a> {
    provider: &'a str,
    phase: &'a str,
    error: Option<&'a str>,
}

fn render(route: &CallbackRoute, phase: &str, error: Option<&str>) -> String {
    let data = serde_json::to_string(&PageData { provider: route.name, phase, error }).unwrap_or_else(|_| "null".to_string());
    // Inside a script element, "<" could close it, so it's written as an escape that JSON reads the same.
    let data = data.replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026");
    PAGE_TEMPLATE.replace("/*PROVIDER_ICON*/", route.icon).replace("/*PAGE*/null", &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for the core: records what it was handed and answers as told.
    #[derive(Default)]
    pub(super) struct FakeCore {
        pub(super) delivered: Vec<(String, String)>,
        pub(super) reject: Option<String>,
        pub(super) status: Status,
    }

    impl FakeCore {
        pub(super) fn deliver(&mut self, code: &str, error: &str) -> Result<(), String> {
            self.delivered.push((code.to_string(), error.to_string()));
            self.reject.clone().map_or(Ok(()), Err)
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    fn codex(fake: FakeCore) -> Session {
        Session::new(route("codex").unwrap(), "state-1".to_string(), Core::Fake(Mutex::new(fake)))
    }

    fn delivered(session: &Session) -> Vec<(String, String)> {
        match &session.core {
            Core::Fake(fake) => fake.lock().unwrap().delivered.clone(),
            Core::Management(_) => unreachable!(),
        }
    }

    fn page_data(html: &str) -> serde_json::Value {
        let start = html.find("const PAGE = ").unwrap() + "const PAGE = ".len();
        let end = start + html[start..].find(";\n").unwrap();
        serde_json::from_str(&html[start..end]).unwrap()
    }

    #[test]
    fn each_provider_answers_on_the_address_it_registered() {
        let codex = route("codex").unwrap();
        assert_eq!((codex.port, codex.path, codex.name), (1455, "/auth/callback", "Codex"));
        let claude = route("anthropic").unwrap();
        assert_eq!((claude.port, claude.path, claude.name), (54545, "/callback", "Claude"));
        assert_eq!(route("antigravity").map(|route| route.port), Some(51121));
        // xAI signs in with a device code, so there's no redirect to answer.
        assert!(route("xai").is_none());
    }

    #[test]
    fn a_callback_goes_to_the_core_once_and_the_browser_moves_on_to_the_page() {
        let session = codex(FakeCore::default());
        let reply = block_on(respond(&session, "GET", "/auth/callback?code=abc&state=state-1&scope=openid"));
        assert_eq!((reply.status, reply.location.as_deref()), (303, Some(PAGE_PATH)));
        // Going back to the callback address doesn't send the code again.
        let again = block_on(respond(&session, "GET", "/auth/callback?code=abc&state=state-1"));
        assert_eq!(again.status, 303);
        assert_eq!(delivered(&session), vec![("abc".to_string(), String::new())]);

        let page = block_on(respond(&session, "GET", PAGE_PATH));
        assert_eq!(page.status, 200);
        assert!(!page.body.contains("abc"), "the code stays out of the page");
        assert_eq!(page_data(&page.body), serde_json::json!({ "provider": "Codex", "phase": "finishing", "error": null }));
        assert!(page.body.contains("<title>Codex</title>"), "the provider's icon is drawn in");
        assert_eq!(block_on(respond(&session, "GET", STATUS_PATH)).body, r#"{"error":null,"status":"wait"}"#);

        session.outcome.lock().unwrap().status = Status::Ok;
        assert_eq!(block_on(respond(&session, "GET", STATUS_PATH)).body, r#"{"error":null,"status":"ok"}"#);
        assert_eq!(page_data(&block_on(respond(&session, "GET", PAGE_PATH)).body)["phase"], "done");
    }

    #[test]
    fn a_refusal_on_the_providers_page_reaches_the_core_and_the_page_says_so() {
        let session = codex(FakeCore::default());
        block_on(respond(&session, "GET", "/auth/callback?error=access_denied&state=state-1"));
        assert_eq!(delivered(&session), vec![(String::new(), "access_denied".to_string())]);
        let data = page_data(&block_on(respond(&session, "GET", PAGE_PATH)).body);
        assert_eq!((data["phase"].as_str(), data["error"].as_str()), (Some("failed"), Some("The sign-in was canceled on the provider's page.")));
        assert!(block_on(respond(&session, "GET", STATUS_PATH)).body.contains(r#""status":"error""#));
    }

    #[test]
    fn a_core_that_turns_the_callback_down_shows_its_reason() {
        let session = codex(FakeCore { reject: Some("unknown or expired state".to_string()), ..FakeCore::default() });
        block_on(respond(&session, "GET", "/auth/callback?code=abc&state=state-1"));
        let data = page_data(&block_on(respond(&session, "GET", PAGE_PATH)).body);
        assert_eq!(data["error"], "Arbor couldn't finish the sign-in: unknown or expired state");
    }

    #[test]
    fn a_callback_for_another_sign_in_or_without_a_code_is_never_handed_on() {
        let session = codex(FakeCore::default());
        let stale = block_on(respond(&session, "GET", "/auth/callback?code=abc&state=older"));
        assert_eq!((stale.status, page_data(&stale.body)["phase"].as_str()), (400, Some("failed")));
        let empty = block_on(respond(&session, "GET", "/auth/callback?state=state-1"));
        assert_eq!(empty.status, 400);
        assert!(delivered(&session).is_empty());
        assert_eq!(block_on(respond(&session, "GET", "/favicon.ico")).status, 404);
        assert_eq!(block_on(respond(&session, "POST", "/auth/callback?code=abc&state=state-1")).status, 405);
        // Opened before the provider sent the browser back, the page doesn't claim anything.
        assert_eq!(page_data(&block_on(respond(&session, "GET", PAGE_PATH)).body)["phase"], "unknown");
    }

    #[test]
    fn the_cores_reason_is_cut_to_its_readable_start() {
        let exchange = "Failed to exchange authorization code for tokens: token exchange failed with status 401: {\n  \"error\": {}\n}";
        assert_eq!(short_reason(exchange), "Failed to exchange authorization code for tokens: token exchange failed with status 401");
        assert_eq!(short_reason("unknown or expired state"), "unknown or expired state");
        assert_eq!(short_reason(" {\"error\":1}"), "Authentication failed");
        assert_eq!(short_reason(&"x".repeat(500)).len(), 160);
    }

    #[test]
    fn a_providers_error_text_cant_break_out_of_the_page() {
        let session = codex(FakeCore::default());
        let target = "/auth/callback?state=state-1&error=%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E";
        block_on(respond(&session, "GET", target));
        let page = block_on(respond(&session, "GET", PAGE_PATH)).body;
        assert!(!page.contains("</script><script>alert"));
        assert_eq!(page_data(&page)["error"], "The provider said: </script><script>alert(1)</script>");
    }

    #[test]
    fn a_request_over_the_wire_gets_a_whole_answer_that_isnt_cached_or_referred() {
        let session = codex(FakeCore::default());
        let (mut browser, mut server) = tokio::io::duplex(64 * 1024);
        let answer = block_on(async {
            browser.write_all(b"GET /status HTTP/1.1\r\nHost: localhost:1455\r\n\r\n").await.unwrap();
            super::answer(&session, &mut server).await;
            drop(server);
            let mut answer = String::new();
            browser.read_to_string(&mut answer).await.unwrap();
            answer
        });
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"));
        for header in ["Cache-Control: no-store", "Referrer-Policy: no-referrer", "connect-src 'self'", "Connection: close"] {
            assert!(answer.contains(header), "missing {header}");
        }
        assert!(answer.ends_with(r#"{"error":null,"status":"wait"}"#));
    }
}
