# Rust side: idle cost and slow commands

Static audit and Rust-side benchmark on 2026-10-06, following [the performance process](../PROCESS.md). The benchmark uses only a synthetic temporary database; no app, core, archive or SSH target was started or read.

## Process measurements

| Process | RSS | CPU | Threads | Footprint / mapping | Evidence |
| --- | ---: | ---: | ---: | --- | --- |
| Arbor | Unavailable | Unavailable | Unavailable | Unavailable | `pgrep -x Arbor` returned no PID. The approximately 140 MB RSS in the task brief was not independently measured. |
| Core started by Arbor | Unavailable | Unavailable | Unavailable | Unavailable | No core process was inspected. |

When Arbor is running, sample only `pgrep -x Arbor`, `ps -o pid,rss,%cpu,nlwp -p <pid>` or `ps -M`, `footprint <pid>` summary, and `vmmap --summary <pid>` at several points over one idle minute. Record window visible/hidden and enabled features separately. Do not infer live heap size from SQLite's 2 GiB mapping: mapped virtual address space is not resident memory.

## Results

### Round 2 query plans and counters

Before changing R2, the hot queries were run against the retained synthetic database at
`/tmp/arbor-rust-side-bench/usage.db` (1,000,133 rows). SQLite reported:

```text
overview fold       SCAN usage_events
analysis fold       SCAN usage_events
cost-group fold     SCAN usage_events
event count         SCAN usage_events USING COVERING INDEX idx_usage_events_completion
events, newest      SCAN usage_events USING INDEX idx_usage_events_timestamp
events, by tokens   SCAN usage_events; USE TEMP B-TREE FOR ORDER BY
```

The three full-range folds have no selective predicate. An additional index would still read the
whole range, so R2 adds no index and does not introduce an incremental rollup. The overview command
can now ask for its Breakdown categories with `include_analysis`; those categories are folded during
the existing request pass, so the Overview refresh no longer starts a second full-range analysis read.
The default response omits the optional field.

The benchmark now reports five samples as median and range, rows visited, serialized bytes where a
page result is measured, and peak RSS from `getrusage`. The retained database run visited 1,000,133
rows for all time, 72,243 for seven days and 10,063 for 24 hours; peak benchmark RSS was 935 MiB.
The same database is used for every run. The current run's all-time reads were:

| Read | Before median (range) | After median (range) | Result |
| --- | ---: | ---: | --- |
| Overview, all time | 615 ms (602–975) | 710 ms (683–1,721) | No measurable change; ranges overlap |
| Analysis, all time | 462 ms (392–494) | 463 ms (443–490) | No measurable change; standalone read unchanged by R2 and ranges overlap |
| Cost groups, all time | 336 ms (322–492) | 375 ms (354–380) | No measurable change; ranges overlap |
| Sessions page 1 | 643 ms (607–1,394) | 660 ms (638–670) | No measurable change; ranges overlap |

The existing R1 session result remains a modest, noisy improvement as reported in round 1. R2's
combined Overview plus Breakdown read is measured by the benchmark, but there is no comparable
interleaved parent sample in this worktree, so it is reported without a win claim.

R4's schedule counter is covered by a unit test: a ten-machine wave has strictly increasing start
delays and its final delay remains below the five-minute interval. The shared shell semaphore test
observed a peak of at most eight concurrent script runs. R5's tray counter command serializes only
`{"waiting":N}`; its unit test records 13 bytes for a count of seven, instead of the fleet and T3
thread payload.

The combined Overview plus Breakdown read was 1,075 ms (1,039–1,119) in the current run; there
is no interleaved parent measurement for that new path, so it has no before/after claim.

The webview regressions were checked against the parent of the Round 2 commits (`9e5187f8`) with
the same filled benchmark setup. The final rebased run keeps the regression ceilings unchanged:

