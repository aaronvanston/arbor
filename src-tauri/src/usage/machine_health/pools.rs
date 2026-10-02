//! Machine pools: named sets of machines that harness runs are balanced across. A machine can be in
//! any number of pools, with its own weight in each: Prefer, Normal and Less often take shares of the
//! work in that order, and Manual only keeps it pickable by hand but never chosen for a run. A machine
//! that shouldn't take a pool's work isn't a member at all.
//!
//! Before choosing, every member is checked against the pool's limits from its latest health sample:
//! answering, a reading fresh for how often the sampler is running, fewer agents running than the
//! pool allows, CPU under its ceiling and free memory over its floor. Each eligible member's chance is
//! its weight times its free agent slots, so a burst spreads instead of landing on one machine. What
//! happens when nobody is eligible (refuse, wait in a queue, or try another pool) is the pool's own
//! setting, carried out by whatever starts the run.
//!
//! Pools live in usage.db, not the window, so the window, `arbor` and triggers all route alike.

use super::*;
use std::collections::BTreeSet;

pub(crate) const MACHINE_POOLS_UPDATED_EVENT: &str = "machine-pools-updated";

/// How much of a pool's work a member takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "PoolWeight")]
pub(crate) enum PoolWeight {
    Prefer,
    Normal,
    Less,
    /// Only when someone picks it by hand.
    Manual,
}

impl PoolWeight {
    fn shares(self) -> f64 {
        match self {
            Self::Prefer => 4.0,
            Self::Normal => 2.0,
            Self::Less => 1.0,
            Self::Manual => 0.0,
        }
    }

    fn stored(self) -> &'static str {
        match self {
            Self::Prefer => "prefer",
            Self::Normal => "normal",
            Self::Less => "less",
            Self::Manual => "manual",
        }
    }

    fn from_stored(text: &str) -> Self {
        match text {
            "prefer" => Self::Prefer,
            "less" => Self::Less,
            "manual" => Self::Manual,
            _ => Self::Normal,
        }
    }
}

/// What a run does when no member has room.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "PoolWhenFull")]
pub(crate) enum PoolWhenFull {
    /// It doesn't start, and says why.
    Refuse,
    /// It waits, oldest first, until a member has room or the wait runs out.
    Queue,
    /// It goes to another pool.
    Spill,
}

