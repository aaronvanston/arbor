//! Times the reads behind each page on a usage.db the size a busy user's gets.
//! Ignored in the normal run; a debug build compiles SQLite unoptimized, so run it
//! in release:
//!
//! ```sh
//! cd src-tauri && cargo test --release usage::bench -- --ignored --nocapture
//! ```
//!
//! `ARBOR_BENCH_EVENTS` (default 1,000,000) and `ARBOR_BENCH_DAYS` (default 90)
//! size the history. `ARBOR_BENCH_DIR` keeps the database between runs, so a
//! change can be measured without filling it again; its schema steps still run.

use super::*;
use std::time::Instant;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;

const MODELS: [(&str, &str, &str); 6] = [
    ("claude-opus-5-5", "claude", "claude-cli/2.1.280 (external, cli)"),
    ("claude-sonnet-5", "claude", "claude-cli/2.1.280 (external, cli)"),
    ("claude-haiku-4-5-20251001", "claude", "claude-cli/2.1.280 (external, cli)"),
    ("gpt-5.5-codex", "codex", "codex_cli_rs/0.60.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1"),
    ("gpt-5.5", "codex", "codex_exec/0.60.0 (Mac OS 26.0.0; arm64)"),
    ("grok-5", "xai", "opencode/1.2.0"),
];
const MARATHON: &str = "0a0a0a0a-0000-4000-8000-000000000000";
const MACHINES: [&str; 5] = ["Mac Studio", "Mac Mini", "Cedar 1", "Cedar 2", "MacBook Pro"];
const TOOL_USAGE: &str = r#"{"tools":{"Bash":40,"Read":65,"Edit":22,"Grep":18,"Skill":2},"subagentTools":{"Read":12},"subagents":{"Explore":1},"skills":{"code-review":1},"usedSkills":["code-review","run"]}"#;

/// A small deterministic generator, so every run fills the same history.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }
}

fn env_number(name: &str, default: i64) -> i64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
}

fn session_id(rng: &mut Rng) -> String {
    format!("{:016x}-{:04x}-4{:03x}-{:016x}", rng.next(), rng.below(0x10000), rng.below(0x1000), rng.next())
}

