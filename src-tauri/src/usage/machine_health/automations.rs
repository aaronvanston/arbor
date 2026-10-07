//! Automations: prompts that run on a schedule on a machine. Arbor finds the ones other apps keep (the Codex app's
//! automations, Claude's scheduled tasks, Orca's and Superset's, one module each in `apps`) and runs its own: on its
//! schedule it runs a precheck on the machine, and only when that passes starts the agent there, so a schedule with
//! nothing to do costs no tokens.
//!
//! What's kept is what the user wrote (name, prompt, schedule, precheck) and each run's times, exit codes, the end of
//! the precheck's output and the session's id. The agent's output is never read: a run's session is linked by its id.

mod apps;
pub(crate) mod commands;
mod discover;
mod draft;
mod proxy;
mod runner;
mod schedule;
mod store;
mod udian;

pub(crate) use runner::poll_loop;

use super::*;
use chrono::Local;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which app keeps an automation and runs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutomationSource {
    /// Arbor's own, which Arbor runs.
    Arbor,
    /// The Codex app's, in a Codex home's `automations` folder.
    CodexApp,
    /// Claude's scheduled tasks, in a Claude home's `scheduled-tasks` folder. Claude keeps the schedule itself.
    ClaudeDesktop,
    /// Orca's, as `orca automations list` gives them.
    Orca,
    /// Superset's, as `superset automations list` gives them: its organization's, kept in its cloud.
    Superset,
    /// Schedules someone made in ultradian, the background runner, themselves (`udian add`), on a machine where it runs.
    Ultradian,
}

/// The agent an automation starts is a harness from the catalog.
pub(crate) use super::harnesses::Harness;

/// Where an Arbor automation runs: a machine, or a pool's member with room when it's due.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(rename = "AutomationTarget")]
pub(crate) enum AutomationTarget {
    Machine { name: String },
    /// A member of the pool, picked when it's due (`runs::pick_for_automation`).
    Pool { id: String },
    /// Saved before pools could be chosen, and never run: it asks for a machine or pool instead.
    Best,
}

/// Where a run works: the project's own checkout, or a new worktree of it for each run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutomationWorkspace {
    #[default]
    Checkout,
    NewWorktree,
}

/// Whether a run starts a new session, or carries on the last run's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutomationSession {
    #[default]
    Fresh,
    Reuse,
}

/// What an Arbor automation's agent may do without asking: edit files in the project (the default), or anything.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutomationAccess {
    /// Claude's `acceptEdits`, Codex's `workspace-write` sandbox.
    #[default]
    Edits,
    /// Claude's `--dangerously-skip-permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`.
    Full,
}

/// What runs an Arbor automation when it's due: Arbor itself, while it's open on this Mac, or the background runner on
/// the machine (ultradian, which Arbor installs there), whether Arbor is open or not.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutomationRunsOn {
    /// Saved before there was a choice, or aimed at a pool, whose member is picked when it's due.
    #[default]
    App,
    Machine,
}

/// The background runner on one machine, as its last look found it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UdianOnMachine {
    /// The build it needs, like `darwin-arm64`; null when Arbor carries none for the machine's system.
    pub(crate) target: Option<String>,
    /// The version installed, or null when it isn't.
    pub(crate) version: Option<String>,
    /// Its daemon answered.
    pub(crate) live: bool,
    /// The fingerprint of its skill in the machine's store, `~/.agents/skills/ultradian`, or null when it has none.
    pub(crate) skill: Option<String>,
}

/// A schedule as words are made from it. `Custom` is a rule none of these describe; `Elsewhere` is a schedule the
/// owning app keeps where Arbor can't read it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ScheduleSummary {
    EveryMinutes { minutes: u32 },
    EveryHours { hours: u32, minute: u32 },
    Daily { hour: u32, minute: u32 },
    Weekdays { hour: u32, minute: u32 },
    /// `days` from Sunday, 0, to Saturday, 6.
    Weekly { days: Vec<u8>, hour: u32, minute: u32 },
    Custom,
    /// No schedule: it runs only when it's started by hand.
    Manual,
    Elsewhere,
}

/// How a run ended, or that it's still going.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AutomationRunStatus {
    Running,
    Done,
    Failed,
    /// The precheck found nothing to do, so the agent wasn't started.
    Skipped,
    /// The machine couldn't be reached when it was due.
    Unreachable,
    /// Arbor wasn't open within the grace window after it was due.
    Missed,
    Canceled,
}

/// The last run, as the list shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationLastRun {
    pub(crate) status: AutomationRunStatus,
    pub(crate) at_ms: i64,
}

/// What the owning app lets Arbor do with an automation it found.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationAbilities {
    pub(crate) edit: bool,
    pub(crate) pause: bool,
    pub(crate) run_now: bool,
    pub(crate) delete: bool,
    /// Can be copied into an Arbor automation, which Arbor then runs.
    pub(crate) copy: bool,
}

/// One automation in the list. The prompt isn't here; `get_automation` has it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationSummary {
    /// `arbor:<id>`, or the source and its own id, with the machine for a source each machine keeps its own of.
    pub(crate) id: String,
    pub(crate) source: AutomationSource,
    pub(crate) name: String,
    pub(crate) enabled: bool,
    /// The machine it runs on; null for one Arbor picks when it's due.
    pub(crate) machine: Option<String>,
    pub(crate) target: AutomationTarget,
    /// The project's folder name, or the name the owning app gives it.
    pub(crate) project: Option<String>,
    pub(crate) agent: Option<Harness>,
    /// The model it runs with: the one it's set to, or, when it's set to none or its app keeps none, the one its
    /// last run used, by the session id the run stores. Null until a run tells.
    pub(crate) model: Option<String>,
    pub(crate) schedule: ScheduleSummary,
    pub(crate) next_run_at_ms: Option<i64>,
    pub(crate) last_run: Option<AutomationLastRun>,
    pub(crate) has_precheck: bool,
    pub(crate) abilities: AutomationAbilities,
    pub(crate) runs_on: AutomationRunsOn,
}