| Counter | Parent | Round 2 after | Result |
| --- | ---: | ---: | --- |
| Usage page commands | 8 | 7 | Fewer calls |
| Default hidden commands/minute | 6.6 | 6.4 | Fewer calls |
| Real hidden commands/minute | 6.6 | 6.5 | Fewer calls |
| Default hidden DOM mutations/minute | 0.6 | 0.6 | No measurable change |
| Real hidden DOM mutations/minute | 0.6 | 0.6 | No measurable change |
| Default reload monitors missing | none | none | Preserved |
| Real reload monitors missing | none | none | Preserved |

The current run's hidden tray reads carry only the displayed waiting count; the hidden command
counter is 64/minute for the default fixture and 65/minute for the real-size fixture. Reset rows now
use absolute reset times, so they remain accurate while hidden without a per-minute countdown write. No ceiling was
raised for these seven counters. The intended monitor code adds 302 bytes to the measured app chunks;
those app-JS ceilings were recorded separately with that reason.

The following table is the historical Round 1 session benchmark. It remains here because R1's
modest, noisy result was reported honestly; it is not evidence of an R2 win.

Release benchmark command: `cd src-tauri && ARBOR_BENCH_DIR=/tmp/arbor-rust-side-bench cargo test --release usage::bench -- --ignored --nocapture`, with one million synthetic requests over 90 days. The same filled database was used for both commits. Each benchmark run reports five samples as a median and range. The range shows the reads are visibly noisy on a shared development machine.

| Read | Before median (range) | After median (range) | Result bytes after |
| --- | ---: | ---: | ---: |
| Overview, all time | 615 ms (602–975) | 569 ms (553–676) | — |
| Cost groups, all time | 336 ms (322–492) | 317 ms (316–628) | 6 groups |
| Analysis, all time | 462 ms (392–494) | 405 ms (393–464) | — |
| Sessions, all time | 659 ms (607–747) | 650 ms (582–902) | — |
| Sessions page 1 | 643 ms (607–1,394) | 597 ms (580–772) | 35,253–35,254 |
| Sessions page 50 | 700 ms (617–1,251) | 604 ms (587–736) | 36,884–36,885 |

The earlier single run showed overview and analysis increasing; the repeated runs do not reproduce that increase. Those reads have no implementation change, so their median differences are benchmark variation, not an optimization. Selecting the session page before constructing and completing session objects lowers the page-1 and page-50 medians, but their ranges overlap and both versions have high outliers. The benchmark does not yet count SQLite rows visited or peak RSS, so it does not claim a memory or I/O reduction from those counters.

The session change keeps the full request aggregate needed for the summary, but selects only the requested top-K session trees before building `UsageSession` values and running `complete_sessions`. The sample equivalence test covers ordering, pagination and completed session fields. The all-time wall time is still dominated by folding one million request rows, so the main gain is bounded session object and completion work rather than a large latency drop.

For R2, `EXPLAIN QUERY PLAN` on the overview fold, analysis fold and session cost fold each reported `SCAN usage_events`. Those reads have no selective predicate or missing index to fix. No index or rollup was added; a rollup would require the owner's decision.

For R3, passive health reads no longer call `touch`; only `passive: false` keeps the five-second active interval. The sampler compares the current health readings while ignoring sample timestamps and emits `machine-health-updated` only when that signature changes. A unit test covers an identical failed round producing no change signature. The 60-second idle interval remains unchanged.

## Ranked slow spots

Ranking is by likely user impact at roughly one million requests and ten machines. Each proposal needs a repeatable benchmark and a check against wall time or Arbor RSS before becoming a fix.

### 1. Sessions page builds all sessions before returning one page

