//! Compute's round against canned answers: no request here reaches the network.

use super::*;
use crate::usage::machine_health::harnesses::Harness;
use std::sync::atomic::{AtomicUsize, Ordering};

const BASE: &str = "https://boat.dev/api/v1";
const FAKE_KEY: &str = "boat_fake_key_for_tests_0123456789";
const SECRET: &str = "boat_SECRET_TOKEN_in_a_command_line_42";
const NOW: i64 = 1_800_000_000_000;

fn boat() -> &'static dyn ComputeProvider {
    provider_by_id(ComputeProviderId::Boat).unwrap()
}

/// Answers by path (with its query); anything it wasn't given is a 404. Records every address asked for, and the most
/// requests that were open at once.
#[derive(Default)]
struct FakeHttp {
    answers: Mutex<HashMap<String, (u16, String)>>,
    asked: Mutex<Vec<String>>,
    open: AtomicUsize,
    most_open: AtomicUsize,
}

impl FakeHttp {
    fn answer(&self, path: &str, status: u16, body: impl Into<String>) {
        self.answers.lock().unwrap().insert(path.to_string(), (status, body.into()));
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }

    fn take_asked(&self) -> Vec<String> {
        std::mem::take(&mut *self.asked.lock().unwrap())
    }
}

impl ComputeHttp for FakeHttp {
    fn get<'a>(&'a self, url: &'a reqwest::Url, key: &'a ComputeKey) -> BoxFuture<'a, Result<ComputeReply, ComputeFailure>> {
        Box::pin(async move {
            assert_eq!(key.expose(), FAKE_KEY);
            let path = url.as_str().strip_prefix(BASE).expect("only the fixed base").to_string();
            self.asked.lock().unwrap().push(url.as_str().to_string());
            let open = self.open.fetch_add(1, Ordering::SeqCst) + 1;
            self.most_open.fetch_max(open, Ordering::SeqCst);
            tokio::task::yield_now().await;
            self.open.fetch_sub(1, Ordering::SeqCst);
            let (status, body) = self.answers.lock().unwrap().get(&path).cloned().unwrap_or((404, "{}".into()));
            Ok(ComputeReply { status, retry_after_secs: (status == 429).then_some(120), body })
        })
    }
}

fn wire_sandbox(id: &str, state: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": format!("cedar-02-{id}"), "state": state, "type": "default", "vcpu": 4, "memoryGB": 8,
        "billingMultiplier": 1, "health": "ok", "createdAt": "2027-01-15T08:00:00Z", "ttlSeconds": 3600,
        "archiveAfter": "2027-01-15T09:00:00Z", "desktopUrl": "https://desktop.example/?token=DESKTOP_SECRET",
        "ip": "203.0.113.10", "createdBy": "Someone Real", "labels": {},
        "cost": {"since": "2027-01-01T00:00:00Z", "seconds": 3600, "dollars": 0.0}
    })
}

fn list_body(sandboxes: Vec<serde_json::Value>, next: Option<&str>) -> String {
    serde_json::json!({
        "ok": true, "type": "sandbox.list", "sandboxes": sandboxes,
        "pageInfo": {"nextCursor": next, "hasMore": next.is_some(), "limit": 200}
    })
    .to_string()
}

const LIST: &str = "/sandboxes?include=cost&limit=200";

/// Eight-letter ids in Boat's alphabet.
fn id(n: usize) -> String {
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    let mut text = String::from("bx_");
    let mut rest = n;
    for _ in 0..8 {
        text.push(ALPHABET[rest % ALPHABET.len()] as char);
        rest /= ALPHABET.len();
    }
    text
}

fn processes(cpu: f64, memory: f64) -> String {
    serde_json::json!({
        "ok": true, "type": "process.list", "live": true, "sampledAt": "2027-01-15T08:30:00Z", "total": 2,
        "processes": [
            {"pid": 41, "parentPid": 1, "user": "someone", "cpuPercent": cpu, "memoryMB": memory,
             "startedAt": "2027-01-15T08:00:00Z", "command": format!("agent --token {SECRET}"), "commandId": null},
            {"pid": 42, "command": format!("curl -H 'Authorization: Bearer {SECRET}'"), "cpuPercent": 0, "memoryMB": 0}
        ]
    })
    .to_string()
}

const LIMITS: &str = r#"{"ok":true,"type":"limits.info","canStart":true,"activeSandboxes":2,"maxActiveSandboxes":10,
    "starts":{"minute":{"limit":10,"used":1,"remaining":9},"hour":{"limit":50,"used":2,"remaining":48},"day":{"limit":150,"used":3,"remaining":147}},
    "planIncluded":{"vmHours":100,"vmHoursRemaining":10,"periodEnd":"2027-02-01T00:00:00Z"}}"#;

fn read_from(http: &FakeHttp, live: &Live) -> ProviderRead {
    let key = ComputeKey::new(FAKE_KEY);
    let api = ProviderApi { provider: boat(), key: &key, http };
    tauri::async_runtime::block_on(read_provider(boat(), &api, &live.load_read_at))
}

fn read_now(http: &FakeHttp, live: &mut Live, now: i64) {
    let read = read_from(http, live);
    apply_read(live, read, now);
}

fn processes_asked(asked: Vec<String>) -> Vec<String> {
    asked.into_iter().filter_map(|url| url.strip_suffix("/processes").and_then(|rest| rest.rsplit('/').next()).map(String::from)).collect()
}