/// One automation with all it's set to do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Automation {
    pub(crate) summary: AutomationSummary,
    pub(crate) prompt: String,
    /// The schedule as an RRULE, when the owning app keeps one.
    pub(crate) rrule: Option<String>,
    /// An IANA time zone; null is this Mac's.
    pub(crate) timezone: Option<String>,
    /// The project's folder on the machine.
    pub(crate) project_path: Option<String>,
    pub(crate) workspace: AutomationWorkspace,
    pub(crate) session: AutomationSession,
    pub(crate) access: AutomationAccess,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    /// A shell command run in the project's folder first: exit 0 starts the agent, anything else skips the run.
    pub(crate) precheck: Option<String>,
    pub(crate) precheck_timeout_secs: u32,
    /// How late a run may still start after Arbor or the machine was away when it was due.
    pub(crate) grace_minutes: u32,
    /// Where the owning app keeps it, from the machine's home folder, for the ones Arbor found.
    pub(crate) source_path: Option<String>,
    pub(crate) created_at_ms: Option<i64>,
    pub(crate) updated_at_ms: Option<i64>,
}

/// One run of an automation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRun {
    pub(crate) id: String,
    pub(crate) automation_id: String,
    pub(crate) machine: Option<String>,
    pub(crate) status: AutomationRunStatus,
    pub(crate) scheduled_at_ms: i64,
    pub(crate) started_at_ms: Option<i64>,
    pub(crate) finished_at_ms: Option<i64>,
    /// Started by hand, not by its schedule.
    pub(crate) manual: bool,
    pub(crate) precheck_exit: Option<i32>,
    /// The end of what the precheck printed, which the agent is given too.
    pub(crate) precheck_output: Option<String>,
    pub(crate) exit_code: Option<i32>,
    /// The session the agent ran in, by the id its transcript stores.
    pub(crate) session_id: Option<String>,
    /// Why it failed, in a few words, when Arbor knows.
    pub(crate) error: Option<String>,
}

/// One machine's last look for automations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationScan {
    pub(crate) machine: String,
    pub(crate) scanned_at_ms: Option<i64>,
    pub(crate) scanning: bool,
    pub(crate) error: Option<String>,
    /// The apps found there: their command line answered, or their automations were found.
    pub(crate) apps: Vec<AutomationSource>,
    /// The background runner there; null until a look got that far.
    pub(crate) udian: Option<UdianOnMachine>,
    /// Arbor's own automations on this machine that the background runner hasn't taken yet, and why, when it failed.
    pub(crate) placing_error: Option<String>,
}

/// Every automation Arbor knows of.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationList {
    pub(crate) automations: Vec<AutomationSummary>,
    pub(crate) scans: Vec<AutomationScan>,
    /// Arbor's own automations run (Settings' master switch).
    pub(crate) running: bool,
    /// The model that drafts an automation from a description, and its effort.
    pub(crate) draft_model: String,
    pub(crate) draft_effort: String,
    /// The background runner's version Arbor carries and installs; null for a build without it.
    pub(crate) udian_bundled: Option<String>,
    /// The fingerprint of the skill that comes with it, which Arbor puts in each machine's agent homes beside it; null
    /// for a build without one.
    pub(crate) udian_skill: Option<String>,
    /// The harnesses Arbor can start an automation with that some machine has, in the catalog's order.
    pub(crate) agents: Vec<Harness>,
    /// The proxy has the Automations client key, which every Claude and Codex automation reaches it with.
    pub(crate) proxy_key: bool,
    /// The address machines try first to reach the proxy; empty to find it on their own.
    pub(crate) proxy_address: String,
    /// The apps whose automations aren't read (Settings › Harnesses): their part of each scan is left out.
    pub(crate) apps_off: Vec<AutomationSource>,
}

/// An Arbor automation as the dialog saves it; no id is a new one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationInput {
    #[ts(optional)]
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) agent: Harness,
    #[ts(optional)]
    pub(crate) model: Option<String>,
    #[ts(optional)]
    pub(crate) effort: Option<String>,
    pub(crate) target: AutomationTarget,
    pub(crate) project_path: String,
    pub(crate) workspace: AutomationWorkspace,
    pub(crate) session: AutomationSession,
    /// Saved before there was a choice means the default.
    #[serde(default)]
    pub(crate) access: AutomationAccess,
    /// Saved before there was a choice runs from the app, as it did.
    #[serde(default)]
    pub(crate) runs_on: AutomationRunsOn,
    pub(crate) rrule: String,
    #[ts(optional)]
    pub(crate) timezone: Option<String>,
    pub(crate) grace_minutes: u32,
    #[ts(optional)]
    pub(crate) precheck: Option<String>,
    pub(crate) precheck_timeout_secs: u32,
    pub(crate) enabled: bool,
}

/// What the drafting model made of a description, for the dialog to fill in and the user to check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationDraft {
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) rrule: String,
    pub(crate) precheck: Option<String>,
    pub(crate) precheck_timeout_secs: u32,
    pub(crate) agent: Harness,
    pub(crate) session: AutomationSession,
    pub(crate) grace_minutes: u32,
    /// What the model couldn't decide and left for the user, in a sentence.
    pub(crate) note: Option<String>,
}

/// What `draft_automation` is given: the description, and the machine and project when they're already picked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub(crate) struct AutomationDraftInput {
    pub(crate) description: String,
    pub(crate) machine: Option<String>,
    pub(crate) project_path: Option<String>,
}