- **Location:** `src-tauri/src/usage.rs:1387-1478`; `src-tauri/src/usage/session_read.rs:69-95,183-230,232-245`.
- **Evidence and estimated cost:** `get_usage_sessions` calls `select_sessions` with `limit: None`, calculates totals over the full vector, then skips to 20–200 returned items. `group_sessions` materializes request tallies and session trees, and `sort_sessions` orders all sessions. CPU and peak heap scale with matching requests and sessions even for page 1. Facets and session filters can also load transcripts for every candidate. At a million requests, the returned JSON is bounded while the preparatory work is not.
- **Bench/counter:** Extend `usage/bench.rs:186-313` with 1M requests and varied session cardinality, page 1 versus page 50, facets on/off; record wall time, peak RSS or allocator high water, candidate sessions, rows read, and serialized response bytes. Confirm against navigation latency and Arbor RSS.
- **Proposed fix:** Keep summary/facets as aggregate queries, select the ordered page in SQL or a bounded top-K structure, and run `complete_sessions` only for that page. Preserve filters that genuinely need transcript metadata with a separate indexed/materialized path.
- **Confidence:** High for O(all sessions) work; medium for its place in total RSS until measured.

### 2. Usage views repeatedly scan the request table and rebuild cost groups

- **Location:** `src-tauri/src/usage.rs:853-920,1264-1335`; `src-tauri/src/usage/cost_groups.rs:43-110`; `src/pages/UsageRecordsPage.tsx:557-562`; `src-tauri/src/usage/bench.rs:250-307`.
- **Evidence and estimated cost:** Overview and analysis fold matching request rows, and cost grouping holds a `HashMap<Vec<u8>, usize>` plus group vector. The requests page caps its returned records at 200, but still counts all matching rows and may sort by a non-time metric. The open page refreshes every 60 seconds and on record changes/focus. At 1M requests, repeated all-time reads can dominate command latency; high-cardinality grouping raises peak heap. Existing benchmark covers these reads but does not report allocations or JSON size.
- **Bench/counter:** In `page_reads_at_volume`, report rows visited, group count, peak RSS, cold/warm command latency and serialized result bytes for overview, analysis and request sorts. Add `EXPLAIN QUERY PLAN` for each slow query before proposing indexes.
- **Proposed fix:** First remove redundant reads in a refresh and reuse one snapshot for related views. If measured cost remains high, maintain small incremental rollups for common time buckets; add an index only after a query plan shows a gap.
- **Confidence:** High for repeated scans; medium for the best remedy.

### 3. Fleet health sampler runs SSH and ping while no page is open

- **Location:** `src-tauri/src/usage/machine_health.rs:84-94,830-831,933-937,1192-1267,1278-1284`.
- **Evidence and estimated cost:** The sampler runs every 60 seconds when inactive and every 5 seconds for 20 seconds after an active read. It executes one health script per enabled machine, plus a ping where a target is known, with all targets launched together. Ten reachable machines imply about 10 SSH script processes and up to 10 ping processes per idle minute; sustained active viewing makes that roughly 120 of each per minute. Host/agent-home state reloads from SQLite every 60 seconds. It emits `machine-health-updated` every round even if readings did not materially change. Window closure does not stop the sampler.
- **Bench/counter:** Add counters for sampler rounds, SSH/ping launches, duration, concurrency, host reloads, and emitted events; expose them to the perf mock/harness. Compare idle CPU and RSS with 0/10/50 mock machines and visible/hidden window. Do not benchmark against real SSH hosts.
- **Proposed fix:** Preserve essential alert freshness, then test longer hidden-window intervals, staggered hosts, cached unchanged results, and event emission only for changed state. Keep passive reads from extending the 5-second mode.
- **Confidence:** High for process rate; medium for actual idle CPU cost.

### 4. Transcript and setup scans can fan out across the fleet