impl PoolWhenFull {
    fn stored(self) -> &'static str {
        match self {
            Self::Refuse => "refuse",
            Self::Queue => "queue",
            Self::Spill => "spill",
        }
    }

    fn from_stored(text: &str) -> Self {
        match text {
            "queue" => Self::Queue,
            "spill" => Self::Spill,
            _ => Self::Refuse,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolMember {
    /// The machine's name as the Machines page lists it.
    pub(crate) machine: String,
    pub(crate) weight: PoolWeight,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachinePool {
    /// Empty for a pool not saved yet; the native side gives it one.
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) members: Vec<PoolMember>,
    /// The most Claude Code and Codex processes a member may have running and still take a run; None is no limit.
    /// A member at any one of the three limits is full.
    pub(crate) max_agents: Option<u32>,
    /// A member at or past this CPU percent is full; None is no limit.
    pub(crate) cpu_ceiling: Option<u32>,
    /// A member with this percent of memory free or less is full; None is no limit.
    pub(crate) mem_floor: Option<u32>,
    pub(crate) when_full: PoolWhenFull,
    /// The pool a run goes to when this one is full and `when_full` is Spill.
    pub(crate) spill_pool: Option<String>,
    /// How long a queued run waits for room before it's dropped.
    pub(crate) queue_timeout_min: u32,
}

/// Why a member could or couldn't take the next run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "PoolVerdictKind")]
pub(crate) enum VerdictKind {
    Eligible,
    /// Manual only: never chosen for a run.
    Manual,
    /// The Machines page doesn't list it (any more).
    NotListed,
    /// Its health checks are switched off.
    Off,
    /// No health sample yet.
    NoReading,
    /// Its last health sample failed.
    Unreachable,
    /// Its last good sample is too old to go by.
    Stale,
    AgentsFull,
    CpuHigh,
    MemoryLow,
    /// Has room, but not the harness a run asked for running with its setup.
    NoHarness,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "PoolMemberVerdict")]
pub(crate) struct MemberVerdict {
    machine: String,
    weight: PoolWeight,
    kind: VerdictKind,
    /// Agents running at the last sample, runs just sent to it included.
    running: Option<u32>,
    cpu: Option<f32>,
    /// Free memory, percent.
    mem_free: Option<f32>,
    #[ts(type = "number | null")]
    reading_age_ms: Option<i64>,
    /// Its chance of taking the next run, 0–1; 0 unless eligible.
    share: f64,
}

impl MemberVerdict {
    pub(super) fn machine(&self) -> &str {
        &self.machine
    }

    pub(super) fn kind(&self) -> VerdictKind {
        self.kind
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolPreview {
    pool: String,
    /// The member most likely to take the next run; None when nobody can.
    likely: Option<String>,
    members: Vec<MemberVerdict>,
    /// How old a reading may be before it's stale, from how often machines are being sampled now.
    #[ts(type = "number")]
    fresh_for_ms: i64,
    /// Where the next few runs would most likely go if they all started now, each counting as running for the ones
    /// after it; None once no member has room. Shows how a burst spreads and when the pool fills.
    plan: Vec<Option<String>>,
}

/// How many runs the preview's plan walks through.
const PLAN_RUNS: usize = 8;

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

/// A member's latest health sample, as far as a pool is concerned.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Reading {
    enabled: bool,
    answering: bool,
    last_ok_at: Option<i64>,
    running: Option<u32>,
    cpu: Option<f32>,
    mem_used: Option<f32>,
}

/// A reading counts for three sampling rounds, and never less than T3 Code's 15 seconds: the sampler
/// slows to once a minute while the Machines page is closed, and a fixed window would call every
/// machine stale then.
fn fresh_for_ms(interval_ms: u64) -> i64 {
    (interval_ms as i64 * 3).max(15_000)
}

/// Each member's verdict and share. `readings` is keyed by normalized machine name (None: not
/// listed); `recent` counts runs sent to a machine since its last sample, so a burst spreads out.
fn assess(pool: &MachinePool, readings: &BTreeMap<String, Reading>, recent: &BTreeMap<String, u32>, now_ms: i64, interval_ms: u64) -> Vec<MemberVerdict> {
    assess_with(pool, readings, recent, now_ms, interval_ms, |_| true)
}

/// `assess` for one run: `can_take` says whether a member has what the run needs (its harness and
/// setup), and a member with room but without it is left out.
pub(super) fn assess_with(
    pool: &MachinePool,
    readings: &BTreeMap<String, Reading>,
    recent: &BTreeMap<String, u32>,
    now_ms: i64,
    interval_ms: u64,
    can_take: impl Fn(&str) -> bool,
) -> Vec<MemberVerdict> {
    let fresh_for = fresh_for_ms(interval_ms);
    let mut verdicts: Vec<MemberVerdict> = pool
        .members
        .iter()
        .map(|member| {
            let key = normalize_machine_name(&member.machine);
            let mut verdict = MemberVerdict {
                machine: member.machine.clone(),
                weight: member.weight,
                kind: VerdictKind::Eligible,
                running: None,
                cpu: None,
                mem_free: None,
                reading_age_ms: None,
                share: 0.0,
            };
            let Some(reading) = readings.get(&key) else {
                verdict.kind = VerdictKind::NotListed;
                return verdict;
            };
            let sent = recent.get(&key).copied().unwrap_or(0);
            verdict.running = reading.running.map(|running| running + sent);
            verdict.cpu = reading.cpu;
            verdict.mem_free = reading.mem_used.map(|used| (100.0 - used).max(0.0));
            verdict.reading_age_ms = reading.last_ok_at.map(|at| (now_ms - at).max(0));
            verdict.kind = if !reading.enabled {
                VerdictKind::Off
            } else if reading.last_ok_at.is_none() {
                if reading.answering { VerdictKind::NoReading } else { VerdictKind::Unreachable }
            } else if !reading.answering {
                VerdictKind::Unreachable
            } else if verdict.reading_age_ms.is_some_and(|age| age > fresh_for) {
                VerdictKind::Stale
            } else if pool.max_agents.is_some_and(|max| verdict.running.unwrap_or(0) >= max) {
                VerdictKind::AgentsFull
            } else if pool.cpu_ceiling.zip(reading.cpu).is_some_and(|(ceiling, cpu)| cpu >= ceiling as f32) {
                VerdictKind::CpuHigh
            } else if pool.mem_floor.zip(verdict.mem_free).is_some_and(|(floor, free)| free <= floor as f32) {
                VerdictKind::MemoryLow
            } else if member.weight == PoolWeight::Manual {
                VerdictKind::Manual
            } else if !can_take(&member.machine) {
                VerdictKind::NoHarness
            } else {
                VerdictKind::Eligible
            };
            verdict
        })
        .collect();
    let weights: Vec<f64> = verdicts
        .iter()
        .map(|verdict| match verdict.kind {
            // Weight times free agent slots; with no agent limit, weight shrinking with each agent running, so a busy
            // member still gets less and a burst still spreads.
            VerdictKind::Eligible => {
                let running = verdict.running.unwrap_or(0);
                match pool.max_agents {
                    Some(max) => verdict.weight.shares() * max.saturating_sub(running) as f64,
                    None => verdict.weight.shares() / (running + 1) as f64,
                }
            }
            _ => 0.0,
        })
        .collect();
    let total: f64 = weights.iter().sum();
    if total > 0.0 {
        for (verdict, weight) in verdicts.iter_mut().zip(weights) {
            verdict.share = weight / total;
        }
    }
    verdicts
}

/// The member a roll in [0, 1) lands on, by share. None when nobody is eligible.
pub(super) fn choose(verdicts: &[MemberVerdict], roll: f64) -> Option<&MemberVerdict> {
    let mut left = roll.clamp(0.0, 1.0);
    let eligible: Vec<&MemberVerdict> = verdicts.iter().filter(|verdict| verdict.share > 0.0).collect();
    for verdict in &eligible {
        if left < verdict.share {
            return Some(verdict);
        }
        left -= verdict.share;
    }
    // Rounding can leave a sliver past the last share.
    eligible.last().copied()
}

/// The most likely member for each of the next `runs` runs, each one counted as running on its member for the next.
fn plan(pool: &MachinePool, readings: &BTreeMap<String, Reading>, now_ms: i64, interval_ms: u64, runs: usize) -> Vec<Option<String>> {
    let mut recent: BTreeMap<String, u32> = BTreeMap::new();
    (0..runs)
        .map(|_| {
            let next = likely(&assess(pool, readings, &recent, now_ms, interval_ms));
            if let Some(machine) = &next {
                *recent.entry(normalize_machine_name(machine)).or_default() += 1;
            }
            next
        })
        .collect()
}

fn likely(verdicts: &[MemberVerdict]) -> Option<String> {
    verdicts
        .iter()
        .filter(|verdict| verdict.share > 0.0)
        .max_by(|a, b| a.share.total_cmp(&b.share))
        .map(|verdict| verdict.machine.clone())
}

/// Every listed machine's reading, keyed by normalized name.
pub(super) fn readings(inner: &Inner) -> BTreeMap<String, Reading> {
    let mut readings: BTreeMap<String, Reading> = inner
        .series
        .values()
        .map(|series| {
            let point = series.points.back();
            (
                normalize_machine_name(&series.host.machine),
                Reading {
                    enabled: series.host.enabled,
                    answering: series.error.is_none(),
                    last_ok_at: series.last_ok_at,
                    running: point.map(|point| point.claude_running.unwrap_or(0) + point.codex_running.unwrap_or(0)),
                    cpu: point.and_then(|point| point.cpu),
                    mem_used: point.map(|point| point.mem),
                },
            )
        })
        .collect();
    // This Mac runs scripts even when the Machines page doesn't list it, but without a series it has
    // no reading to go by.
    if let Some(name) = this_machine_name(inner) {
        readings.entry(normalize_machine_name(&name)).or_insert(Reading { enabled: true, answering: true, ..Reading::default() });
    }
    readings
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

pub(super) fn read_pools(connection: &Connection) -> Result<Vec<MachinePool>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, max_agents, cpu_ceiling, mem_floor, when_full, spill_pool, queue_timeout_min
             FROM usage_pools ORDER BY name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let mut pools = statement
        .query_map([], |row| {
            Ok(MachinePool {
                id: row.get(0)?,
                name: row.get(1)?,
                members: Vec::new(),
                // 0 is stored for a limit that's off.
                max_agents: row.get::<_, Option<u32>>(2)?.filter(|value| *value > 0),
                cpu_ceiling: row.get::<_, Option<u32>>(3)?.filter(|value| *value > 0),
                mem_floor: row.get::<_, Option<u32>>(4)?.filter(|value| *value > 0),
                when_full: PoolWhenFull::from_stored(&row.get::<_, String>(5)?),
                spill_pool: row.get(6)?,
                queue_timeout_min: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT pool_id, machine, weight FROM usage_pool_members ORDER BY position")
        .map_err(|error| error.to_string())?;
    let members = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for (pool_id, machine, weight) in members {
        if let Some(pool) = pools.iter_mut().find(|pool| pool.id == pool_id) {
            pool.members.push(PoolMember { machine, weight: PoolWeight::from_stored(&weight) });
        }
    }
    Ok(pools)
}

/// Where a spill pool leads, so a pool can never spill back into itself.
fn spills_back(pools: &[MachinePool], start: &MachinePool) -> bool {
    let mut seen = BTreeSet::from([start.id.clone()]);
    let mut next = start.spill_pool.clone().filter(|_| start.when_full == PoolWhenFull::Spill);
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return true;
        }
        next = pools
            .iter()
            .find(|pool| pool.id == id)
            .and_then(|pool| pool.spill_pool.clone().filter(|_| pool.when_full == PoolWhenFull::Spill));
    }
    false
}

/// A pool as it may be saved, beside the others already saved.
fn checked(mut pool: MachinePool, others: &[MachinePool]) -> Result<MachinePool, String> {
    pool.name = pool.name.trim().to_string();
    if pool.name.is_empty() {
        return Err("Give the pool a name.".into());
    }
    if others.iter().any(|other| other.id != pool.id && other.name.eq_ignore_ascii_case(&pool.name)) {
        return Err(format!("There's already a pool called {}.", pool.name));
    }
    let mut seen = BTreeSet::new();
    pool.members.retain(|member| !member.machine.trim().is_empty() && seen.insert(normalize_machine_name(&member.machine)));
    pool.max_agents = pool.max_agents.map(|max| max.clamp(1, 64));
    pool.cpu_ceiling = pool.cpu_ceiling.map(|ceiling| ceiling.clamp(10, 100));
    // No memory free at all is no floor.
    pool.mem_floor = pool.mem_floor.map(|floor| floor.min(90)).filter(|floor| *floor > 0);
    pool.queue_timeout_min = pool.queue_timeout_min.clamp(1, 24 * 60);
    if pool.when_full != PoolWhenFull::Spill {
        pool.spill_pool = None;
    } else {
        let Some(target) = pool.spill_pool.as_deref() else {
            return Err("Pick the pool to try when this one is full.".into());
        };
        if target == pool.id || !others.iter().any(|other| other.id == target) {
            return Err("Pick another saved pool to try when this one is full.".into());
        }
        let mut all: Vec<MachinePool> = others.iter().filter(|other| other.id != pool.id).cloned().collect();
        all.push(pool.clone());
        if spills_back(&all, &pool) {
            return Err("That pool already sends its overflow back here. Pick another, or have one of them refuse or queue.".into());
        }
    }
    Ok(pool)
}

fn new_id() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_pool(connection: &mut Connection, pool: &MachinePool) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO usage_pools (id, name, max_agents, cpu_ceiling, mem_floor, when_full, spill_pool, queue_timeout_min)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name = ?2, max_agents = ?3, cpu_ceiling = ?4, mem_floor = ?5,
                when_full = ?6, spill_pool = ?7, queue_timeout_min = ?8",
            params![
                pool.id,
                pool.name,
                pool.max_agents.unwrap_or(0),
                pool.cpu_ceiling.unwrap_or(0),
                pool.mem_floor.unwrap_or(0),
                pool.when_full.stored(),
                pool.spill_pool,
                pool.queue_timeout_min
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM usage_pool_members WHERE pool_id = ?1", params![pool.id]).map_err(|error| error.to_string())?;
    for (position, member) in pool.members.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO usage_pool_members (pool_id, machine, weight, position) VALUES (?1, ?2, ?3, ?4)",
                params![pool.id, member.machine.trim(), member.weight.stored(), position as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

/// Takes a pool off the list. Pools that spilled into it refuse instead, rather than pointing nowhere.
fn delete_pool(connection: &mut Connection, id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM usage_pool_members WHERE pool_id = ?1", params![id]).map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM usage_pools WHERE id = ?1", params![id]).map_err(|error| error.to_string())?;
    transaction
        .execute("UPDATE usage_pools SET when_full = 'refuse', spill_pool = NULL WHERE spill_pool = ?1", params![id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every machine pool, with its members, their weights, and its limits.
#[tauri::command]
pub(crate) async fn get_pools() -> Result<Vec<MachinePool>, String> {
    run_usage_task(|| read_pools(&open_usage_database()?)).await
}

/// Adds a pool, or changes one. A pool given an id that isn't saved is added with it, so Undo after
/// a removal brings back the same pool.
#[tauri::command]
pub(crate) async fn save_pool(app: tauri::AppHandle, pool: MachinePool) -> Result<Vec<MachinePool>, String> {
    let pools = run_usage_task(move || {
        let mut connection = open_usage_database()?;
        let others = read_pools(&connection)?;
        let mut pool = checked(pool, &others)?;
        if pool.id.is_empty() {
            pool.id = new_id();
        }
        write_pool(&mut connection, &pool)?;
        read_pools(&connection)
    })
    .await?;
    let _ = app.emit(MACHINE_POOLS_UPDATED_EVENT, ());
    Ok(pools)
}

/// Takes a pool off the list by its id. Pools that sent their overflow to it refuse runs instead.
#[tauri::command]
pub(crate) async fn remove_pool(app: tauri::AppHandle, id: String) -> Result<Vec<MachinePool>, String> {
    let pools = run_usage_task(move || {
        let mut connection = open_usage_database()?;
        delete_pool(&mut connection, &id)?;
        read_pools(&connection)
    })
    .await?;
    let _ = app.emit(MACHINE_POOLS_UPDATED_EVENT, ());
    Ok(pools)
}

/// Who would take the next run in each pool, and why each member could or couldn't, from the
/// machines' latest health samples. Starts no run.
#[tauri::command]
pub(crate) async fn preview_pools(state: tauri::State<'_, MachineHealthState>) -> Result<Vec<PoolPreview>, String> {
    let pools = run_usage_task(|| read_pools(&open_usage_database()?)).await?;
    let (readings, interval_ms) = {
        let inner = state.lock();
        (readings(&inner), inner.interval_ms)
    };
    let now_ms = Local::now().timestamp_millis();
    Ok(pools
        .iter()
        .map(|pool| {
            let members = assess(pool, &readings, &BTreeMap::new(), now_ms, interval_ms);
            PoolPreview {
                pool: pool.id.clone(),
                likely: likely(&members),
                members,
                fresh_for_ms: fresh_for_ms(interval_ms),
                plan: plan(pool, &readings, now_ms, interval_ms, PLAN_RUNS),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn pool(members: &[(&str, PoolWeight)]) -> MachinePool {
        MachinePool {
            id: "p1".into(),
            name: "Builds".into(),
            members: members.iter().map(|(machine, weight)| PoolMember { machine: (*machine).into(), weight: *weight }).collect(),
            max_agents: Some(4),
            cpu_ceiling: Some(95),
            mem_floor: Some(5),
            when_full: PoolWhenFull::Refuse,
            spill_pool: None,
            queue_timeout_min: 30,
        }
    }

    fn healthy(running: u32) -> Reading {
        Reading { enabled: true, answering: true, last_ok_at: Some(NOW - 2_000), running: Some(running), cpu: Some(30.0), mem_used: Some(50.0) }
    }

    fn readings(entries: &[(&str, Reading)]) -> BTreeMap<String, Reading> {
        entries.iter().map(|(name, reading)| (normalize_machine_name(name), *reading)).collect()
    }

    fn kinds(verdicts: &[MemberVerdict]) -> Vec<VerdictKind> {
        verdicts.iter().map(|verdict| verdict.kind).collect()
    }

    #[test]
    fn a_member_is_left_out_for_the_first_limit_it_breaks() {
        let pool = pool(&[
            ("casey-mbp", PoolWeight::Prefer),
            ("build-box", PoolWeight::Normal),
            ("studio", PoolWeight::Normal),
            ("old-mini", PoolWeight::Normal),
            ("lab", PoolWeight::Normal),
            ("gone", PoolWeight::Normal),
            ("spare", PoolWeight::Manual),
        ]);
        let readings = readings(&[
            ("casey-mbp", healthy(1)),
            ("Build Box", healthy(4)),
            ("studio", Reading { cpu: Some(97.0), ..healthy(0) }),
            ("old-mini", Reading { mem_used: Some(96.0), ..healthy(0) }),
            ("lab", Reading { answering: false, ..healthy(0) }),
            ("spare", healthy(0)),
        ]);
        let verdicts = assess(&pool, &readings, &BTreeMap::new(), NOW, 5_000);
        assert_eq!(
            kinds(&verdicts),
            vec![
                VerdictKind::Eligible,
                VerdictKind::AgentsFull,
                VerdictKind::CpuHigh,
                VerdictKind::MemoryLow,
                VerdictKind::Unreachable,
                VerdictKind::NotListed,
                VerdictKind::Manual,
            ]
        );
        assert_eq!(verdicts[0].share, 1.0);
        assert_eq!(likely(&verdicts).as_deref(), Some("casey-mbp"));
    }

    #[test]
    fn a_member_with_room_but_not_what_the_run_needs_is_left_out() {
        let pool = pool(&[("casey-mbp", PoolWeight::Prefer), ("cedar-02", PoolWeight::Normal), ("ci-01", PoolWeight::Normal)]);
        let all = readings(&[("casey-mbp", healthy(0)), ("cedar-02", healthy(0)), ("ci-01", healthy(9))]);
        let verdicts = assess_with(&pool, &all, &BTreeMap::new(), NOW, 5_000, |machine| machine != "casey-mbp");
        // Full comes first: a busy member is busy whatever it has.
        assert_eq!(kinds(&verdicts), vec![VerdictKind::NoHarness, VerdictKind::Eligible, VerdictKind::AgentsFull]);
        assert_eq!(choose(&verdicts, 0.99).map(MemberVerdict::machine), Some("cedar-02"));
    }

    #[test]
    fn a_reading_is_fresh_for_three_sampling_rounds() {
        let pool = pool(&[("casey-mbp", PoolWeight::Normal)]);
        let old = readings(&[("casey-mbp", Reading { last_ok_at: Some(NOW - 100_000), ..healthy(0) })]);
        // Sampling every 5 s: 100 s old is stale. Every minute (Machines closed): still good.
        assert_eq!(kinds(&assess(&pool, &old, &BTreeMap::new(), NOW, 5_000)), vec![VerdictKind::Stale]);
        assert_eq!(kinds(&assess(&pool, &old, &BTreeMap::new(), NOW, 60_000)), vec![VerdictKind::Eligible]);
        let never = readings(&[("casey-mbp", Reading { last_ok_at: None, ..healthy(0) })]);
        assert_eq!(kinds(&assess(&pool, &never, &BTreeMap::new(), NOW, 5_000)), vec![VerdictKind::NoReading]);
        let off = readings(&[("casey-mbp", Reading { enabled: false, ..healthy(0) })]);
        assert_eq!(kinds(&assess(&pool, &off, &BTreeMap::new(), NOW, 5_000)), vec![VerdictKind::Off]);
    }

    #[test]
    fn shares_follow_weight_and_free_agent_slots() {
        let pool = pool(&[("a", PoolWeight::Prefer), ("b", PoolWeight::Normal), ("c", PoolWeight::Less)]);
        let idle = readings(&[("a", healthy(0)), ("b", healthy(0)), ("c", healthy(0))]);
        let shares: Vec<f64> = assess(&pool, &idle, &BTreeMap::new(), NOW, 5_000).iter().map(|verdict| verdict.share).collect();
        assert_eq!(shares, vec![4.0 / 7.0, 2.0 / 7.0, 1.0 / 7.0]);
        // A preferred machine with one slot left takes less than an idle normal one.
        let busy = readings(&[("a", healthy(3)), ("b", healthy(0)), ("c", healthy(0))]);
        let verdicts = assess(&pool, &busy, &BTreeMap::new(), NOW, 5_000);
        assert!(verdicts[0].share < verdicts[1].share);
    }

    #[test]
    fn a_limit_left_off_never_makes_a_member_full() {
        let mut pool = pool(&[("a", PoolWeight::Normal), ("b", PoolWeight::Normal)]);
        let busy = readings(&[("a", Reading { cpu: Some(99.0), mem_used: Some(99.0), ..healthy(12) }), ("b", healthy(0))]);
        assert_eq!(kinds(&assess(&pool, &busy, &BTreeMap::new(), NOW, 5_000))[0], VerdictKind::AgentsFull);
        pool.max_agents = None;
        assert_eq!(kinds(&assess(&pool, &busy, &BTreeMap::new(), NOW, 5_000))[0], VerdictKind::CpuHigh);
        pool.cpu_ceiling = None;
        assert_eq!(kinds(&assess(&pool, &busy, &BTreeMap::new(), NOW, 5_000))[0], VerdictKind::MemoryLow);
        pool.mem_floor = None;
        let verdicts = assess(&pool, &busy, &BTreeMap::new(), NOW, 5_000);
        assert_eq!(kinds(&verdicts), vec![VerdictKind::Eligible, VerdictKind::Eligible]);
        // With no agent limit, each agent running shrinks a member’s weight: 2/13 against 2/1, so 1/14 of the chance.
        assert!((verdicts[0].share - 1.0 / 14.0).abs() < 1e-9);
    }

    #[test]
    fn the_plan_spreads_a_burst_and_says_when_the_pool_fills() {
        let mut pool = pool(&[("a", PoolWeight::Prefer), ("b", PoolWeight::Normal)]);
        pool.max_agents = Some(2);
        let idle = readings(&[("a", healthy(0)), ("b", healthy(1))]);
        let planned = plan(&pool, &idle, NOW, 5_000, 5);
        let named: Vec<Option<&str>> = planned.iter().map(|entry| entry.as_deref()).collect();
        assert_eq!(named, vec![Some("a"), Some("a"), Some("b"), None, None]);
        pool.max_agents = None;
        let open: Vec<String> = plan(&pool, &idle, NOW, 5_000, 4).into_iter().flatten().collect();
        assert_eq!(open.len(), 4);
        assert!(open.contains(&"b".to_string()), "a burst reaches the normal member too: {open:?}");
    }

    #[test]
    fn runs_just_sent_count_as_running_so_a_burst_spreads() {
        let pool = pool(&[("a", PoolWeight::Prefer), ("b", PoolWeight::Normal)]);
        let idle = readings(&[("a", healthy(0)), ("b", healthy(0))]);
        let recent = BTreeMap::from([(normalize_machine_name("a"), 4)]);
        let verdicts = assess(&pool, &idle, &recent, NOW, 5_000);
        assert_eq!(kinds(&verdicts), vec![VerdictKind::AgentsFull, VerdictKind::Eligible]);
        assert_eq!(verdicts[0].running, Some(4));
    }

    #[test]
    fn a_roll_lands_on_members_by_share() {
        let pool = pool(&[("a", PoolWeight::Prefer), ("b", PoolWeight::Normal), ("c", PoolWeight::Less), ("d", PoolWeight::Manual)]);
        let idle = readings(&[("a", healthy(0)), ("b", healthy(0)), ("c", healthy(0)), ("d", healthy(0))]);
        let verdicts = assess(&pool, &idle, &BTreeMap::new(), NOW, 5_000);
        let mut counts = BTreeMap::<String, u32>::new();
        for step in 0..700 {
            // Mid-steps, so no roll sits exactly on a boundary between shares.
            let picked = choose(&verdicts, (step as f64 + 0.5) / 700.0).unwrap();
            *counts.entry(picked.machine.clone()).or_default() += 1;
        }
        assert_eq!(counts.get("a"), Some(&400));
        assert_eq!(counts.get("b"), Some(&200));
        assert_eq!(counts.get("c"), Some(&100));
        assert_eq!(counts.get("d"), None);
        assert_eq!(choose(&verdicts, 1.0).map(|verdict| verdict.machine.as_str()), Some("c"));
        let nobody = assess(&pool, &BTreeMap::new(), &BTreeMap::new(), NOW, 5_000);
        assert!(choose(&nobody, 0.5).is_none());
    }

    #[test]
    fn a_pool_is_tidied_and_checked_before_it_is_saved() {
        let mut draft = pool(&[("casey-mbp", PoolWeight::Prefer), ("Casey MBP", PoolWeight::Less), (" ", PoolWeight::Normal)]);
        draft.name = "  Builds ".into();
        draft.max_agents = Some(0);
        draft.cpu_ceiling = Some(500);
        draft.queue_timeout_min = 0;
        let saved = checked(draft.clone(), &[]).unwrap();
        assert_eq!(saved.name, "Builds");
        assert_eq!(saved.members, vec![PoolMember { machine: "casey-mbp".into(), weight: PoolWeight::Prefer }]);
        assert_eq!((saved.max_agents, saved.cpu_ceiling, saved.queue_timeout_min), (Some(1), Some(100), 1));

        let mut other = pool(&[]);
        other.id = "p2".into();
        other.name = "builds".into();
        assert!(checked(draft.clone(), &[other.clone()]).unwrap_err().contains("already a pool"));
        draft.name = "".into();
        assert!(checked(draft, &[]).is_err());
    }

    #[test]
    fn a_pool_can_spill_only_into_another_saved_pool_that_doesnt_lead_back() {
        let mut first = pool(&[]);
        first.when_full = PoolWhenFull::Spill;
        first.spill_pool = Some("p1".into());
        assert!(checked(first.clone(), &[]).is_err(), "not into itself");
        first.spill_pool = Some("nowhere".into());
        assert!(checked(first.clone(), &[]).is_err(), "not into a pool that isn't saved");

        let mut second = pool(&[]);
        second.id = "p2".into();
        second.name = "Overflow".into();
        first.spill_pool = Some("p2".into());
        assert!(checked(first.clone(), &[second.clone()]).is_ok());
        second.when_full = PoolWhenFull::Spill;
        second.spill_pool = Some("p1".into());
        assert!(checked(first.clone(), &[second]).unwrap_err().contains("back here"));

        let mut refusing = pool(&[]);
        refusing.spill_pool = Some("p2".into());
        assert_eq!(checked(refusing, &[]).unwrap().spill_pool, None, "only a spilling pool keeps its target");
    }

    #[test]
    fn pools_round_trip_through_usage_db_and_removal_unhooks_spills() {
        let mut connection = crate::usage::schema::test_database();
        let mut builds = pool(&[("casey-mbp", PoolWeight::Prefer), ("build-box", PoolWeight::Manual)]);
        let mut overflow = pool(&[("studio", PoolWeight::Normal)]);
        overflow.id = "p2".into();
        overflow.name = "Overflow".into();
        write_pool(&mut connection, &overflow).unwrap();
        builds.when_full = PoolWhenFull::Spill;
        builds.spill_pool = Some("p2".into());
        write_pool(&mut connection, &builds).unwrap();
        assert_eq!(read_pools(&connection).unwrap(), vec![builds.clone(), overflow.clone()]);

        builds.members.reverse();
        write_pool(&mut connection, &builds).unwrap();
        assert_eq!(read_pools(&connection).unwrap()[0].members, builds.members);

        delete_pool(&mut connection, "p2").unwrap();
        let left = read_pools(&connection).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!((left[0].when_full, left[0].spill_pool.clone()), (PoolWhenFull::Refuse, None));
    }
}