fn live() -> Live {
    Live::new(ComputeKey::new(FAKE_KEY))
}

fn listed(id: &str, state: ComputeSandboxState) -> ListedSandbox {
    ListedSandbox {
        id: id.into(),
        name: id.into(),
        size: "default".into(),
        vcpus: 4,
        memory_gb: 8.0,
        multiplier: Some(1.0),
        state,
        issue: None,
        issue_since_ms: None,
        created_at_ms: NOW - 60_000,
        run_started_at_ms: Some(NOW - 60_000),
        stops_at_ms: None,
        auto_stop_seconds: Some(3600),
        month_hours: None,
        month_dollars: None,
        mine: true,
        monitoring_off: false,
        label_machine: None,
        label_session: None,
    }
}

#[test]
fn a_secret_in_a_command_line_crosses_nowhere() {
    let http = FakeHttp::default();
    let (a, b, c, d) = (id(1), id(2), id(3), id(4));
    let sandboxes = [&a, &b, &c, &d].map(|id| wire_sandbox(id, "running")).to_vec();
    http.answer(LIST, 200, list_body(sandboxes, None));
    // Errors whose bodies repeat the secret: their bodies are never read.
    http.answer("/limits", 403, format!("{{\"code\":\"forbidden\",\"message\":\"{SECRET}\"}}"));
    http.answer(&format!("/sandboxes/{a}/processes"), 200, processes(200.0, 2048.0));
    http.answer(&format!("/sandboxes/{b}/processes"), 500, format!("{{\"message\":\"{SECRET}\"}}"));
    // A 200 that doesn't parse, with the secret in it.
    http.answer(&format!("/sandboxes/{c}/processes"), 200, format!("{{\"live\":true,\"processes\":[{{\"command\":\"{SECRET}\",\"cpuPercent\":\"x\"}}"));
    http.answer(&format!("/sandboxes/{d}/processes"), 429, format!("{{\"message\":\"{SECRET}\"}}"));
    let mut state = live();
    let read = read_from(&http, &state);
    // Every result of the round, failures included, as it came back from the provider.
    let returned = format!("{read:?}");
    assert!(returned.contains("Unexpected") && returned.contains("Unreachable") && returned.contains("RateLimited"), "{returned}");
    for secret in [SECRET, "DESKTOP_SECRET", "203.0.113.10", "Someone Real", FAKE_KEY] {
        assert!(!returned.contains(secret), "{secret} in {returned}");
    }
    apply_read(&mut state, read, NOW);
    let snapshot = serde_json::to_string(&provider_snapshot(boat(), &state, NOW)).unwrap();
    let history = serde_json::to_string(&state.rings.values().flatten().collect::<Vec<_>>()).unwrap();
    for text in [&snapshot, &history] {
        for secret in [SECRET, "DESKTOP_SECRET", "203.0.113.10", "Someone Real", FAKE_KEY] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
    }
    assert!(!format!("{:?}{:?}", state.sandboxes, state.key).contains(SECRET));
    assert!(!format!("{:?}", state.key).contains(FAKE_KEY));
    assert!(snapshot.contains("\"kind\":\"read\""));
}

#[test]
fn only_allowed_gets_on_the_fixed_base_leave() {
    let http = FakeHttp::default();
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&id(1), "running")], None));
    let key = ComputeKey::new(FAKE_KEY);
    let api = ProviderApi { provider: boat(), key: &key, http: &http };
    for path in ["/sandboxes/bx_23456789/conversations", "/ai-usage", "/sandboxes/bx_23456789/events", "//evil.example/x", "@evil.example/x", "/api-keys"] {
        let answer = tauri::async_runtime::block_on(api.get(path));
        assert_eq!(answer.err(), Some(ComputeFailure::Unsupported), "{path}");
    }
    assert!(http.asked().is_empty(), "nothing off the allowlist was sent");
    let mut state = live();
    read_now(&http, &mut state, NOW);
    let asked = http.asked();
    assert!(!asked.is_empty());
    for url in asked {
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!((parsed.scheme(), parsed.host_str()), ("https", Some("boat.dev")));
        let path = url.strip_prefix(BASE).unwrap();
        assert!(boat().allows(path), "{path}");
    }
    assert!(request_url(boat(), "/limits").is_some());
    assert!(request_url(boat(), "limits").is_none());
}

#[test]
fn a_live_false_sample_is_ignored() {
    let http = FakeHttp::default();
    let a = id(1);
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&a, "running")], None));
    http.answer(&format!("/sandboxes/{a}/processes"), 200, r#"{"ok":true,"live":false,"sampledAt":null,"total":1,"processes":[{"pid":1,"command":"x","cpuPercent":90,"memoryMB":100}]}"#);
    let mut state = live();
    read_now(&http, &mut state, NOW);
    assert!(state.rings.is_empty(), "the stale sample isn't kept");
    let snapshot = provider_snapshot(boat(), &state, NOW);
    // A running sandbox whose agent can't report says so, rather than "not read yet" for as long as it runs.
    assert_eq!(snapshot.sandboxes[0].load, ComputeLoad::Unavailable);
    // Once it reports, the reading shows.
    http.answer(&format!("/sandboxes/{a}/processes"), 200, processes(40.0, 512.0));
    read_now(&http, &mut state, NOW + 60_000);
    assert!(matches!(provider_snapshot(boat(), &state, NOW).sandboxes[0].load, ComputeLoad::Read { .. }));
}