- **Location:** `src-tauri/src/usage/machine_health/transcripts.rs:25-39,441-451,1152-1197,1433-1519`; `src-tauri/src/usage/machine_health/setup.rs:43-44,1982-1999,2025-2051`; `src/components/SetupChangeMonitor.tsx:10-36`; `src-tauri/src/usage/machine_health/agent_homes.rs:890-924`.
- **Evidence and estimated cost:** Each answering machine gets a transcript scan every five minutes. A scan can ask about 5,000 recent sessions, reread 200 old tool lists, parse several vectors/maps, and write changed results to SQLite. Due machines are spawned in the same sampler round. Setup change alerts start a scan after one minute and every 30 minutes when enabled; each target starts a task. Agent-home discovery retries failures after 30 minutes and refreshes successful machines daily. At ten machines, the five-minute transcript wave is up to ten SSH scripts and DB operations, with transient output and parse memory; setup waves can coincide. They continue when the window is hidden if the relevant background feature is enabled.
- **Bench/counter:** Use synthetic transcript listings and temp SQLite homes at 5,000 sessions per machine. Count script bytes, parse high water, DB rows changed, scan duration, simultaneous scans, and total SSH launches. Feed the same counters to the mock idle journey.
- **Proposed fix:** Limit fleet scan concurrency and spread due times. Use per-machine change signatures or smaller incremental batches where correctness permits; keep setup scans gated by the alert setting and freshness.
- **Confidence:** High for fan-out/bounds; medium for steady RSS impact.

### 5. Fleet/live board and T3 thread polling continue in the background

- **Location:** `src/components/FleetMonitor.tsx:10-18,25-68`; `src-tauri/src/usage/bench.rs:302-303`; `src-tauri/src/usage/machine_health/t3_threads.rs:26-42,732-739,797-820,1348-1375`.
- **Evidence and estimated cost:** The headless fleet monitor reloads native sources at least every 15 seconds, including with the window hidden, and reacts to source events with a 5-second throttle. The Rust benchmark notes live-board reads every 15 seconds and every 5 seconds while requests arrive. If T3 thread reading is enabled, local file signatures are checked every 5 seconds; unchanged databases are still reread every five minutes. Remote T3 machines are read every 30 seconds and each can return up to 500 threads. A local read builds all returned rows in `read.rows` before conversion. Ten eligible remote machines imply up to 20 remote scans/minute, independent of the health scripts.
- **Bench/counter:** Record per-minute `loadFleetSources` calls, native commands, DB rows read, remote scripts, payload bytes and time. In Rust, benchmark `query_database` with 500 synthetic threads and unchanged/changed signatures. Tie command count to hidden-window CPU.
- **Proposed fix:** Split tray-critical counts from full board data; poll only the former while hidden, and use change events/signatures for the full board. Keep the T3 enabled switch and cap, and coalesce simultaneous source events.
- **Confidence:** High for cadence; medium for how much of the 140 MB target it explains.

### 6. Telemetry writes and emits once per accepted request

- **Location:** `src-tauri/src/usage/machine_health/telemetry.rs:45-49,153-163,281-322,336-373,724-777`.
- **Evidence and estimated cost:** The optional receiver checks network state every ten seconds, allows 16 connections, accepts up to 20,000 points per request, and opens `usage.db` inside `spawn_blocking` for each accepted request. It folds points into a `BTreeMap`, writes hour rows, updates a `seen` map, and emits `agent-telemetry-updated` for every request. The cost is proportional to exporter rate; one request per second would mean 60 connection opens, transactions and events per minute. It is not a major default idle cost if no exporters send data.
- **Bench/counter:** A synthetic local receiver benchmark should report requests/s, points/request, DB opens/transactions, event rate, p95 request latency and peak RSS at 1/10/16 concurrent senders. Compare the perf harness's command/event count to window CPU.
- **Proposed fix:** Batch adjacent telemetry writes and coalesce events on a short interval if the freshness contract permits. Bound/prune `seen` by configured machine grants.
- **Confidence:** High for per-request amplification; low for relevance to an idle installation without telemetry senders.

### 7. Archive passes can consume disk and memory during catch-up