/// Sessions of 10 to 300 requests, a fifth of them with subagents, spread over
/// the days up to `now_ms`, until there are `events` requests.
fn fill(connection: &mut Connection, events: i64, days: i64, now_ms: i64) {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let transaction = connection.transaction().unwrap();
    for (index, machine) in MACHINES.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO usage_machine_assignments (api_key_hash, label, machine, pool) VALUES (?1, '', ?2, '')",
                params![format!("key-{index}"), machine],
            )
            .unwrap();
    }
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms, source, auth_index,
                     failed, failure_status, failure_body, provider, model, reasoning_effort, endpoint, auth_type, api_key_hash,
                     api_key_display, request_id, user_agent, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                     cache_creation_tokens, total_tokens, created_at, session_id, parent_session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, '/v1/messages', 'oauth', ?15, 'sk-…', ?16,
                     ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?2, ?24, ?25)",
            )
            .unwrap();
        let mut transcript = transaction
            .prepare(
                "INSERT OR IGNORE INTO usage_session_transcripts (session_id, machine, agent, file_size, read_at_ms, home, cwd,
                     repo_root, main_repo, branch, commit_hash, repository_url, title, title_source, pull_requests,
                     lines_added, lines_removed, compactions)
                 VALUES (?1, ?2, 'claude', 52000, ?3, '/Users/owner', ?4, ?4, ?5, ?6, '', '', ?7, 'ai', '[]', 120, 30, '[]')",
            )
            .unwrap();
        let span = days * DAY;
        let mut written = 0_i64;
        let mut number = 0_u64;
        let mut marathon = true;
        while written < events {
            let (model, provider, user_agent) = MODELS[rng.below(MODELS.len() as u64) as usize];
            let key = rng.below(MACHINES.len() as u64) as usize;
            let root = if marathon { MARATHON.to_string() } else { session_id(&mut rng) };
            // One session that ran for days, the longest a session's page has to show.
            let root_requests = if marathon { 20_000 } else { 10 + rng.below(290) as i64 };
            let start = if marathon { now_ms - 20 * DAY } else { now_ms - span + rng.below(span as u64) as i64 };
            marathon = false;
            let mut threads = vec![(root.clone(), None::<String>, root_requests)];
            if rng.below(5) == 0 {
                for _ in 0..1 + rng.below(4) {
                    threads.push((session_id(&mut rng), Some(root.clone()), 5 + rng.below(60) as i64));
                }
            }
            if rng.below(10) < 7 {
                let project = format!("project-{}", rng.below(24));
                let folder = format!("/Users/owner/src/{project}");
                transcript
                    .execute(params![
                        root,
                        MACHINES[key],
                        now_ms,
                        folder,
                        folder,
                        format!("feature/branch-{}", rng.below(400)),
                        format!("Session {number}"),
                    ])
                    .unwrap();
            }
            for (thread, parent, requests) in threads {
                let mut at = start + rng.below(10 * MINUTE as u64) as i64;
                for _ in 0..requests {
                    number += 1;
                    at += 5_000 + rng.below(90_000) as i64;
                    let failed = rng.below(50) == 0;
                    let input = 20_000 + rng.below(330_000) as i64;
                    let output = 200 + rng.below(6_000) as i64;
                    let cache_read = input * (60 + rng.below(38) as i64) / 100;
                    let cache_creation = rng.below(8_000) as i64;
                    let when = DateTime::<chrono::Utc>::from_timestamp_millis(at).unwrap();
                    insert
                        .execute(params![
                            format!("bench-{number}"),
                            when.to_rfc3339(),
                            at,
                            when.format("%Y-%m-%dT%H").to_string(),
                            1_000 + rng.below(60_000) as i64,
                            400 + rng.below(4_000) as i64,
                            format!("account-{}@example.com", rng.below(6)),
                            format!("{}", rng.below(6)),
                            failed,
                            if failed { 429 } else { 0 },
                            if failed { "{\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"}}" } else { "" },
                            provider,
                            model,
                            ["", "low", "medium", "high"][rng.below(4) as usize],
                            format!("key-{key}"),
                            format!("req_{number:012x}"),
                            user_agent,
                            input,
                            output,
                            rng.below(2_000) as i64,
                            cache_read,
                            cache_creation,
                            input + output,
                            thread,
                            parent,
                        ])
                        .unwrap();
                    written += 1;
                }
            }
        }
    }
    transaction.commit().unwrap();
}

/// Runs `read` five times and prints the median and range.
fn time<T>(label: &str, mut read: impl FnMut() -> Result<T, String>) {
    let mut samples = (0..5)
        .map(|_| {
            let started = Instant::now();
            read().unwrap();
            started.elapsed().as_secs_f64() * 1_000.0
        })
        .collect::<Vec<_>>();
    samples.sort_by(f64::total_cmp);
    println!("{label:<44} median {:>9.1} ms   range {:>9.1}–{:>9.1} ms", samples[2], samples[0], samples[4]);
}