#[test]
fn a_sandbox_made_with_monitoring_off_is_never_asked_for_its_processes() {
    let http = FakeHttp::default();
    let (a, b) = (id(1), id(2));
    let mut quiet = wire_sandbox(&a, "running");
    quiet["monitoring"] = serde_json::json!(false);
    http.answer(LIST, 200, list_body(vec![quiet, wire_sandbox(&b, "running")], None));
    http.answer(&format!("/sandboxes/{b}/processes"), 200, processes(40.0, 512.0));
    let mut state = live();
    read_now(&http, &mut state, NOW);
    assert_eq!(processes_asked(http.asked()), [b.clone()]);
    let snapshot = provider_snapshot(boat(), &state, NOW);
    let load = |id: &str| snapshot.sandboxes.iter().find(|sandbox| sandbox.id == id).unwrap().load;
    assert_eq!(load(&a), ComputeLoad::MonitoringOff);
    assert!(matches!(load(&b), ComputeLoad::Read { .. }));
}

#[test]
fn a_429_on_processes_honors_retry_after_and_sends_no_more() {
    let http = FakeHttp::default();
    let ids: Vec<String> = (0..30).map(id).collect();
    http.answer(LIST, 200, list_body(ids.iter().map(|id| wire_sandbox(id, "running")).collect(), None));
    http.answer("/limits", 200, LIMITS);
    for id in &ids {
        http.answer(&format!("/sandboxes/{id}/processes"), 429, "{}");
    }
    let mut state = live();
    read_now(&http, &mut state, NOW);
    let asked = processes_asked(http.take_asked());
    assert!(!asked.is_empty() && asked.len() <= LOADS_AT_ONCE, "only those already open: {}", asked.len());
    assert_eq!(state.status, ComputeProviderStatus::RateLimited);
    assert_eq!(state.rate_limited_until_ms, NOW + 120_000);
    assert!(!state.due(NOW + 60_000, false));
    assert!(!state.due(NOW + 60_000, true));
    // Those never sent weren't read, so they're first next time.
    assert_eq!(state.load_read_at.len(), asked.len());
    // A 403 on limits says more than a slow-down, so it stays.
    http.answer("/limits", 403, "{}");
    let mut scoped = live();
    read_now(&http, &mut scoped, NOW);
    assert_eq!(scoped.status, ComputeProviderStatus::LimitsNeedScope);
    assert_eq!(scoped.rate_limited_until_ms, NOW + 120_000);
}

#[test]
fn an_expired_key_is_refused_not_short_of_scope() {
    let http = FakeHttp::default();
    http.answer(LIST, 403, r#"{"ok":false,"code":"api_key_expired","message":"words"}"#);
    let mut state = live();
    let read = read_from(&http, &state);
    assert_eq!(read.list.as_ref().err(), Some(&ComputeFailure::Refused));
    assert!(connect_error("Boat", ComputeFailure::Refused).message.contains("expired"));
    apply_read(&mut state, read, NOW);
    assert_eq!(state.status, ComputeProviderStatus::Refused);
    // Another 403 is still a key without the scope.
    http.answer(LIST, 403, r#"{"ok":false,"code":"forbidden"}"#);
    assert_eq!(read_from(&http, &live()).list.err(), Some(ComputeFailure::Forbidden));
}

#[test]
fn a_list_past_the_page_cap_is_kept_as_partial_and_prunes_nothing() {
    let http = FakeHttp::default();
    // Fifty pages, each saying there's more.
    for page in 0..50 {
        let path = if page == 0 { LIST.to_string() } else { format!("{LIST}&cursor=p{page}") };
        http.answer(&path, 200, list_body(vec![wire_sandbox(&id(page), "stopped")], Some(&format!("p{}", page + 1))));
    }
    let mut state = live();
    let read = read_from(&http, &state);
    assert!(read.list.as_ref().is_ok_and(|listed| listed.partial && listed.sandboxes.len() == 50));
    assert_eq!(prunable_ids(&read), None, "a partial list never prunes links");
    apply_read(&mut state, read, NOW);
    let snapshot = provider_snapshot(boat(), &state, NOW);
    assert_eq!(snapshot.status, ComputeProviderStatus::Ok);
    assert!(snapshot.list_partial);
    assert_eq!(snapshot.sandboxes.len(), 50);
    assert!(!http.asked().iter().any(|url| url.ends_with("cursor=p50")), "no page past the cap");
    // A whole list prunes, and says it's whole.
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&id(0), "stopped")], None));
    let read = read_from(&http, &state);
    assert_eq!(prunable_ids(&read), Some(vec![id(0)]));
    apply_read(&mut state, read, NOW);
    assert!(!provider_snapshot(boat(), &state, NOW).list_partial);
}