- **Location:** `src-tauri/src/usage/machine_health/archive.rs:38-55,1019-1038`; `src-tauri/src/usage/machine_health/archive/index.rs:135-150`.
- **Evidence and estimated cost:** The archive first runs one minute after startup, then every five minutes; a pass that hits its budget retries after five seconds. Local copy budget is 2 GiB/3 min, fleet 1 GiB/2 min, imports 2 GiB/3 min, and token counting 2 GiB/2 min. These are ceilings, not normal idle bytes. The archive index opens a SQLite connection per use, WAL with synchronous FULL. During catch-up the process can sustain disk I/O for minutes and create a misleading “idle” sample. No archive content was read in this audit.
- **Bench/counter:** Build only temp stores and generated transcripts. Report bytes listed/copied/read, index opens/writes, active seconds per pass, outstanding buffers, RSS high water and catch-up duty cycle. Measure separately from settled idle.
- **Proposed fix:** If counters show duty-cycle pressure, lower background budgets, skip unchanged listings, and defer token recounts while the window is idle/hidden without risking archive completeness.
- **Confidence:** High for configured ceilings; low for typical settled idle cost.

### 8. Repeated connection setup and IPC serialization add latency and transient heap

- **Location:** `src-tauri/src/usage/database.rs:225-254`; `src-tauri/src/usage/machine_health.rs:326-351,1398-1497`; `src-tauri/src/usage/bench.rs:238-250`; `src-tauri/src/usage/schema.rs:587-668`.
- **Evidence and estimated cost:** Each usage read opens a fresh SQLite connection, sets a 5-second busy timeout, foreign keys, synchronous NORMAL, a nearly 2 GiB `mmap_size`, and `temp_store=MEMORY`; there is no explicit `cache_size` or pool. The code explicitly notes the empty per-connection SQLite page cache. WAL is set at initialization. The health snapshot copies up to 720 points per machine, so ten machines can reach 7,200 points if actively sampled over an hour; serialization can be hundreds of KB to a few MB depending fields, but this has not been measured. The requests and sessions commands return at most 200 items, while their internal work can be much larger. Existing timestamp, model, provider, source, failure and session indexes cover common filters; an index gap is not established.
- **Bench/counter:** Extend `usage/bench.rs` to compare new versus reused connection, cold versus warm mapped reads, and `serde_json::to_vec` byte count/time for 10 and 50 machine snapshots. Count native invocations and bytes in the mock journey; sample RSS during repeated calls.
- **Proposed fix:** Reuse a small bounded read connection set only if benchmarks beat fresh connections without lock contention or excess retained cache. Default consumers to `since` deltas and smaller windows; avoid serializing identical snapshots to multiple listeners. Add indexes only after query plans show a measurable need.
- **Confidence:** High for connection churn and payload bounds; medium for their rank.

## Background activity inventory

The `spawn` sites are tasks, not one OS thread each. “Hidden” means the webview is hidden but Arbor remains open. All machine scripts use the shared shell helper; rates below are maximum due rates before failures/timeouts and optional feature gates.