fn time_bytes<T: serde::Serialize>(label: &str, mut read: impl FnMut() -> Result<T, String>) {
    let mut samples = Vec::with_capacity(5);
    let mut bytes = 0;
    for _ in 0..5 {
        let started = Instant::now();
        let value = read().unwrap();
        bytes = serde_json::to_vec(&value).unwrap().len();
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    samples.sort_by(f64::total_cmp);
    println!("{label:<44} median {:>9.1} ms   range {:>9.1}–{:>9.1} ms   {:>9} bytes", samples[2], samples[0], samples[4], bytes);
}

fn time_count<T>(label: &str, mut read: impl FnMut() -> Result<Vec<T>, String>) {
    let mut samples = Vec::with_capacity(5);
    let mut count = 0;
    for _ in 0..5 {
        let started = Instant::now();
        count = read().unwrap().len();
        samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    samples.sort_by(f64::total_cmp);
    println!("{label:<44} median {:>9.1} ms   range {:>9.1}–{:>9.1} ms   {:>9} groups", samples[2], samples[0], samples[4], count);
}

#[cfg(unix)]
fn peak_rss_bytes() -> Option<u64> {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 { return None; }
    #[cfg(target_os = "macos")]
    { Some(usage.ru_maxrss as u64) }
    #[cfg(not(target_os = "macos"))]
    { Some((usage.ru_maxrss as u64).saturating_mul(1024)) }
}

fn since(now_ms: i64, back_ms: i64) -> Option<String> {
    DateTime::<chrono::Utc>::from_timestamp_millis(now_ms - back_ms).map(|start| start.to_rfc3339())
}

/// The filled usage.db, where it is, the time it was filled up to, and whether it's kept after the run.
struct BenchDatabase {
    root: PathBuf,
    connection: Connection,
    now_ms: i64,
    kept: bool,
}

impl Drop for BenchDatabase {
    fn drop(&mut self) {
        if !self.kept {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

#[test]
#[ignore = "benchmark: run in release with --ignored --nocapture"]
fn page_reads_at_volume() {
    let database = bench_database();
    page_reads(&database.root, &database.connection, database.now_ms);
}

/// The live board's sources, as `get_fleet_sources` reads them several times a minute, with T3 Code's 500 threads
/// each naming a session from the last week. Times from the newest request, so a kept database still has a window.
///
/// ```sh
/// cd src-tauri && cargo test --release usage::bench::live_board -- --ignored --nocapture
/// ```
#[test]
#[ignore = "benchmark: run in release with --ignored --nocapture"]
fn live_board_at_volume() {
    let database = bench_database();
    let connection = &database.connection;
    let now_ms: i64 = connection.query_row("SELECT MAX(timestamp_ms) FROM usage_events", [], |row| row.get(0)).unwrap();
    let open = || open_usage_database_at(&database.root);
    let config = GuiConfigFile::default();
    let agent_ids = connection
        .prepare("SELECT DISTINCT session_id FROM usage_events WHERE timestamp_ms >= ?1 AND session_id IS NOT NULL LIMIT 500")
        .unwrap()
        .query_map([now_ms - 7 * DAY], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let sessions = fleet::recent_sessions(connection, &config, now_ms).unwrap().len();
    println!("live board: {sessions} sessions in 6 hours, {} T3 Code threads", agent_ids.len());
    for _ in 0..3 {
        time_bytes("live board: fleet sources", || {
            fleet::fleet_sources(&open()?, &config, Default::default(), fleet::bench_channels(&agent_ids), now_ms)
        });
    }
}

fn bench_database() -> BenchDatabase {
    let events = env_number("ARBOR_BENCH_EVENTS", 1_000_000);
    let days = env_number("ARBOR_BENCH_DAYS", 90);
    let kept = std::env::var("ARBOR_BENCH_DIR").ok().map(PathBuf::from);
    let root = kept.clone().unwrap_or_else(|| {
        std::env::temp_dir().join(format!("arbor-usage-bench-{}", std::process::id()))
    });
    let now_ms = Local::now().timestamp_millis();
    let fresh = !root.join(USAGE_DATABASE_FILE).exists();
    let mut connection = open_usage_database_at(&root).unwrap();
    if fresh {
        let started = Instant::now();
        // No ANALYZE: the app never runs it, so the planner works without statistics here too.
        fill(&mut connection, events, days, now_ms);
        println!("filled {events} requests over {days} days in {:.1}s", started.elapsed().as_secs_f64());
    }
    // Every transcript has an agent home and tool usage, and was last read a few hours after its session began, as a
    // scan finds them; the fill writes neither and reads them all "now".
    connection
        .execute(
            "UPDATE usage_session_transcripts SET agent_home = '~/.claude', tool_usage = ?1,
                 read_at_ms = MIN(?2, 3 * 3600000 + (SELECT MIN(timestamp_ms) FROM usage_events
                     WHERE usage_events.session_id = usage_session_transcripts.session_id))",
            params![TOOL_USAGE, now_ms],
        )
        .unwrap();
    // A quarter of the sessions opened a pull request from their branch, and a tenth of those merged in the last week.
    connection
        .execute(
            "UPDATE usage_session_transcripts SET pull_requests = json_array(json_object('number', rowid,
                 'url', 'https://github.com/acme/bench/pull/' || rowid, 'repository', 'acme/bench'))
             WHERE rowid % 4 = 0",
            [],
        )
        .unwrap();
    let opened = connection
        .prepare("SELECT rowid, branch FROM usage_session_transcripts WHERE rowid % 4 = 0")
        .unwrap()
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let states = opened
        .iter()
        .map(|(number, branch)| {
            let merged_at_ms = if number % 40 == 0 { now_ms - (number % 7) * DAY } else { now_ms - 30 * DAY };
            ("acme/bench", *number as u64, pull_requests::test_merged_state(branch, "main", merged_at_ms))
        })
        .collect::<Vec<_>>();
    pull_requests::store_test_states(&mut connection, &states);
    BenchDatabase { root, connection, now_ms, kept: kept.is_some() }
}

fn page_reads(root: &Path, connection: &Connection, now_ms: i64) {
    // Each read opens usage.db as a command does, so the cost of opening counts.
    let open = || open_usage_database_at(root);
    let config = GuiConfigFile::default();
    let all = UsageQuery::default();
    let week = UsageQuery { start: since(now_ms, 7 * DAY), ..UsageQuery::default() };
    let day = UsageQuery { start: since(now_ms, DAY), ..UsageQuery::default() };
    let opus_week = UsageQuery { model: Some("claude-opus-5-5".into()), ..week.clone() };
    let studio_week = UsageQuery { machine: Some("Mac Studio".into()), ..week.clone() };
    let busiest = MARATHON.to_string();

    for (label, query) in [("all time", &all), ("7 days", &week), ("24 hours", &day)] {
        let filter = build_usage_filter(query);
        let rows: i64 = connection.query_row(&format!("SELECT COUNT(*) FROM usage_events{}", filter.clause), params_from_iter(filter.params.iter()), |row| row.get(0)).unwrap();
        println!("rows visited, {label:<35} {rows}");
    }

    let mapped: i64 = connection.pragma_query_value(None, "mmap_size", |row| row.get(0)).unwrap();
    println!("usage.db: {} (mapped up to {} MB)", root.join(USAGE_DATABASE_FILE).display(), mapped >> 20);
    time("open usage.db", || open().map(|_| ()));
    time("overview, all time", || load_usage_overview(&open()?, &all));
    time("overview + breakdown, all time", || load_usage_overview(&open()?, &UsageQuery { include_analysis: Some(true), ..all.clone() }));
    time_count("cost groups, all time", || load_usage_cost_groups(&open()?, &build_usage_filter(&all)));
    time("overview, 7 days", || load_usage_overview(&open()?, &week));
    time("overview, 24 hours", || load_usage_overview(&open()?, &day));
    time("overview, 7 days, one model", || load_usage_overview(&open()?, &opus_week));
    time("overview, 7 days, one machine", || load_usage_overview(&open()?, &studio_week));
    time("analysis, all time", || load_usage_analysis(&open()?, &all, &config));
    time("analysis, 7 days", || load_usage_analysis(&open()?, &week, &config));
    time("requests page, all time", || load_usage_events(&open()?, &all, &config));
    time("requests page, 7 days", || load_usage_events(&open()?, &week, &config));
    time("requests page, 7 days, one model", || load_usage_events(&open()?, &opus_week, &config));
    let by_total = Some(UsageRequestOrder { by: UsageRequestSortKey::Total, descending: true });
    time("requests page, all time, biggest first", || {
        load_usage_events(&open()?, &UsageQuery { request_order: by_total, ..all.clone() }, &config)
    });
    time("requests page, all time, biggest first, page 50", || {
        load_usage_events(&open()?, &UsageQuery { request_order: by_total, page: Some(50), ..all.clone() }, &config)
    });
    time("requests page, 7 days, oldest first", || {
        let order = Some(UsageRequestOrder { by: UsageRequestSortKey::Time, descending: false });
        load_usage_events(&open()?, &UsageQuery { request_order: order, ..week.clone() }, &config)
    });
    time("requests page, failures", || {
        load_usage_events(&open()?, &UsageQuery { failed: Some(true), ..all.clone() }, &config)
    });
    time("pricing, 7 days", || load_usage_pricing(&open()?, &week));
    time("sessions, all time", || load_usage_sessions(&open()?, &all, &config, now_ms));
    for page in [1, 50] {
        let query = UsageQuery { page: Some(page), page_size: Some(20), ..all.clone() };
        time_bytes(&format!("sessions page {page}, all time"), || load_usage_sessions(&open()?, &query, &config, now_ms));
    }
    time("sessions, 7 days", || load_usage_sessions(&open()?, &week, &config, now_ms));
    time("sessions, 7 days, one machine", || load_usage_sessions(&open()?, &studio_week, &config, now_ms));
    time("sessions, 7 days, with facets", || {
        load_usage_sessions(&open()?, &UsageQuery { facets: Some(true), ..week.clone() }, &config, now_ms)
    });
    time("session timeline, 20,000 requests", || load_usage_session_timeline(&open()?, &busiest, &config, now_ms));
    time("session requests, 20,000 requests", || {
        load_usage_events(&open()?, &UsageQuery { session: Some(busiest.clone()), ..all.clone() }, &config)
    });
    time("machine sessions, 7 days", || machine_sessions::load_machine_sessions(&open()?, &week, &config, now_ms));
    time("projects, 7 days", || projects::load_session_projects(&open()?, &week, &config, now_ms));
    time("projects, all time", || projects::load_session_projects(&open()?, &all, &config, now_ms));
    time("merged pull requests, 7 days", || {
        projects::load_merged_pull_requests(&open()?, &config, now_ms - 7 * DAY, now_ms, None, now_ms)
    });
    time("sessions, all time, with facets", || {
        load_usage_sessions(&open()?, &UsageQuery { facets: Some(true), ..all.clone() }, &config, now_ms)
    });
    time("starting context, 28 days", || {
        machine_health::starting_context::starting_context(&open()?, now_ms - 28 * DAY, now_ms)
    });
    // Live learns where compactions happen at most every few minutes; the list itself reloads far more often.
    time("live: learn compaction points, 30 days", || live::learn_compaction_points(&open()?, now_ms - 30 * DAY));
    let points = live::learn_compaction_points(&connection, now_ms - 30 * DAY).unwrap();
    time("live sessions", || live::load_live_sessions(&open()?, &config, now_ms, &points));
    // The live board reads these every 15 seconds, and every 5 while requests arrive, window shown or not.
    time("live board: recent sessions, 6 hours", || fleet::recent_sessions(&open()?, &config, now_ms).map(|sessions| sessions.len()));
    time("cache misses, 7 days", || digest::load_cache_misses(&open()?, &week));
    let capacity_week: capacity::CapacityQuery = serde_json::from_value(serde_json::json!({ "start": week.start })).unwrap();
    time("capacity, 7 days", || capacity::load_capacity_report(&open()?, &capacity_week, now_ms));
    time("machine assignments", || machines::load_assignments(&open()?, &config));
    #[cfg(unix)]
    if let Some(bytes) = peak_rss_bytes() {
        println!("peak benchmark RSS: {} MiB", bytes / (1024 * 1024));
    }
}