#[test]
fn monitoring_off_and_a_key_that_cant_read_load_say_so_without_failing_the_round() {
    let http = FakeHttp::default();
    let (a, b) = (id(1), id(2));
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&a, "running"), wire_sandbox(&b, "running")], None));
    http.answer("/limits", 200, LIMITS);
    http.answer(&format!("/sandboxes/{a}/processes"), 409, r#"{"ok":false,"code":"monitoring_off","message":"words"}"#);
    http.answer(&format!("/sandboxes/{b}/processes"), 403, r#"{"ok":false,"code":"forbidden"}"#);
    let mut state = live();
    read_now(&http, &mut state, NOW);
    let snapshot = provider_snapshot(boat(), &state, NOW);
    assert_eq!(snapshot.status, ComputeProviderStatus::Ok);
    let load = |id: &str| snapshot.sandboxes.iter().find(|sandbox| sandbox.id == id).unwrap().load;
    assert_eq!(load(&a), ComputeLoad::MonitoringOff);
    assert_eq!(load(&b), ComputeLoad::Unavailable);
    // Another 409 is not monitoring being off.
    http.answer(&format!("/sandboxes/{a}/processes"), 409, r#"{"ok":false,"code":"something_else"}"#);
    let mut other = live();
    read_now(&http, &mut other, NOW);
    assert_eq!(provider_snapshot(boat(), &other, NOW).sandboxes[0].load, ComputeLoad::NotReadYet);
}

#[test]
fn a_403_on_limits_keeps_the_list() {
    let http = FakeHttp::default();
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&id(1), "archived")], None));
    http.answer("/limits", 403, "{}");
    let mut state = live();
    read_now(&http, &mut state, NOW);
    let snapshot = provider_snapshot(boat(), &state, NOW);
    assert_eq!(snapshot.status, ComputeProviderStatus::LimitsNeedScope);
    assert_eq!(snapshot.sandboxes.len(), 1);
    assert_eq!(snapshot.sandboxes[0].state, ComputeSandboxState::Stopped);
    assert!(snapshot.limits.is_empty());
    assert_eq!(snapshot.checked_at_ms, Some(NOW));
}

#[test]
fn a_401_on_the_list_is_refused_and_the_last_figures_stay() {
    let http = FakeHttp::default();
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&id(1), "running")], None));
    let mut state = live();
    read_now(&http, &mut state, NOW);
    http.answer(LIST, 401, r#"{"ok":false,"code":"unauthorized"}"#);
    read_now(&http, &mut state, NOW + 60_000);
    let snapshot = provider_snapshot(boat(), &state, NOW + 60_000);
    assert_eq!(snapshot.status, ComputeProviderStatus::Refused);
    assert_eq!(snapshot.sandboxes.len(), 1);
    assert_eq!(snapshot.checked_at_ms, Some(NOW));
    http.answer(LIST, 403, "{}");
    read_now(&http, &mut state, NOW + 120_000);
    assert_eq!(state.status, ComputeProviderStatus::Refused);
}

#[test]
fn failures_back_off_to_ten_minutes_and_retry_after_is_honored() {
    let http = FakeHttp::default();
    http.answer(LIST, 503, "{}");
    let mut state = live();
    let mut waits = Vec::new();
    for round in 0..7 {
        read_now(&http, &mut state, NOW + round);
        waits.push(state.next_try_at_ms - (NOW + round));
    }
    assert_eq!(waits, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
    assert_eq!(state.status, ComputeProviderStatus::Unreachable);
    assert!(!state.due(NOW + 7, false));
    assert!(state.due(NOW + 7, true), "Check now skips a backoff");
    http.answer(LIST, 429, "{}");
    let mut limited = live();
    read_now(&http, &mut limited, NOW);
    assert_eq!(limited.status, ComputeProviderStatus::RateLimited);
    assert_eq!(limited.rate_limited_until_ms, NOW + 120_000);
    assert!(!limited.due(NOW + 60_000, true), "not even Check now goes before Retry-After");
    assert!(limited.due(NOW + 120_000, false));
}

#[test]
fn the_list_is_read_page_by_page_by_cursor() {
    let http = FakeHttp::default();
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&id(1), "running"), wire_sandbox(&id(2), "cancelled")], Some("c/2==")));
    http.answer(&format!("{LIST}&cursor=c%2F2%3D%3D"), 200, list_body(vec![wire_sandbox(&id(3), "stopped")], None));
    let mut state = live();
    read_now(&http, &mut state, NOW);
    let ids: Vec<&str> = state.sandboxes.iter().map(|sandbox| sandbox.id.as_str()).collect();
    assert_eq!(ids, [id(1), id(3)], "a cancelled sandbox is dropped");
    // A cursor that comes back again would loop forever.
    http.answer(&format!("{LIST}&cursor=c%2F2%3D%3D"), 200, list_body(vec![], Some("c/2==")));
    let mut looping = live();
    read_now(&http, &mut looping, NOW);
    assert_eq!(looping.status, ComputeProviderStatus::Unreachable);
}

#[test]
fn load_is_read_for_24_a_round_least_recently_read_first_and_8_at_once() {
    let http = FakeHttp::default();
    let ids: Vec<String> = (0..30).map(id).collect();
    http.answer(LIST, 200, list_body(ids.iter().map(|id| wire_sandbox(id, "running")).collect(), None));
    for id in &ids {
        http.answer(&format!("/sandboxes/{id}/processes"), 200, processes(40.0, 512.0));
    }
    let mut state = live();
    read_now(&http, &mut state, NOW);
    let first = processes_asked(http.take_asked());
    assert_eq!(first.len(), 24);
    assert!(http.most_open.load(Ordering::SeqCst) <= 8);
    assert_eq!(http.most_open.load(Ordering::SeqCst), 8);
    read_now(&http, &mut state, NOW + 60_000);
    let second = processes_asked(http.take_asked());
    assert_eq!(second.len(), 24);
    let never_read: Vec<&String> = ids.iter().filter(|id| !first.contains(id)).collect();
    assert_eq!(never_read.len(), 6);
    for id in never_read {
        assert!(second.contains(id), "{id} waited longest and is read next");
    }
}