| Activity and location | Period / work | Hidden or unchanged behavior |
| --- | --- | --- |
| Health sampler, `machine_health.rs:1192-1284` | 5 s active, 60 s idle; one SSH health script and possible ping per enabled machine; reload hosts via SQLite each 60 s; emit each round | Drops to 60 s after 20 s without an active read, but runs hidden. |
| Agent attention, `attention.rs:34,1205-1232` | 10 s; one reporter SSH poll per configured machine | Skips when no reporters; emits only on change; otherwise runs hidden. |
| T3 threads, `t3_threads.rs:26-42,1348-1375` | 5 s local tick, 30 s remote SSH, 5 min unchanged local reread | Entire loop skips when disabled; enabled reading continues hidden. |
| Agent versions, `agents.rs:16-18,615-623` | 10 min per answering machine, SSH script | Due from health rounds, including hidden. |
| Transcripts and agent homes, `transcripts.rs:25-39,1508-1519`; `agent_homes.rs:893-924` | 5 min transcript scan; 24 h successful home relook, 30 min failure retry | Due from health rounds; SQLite writes only for scan results. |
| Setup change alerts, `SetupChangeMonitor.tsx:10-36`; `setup.rs:1987-2051` | First at 60 s, then 30 min; one setup script per stale answering machine | Runs hidden only when alerts enabled; normal page scans are on demand. |
| Automations, `automations/runner.rs:24,674-694`; `automations/discover.rs:91-130` | 30 s runner/reconcile/sync round; other-app discovery per machine every 30 min | Runs hidden. Discovery result remains in memory, events on scan start/finish and changed runs. |
| Archive, `archive.rs:38-55,1019-1038` | First at 60 s, then 5 min; 5 s catch-up; file listing/copying and SQLite index writes | Runs hidden when configured; does nothing substantial without a configured store. |
| Usage collector, `collector.rs:7-17,156-374,574-583` | Live subscription; core check 30 s subscribed/2 s otherwise; 30 s inbox recovery; hourly cleanup; 1 s HTTP fallback polling | Runs hidden. Each live message opens a DB connection and processes an inbox batch; record events are capped at one per second by `usage.rs:679-705`. |
| Telemetry receiver, `telemetry.rs:45-49,281-373` | 10 s network-state check; per incoming request, DB write and event | Runs hidden if configured; no periodic data write without senders. |
| Fleet/live board, `FleetMonitor.tsx:10-68` | Native reads every 15 s, event driven with 5 s throttle | Explicitly remains active hidden for tray and pools. |
| Limits, status, reserves, `LimitsMonitor.tsx:141-180`; `AccountReservesMonitor.tsx:22-25,74-82` | Account quota refresh at configured interval (15 min default); public provider status every 5 min; cap checks every 2 min | Limits refresh hidden only for tray/alerts/routing/caps; reserves continue with caps. Provider status uses public network, not the core. |
| App update, `appUpdate.tsx:45,115-137`; `app_update.rs:256-268` | Feed check at startup and every 30 min; update installation task only on request | Background feed poll skips hidden window. No autonomous Rust update loop was found. |
| Phone alerts and tray, `phone_alerts.rs:302-303`; `tray.rs:575-608` | Send on alert; tray refresh on state/events; one short thread on tray click | No periodic phone send or tray thread loop found. The `phone_alerts.rs:549` thread is test-only. |
| Configuration watcher, `configuration_watcher.rs:298-335` | One OS thread blocked on file events, debounced for 2 s | No periodic scan when unchanged; remains hidden. |
| Diagnostics and analytics, `diagnostics.rs:28-38,370-483`; `product_analytics.rs:33-36,294-304` | Diagnostics queue max 1,000, delayed DB flush 2 s after events; analytics queue max 1,000, flush every 30 s when enabled | Diagnostics writes on activity; analytics timer is skipped if no sender. |
| Pools and runs, `machine_health.rs:1255-1258`; `runs.rs:1028-1058` | Check/route on a health round or while a run is queued/running | No standalone always-on pool poll found; SSH run checks need open runs. |

## Runtime, SQLite, memory, IPC, startup, and core notes