#[test]
fn rings_hold_120_points_the_row_gets_30_and_leavers_lose_theirs() {
    let http = FakeHttp::default();
    let (a, b) = (id(1), id(2));
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&a, "running"), wire_sandbox(&b, "running")], None));
    http.answer(&format!("/sandboxes/{a}/processes"), 200, processes(40.0, 512.0));
    http.answer(&format!("/sandboxes/{b}/processes"), 200, processes(40.0, 512.0));
    let mut state = live();
    for round in 0..130 {
        read_now(&http, &mut state, NOW + round * 60_000);
    }
    let ring = &state.rings[&a];
    assert_eq!(ring.len(), RING_POINTS);
    assert_eq!(ring.front().unwrap().at_ms, NOW + 10 * 60_000);
    let snapshot = provider_snapshot(boat(), &state, NOW);
    assert_eq!(snapshot.sandboxes[0].points.len(), SPARK_POINTS);
    assert_eq!(snapshot.sandboxes[0].points.last().unwrap().at_ms, NOW + 129 * 60_000);
    // b leaves the list.
    http.answer(LIST, 200, list_body(vec![wire_sandbox(&a, "running")], None));
    read_now(&http, &mut state, NOW + 200 * 60_000);
    assert!(!state.rings.contains_key(&b));
    assert!(!state.load_read_at.contains_key(&b));
    assert!(state.rings.contains_key(&a));
}

fn lookup(machines: &[&str], sessions: &[(&str, Option<i64>, Option<Harness>)]) -> ComputeLookup {
    ComputeLookup {
        machines: machines.iter().map(|machine| machine.to_string()).collect(),
        sessions: sessions
            .iter()
            .map(|(id, last, harness)| (id.to_string(), SeenSession { last_request_ms: *last, harness: *harness }))
            .collect(),
    }
}

fn claim(sandbox_id: &str, machine: &str, session: Option<&str>, linked_at_ms: i64) -> ComputeClaim {
    ComputeClaim {
        provider: ComputeProviderId::Boat,
        sandbox_id: sandbox_id.into(),
        machine: machine.into(),
        session: session.map(String::from),
        linked_at_ms,
    }
}

#[test]
fn a_link_wins_over_labels_and_unlinking_falls_back_to_them() {
    let mut labelled = listed("bx_23456789", ComputeSandboxState::Running);
    labelled.label_machine = Some("ci-01".into());
    labelled.label_session = Some("s-label".into());
    let mut teammate = listed("bx_3456789a", ComputeSandboxState::Running);
    teammate.mine = false;
    teammate.label_machine = Some("ci-01".into());
    let sandboxes = [labelled, teammate];
    let claims = [claim("bx_23456789", "cam-mbp", Some("s-claim"), NOW)];
    let wanted = wanted_links(ComputeProviderId::Boat, &sandboxes, &claims);
    assert_eq!(
        wanted,
        [Wanted {
            id: "bx_23456789".into(),
            machine: Some("cam-mbp".into()),
            session: Some("s-claim".into()),
            by: ComputeLinkedBy::Link
        }],
        "a teammate's sandbox is never linked"
    );
    let unlinked = wanted_links(ComputeProviderId::Boat, &sandboxes, &[]);
    assert_eq!(unlinked[0].machine.as_deref(), Some("ci-01"));
    assert_eq!(unlinked[0].session.as_deref(), Some("s-label"));
    assert_eq!(unlinked[0].by, ComputeLinkedBy::Label);
    // A label that isn't a session id's shape is ignored.
    let mut odd = listed("bx_456789ab", ComputeSandboxState::Running);
    odd.label_session = Some("not a session; rm -rf".into());
    assert_eq!(wanted_links(ComputeProviderId::Boat, &[odd], &[])[0].session, None);
}

#[test]
fn links_prune_only_once_the_list_has_had_time_to_catch_up() {
    let mut claims = vec![
        claim("bx_23456789", "cam-mbp", None, NOW - CLAIM_GRACE_MS - 1),
        claim("bx_3456789a", "cam-mbp", None, NOW - 1_000),
        claim("bx_456789ab", "cam-mbp", None, NOW - CLAIM_GRACE_MS - 1),
    ];
    let listed: HashSet<&str> = ["bx_456789ab"].into_iter().collect();
    assert!(prune_claims(&mut claims, ComputeProviderId::Boat, &listed, NOW));
    let kept: Vec<&str> = claims.iter().map(|claim| claim.sandbox_id.as_str()).collect();
    assert_eq!(kept, ["bx_3456789a", "bx_456789ab"]);
    assert!(!prune_claims(&mut claims, ComputeProviderId::Boat, &listed, NOW));
}