- **Runtime and threads.** Production startup uses Tauri's async runtime and `spawn_blocking` (`main.rs:1648-1661`); the collector occupies a blocking worker for its loop (`collector.rs:127-139`). No production Tokio worker or blocking-pool size override was found. `archive/remote.rs:547-548` creates a one-worker runtime for test support, not the app's main runtime. Expected OS thread count cannot be derived from `spawn` count: it includes Tauri/WebKit/platform threads, Tokio workers and lazily created blocking workers. With no Arbor PID, observed count is unavailable. A useful startup counter would log runtime task categories and blocking jobs alongside `available_parallelism()` and allowed `ps -M` thread count, without logging app data.
- **SQLite.** Usage connections are opened per command/call (`database.rs:225-254`), WAL is enabled at initialization (`database.rs:100-113`), `synchronous=NORMAL`, `temp_store=MEMORY`, mmap target `0x7fff_0000` bytes and no explicit cache size. Simultaneous connection count therefore follows simultaneous commands/tasks, not a fixed pool. The archive has its own per-open index connection and WAL/FULL (`archive/index.rs:135-150`). The schema has several hot-path indexes (`schema.rs:587-668`); inspect plans before adding more. `usage/bench.rs:186-313` already uses fresh connections at 1M events and is the natural place for the proposed counters.
- **Held memory.** Health histories are bounded at 720 points per machine (`machine_health.rs:84,637-685`). T3 local signature caches are keyed by channel/process (`t3_threads.rs:732-739`), while automation discovery retains each machine's last `Vec<Found>` in a static map and clones it for reads (`automations/discover.rs:40-48,91-130`). Setup inventories live with machine state (`setup.rs:780-783,886-889`); transcript `ScanOutput` holds file vectors and title/branch/place/home maps during a scan (`transcripts.rs:441-451`). The bundled model price catalog is a process-lifetime `LazyLock<HashMap>` (`pricing.rs:331-337`). Telemetry's `seen` map is keyed by sender machine (`telemetry.rs:153-171`). Diagnostics and analytics queues are capped. No evidence here establishes a single permanent 140 MB Rust cache; WebKit and mapped pages require process measurement to separate.
- **IPC.** The largest recurring candidate is the fleet board read at 15 s (`FleetMonitor.tsx:10-68`), followed by health snapshots and open usage views. `get_machine_health` can serialize all recent points for all enabled machines (`machine_health.rs:1431-1497`), while `since` can return deltas. Session/event pages return at most 200 rows, but do full candidate work upstream (`usage.rs:1264-1335,1387-1478`). Measure actual JSON bytes and repeated serialization; do not treat the rough bound above as an observed payload.
- **Startup.** `main.rs:1525-1535` loads config and starts analytics before the builder. Synchronous setup applies window/tray state, icon, watcher, analytics flush and CLI server (`main.rs:1619-1645`). Usage initialization/migration, startup retention, collector, telemetry and machine tasks begin on one blocking task (`main.rs:1647-1657`; `database.rs:100-113`; `collector.rs:127-139`); bundled core installation/adoption/start begins on another (`main.rs:1659-1685`). They should not gate first paint directly, since the window is revealed on frontend readiness with a fallback (`main_window.rs:90-115`), but they compete for CPU, disk and blocking workers just after launch. Benchmark time to first paint and first useful data separately. If contention is proven, defer optional legacy migration/retention and first background scans, keeping required schema setup ordered.
- **Core process.** Arbor starts the core with its config path (`core_runtime.rs:1053-1075`). Default config sets debug off, file logging off, request logging off and usage statistics on (`main.rs:529-536`), written to core YAML by `core_config/yaml.rs:240-277`. The collector subscribes to the core's usage queue and polls HTTP every second only when subscription is unavailable (`collector.rs:249-374`). These settings imply recording/queue work per request and reduce optional logging work, but reveal no core RSS or CPU figure. Measure the core separately only through an explicitly authorized process-only method; no core data inspection is needed.

## Top eight in one line each

1. Bound session-page work before pagination; it currently builds and sorts every candidate.
2. Measure repeated full-range usage reads and cost-group allocations at 1M requests.
3. Count hidden-window health SSH/ping launches and the unconditional round event.
4. Spread and cap transcript/setup scan waves across machines.
5. Separate hidden tray counts from full fleet/live-board and T3 thread reads.
6. Batch telemetry DB writes/events if sender rate makes them material.
7. Measure archive catch-up separately from settled idle.
8. Measure fresh SQLite connection cost and actual IPC bytes before caching or pooling.

The post-change `perf:check` run completed without a page error but retained the existing baseline: 16 counters exceeded their ceilings, including hidden command rate, JavaScript byte ceilings, Usage command count and reload monitor presence. No ceiling was raised because the run did not isolate those existing overruns to this change.