#[test]
fn machines_resolve_exactly_and_sessions_by_id() {
    let wanted = [
        Wanted { id: "a".into(), machine: Some("cam-mbp".into()), session: Some("s-live".into()), by: ComputeLinkedBy::Link },
        Wanted { id: "b".into(), machine: Some("Cam-MBP".into()), session: Some("s-never".into()), by: ComputeLinkedBy::Label },
        Wanted { id: "c".into(), machine: None, session: Some("s-ended".into()), by: ComputeLinkedBy::Label },
        Wanted { id: "d".into(), machine: None, session: None, by: ComputeLinkedBy::Label },
    ];
    let found = lookup(
        &["cam-mbp", "ci-01"],
        &[("s-live", Some(NOW - 60_000), Some(Harness::Claude)), ("s-ended", Some(NOW - 3_600_000), Some(Harness::Codex))],
    );
    let links = resolve_links(&wanted, &found, NOW);
    let a = &links["a"];
    assert_eq!((a.machine.as_deref(), a.problem), (Some("cam-mbp"), None));
    assert_eq!(
        a.session,
        Some(ComputeSession { id: "s-live".into(), known: true, live: true, ended_at_ms: None, harness: Some(Harness::Claude) })
    );
    let b = &links["b"];
    assert_eq!((b.machine.as_deref(), b.problem), (None, Some(ComputeLinkProblem::UnknownMachine)));
    assert_eq!(b.session, Some(ComputeSession { id: "s-never".into(), known: false, live: false, ended_at_ms: None, harness: None }));
    let c = &links["c"];
    assert_eq!(c.problem, Some(ComputeLinkProblem::NotLinked));
    assert_eq!(c.session.as_ref().and_then(|session| session.ended_at_ms), Some(NOW - 3_600_000));
    // Where each came from, so the window offers Unlink only for a link; nothing named means nothing to undo.
    assert_eq!((a.by, b.by, c.by, links["d"].by), (Some(ComputeLinkedBy::Link), Some(ComputeLinkedBy::Label), Some(ComputeLinkedBy::Label), None));
}

#[test]
fn the_snapshot_says_whether_a_link_or_a_label_linked_it() {
    let mut state = live();
    state.sandboxes = vec![listed("bx_23456789", ComputeSandboxState::Running), listed("bx_3456789a", ComputeSandboxState::Running)];
    let wanted = wanted_links(
        ComputeProviderId::Boat,
        &[ListedSandbox { label_machine: Some("ci-01".into()), ..listed("bx_3456789a", ComputeSandboxState::Running) }, listed("bx_23456789", ComputeSandboxState::Running)],
        &[claim("bx_23456789", "cam-mbp", None, NOW)],
    );
    state.links = resolve_links(&wanted, &lookup(&["cam-mbp", "ci-01"], &[]), NOW);
    let snapshot = provider_snapshot(boat(), &state, NOW);
    let by = |id: &str| snapshot.sandboxes.iter().find(|sandbox| sandbox.id == id).unwrap().linked_by;
    assert_eq!(by("bx_23456789"), Some(ComputeLinkedBy::Link));
    assert_eq!(by("bx_3456789a"), Some(ComputeLinkedBy::Label));
    assert!(serde_json::to_string(&snapshot).unwrap().contains("\"linkedBy\":\"link\""));
}

#[test]
fn links_read_from_an_older_links_file_never_overwrite_newer_ones() {
    let mut inner = Inner::default();
    inner.providers.insert(ComputeProviderId::Boat, live());
    let links = |machine: &str| {
        let link = Link { machine: Some(machine.into()), by: Some(ComputeLinkedBy::Link), ..Link::default() };
        BTreeMap::from([(ComputeProviderId::Boat, HashMap::from([("bx_23456789".to_string(), link)]))])
    };
    // A round reads the file, then a link is saved and its own refresh reads the file again and lands first.
    let round = inner.take_links_ticket();
    let after_link = inner.take_links_ticket();
    assert!(inner.land_links(after_link, links("cam-mbp")));
    assert!(!inner.land_links(round, links("stale")), "the round's older read lands late and is dropped");
    let machine = |inner: &Inner| inner.providers[&ComputeProviderId::Boat].links["bx_23456789"].machine.clone();
    assert_eq!(machine(&inner).as_deref(), Some("cam-mbp"));
    let next = inner.take_links_ticket();
    assert!(inner.land_links(next, links("ci-01")));
    assert_eq!(machine(&inner).as_deref(), Some("ci-01"));
}

#[test]
fn a_round_that_waited_behind_another_does_not_run_again() {
    let just = Some(Duration::from_secs(2));
    assert!(!RoundKind::Manual.wanted(just), "Check now right after a round returns that round");
    assert!(!RoundKind::Timer.wanted(just), "the timer doesn't follow a Check now with a round of its own");
    assert!(RoundKind::Connect.wanted(just), "a new provider is always read");
    assert!(RoundKind::Manual.wanted(Some(REFRESH_AT_MOST_EVERY)));
    assert!(!RoundKind::Timer.wanted(Some(Duration::from_secs(30))));
    assert!(RoundKind::Timer.wanted(Some(ROUND_EVERY - Duration::from_millis(DUE_SLACK_MS as u64))));
    for kind in [RoundKind::Timer, RoundKind::Manual, RoundKind::Connect] {
        assert!(kind.wanted(None), "{kind:?} with no round before it");
    }
}

#[test]
fn each_forgotten_rule_and_teammates_are_exempt() {
    let ended = |ago: i64| ComputeSession { id: "s".into(), known: true, live: false, ended_at_ms: Some(NOW - ago), harness: None };
    let running = listed("bx_23456789", ComputeSandboxState::Running);
    assert_eq!(forgotten(&running, Some(&ended(31 * 60_000)), NOW), Some(ComputeForgotten::SessionEnded));
    assert_eq!(forgotten(&running, Some(&ended(29 * 60_000)), NOW), None);
    let unknown = ComputeSession { id: "s".into(), known: false, live: false, ended_at_ms: Some(NOW - 3_600_000), harness: None };
    assert_eq!(forgotten(&running, Some(&unknown), NOW), None, "a session Arbor hasn't seen never drives it");
    // An ended session doesn't make it forgotten when it stops by itself soon; it still does when that's far off.
    let mut stops_soon = listed("bx_23456789", ComputeSandboxState::Running);
    stops_soon.stops_at_ms = Some(NOW + 20 * 60_000);
    assert_eq!(forgotten(&stops_soon, Some(&ended(31 * 60_000)), NOW), None);
    stops_soon.stops_at_ms = Some(NOW + 40 * 60_000);
    assert_eq!(forgotten(&stops_soon, Some(&ended(31 * 60_000)), NOW), Some(ComputeForgotten::SessionEnded));
    let mut no_stop = listed("bx_23456789", ComputeSandboxState::Running);
    no_stop.auto_stop_seconds = None;
    no_stop.run_started_at_ms = Some(NOW - 3 * 3_600_000 - 1);
    assert_eq!(forgotten(&no_stop, None, NOW), Some(ComputeForgotten::NoAutoStop));
    no_stop.run_started_at_ms = Some(NOW - 3 * 3_600_000 + 1);
    assert_eq!(forgotten(&no_stop, None, NOW), None);
    let mut extended = listed("bx_23456789", ComputeSandboxState::Running);
    extended.auto_stop_seconds = Some(1800);
    extended.run_started_at_ms = Some(NOW - 3_600_001);
    assert_eq!(forgotten(&extended, None, NOW), Some(ComputeForgotten::KeptAlive));
    extended.run_started_at_ms = Some(NOW - 3_600_000);
    assert_eq!(forgotten(&extended, None, NOW), None);
    let mut teammate = no_stop.clone();
    teammate.mine = false;
    teammate.run_started_at_ms = Some(NOW - 10 * 3_600_000);
    assert_eq!(forgotten(&teammate, Some(&ended(3_600_000)), NOW), None);
    let mut stopped = no_stop;
    stopped.state = ComputeSandboxState::Stopped;
    stopped.run_started_at_ms = Some(NOW - 10 * 3_600_000);
    assert_eq!(forgotten(&stopped, None, NOW), None, "a stopped sandbox is never a problem");
}

#[test]
fn a_resumed_sandbox_ages_from_its_resume_and_one_restoring_has_just_started() {
    let http = FakeHttp::default();
    let (resumed, restoring) = (id(1), id(2));
    let mut wire = wire_sandbox(&resumed, "running");
    wire["createdAt"] = serde_json::json!("2027-01-12T08:00:00Z");
    wire["hydrated"] = serde_json::json!(true);
    wire["hydratedAt"] = serde_json::json!("2027-01-15T07:55:00Z");
    let mut still = wire_sandbox(&restoring, "running");
    still["createdAt"] = serde_json::json!("2027-01-12T08:00:00Z");
    still["hydrated"] = serde_json::json!(false);
    still["hydratedAt"] = serde_json::json!("2027-01-13T08:00:00Z");
    still["ttlSeconds"] = serde_json::Value::Null;
    http.answer(LIST, 200, list_body(vec![wire, still], None));
    let now = chrono::DateTime::parse_from_rfc3339("2027-01-15T08:00:00Z").unwrap().timestamp_millis();
    let mut state = live();
    read_now(&http, &mut state, now);
    let snapshot = provider_snapshot(boat(), &state, now);
    let sandbox = |id: &str| snapshot.sandboxes.iter().find(|sandbox| sandbox.id == id).unwrap().clone();
    let resumed = sandbox(&resumed);
    assert_eq!(resumed.started_at_ms, now - 5 * 60_000);
    assert_eq!(resumed.created_at_ms, now - 3 * 24 * 3_600_000, "created stays the first creation");
    assert_eq!(resumed.forgotten, None, "three days since it was made, five minutes since it resumed");
    let restoring = sandbox(&restoring);
    assert_eq!(restoring.started_at_ms, now, "still restoring: just started");
    assert_eq!(restoring.forgotten, None, "no auto-stop, but it has only just started");
}

#[test]
fn burn_adds_running_multipliers_and_runs_out_at_that_rate() {
    let mut large = listed("bx_23456789", ComputeSandboxState::Running);
    large.multiplier = Some(2.0);
    let small = ListedSandbox { multiplier: Some(0.5), ..listed("bx_3456789a", ComputeSandboxState::Running) };
    let stopped = ListedSandbox { multiplier: Some(5.0), ..listed("bx_456789ab", ComputeSandboxState::Stopped) };
    let limits = ListedLimits {
        limits: vec![ComputeLimit { kind: ComputeLimitKind::PlanHours, used: 90.0, max: Some(100.0), resets_at_ms: None }],
        can_start: Some(true),
        start_block: None,
        period_end_ms: None,
    };
    let capabilities = boat().capabilities();
    let (rate, run_out) = burn(capabilities, &[large.clone(), small, stopped.clone()], Some(&limits), NOW);
    assert_eq!(rate, Some(2.5));
    assert_eq!(run_out, Some(NOW + 4 * 3_600_000));
    assert_eq!(burn(capabilities, &[stopped], Some(&limits), NOW), (Some(0.0), None));
    assert_eq!(burn(capabilities, &[large.clone()], None, NOW).1, None);
    assert_eq!(burn(ComputeCapabilities::default(), &[large], Some(&limits), NOW), (None, None));
}

#[test]
fn connect_errors_are_kinds_without_the_key() {
    for (failure, kind) in [
        (ComputeFailure::Refused, crate::command_error::CommandErrorKind::Refused),
        (ComputeFailure::Forbidden, crate::command_error::CommandErrorKind::Refused),
        (ComputeFailure::Unreachable, crate::command_error::CommandErrorKind::Unreachable),
        (ComputeFailure::RateLimited { retry_after_secs: None }, crate::command_error::CommandErrorKind::Unreachable),
        (ComputeFailure::Unexpected, crate::command_error::CommandErrorKind::Failed),
    ] {
        let error = connect_error("Boat", failure);
        assert_eq!(error.kind, kind);
        assert!(!format!("{error:?}").contains(FAKE_KEY));
    }
    assert!(check_key_shape(&ComputeKey::new("  ")).is_err());
    assert!(check_key_shape(&ComputeKey::new("boat_has a space")).is_err());
    let refused = check_key_shape(&ComputeKey::new("boat_with\u{7}bell")).unwrap_err();
    assert!(!refused.message.contains("boat_with"));
    assert!(check_key_shape(&ComputeKey::new(FAKE_KEY)).is_ok());
}

#[test]
fn a_link_needs_a_sandbox_id_a_machine_and_a_session_id_of_the_right_shape() {
    assert_eq!(
        checked_link(boat(), " bx_23456789 ", " cam-mbp ", Some(" s-1 ")).unwrap(),
        ("bx_23456789".to_string(), "cam-mbp".to_string(), Some("s-1".to_string()))
    );
    assert_eq!(checked_link(boat(), "bx_23456789", "cam-mbp", Some("")).unwrap().2, None);
    assert!(checked_link(boat(), "cedar-02-feature", "cam-mbp", None).unwrap_err().contains("isn't a Boat sandbox id"));
    assert!(checked_link(boat(), "bx_23456789", "  ", None).is_err());
    assert!(checked_link(boat(), "bx_23456789", &"m".repeat(101), None).is_err());
    assert!(checked_link(boat(), "bx_23456789", "cam-mbp", Some("$(whoami)")).is_err());
    assert!(checked_link(boat(), "bx_23456789", "cam-mbp", Some(&"a".repeat(129))).is_err());
    assert!(unknown_machine("cedar-02").contains("cedar-02"));
}

#[test]
fn an_issue_keeps_when_arbor_first_saw_it() {
    let mut state = live();
    let mut sick = listed("bx_23456789", ComputeSandboxState::Running);
    sick.issue = Some(ComputeIssue::MemoryPressure);
    let read = |sandbox: ListedSandbox| ProviderRead { list: Ok(ListedSandboxes { sandboxes: vec![sandbox], partial: false }), limits: None, key: None, loads: Vec::new() };
    apply_read(&mut state, read(sick.clone()), NOW);
    apply_read(&mut state, read(sick.clone()), NOW + 60_000);
    assert_eq!(provider_snapshot(boat(), &state, NOW).sandboxes[0].issue_since_ms, Some(NOW));
    apply_read(&mut state, read(listed("bx_23456789", ComputeSandboxState::Running)), NOW + 120_000);
    apply_read(&mut state, read(sick), NOW + 180_000);
    assert_eq!(provider_snapshot(boat(), &state, NOW).sandboxes[0].issue_since_ms, Some(NOW + 180_000));
}

#[test]
fn the_sandbox_snapshot_says_not_linked_for_own_and_nothing_for_teammates() {
    let mut state = live();
    let mut teammate = listed("bx_3456789a", ComputeSandboxState::Running);
    teammate.mine = false;
    state.sandboxes = vec![listed("bx_23456789", ComputeSandboxState::Running), teammate];
    let snapshot = provider_snapshot(boat(), &state, NOW);
    assert_eq!(snapshot.sandboxes[0].link_problem, Some(ComputeLinkProblem::NotLinked));
    assert_eq!(snapshot.sandboxes[1].link_problem, None);
    assert_eq!(snapshot.sandboxes[1].machine, None);
}

#[test]
fn the_saved_keys_are_connected_providers_before_any_round() {
    let dir = std::env::temp_dir().join(format!("arbor-compute-start-{}-{}", std::process::id(), NOW));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("compute-secrets.json");

    // No file: nothing connected, and no error.
    let state = ComputeState::default();
    state.load_saved_keys(&path).unwrap();
    assert!(!state.connected());
    assert!(state.snapshot(NOW).providers.is_empty());

    // A saved key: the provider is in the snapshot at once, not read yet, so the window never takes it as gone.
    files::save_key(&path, ComputeProviderId::Boat, Some(&ComputeKey::new(FAKE_KEY))).unwrap();
    let state = ComputeState::default();
    state.load_saved_keys(&path).unwrap();
    let snapshot = state.snapshot(NOW);
    assert_eq!(snapshot.providers.len(), 1);
    assert_eq!(snapshot.providers[0].id, ComputeProviderId::Boat);
    assert_eq!(snapshot.providers[0].checked_at_ms, None);
    assert!(!serde_json::to_string(&snapshot).unwrap().contains(FAKE_KEY));
    std::fs::remove_dir_all(dir).unwrap();
}
