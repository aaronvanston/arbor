// Written by `bun run bindings` from the Rust types in src-tauri (see src-tauri/src/bindings.rs).
// Don't edit it by hand: `bun run verify:rust` fails when it no longer matches them.

export type AccountValue = {
  authIndex: string,
  provider: string,
  requests: number,
  totalTokens: number,
  /**
   * What the account's requests in the period would have cost at API prices.
   */
  estimatedCost: number,
  pricedRequests: number,
  /**
   * The account's first recorded request, in the period or before it.
   */
  firstSeenMs: number,
};

export type AgentAttentionReport = {
  /**
   * Those asking for permission or an answer first, then those done with their turn; the longest waiting first.
   */
  items: Array<AttentionItem>,
  /**
   * Machines the reporter is set up on.
   */
  reporting: Array<string>,
};

/**
 * Another copy of an agent on the machine.
 */
export type AgentCopy = {
  path: string,
  real: string | null,
  version: string | null,
};

export type AgentHome = {
  /**
   * The machine it's on, by name, or empty for every machine.
   */
  machine: string,
  agent: AgentHomeKind,
  /**
   * From `~/` or `/`, where a `*` in a folder's name stands for any characters in it; for a standard home, an
   * environment variable the agent reads its home from, like `$CLAUDE_CONFIG_DIR`.
   */
  path: string,
  source: AgentHomeSource,
  /**
   * Its sessions are read for the Sessions pages and kept by the archive.
   */
  sessions: boolean,
  /**
   * Its settings are read and changed: the Sync page, the needs-you reporter, telemetry, how long sessions are kept.
   */
  sync: boolean,
  /**
   * The user picked its role. Otherwise it follows what each look at its machine guesses.
   */
  chosen: boolean,
  /**
   * What the last look at its machine makes of it, for a home found or added there. Never saved.
   */
  guess: HomeGuess | null,
};

/**
 * What a home belongs to, by the name the archive files its sessions under.
 */
export type AgentHomeKind = "claude" | "codex" | "pi" | "claude-desktop" | "pi-agent" | "prime-agent" | "opencode" | "droid" | "amp";

/**
 * What a home is for. It's kept as the two things it decides: whether its sessions are read, and whether its settings
 * are read and changed.
 */
export type AgentHomeRole = "active" | "history" | "ignored";

/**
 * Where a home on the list came from.
 */
export type AgentHomeSource = "standard" | "found" | "added";

/**
 * Each machine's homes, as Settings › Agent homes shows them.
 */
export type AgentHomesView = {
  /**
   * The homes on every machine: the standard ones of the harnesses found on some machine, and those saved for every
   * machine.
   */
  everywhere: Array<AgentHome>,
  machines: Array<MachineAgentHomes>,
  /**
   * What Arbor knows about each harness: its home, sessions, instructions, skills and MCP config.
   */
  harnesses: Array<HarnessInfo>,
};

/**
 * One agent's install on a machine.
 */
export type AgentInstall = {
  /**
   * From `--version`; None when it printed nothing that reads as a version.
   */
  version: string | null,
  /**
   * The binary the machine's PATH leads to.
   */
  path: string,
  /**
   * The file `path` leads to, when that's somewhere else.
   */
  real: string | null,
  method: InstallMethod,
  /**
   * What an update runs, as its user is shown it.
   */
  updateCommand: string,
  /**
   * Other copies of the agent further along PATH, which the shell finds only after this one.
   */
  copies: Array<AgentCopy>,
};

export type AgentKind = "claude" | "codex";

/**
 * What an update did, for the page.
 */
export type AgentUpdate = {
  before: string | null,
  after: string | null,
  /**
   * The end of what the update printed.
   */
  output: string,
};

export type AntiburnStatus = {
  /**
   * Antiburn is in /Applications or ~/Applications.
   */
  installed: boolean,
  /**
   * This Mac, as the Machines page names it, so the page can tell a session's transcript is on it.
   */
  thisMachine: string,
};

/**
 * A color for the icon, or auto for the running build's own.
 */
export type AppIconChoice = "auto" | "forest" | "amber" | "sky" | "ember" | "signal" | "paper" | "mono";

/**
 * What's saved, and the icon it shows in the Dock (never auto).
 */
export type AppIconSetting = {
  choice: AppIconChoice,
  shown: AppIconChoice,
};

/**
 * What an app menu item asks the window to do.
 */
export type AppMenuAction = "checkForUpdates" | "openSettings";

export type AppUpdateInfo = {
  currentVersion: string,
  latestVersion: string,
  updateAvailable: boolean,
  releaseUrl: string,
  autoUpdateSupported: boolean,
  downloadSizeBytes: number | null,
  unsupportedReason: string | null,
  /**
   * Recent releases' notes from the update feed; empty for feeds published before notes.
   */
  releases: Array<ReleaseNotes>,
  /**
   * The core the latest release bundles, which it installs at launch over an older one; None when the feed
   * doesn't say.
   */
  bundledCoreVersion: string | null,
};

/**
 * Where an app update is; the window shows its progress from this.
 */
export type AppUpdatePhase = "idle" | "available" | "checking" | "downloading" | "verifying" | "staging" | "restarting" | "canceled" | "failed";

export type AppUpdateTask = {
  running: boolean,
  cancelable: boolean,
  phase: AppUpdatePhase,
  targetVersion: string | null,
  downloadedBytes: number,
  totalBytes: number | null,
  percent: number | null,
  message: string | null,
  /**
   * A dev build copied from this Mac's builder folder: no download, so no progress to show for it.
   */
  fromThisMac: boolean,
};

/**
 * The proxy session with the thread's agent session id, when its requests came through Arbor.
 */
export type ArborSession = {
  id: string,
  lastActiveAtMs: number,
  /**
   * Its own thread's last request failed, and wasn't canceled.
   */
  lastRequestFailed: boolean,
};

/**
 * Where the archive stands, as the status names it.
 */
export type ArchiveCondition = "off" | "ok" | "catching-up" | "paused" | "main-missing" | "foreign" | "error";

export type ArchiveExport = {
  out: string,
  sessions: number,
  files: number,
  bytes: number,
  /**
   * The repositories the project matched, as `owner/name`, or checkout folders for one with no remote.
   */
  projects: Array<string>,
  /**
   * Sessions that couldn't be put back together, and why. What they had that could be read is in their folder.
   */
  failed: Array<ArchiveExportFailure>,
};

export type ArchiveExportFailure = {
  sessionId: string,
  error: string,
};

/**
 * Which sessions to export, and where to.
 */
export type ArchiveExportRequest = {
  /**
   * A full path to a folder that's missing or empty.
   */
  out: string,
  /**
   * The repository as `owner/name` or just its name, or the name of the checkout's folder.
   */
  project: string | null,
  /**
   * Only sessions kept from this machine.
   */
  machine: string | null,
  /**
   * Only sessions active since this time, in ms.
   */
  since: number | null,
  /**
   * Every version each file has had, not only the newest.
   */
  allVersions: boolean,
};

/**
 * An old backup taken in, or being taken in. Its homes are kept like a live home's, filed under
 * `machine`.
 */
export type ArchiveImport = {
  id: number,
  /**
   * The folder the user chose.
   */
  path: string,
  machine: string,
  /**
   * Every machine its homes are filed under.
   */
  machines: Array<string>,
  homes: number,
  /**
   * Files listed in its homes so far, how many are kept, and the sessions they belong to.
   */
  files: number,
  kept: number,
  sessions: number,
  addedAt: number,
  finishedAt: number | null,
  /**
   * Its folder is there to read, which it isn't while its drive is unplugged.
   */
  connected: boolean,
  failures: number,
  error: string | null,
};

/**
 * How keeping another machine's sessions went last time.
 */
export type ArchiveMachineRun = {
  machine: string,
  at: number,
  /**
   * Everything it listed was kept.
   */
  complete: boolean,
  /**
   * Why it couldn't be listed or read, when it couldn't.
   */
  error: string | null,
  /**
   * The last time it went without an error.
   */
  lastOkAt: number | null,
};

/**
 * A project's own values: on every machine, and on one machine (by normalized name), which wins.
 */
export type ArchiveProjectKeep = {
  all: boolean | null,
  machines: { [key in string]: boolean },
};

export type ArchiveSource = {
  machine: string,
  /**
   * The agent home, with the home folder as `~`.
   */
  label: string,
  agent: string,
  files: number,
  kept: number,
  gone: number,
  /**
   * Claude Code's cleanupPeriodDays for the home, when it sets one.
   */
  retentionDays: number | null,
};

export type ArchiveStatus = {
  state: ArchiveCondition,
  archiveId: string | null,
  main: ArchiveStore | null,
  sources: Array<ArchiveSource>,
  /**
   * The other machines' last passes.
   */
  machines: Array<ArchiveMachineRun>,
  /**
   * Old backups taken in, or being taken in.
   */
  imports: Array<ArchiveImport>,
  totals: ArchiveTotals,
  running: boolean,
  lastPassAt: number | null,
  nextPassAt: number | null,
  lastError: string | null,
  /**
   * When passes started failing, while they still are; since Arbor started at the earliest.
   */
  failingSince: number | null,
  paused: boolean,
  gentle: boolean,
  /**
   * The other machines on the Machines page are kept too: the All machines value.
   */
  otherMachines: boolean,
  /**
   * Machines with a value of their own, by normalized name: kept (true) or skipped (false).
   */
  machineOverrides: { [key in string]: boolean },
  /**
   * Projects with a value of their own, by lowercase `owner/name`.
   */
  projectOverrides: { [key in string]: ArchiveProjectKeep },
  /**
   * noowners: the drive doesn't enforce who can read the archive. own-disk: it's on this Mac's own disk, so it
   * doesn't outlive the disk it backs up.
   */
  warnings: Array<"noowners" | "own-disk">,
};

export type ArchiveStore = {
  root: string,
  /**
   * The drive is plugged in and the folder holds this archive.
   */
  connected: boolean,
  mountPoint: string | null,
  freeBytes: number | null,
  /**
   * The drive doesn't enforce owners and modes, so anyone on the Mac can read it.
   */
  noowners: boolean,
  /**
   * The last time a pass reached the store, which says how long a missing drive has been away.
   */
  lastSeenAt: number | null,
};

export type ArchiveTotals = {
  sessions: number,
  versions: number,
  files: number,
  storedBytes: number,
  rawBytes: number,
  growing: number,
  pendingBytes: number,
};

/**
 * Which machines a project is on.
 */
export type Assignment = { "kind": "all" } | { "kind": "some", machines: { [key in string]: ProjectOnMachine }, };

export type AttentionItem = {
  machine: string,
  agent: AgentKind,
  sessionId: string,
  kind: WaitKind,
  sinceMs: number,
  /**
   * The session as the Sessions page lists it, when its requests came through Arbor.
   */
  session: UsageSession | null,
};

/**
 * One automation with all it's set to do.
 */
export type Automation = {
  summary: AutomationSummary,
  prompt: string,
  /**
   * The schedule as an RRULE, when the owning app keeps one.
   */
  rrule: string | null,
  /**
   * An IANA time zone; null is this Mac's.
   */
  timezone: string | null,
  /**
   * The project's folder on the machine.
   */
  projectPath: string | null,
  workspace: AutomationWorkspace,
  session: AutomationSession,
  access: AutomationAccess,
  model: string | null,
  effort: string | null,
  /**
   * A shell command run in the project's folder first: exit 0 starts the agent, anything else skips the run.
   */
  precheck: string | null,
  precheckTimeoutSecs: number,
  /**
   * How late a run may still start after Arbor or the machine was away when it was due.
   */
  graceMinutes: number,
  /**
   * Where the owning app keeps it, from the machine's home folder, for the ones Arbor found.
   */
  sourcePath: string | null,
  createdAtMs: number | null,
  updatedAtMs: number | null,
};

/**
 * What the owning app lets Arbor do with an automation it found.
 */
export type AutomationAbilities = {
  edit: boolean,
  pause: boolean,
  runNow: boolean,
  delete: boolean,
  /**
   * Can be copied into an Arbor automation, which Arbor then runs.
   */
  copy: boolean,
};

/**
 * What an Arbor automation's agent may do without asking: edit files in the project (the default), or anything.
 */
export type AutomationAccess = "edits" | "full";

/**
 * What the drafting model made of a description, for the dialog to fill in and the user to check.
 */
export type AutomationDraft = {
  name: string,
  prompt: string,
  rrule: string,
  precheck: string | null,
  precheckTimeoutSecs: number,
  agent: Harness,
  session: AutomationSession,
  graceMinutes: number,
  /**
   * What the model couldn't decide and left for the user, in a sentence.
   */
  note: string | null,
};

/**
 * What `draft_automation` is given: the description, and the machine and project when they're already picked.
 */
export type AutomationDraftInput = {
  description: string,
  machine?: string,
  projectPath?: string,
};

/**
 * An Arbor automation as the dialog saves it; no id is a new one.
 */
export type AutomationInput = {
  id?: string,
  name: string,
  prompt: string,
  agent: Harness,
  model?: string,
  effort?: string,
  target: AutomationTarget,
  projectPath: string,
  workspace: AutomationWorkspace,
  session: AutomationSession,
  /**
   * Saved before there was a choice means the default.
   */
  access: AutomationAccess,
  /**
   * Saved before there was a choice runs from the app, as it did.
   */
  runsOn: AutomationRunsOn,
  rrule: string,
  timezone?: string,
  graceMinutes: number,
  precheck?: string,
  precheckTimeoutSecs: number,
  enabled: boolean,
};

/**
 * The last run, as the list shows it.
 */
export type AutomationLastRun = {
  status: AutomationRunStatus,
  atMs: number,
};

/**
 * Every automation Arbor knows of.
 */
export type AutomationList = {
  automations: Array<AutomationSummary>,
  scans: Array<AutomationScan>,
  /**
   * Arbor's own automations run (Settings' master switch).
   */
  running: boolean,
  /**
   * The model that drafts an automation from a description, and its effort.
   */
  draftModel: string,
  draftEffort: string,
  /**
   * The background runner's version Arbor carries and installs; null for a build without it.
   */
  udianBundled: string | null,
  /**
   * The fingerprint of the skill that comes with it, which Arbor puts in each machine's agent homes beside it; null
   * for a build without one.
   */
  udianSkill: string | null,
  /**
   * The harnesses Arbor can start an automation with that some machine has, in the catalog's order.
   */
  agents: Array<Harness>,
  /**
   * The proxy has the Automations client key, which every Claude and Codex automation reaches it with.
   */
  proxyKey: boolean,
  /**
   * The address machines try first to reach the proxy; empty to find it on their own.
   */
  proxyAddress: string,
  /**
   * The apps whose automations aren't read (Settings › Harnesses): their part of each scan is left out.
   */
  appsOff: Array<AutomationSource>,
};

/**
 * One run of an automation.
 */
export type AutomationRun = {
  id: string,
  automationId: string,
  machine: string | null,
  status: AutomationRunStatus,
  scheduledAtMs: number,
  startedAtMs: number | null,
  finishedAtMs: number | null,
  /**
   * Started by hand, not by its schedule.
   */
  manual: boolean,
  precheckExit: number | null,
  /**
   * The end of what the precheck printed, which the agent is given too.
   */
  precheckOutput: string | null,
  exitCode: number | null,
  /**
   * The session the agent ran in, by the id its transcript stores.
   */
  sessionId: string | null,
  /**
   * Why it failed, in a few words, when Arbor knows.
   */
  error: string | null,
};

/**
 * How a run ended, or that it's still going.
 */
export type AutomationRunStatus = "running" | "done" | "failed" | "skipped" | "unreachable" | "missed" | "canceled";

/**
 * What runs an Arbor automation when it's due: Arbor itself, while it's open on this Mac, or the background runner on
 * the machine (ultradian, which Arbor installs there), whether Arbor is open or not.
 */
export type AutomationRunsOn = "app" | "machine";

/**
 * One machine's last look for automations.
 */
export type AutomationScan = {
  machine: string,
  scannedAtMs: number | null,
  scanning: boolean,
  error: string | null,
  /**
   * The apps found there: their command line answered, or their automations were found.
   */
  apps: Array<AutomationSource>,
  /**
   * The background runner there; null until a look got that far.
   */
  udian: UdianOnMachine | null,
  /**
   * Arbor's own automations on this machine that the background runner hasn't taken yet, and why, when it failed.
   */
  placingError: string | null,
};

/**
 * Whether a run starts a new session, or carries on the last run's.
 */
export type AutomationSession = "fresh" | "reuse";

/**
 * Which app keeps an automation and runs it.
 */
export type AutomationSource = "arbor" | "codexApp" | "claudeDesktop" | "orca" | "superset" | "ultradian";

/**
 * One automation in the list. The prompt isn't here; `get_automation` has it.
 */
export type AutomationSummary = {
  /**
   * `arbor:<id>`, or the source and its own id, with the machine for a source each machine keeps its own of.
   */
  id: string,
  source: AutomationSource,
  name: string,
  enabled: boolean,
  /**
   * The machine it runs on; null for one Arbor picks when it's due.
   */
  machine: string | null,
  target: AutomationTarget,
  /**
   * The project's folder name, or the name the owning app gives it.
   */
  project: string | null,
  agent: Harness | null,
  /**
   * The model it runs with: the one it's set to, or, when it's set to none or its app keeps none, the one its
   * last run used, by the session id the run stores. Null until a run tells.
   */
  model: string | null,
  schedule: ScheduleSummary,
  nextRunAtMs: number | null,
  lastRun: AutomationLastRun | null,
  hasPrecheck: boolean,
  abilities: AutomationAbilities,
  runsOn: AutomationRunsOn,
};

/**
 * Where an Arbor automation runs: a machine, or a pool's member with room when it's due.
 */
export type AutomationTarget = { "kind": "machine", name: string, } | { "kind": "pool", id: string, } | { "kind": "best" };

/**
 * Where a run works: the project's own checkout, or a new worktree of it for each run.
 */
export type AutomationWorkspace = "checkout" | "newWorktree";

/**
 * One file or skill a change wrote or removed.
 */
export type BackupFile = {
  /**
   * As the scan names it.
   */
  path: string,
  /**
   * `added` (it wasn't there before), `changed` or `removed`.
   */
  change: string,
  /**
   * A skill's folder in the store, rather than a file.
   */
  skill: boolean,
};

/**
 * A change to a skill in one home, as it's made and as its backup lists it.
 */
export type BackupSkill = {
  /**
   * As the scan names it: ~/.claude.
   */
  home: string,
  name: string,
  action: SkillAction,
};

/**
 * Why a worktree can't be removed.
 */
export type Blocker = "main" | "locked" | "nested" | "missing" | "unknown" | "dirty" | "hidden" | "midway" | "unreachable" | "open" | "recent" | "defaultBranch" | "notMerged";

export type BranchOutcome = "deleted" | "kept";

export type CacheMisses = {
  /**
   * Requests that missed the cache.
   */
  requests: number,
  /**
   * The context they had to send again uncached.
   */
  tokens: number,
  /**
   * What those requests paid for input the cache didn't cover: uncached
   * input and cache writes. Missed requests without a price add nothing.
   */
  cost: number,
  /**
   * Missed requests with a price. Without any, the cost isn't known.
   */
  pricedRequests: number,
};

export type CallDiagnostics = {
  calls: Array<DiagnosticCall>,
  keepDays: number,
  maxCalls: number,
  machineSlowMs: number,
  coreSlowMs: number,
  clearedAtMs: number | null,
};

export type CallKind = "machine" | "core";

export type CallOutcome = "ok" | "failed" | "timedOut";

export type CapacityQuery = {
  start?: string,
  end?: string,
  /**
   * The limit windows to follow, usually each provider's headline window.
   */
  windows?: Array<string>,
};

export type CapacityReport = {
  /**
   * Where the period starts: the range start, or the first recorded request
   * when the range has no start. None when nothing is recorded.
   */
  startMs: number | null,
  endMs: number,
  accounts: Array<AccountValue>,
  coverage: Array<LimitCoverage>,
  cycles: Array<LimitCycle>,
  /**
   * The first limit reading on record.
   */
  historySinceMs: number | null,
};

/**
 * One plugin a marketplace offers.
 */
export type CatalogPlugin = {
  name: string,
  /**
   * How the marketplace shows its name, when that isn't the name.
   */
  displayName: string | null,
  description: string | null,
  version: string | null,
  category: string | null,
  /**
   * Installing it asks its user to sign in to something on that machine (Codex's `authentication: ON_INSTALL`).
   */
  signsIn: boolean,
  /**
   * The marketplace lets it be installed (Codex's `installation: AVAILABLE`, or no policy at all).
   */
  installable: boolean,
};

/**
 * What made a change, as its backup names it.
 */
export type ChangeKind = "sync" | "skills" | "reporter" | "keepSessions" | "telemetry" | "mcp" | "checkouts" | "plugins" | "hooks" | "automations" | "ssh" | "projects" | "cleanup";

/**
 * One of the instruction files in a checkout, with what Arbor's first line says it holds.
 */
export type CheckoutInstructions = {
  file: InstructionFile,
  state: LocalFileState,
  /**
   * The fingerprint of the project's text it holds.
   */
  text: string | null,
  /**
   * CLAUDE.local.md: it imports AGENTS.md first.
   */
  import: boolean | null,
  /**
   * AGENTS.override.md: the fingerprint of the AGENTS.md it copied, `-` for none.
   */
  agents: string | null,
};

/**
 * A file to bring in step in one checkout.
 */
export type CheckoutInstructionsChange = {
  checkout: string,
  file: InstructionFile,
};

export type CheckoutInstructionsResult = {
  checkout: string,
  file: InstructionFile,
  outcome: CheckoutOutcome,
};

/**
 * An MCP server to keep out of one checkout, or have there.
 */
export type CheckoutMcpChange = {
  checkout: string,
  server: string,
  on: boolean,
};

/**
 * An MCP server a checkout's settings deny, by name, and nothing else of the entry.
 */
export type CheckoutMcpDeny = {
  name: string,
  /**
   * From settings.local.json rather than the checked-in settings.json.
   */
  local: boolean,
};

export type CheckoutMcpResult = {
  checkout: string,
  server: string,
  outcome: CheckoutOutcome,
};

/**
 * How a checkout change went.
 */
export type CheckoutOutcome = "done" | "already" | "changed" | "notIgnored" | "unusable" | "ignored" | "missing" | "denied" | "toggled" | "noDefinition" | "own" | "failed";

/**
 * A plugin a checkout's settings name in enabledPlugins. Only the id and whether it's on leave the
 * scan; the rest of those files never does.
 */
export type CheckoutPlugin = {
  id: string,
  on: boolean,
  /**
   * From settings.local.json rather than the checked-in settings.json.
   */
  local: boolean,
};

/**
 * A skill a checkout's settings name in skillOverrides: its name and the state, nothing else.
 */
export type CheckoutSkill = {
  name: string,
  state: OverrideState,
  /**
   * From settings.local.json rather than the checked-in settings.json.
   */
  local: boolean,
};

/**
 * A skill to turn on or off in one checkout.
 */
export type CheckoutSkillChange = {
  checkout: string,
  skill: string,
  on: boolean,
};

export type CheckoutSkillResult = {
  checkout: string,
  skill: string,
  outcome: CheckoutOutcome,
};

/**
 * How a main checkout stands: what Sync › Projects needs to say whether it's up to date and safe to move.
 */
export type CheckoutStatus = {
  /**
   * None when no branch is checked out.
   */
  branch: string | null,
  /**
   * Changed tracked files, and untracked ones; None when `git status` failed.
   */
  changed: number | null,
  untracked: number | null,
  upstream: string | null,
  ahead: number | null,
  behind: number | null,
  /**
   * The remote's default branch, like `origin/main`.
   */
  defaultBranch: string | null,
  fetchedAt: number | null,
  /**
   * The fetch Arbor asked for didn't work.
   */
  fetchFailed: boolean,
  /**
   * Its linked worktrees, which a move would have to repair.
   */
  worktrees: number,
};

/**
 * The managed-settings policy Claude Code finds on a machine. It outranks every home's own
 * settings, and Arbor only ever reads it: its values, env values above all, never leave the scan.
 */
export type ClaudePolicy = {
  /**
   * Where it is on the machine.
   */
  file: string,
  /**
   * What it sets, by name.
   */
  keys: Array<PolicyKey>,
  /**
   * Why Arbor couldn't read it, when it couldn't; what it sets is then unknown.
   */
  problem: string | null,
  /**
   * Claude Code ignores its `skillOverrides`, as one of the values isn't one it knows.
   */
  ignoredOverrides: boolean,
};

export type CleanupAgent = {
  harness: Harness,
  /**
   * Its command, from ~ when it's in the home folder.
   */
  path: string,
  /**
   * What the command leads to, when that's somewhere else.
   */
  real: string | null,
  version: string | null,
  /**
   * How its paths say it was installed. Shown only: nothing is run on this word.
   */
  method: InstallMethod,
  /**
   * The first of its harness on the PATH, the one that runs.
   */
  first: boolean,
};

export type CleanupCache = {
  harness: Harness,
  kind: ClearableKind,
  path: string,
  /**
   * The agent home it's in, if any.
   */
  home: string | null,
  sizeKb: number | null,
  newestMs: number | null,
  held: CleanupHold | null,
};

export type CleanupGroup = "home" | "cache" | "leftover";

/**
 * Why an item has no Remove.
 */
export type CleanupHold = "sessions" | "unmeasured" | "outsideHome";

export type CleanupHome = {
  /**
   * From ~ when it's in the home folder.
   */
  path: string,
  agent: AgentHomeKind,
  harness: Harness,
  role: AgentHomeRole,
  sizeKb: number | null,
  /**
   * When anything in it was last written.
   */
  newestMs: number | null,
  /**
   * When a session file in it was last written.
   */
  lastSessionMs: number | null,
  /**
   * How many session files it holds, once measured.
   */
  sessionFiles: number | null,
  /**
   * The harness's command is on the machine.
   */
  installed: boolean,
  /**
   * The app folder it sits in, by that folder's name, for a home an app keeps.
   */
  inside: string | null,
  /**
   * For a home whose own agent's sessions Arbor doesn't read from it, the sessions folder the catalog says it
   * keeps, when it's there.
   */
  ownSessions: string | null,
  /**
   * That sessions folder is a home on the list Arbor reads and archives, which removing this one takes along.
   */
  ownSessionsArchived: boolean,
  held: CleanupHold | null,
};

export type CleanupLeftover = {
  kind: LeftoverKind,
  /**
   * Its file's name without the extension: the launch agent's label or the unit's name, as a rule.
   */
  name: string,
  path: string,
  /**
   * The program it starts, which isn't there.
   */
  program: string,
  sizeKb: number | null,
  newestMs: number | null,
  held: CleanupHold | null,
};

export type CleanupRemoval = {
  /**
   * The removal's stamp, which Undo puts back by.
   */
  stamp: string | null,
  removed: Array<string>,
  /**
   * Paths that couldn't be moved; the rest were.
   */
  failed: Array<string>,
  scan: CleanupScan,
};

export type CleanupRestore = {
  restored: Array<string>,
  failed: Array<RestoreFailure>,
  scan: CleanupScan,
};

/**
 * A machine's clean-up: what the last scan found, and what's set aside there now.
 */
export type CleanupScan = {
  machine: string,
  /**
   * When the groups were read; none when only what's set aside was.
   */
  scannedAtMs: number | null,
  homes: Array<CleanupHome>,
  agents: Array<CleanupAgent>,
  leftovers: Array<CleanupLeftover>,
  caches: Array<CleanupCache>,
  aside: Array<SetAsideItem>,
  /**
   * The scan ran out of time before measuring everything.
   */
  partial: boolean,
};

/**
 * One thing to remove, as the scan lists it.
 */
export type CleanupTarget = {
  group: CleanupGroup,
  path: string,
};

/**
 * What a folder the clean-up offers to clear holds.
 */
export type ClearableKind = "logs" | "cache";

export type ClearedCalls = {
  count: number,
  clearedAtMs: number,
  previousClearedAtMs: number | null,
};

/**
 * What a command does, which decides whether it runs straight away.
 */
export type CliAccess = "read" | "write" | "confirm";

/**
 * One request from the command line.
 */
export type CliActivity = {
  /**
   * When it was asked, in ms since the epoch.
   */
  at: number,
  /**
   * `arbor` or `arbor mcp`.
   */
  client: "cli" | "mcp",
  method: string,
  /**
   * What the method does; none when there was no such method.
   */
  access: CliAccess | null,
  /**
   * ok, plan (it needed confirming), or the failure's kind.
   */
  outcome: "ok" | "plan" | "failed" | "canceled" | "core" | "changed" | "unsupported" | "unavailable",
  ms: number,
};

export type CliInstall = {
  state: CliInstallState,
  /**
   * Where the link goes.
   */
  linkPath: string,
  /**
   * What the link there runs now, when it's a link.
   */
  target: string | null,
  /**
   * The program a link should run: this copy of Arbor.
   */
  executable: string | null,
};

/**
 * What `install_cli_link` did.
 */
export type CliInstallResult = {
  install: CliInstall,
};

/**
 * Where `arbor` stands on this Mac.
 */
export type CliInstallState = "installed" | "missing" | "elsewhere" | "taken" | "unavailable";

/**
 * Everything Settings › App › Command line shows.
 */
export type CliOverview = {
  settings: CliSettings,
  install: CliInstall,
  /**
   * The latest requests, newest first.
   */
  activity: Array<CliActivity>,
  /**
   * Whether this Mac's skill store has the skill that teaches agents `arbor`.
   */
  skill: CliSkillState,
};

export type CliSettings = {
  /**
   * Whether the app answers the command line at all.
   */
  enabled: boolean,
  /**
   * Whether it may change things, or only look.
   */
  changes: boolean,
};

/**
 * What installing the skill did, each place with the home folder as ~.
 */
export type CliSkillInstall = {
  written: Array<string>,
  /**
   * Already the skill as this Arbor has it.
   */
  already: Array<string>,
  failed: Array<string>,
};

/**
 * Whether the store holds the skill, and whether it's this Arbor's.
 */
export type CliSkillState = "missing" | "current" | "outdated";

/**
 * An action the window answers for the command line.
 */
export type CliWindowAction = {
  name: string,
  access: CliAccess,
  summary: string,
  args: Array<CliWindowArg>,
};

/**
 * One argument a window action takes.
 */
export type CliWindowArg = {
  name: string,
  tsType: string,
  optional: boolean,
};

/**
 * Why the window couldn't do what was asked.
 */
export type CliWindowError = {
  message: string,
};

/**
 * One hour of one client's requests from one machine.
 */
export type ClientHour = {
  /**
   * The machine its API key is assigned to, or empty for a key that isn't.
   */
  machine: string,
  userAgent: string,
  /**
   * When the hour starts.
   */
  hourMs: number,
  requests: number,
  /**
   * Failed requests, apart from those the client canceled.
   */
  failed: number,
  /**
   * Of those, the ones refused for a rate limit.
   */
  rateLimited: number,
};

export type ClientVersions = {
  /**
   * Oldest hour first.
   */
  hours: Array<ClientHour>,
  truncated: boolean,
};

/**
 * A change to a plugin in one Codex home.
 */
export type CodexPluginChange = {
  /**
   * The home, as the scan names it: ~/.codex.
   */
  home: string,
  /**
   * AddMarketplace, Install, Enable, Disable or Uninstall.
   */
  action: PluginAction,
  /**
   * `name@marketplace`, or a marketplace's name to add.
   */
  target: string,
  /**
   * The GitHub repository a marketplace is added from.
   */
  source?: string,
};

/**
 * Whether the core's requests are being copied into usage.db.
 */
export type CollectorState = "waiting-core" | "collecting" | "error";

export type CommandError = {
  kind: CommandErrorKind,
  /**
   * The core's HTTP status.
   */
  status?: number,
  /**
   * The core's own words for it, from its `error` or `message` field.
   */
  reason?: string,
  /**
   * What to show.
   */
  message: string,
};

export type CommandErrorKind = "failed" | "canceled" | "core" | "changed";

/**
 * One of a plugin's skills, commands or agents: what its listing adds to every session, and what
 * it adds again each time it's used.
 */
export type ComponentCost = {
  name: string,
  alwaysOn: TokenEstimate | null,
  onInvoke: TokenEstimate | null,
};

/**
 * How a request relates to the conversation in its thread, worked out from
 * context sizes alone: the proxy doesn't see the conversation itself.
 */
export type ContextStep = "conversation" | "compacted" | "side";

export type CoreApiKeyView = {
  apiKey: string,
  /**
   * The hash usage records carry for this key.
   */
  apiKeyHash: string,
  remark: string,
};

export type CoreConfigView = {
  host: string,
  apiKeys: Array<CoreApiKeyView>,
  pausedApiKeys: Array<CoreApiKeyView>,
  managementSecretConfigured: boolean,
  port: number,
  allowLan: boolean,
  debug: boolean,
  commercialMode: boolean,
  loggingToFile: boolean,
  logsMaxTotalSizeMb: number,
  errorLogsMaxFiles: number,
  usageStatisticsEnabled: boolean,
  redisUsageQueueRetentionSeconds: number,
  requestLog: boolean,
  pluginsEnabled: boolean,
  routingStrategy: string,
  proxyUrl: string,
  routingSessionAffinity: boolean,
  routingSessionAffinityTtl: string,
  disableCooling: boolean,
  requestRetry: number,
  maxRetryCredentials: number,
  maxRetryInterval: number,
  streamingBootstrapRetries: number,
};

export type CoreInstallResult = {
  version: string,
  assetName: string,
  installDir: string,
  binaryPath: string | null,
};

export type CoreInstallTask = {
  running: boolean,
  cancelable: boolean,
  phase: string,
  downloaded: number,
  total: number | null,
  percent: number | null,
  message: string | null,
  result: CoreInstallResult | null,
};

export type CoreLatest = {
  version: string,
  assetName: string,
  /**
   * The newest releases' changelogs from GitHub, when the check read its releases feed.
   */
  releases: Array<ReleaseNotes>,
};

export type CoreLoggingSettingsInput = {
  debug: boolean,
  commercialMode: boolean,
  loggingToFile: boolean,
  logsMaxTotalSizeMb: number,
  errorLogsMaxFiles: number,
  usageStatisticsEnabled: boolean,
  redisUsageQueueRetentionSeconds: number,
};

export type CoreStatus = {
  installed: boolean,
  /**
   * The tracked core process is alive. Drives the status label and Start/Stop controls.
   */
  running: boolean,
  /**
   * Running and answering on its management port, so the UI and usage collector can talk to it. Gate anything
   * that calls the core on this.
   */
  ready: boolean,
  starting: boolean,
  managed: boolean,
  processId: number | null,
  currentVersion: string | null,
  installDir: string,
  binaryPath: string | null,
  message: string,
};

export type CoreTlsSettings = {
  enabled: boolean,
  cert: string,
  key: string,
};

/**
 * A cost in USD, split by what it paid for.
 */
export type CostParts = {
  /**
   * Input that wasn't read from or written to the cache.
   */
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
};

export type CountedSource = {
  machine: string,
  home: string,
  agent: string,
  kind: string,
};

export type DayRow = {
  /**
   * yyyy-mm-dd
   */
  day: string,
  calls: number,
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
  reasoning: number,
};

/**
 * A definition, as far as it's safe to show: how it's reached, where, and the variables it reads.
 */
export type DefinitionView = {
  transport: string,
  /**
   * The host of its URL, or the program it runs.
   */
  place: string | null,
  /**
   * The environment variables it reads secrets and settings from, by name.
   */
  variables: Array<string>,
};

/**
 * What the builder is doing, as it writes it in status.json.
 */
export type DevBuildState = "idle" | "waiting" | "building" | "failed";

/**
 * Whether this Mac builds main for the dev channel, and how its builds are going.
 */
export type DevBuildStatus = {
  /**
   * The builder's LaunchAgent is set up (scripts/install-dev-builds.sh).
   */
  installed: boolean,
  /**
   * The Arbor repository it was set up from, which turning it back on uses.
   */
  repository: string | null,
  state: DevBuildState,
  /**
   * The commit of main being waited on or built.
   */
  commit: string | null,
  step: DevBuildStep | null,
  startedAt: string | null,
  finishedAt: string | null,
  /**
   * Why the last build failed.
   */
  error: string | null,
  /**
   * The last build's log, when there is one to open.
   */
  hasLog: boolean,
  /**
   * "Build latest main" was asked for and the builder hasn't taken it yet.
   */
  requested: boolean,
  /**
   * The newest build that finished, which the dev channel offers.
   */
  builtVersion: string | null,
  builtCommit: string | null,
  builtAt: string | null,
  /**
   * While it waits for main to settle: when it'll start building, unless main moves again.
   */
  settlesAt: string | null,
};

/**
 * The step a running build is on.
 */
export type DevBuildStep = "fetching" | "installing" | "building" | "signing";

/**
 * One call, as Diagnostics keeps it.
 */
export type DiagnosticCall = {
  /**
   * When it finished.
   */
  atMs: number,
  kind: CallKind,
  /**
   * The machine's name, or "core".
   */
  target: string,
  /**
   * A fixed name for a machine's script ("setup scan"), or a core request's method and path
   * ("GET /auth-files").
   */
  operation: string,
  durationMs: number,
  /**
   * The script's exit code, or the core's HTTP status.
   */
  code: number | null,
  outcome: CallOutcome,
  slowAfterMs: number,
  /**
   * Finished fine, but took longer than `slow_after_ms`.
   */
  slow: boolean,
};

/**
 * A machine to offer in the Add machine dialog.
 */
export type DiscoveredHost = {
  /**
   * What to call it: the ssh_config alias, the peer's tailnet name, or the first part of a
   * known host's name. Empty when it's only known by its address.
   */
  name: string,
  /**
   * What goes in the SSH host field. An ssh_config alias stays the alias, so ssh applies the
   * rest of its settings.
   */
  endpoint: string,
  port: number,
  /**
   * Where the alias leads, when ssh_config says.
   */
  hostName: string | null,
  user: string | null,
  /**
   * Every name and address it's known by, lowercased, to match against machines already added.
   */
  addresses: Array<string>,
  /**
   * Where it was found.
   */
  sources: Array<DiscoverySource>,
  /**
   * The OS Tailscale reports for it.
   */
  os: string | null,
  /**
   * Whether it's online on the tailnet.
   */
  online: boolean | null,
};

/**
 * Where a machine was found.
 */
export type DiscoverySource = "sshConfig" | "knownHosts" | "tailscale";

/**
 * A machine's project scan, as far as Sync › Projects needs it.
 */
export type DriftMachine = {
  machine: string,
  scannedAt: number | null,
  scanning: boolean,
  error: string | null,
};

export type ExceptionReport = {
  source: ExceptionSource,
  name: string,
  message: string,
  stack: string,
  page: string | null,
  /**
   * `globalThis._posthogChunkIds` as the release build's inject step left it: a stack from inside each bundle
   * file, keyed to that file's chunk id, which is how PostHog finds the source map for a frame.
   */
  chunkIds?: { [key in string]: string },
};

/**
 * Where a window error was caught.
 */
export type ExceptionSource = "app" | "page" | "monitor" | "window" | "rejection";

/**
 * How much an MCP server or a plugin was used in the sessions active lately.
 */
export type ExtensionUsage = {
  /**
   * A server as its tools' names give it, or a plugin's name.
   */
  name: string,
  sessions: number,
  /**
   * Calls to its tools, and for a plugin to its skills, by sessions and their subagents.
   */
  calls: number,
  /**
   * When the latest of those sessions was last active.
   */
  lastMs: number,
  /**
   * Its sessions by the machine each ran on.
   */
  machines: { [key in string]: number },
};

/**
 * One extra model, with the details the core would otherwise take from its catalog.
 */
export type ExtraModel = {
  id: string,
  displayName: string | null,
  description: string | null,
  contextLength: number | null,
  maxCompletionTokens: number | null,
  thinking: ExtraModelThinking | null,
  inputModalities: Array<string>,
  outputModalities: Array<string>,
};

export type ExtraModelThinking = {
  levels: Array<string>,
  min: number | null,
  max: number | null,
  zeroAllowed: boolean,
  dynamicAllowed: boolean,
};

export type ExtraModelsProvider = {
  /**
   * The core's key for the provider, such as `claude` or `codex`.
   */
  provider: string,
  models: Array<ExtraModel>,
  /**
   * The core's built-in models for the provider, to fill a new extra in from and to tell when one has become
   * built in.
   */
  catalog: Array<ExtraModel>,
  /**
   * Whether the core has an account for the provider that's switched on. Not known while it's stopped.
   */
  hasAccount: boolean,
  pluginInstalled: boolean,
  pluginLoaded: boolean,
};

/**
 * What the Extra models page shows: each provider's list in config.yaml, and what the running core makes of it.
 */
export type ExtraModelsView = {
  /**
   * The providers with an account in the core, or with extra models saved, in `EXTRA_MODEL_PROVIDERS` order.
   */
  providers: Array<ExtraModelsProvider>,
  /**
   * The model ids the core serves right now, from every provider.
   */
  served: Array<string>,
  coreRunning: boolean,
};

/**
 * How many sessions one choice in a filter menu would show, given the other filters.
 */
export type FacetCount = {
  value: string,
  sessions: number,
};

/**
 * The features `feature.used` can name.
 */
export type Feature = "account-signed-in" | "machines-saved" | "sync-applied" | "sync-undone" | "skills-changed" | "plugins-changed" | "mcp-changed" | "hooks-changed" | "worktrees-removed" | "node-versions-changed" | "alert-sent" | "digest-exported" | "palette-used" | "update-started" | "core-started" | "core-stopped" | "core-restarted" | "prices-synced" | "antiburn-opened";

/**
 * What a change does, or did, to a settings file.
 */
export type FileChange = "create" | "edit" | "none";

export type FixOutcome = "done" | "skipped" | "failed";

/**
 * A proxy session, over its requests in the window.
 */
export type FleetProxySession = {
  session: UsageSession,
  /**
   * Its own thread's latest request failed, and wasn't canceled. A subagent's failure doesn't
   * count: the session carries on without it.
   */
  lastRequestFailed: boolean,
};

export type FleetSources = {
  nowMs: number,
  /**
   * This Mac, as the Machines page names it.
   */
  thisMachine: string,
  /**
   * T3 Code's threads are being read.
   */
  t3Enabled: boolean,
  /**
   * Some machine has T3 Code, so its threads could be read. Without it the board never mentions T3 Code.
   */
  t3Found: boolean,
  t3: Array<T3Channel>,
  attention: AgentAttentionReport,
  sessions: Array<FleetProxySession>,
};

export type FleetTrayCounts = {
  waiting: number,
};

/**
 * What a folder is, before an archive is made or used there.
 */
export type FolderCheck = {
  kind: FolderKind,
  /**
   * On this Mac's own disk, where Arbor keeps the index: an archive there doesn't outlive the disk it backs up.
   */
  ownDisk: boolean,
  freeBytes: number | null,
  mountPoint: string | null,
  noowners: boolean,
  archiveId: string | null,
};

export type FolderKind = "empty" | "archive" | "not-empty" | "missing" | "not-writable";

/**
 * A folder the last scan found that the list doesn't cover, or siblings of one kind folded into a `*`.
 */
export type FoundHome = {
  agent: AgentHomeKind,
  path: string,
  /**
   * How many folders it stands for.
   */
  folders: number,
  /**
   * The role it would start with.
   */
  guess: HomeGuess | null,
};

/**
 * A place the setup repo wants a project, as the last scan found it.
 */
export type FoundPlace = {
  /**
   * As the repo gives it: `~/…` or absolute.
   */
  path: string,
  kind: PlaceKind,
  /**
   * Where it leads, when it's a link.
   */
  link: string | null,
  /**
   * The folder it is, links followed.
   */
  real: string | null,
  /**
   * A checkout's origin as `host/owner/name`.
   */
  remote: string | null,
  /**
   * None when no branch is checked out.
   */
  branch: string | null,
  /**
   * Changed tracked files, and untracked ones; None when `git status` failed.
   */
  changed: number | null,
  untracked: number | null,
  upstream: string | null,
  ahead: number | null,
  behind: number | null,
  /**
   * The remote's default branch, like `origin/main`.
   */
  defaultBranch: string | null,
  fetchedAt: number | null,
  /**
   * The fetch Arbor asked for didn't work.
   */
  fetchFailed: boolean,
  /**
   * Its linked worktrees, which a move would have to repair.
   */
  worktrees: number,
};

/**
 * How the checks with GitHub are going, for the Projects view.
 */
export type GithubStatus = {
  /**
   * True while pull requests are being asked about.
   */
  checking: boolean,
  /**
   * How the last check went: "ok", "missing" when the GitHub CLI isn't
   * installed, "signedOut", or "failed". Empty before the first.
   */
  last: string,
  /**
   * What went wrong, for "failed".
   */
  message: string,
  /**
   * Why GitHub didn't say how checks, reviews and merging stand, when it
   * turned down asking and answered only whether they merged.
   */
  detailError: string,
  /**
   * When the last check finished.
   */
  atMs: number | null,
};

export type GuiNetworkEndpointSettings = {
  host: string,
  port: number,
  proxyUrl: string,
};

export type GuiRetrySettings = {
  disableCooling: boolean,
  requestRetry: number,
  maxRetryCredentials: number,
  maxRetryInterval: number,
  streamingBootstrapRetries: number,
};

export type GuiSessionRoutingSettings = {
  routingSessionAffinity: boolean,
  routingSessionAffinityTtl: string,
};

export type GuiSettings = {
  host: string,
  port: number,
  allowLan: boolean,
  runOnStartup: boolean,
  closeBehavior: WindowsCloseBehavior,
};

/**
 * A harness, by the id the other apps that start agents (Orca, the Codex app) give it.
 */
export type Harness = "claude" | "codex" | "pi" | "primeAgent" | "openCode" | "droid" | "amp" | "gemini" | "other";

/**
 * A home of a harness other than Claude Code and Codex, as far as Sync reads it so far: its own instructions file
 * and the skills in its own folder, which the setup repo and skill changes reach.
 */
export type HarnessHome = {
  harness: Harness,
  /**
   * With the machine's home as ~.
   */
  path: string,
  items: Array<SetupItem>,
  /**
   * Where its skills folder leads, when that's a link: every skill in it is then that folder's.
   */
  skillsLink: string | null,
};

/**
 * A harness as Settings › Agent homes shows it.
 */
export type HarnessInfo = {
  harness: Harness,
  binary: string,
  /**
   * Where it keeps its settings, with the variable that moves it.
   */
  home: string,
  homeEnv?: string,
  /**
   * Where Arbor reads its sessions; none when it can't yet.
   */
  sessions?: string,
  globalInstructions?: string,
  projectInstructions: Array<string>,
  skills: Array<string>,
  /**
   * Its MCP config file, when it has one, the key its servers sit under and the file's shape.
   */
  mcp?: string,
  mcpKey?: string,
  mcpFormat?: McpFormat,
  /**
   * Sync reads its home.
   */
  sync: boolean,
  /**
   * Arbor can start an automation with it.
   */
  automations: boolean,
  /**
   * Arbor can hold it to editing files; one that can't only runs with full access.
   */
  limitsEdits: boolean,
  /**
   * Arbor shows it outside this list: Claude Code and Codex always, any other once a machine has it.
   */
  found: boolean,
  /**
   * The machines whose last setup scan found its command or its home, by name.
   */
  foundOn: Array<string>,
};

/**
 * Another harness's command on the machine's PATH. The first of each harness is the one that runs.
 */
export type HarnessInstall = {
  harness: Harness,
  /**
   * With the machine's home as ~.
   */
  path: string,
  /**
   * The file `path` leads to, when that's somewhere else.
   */
  real: string | null,
  /**
   * From its version command; None when it printed nothing that reads as one.
   */
  version: string | null,
  /**
   * Its own command that updates it, which the page shows before running it; none when Arbor doesn't update it.
   */
  updateCommand: string | null,
};

export type HarnessRun = {
  id: string,
  trigger: string | null,
  pool: string,
  /**
   * The pool it ran on, after any spill.
   */
  ranPool: string | null,
  machine: string | null,
  /**
   * The harness asked for.
   */
  harness: RunHarness,
  /**
   * The harness it went to: the command line when it fell back.
   */
  used: RunHarness | null,
  setup: string,
  /**
   * The folder asked for, or once a run that named a repo is placed, its checkout on the machine it went to.
   */
  folder: string,
  repo: string | null,
  title: string,
  state: RunState,
  reason: RunReason | null,
  /**
   * What the harness or the machine said when it failed: a script's failure code, the members
   * looked on, or for an agent that failed its exit code (`gone` when it left none).
   */
  detail: string | null,
  handle: RunHandle,
  queuedAtMs: number,
  startedAtMs: number | null,
  endedAtMs: number | null,
  /**
   * How long it may wait in the queue, from the pool.
   */
  waitUntilMs: number | null,
};

/**
 * A harness's own setup of an agent: T3 Code's provider instances.
 */
export type HarnessSetup = {
  id: string,
  /**
   * The agent behind it, in the harness's words ("codex", "claudeAgent", "cursor").
   */
  driver: string,
  /**
   * What the harness shows it as, when it was given a name.
   */
  name: string | null,
  enabled: boolean,
};

/**
 * What an update did, for the page.
 */
export type HarnessUpdate = {
  before: string | null,
  after: string | null,
  /**
   * The end of what the update printed.
   */
  output: string,
};

/**
 * What a health score is read from.
 */
export type HealthMetric = "cpu" | "memory" | "swap" | "disk" | "load" | "cpuTemp" | "gpuTemp";

export type HealthPoint = {
  t: number,
  score: number,
  cpu: number | null,
  mem: number,
  memUsedKb: number,
  swap: number | null,
  swapUsedKb: number | null,
  disk: number,
  diskFreeKb: number,
  load1: number,
  load5: number,
  load15: number,
  rxBps: number | null,
  txBps: number | null,
  latencyMs: number | null,
  cpuTemp: number | null,
  gpuTemp: number | null,
  gpuUtil: number | null,
  gpuMemUsedMb: number | null,
  /**
   * Claude Code and Codex processes running when the sample was taken.
   */
  claudeRunning: number | null,
  codexRunning: number | null,
};

export type HealthReason = {
  metric: HealthMetric,
  value: number,
};

/**
 * How a machine is doing: a band of its score, or why there's no score.
 */
export type HealthStatus = "healthy" | "degraded" | "critical" | "unreachable" | "pending" | "unconfigured";

/**
 * A session the heavy-session check looks at: only what it needs to hold the
 * session to its project's and machine's threshold, say where it runs and what
 * it used, and warn who else pausing its key would stop.
 */
export type HeavySessionCandidate = {
  id: string,
  machine: string,
  /**
   * The machine its transcript is on; empty until one is found.
   */
  transcriptMachine: string,
  /**
   * `owner/name` from its transcript's remote, else its first pull request's.
   */
  repository: string | null,
  apiKeyHash: string,
  userAgent: string | null,
  totalTokens: number,
  requests: number,
  pricedRequests: number,
  estimatedCost: number,
  /**
   * Other sessions that sent requests with the same key in the window.
   */
  otherKeySessions: number,
};

/**
 * One file in a skill.
 * Why a skill's file isn't shown.
 */
export type HiddenReason = "secret" | "large" | "binary";

export type HomeAgent = "claude" | "codex" | "shared";

export type HomeGuess = {
  role: AgentHomeRole,
  reason: HomeGuessReason,
};

/**
 * Why a look guessed a home's role.
 */
export type HomeGuessReason = "recent" | "idle" | "sessionCopy";

/**
 * Why Arbor won't change a home's hook.
 */
export type HookBlock = "broken";

export type HookCell = {
  machine: string,
  agent: AgentKind,
  /**
   * As the scan names it.
   */
  home: string,
  /**
   * The repo's name for it; None for a hook the repo hasn't got.
   */
  name: string | null,
  event: string,
  /**
   * The script it runs, in ~/.agents/hooks.
   */
  script: string,
  state: HookState,
  blocked: HookBlock | null,
};

/**
 * The repo's hooks and how every machine's Claude Code and Codex homes stand against them.
 */
export type HookRegistry = {
  /**
   * The commit they're read from, the repo's last. None before anything's committed.
   */
  commit: string | null,
  /**
   * The file is in that commit.
   */
  found: boolean,
  /**
   * The file has changes that aren't committed, which count once they are.
   */
  uncommitted: boolean,
  problems: Array<string>,
  hooks: Array<HookView>,
  cells: Array<HookCell>,
};

/**
 * How a home's hook stands against the repo.
 */
export type HookState = "same" | "add" | "update" | "extra";

export type HookView = {
  name: string,
  event: string,
  matcher: string | null,
  /**
   * As the repo has it; None when it looks like it holds a secret, which is never shown.
   */
  command: string | null,
  script: string | null,
  timeout: number | null,
  agents: Array<AgentKind>,
  homes: Array<string> | null,
  removed: boolean,
  /**
   * Turned off on every machine, kept in the repo.
   */
  allOff: boolean,
  /**
   * Machines it's kept off.
   */
  off: Array<string>,
  problems: Array<string>,
};

/**
 * What the repo wants of a hook, for every machine or one.
 */
export type HookWanted = "default" | "off" | "removed";

export type HubBranch = {
  branch: string,
  state: HubBranchState,
  /**
   * The machines whose copies have moved on apart, for a diverged branch.
   */
  apart: Array<string>,
};

/**
 * How a hub branch came out of a round.
 */
export type HubBranchState = "same" | "advanced" | "new" | "diverged";

export type HubMachine = {
  machine: string,
  collected: boolean,
  handedOut: boolean,
  error: string | null,
};

/**
 * How a round through the hub went.
 */
export type HubSync = {
  project: string,
  branches: Array<HubBranch>,
  machines: Array<HubMachine>,
};

/**
 * Where an @import is, in the file that has it.
 */
export type ImportFacts = {
  /**
   * The file with the @import, with the machine's home as ~.
   */
  from: string,
  /**
   * The path as written after the @.
   */
  written: string,
  /**
   * 1 for an @import in the instructions or a rule, 2 for one in the file that pulls in, and so on.
   */
  level: number,
};

/**
 * Where a home an import found stands.
 */
export type ImportHomeState = "new" | "live" | "imported";

/**
 * What the page shows before an import: paths, counts, sizes and file times, nothing a file says.
 */
export type ImportPreview = {
  path: string,
  homes: Array<ImportPreviewHome>,
  /**
   * Sessions in the new homes, by the ids their file names carry, and how many the archive doesn't have.
   */
  sessions: number,
  newSessions: number,
  files: number,
  bytes: number,
  /**
   * The oldest and newest session file, by when each was last changed.
   */
  firstAt: number | null,
  lastAt: number | null,
  /**
   * Arbor stopped looking before it had looked everywhere.
   */
  partial: boolean,
  /**
   * Machines the backup could have come from, this Mac first.
   */
  machines: Array<string>,
};

export type ImportPreviewHome = {
  /**
   * claude or codex for a home; the layout's own name for OpenClaw and Claude desktop sessions.
   */
  agent: string,
  root: string,
  /**
   * home: a copied agent home; otherwise openclaw or claude-desktop.
   */
  layout: string,
  state: ImportHomeState,
  files: number,
  bytes: number,
  sessions: number,
};

export type InEffect = "live" | "notLoaded" | "coreStopped" | "unknown";

export type InstallMethod = "native" | "homebrew" | "npm" | "bun" | "pnpm" | "mise" | "unknown";

/**
 * A project instruction file Arbor writes in a checkout.
 */
export type InstructionFile = "claudeLocal" | "agentsOverride";

export type ItemKind = "instructions" | "import" | "rule" | "skill" | "subagent" | "command" | "hook" | "mcp" | "plugin" | "marketplace" | "setting" | "env" | "profile";

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

/**
 * A version a version manager keeps, which a project that pins it gets.
 */
export type KeptVersion = {
  tool: string,
  /**
   * nvm, fnm, volta, mise, asdf, pyenv, uv, rustup, sdk, toolchain, corepack or brew.
   */
  manager: string,
  version: string,
  /**
   * A rustup toolchain's channel, like `stable` or `nightly-2026-09-01`.
   */
  label: string | null,
};

/**
 * Each agent's `latest` on npm, or None when npm couldn't be asked.
 */
export type LatestVersions = {
  claude: string | null,
  codex: string | null,
};

/**
 * A layer file Arbor skipped, or a value in one, and why.
 */
export type LayerProblem = {
  file: string,
  problem: string,
};

export type LeftoverKind = "launchAgent" | "systemdUnit";

export type LifetimeTokens = {
  /**
   * An archive has been set up, so there's something to count.
   */
  archived: boolean,
  months: Array<MonthRow>,
  days: Array<DayRow>,
  /**
   * The homes whose sessions are kept, and so counted.
   */
  sources: Array<CountedSource>,
  /**
   * Claude Code's own daily totals on days no Claude transcript was counted for on that machine.
   * It counts more than the transcripts hold, so these are in none of the rows above.
   */
  recovered: Array<RecoveredDay>,
  recoveredOverlap: RecoveredOverlap,
  /**
   * Kept transcripts not yet counted to their end.
   */
  versionsLeft: number,
  bytesLeft: number,
  lastError: string | null,
};

export type LimitAccountRename = {
  from: string,
  to: string,
};

/**
 * When one account's window was watched during the period: its first and
 * last reading, including readings while the window wasn't running.
 */
export type LimitCoverage = {
  account: string,
  window: string,
  firstSampledAtMs: number,
  lastSampledAtMs: number,
};

/**
 * One account's use of one limit window between two resets, as far as the
 * period's readings show it.
 */
export type LimitCycle = {
  account: string,
  authIndex: string,
  plan: string,
  window: string,
  resetAtMs: number,
  /**
   * How much of the window was left at the first reading in the period.
   */
  firstRemainingPercent: number,
  /**
   * The least of the window left at any reading.
   */
  minRemainingPercent: number,
  firstSampledAtMs: number,
  lastSampledAtMs: number,
};

/**
 * One limit window of one account at one refresh, as the webview reports it.
 * These are kept for months, unlike the 24-hour pooled history behind the
 * sparklines, so the capacity report can show how much of each account's
 * limits gets used before they reset.
 */
export type LimitReading = {
  /**
   * The account's app key: credential file name and auth index.
   */
  account: string,
  authIndex: string,
  provider: string,
  plan: string,
  window: string,
  remainingPercent: number | null,
  resetAtMs: number | null,
  extra: boolean,
  sampledAtMs: number,
};

/**
 * A running session's main conversation.
 */
export type LiveContext = {
  /**
   * How much context it's at, in input tokens. 0 when the session's own
   * thread has made no request.
   */
  tokens: number,
  /**
   * The model of its latest request, which a learned point is for.
   */
  model: string,
  /**
   * Where it's likely to compact next.
   */
  compactsAt: number | null,
  /**
   * What says so: `session` where it compacted by itself before, `learned`
   * where sessions of its client and model have, `default` where Claude
   * Code usually does. Empty without a point.
   */
  basis: string,
  /**
   * How fast it has grown lately, in tokens a minute.
   */
  growthPerMinute: number | null,
  /**
   * How long until it compacts at that pace, from its latest request. 0
   * once it's at the point.
   */
  compactsInMs: number | null,
};

/**
 * A setting the core takes from its file without a restart. Host, port, TLS and commercial mode only change when it
 * restarts, so a difference there says nothing about whether it reloaded.
 */
export type LiveCoreSetting = "debug" | "loggingToFile" | "logsMaxTotalSize" | "errorLogsMaxFiles" | "requestLog" | "usageStatistics" | "usageQueueRetention" | "disableCooling" | "requestRetry" | "maxRetryCredentials" | "maxRetryInterval" | "streamingBootstrapRetries" | "routingStrategy" | "sessionAffinity" | "sessionAffinityTtl" | "proxyUrl" | "plugins" | "clientKeys";

export type LiveSession = {
  /**
   * When its main conversation started, which can be long before the hour.
   */
  runningSinceMs: number,
  context: LiveContext,
  provider: string,
  machine: string,
  pool: string,
  apiKeyHash: string,
  active: boolean,
  hasOwnRequests: boolean,
  subagents: number,
  threads: Array<UsageSessionThread>,
  /**
   * Where the session ran and what it was called, from its transcript. None until one is found.
   */
  transcript: SessionTranscript | null,
  id: string,
  parentId: string | null,
  depth: number,
  models: Array<string>,
  providers: Array<string>,
  userAgent: string | null,
  /**
   * The largest context the thread's conversation reached, in input tokens.
   * Like `compactions`, it covers the whole thread whatever the filters: a
   * thread missing some of its requests would show drops that never happened.
   */
  peakContext: number,
  /**
   * How often the thread's context was compacted. A session's own count is
   * its main thread's.
   */
  compactions: number,
  startedAtMs: number,
  lastActiveAtMs: number,
  requests: number,
  failures: number,
  canceled: number,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalTokens: number,
  estimatedCost: number,
  pricedRequests: number,
};

export type LiveSessionsReport = {
  /**
   * The costliest in the last hour first.
   */
  sessions: Array<LiveSession>,
  /**
   * Every running session, listed or not.
   */
  running: number,
  /**
   * What they all spent in the last hour.
   */
  costPerHour: number,
  /**
   * Their requests in the hour, and those with a price. Without any, the cost isn't known.
   */
  requests: number,
  pricedRequests: number,
  /**
   * Every running session's User-Agent, empty when it sent none, so they can be counted by client.
   */
  clients: Array<string>,
};

/**
 * How a checkout has one of those files.
 */
export type LocalFileState = "none" | "seen" | "own" | "arbor";

export type MachineAgentHomes = {
  machine: string,
  /**
   * Its homes as its scripts read them, those for every machine included.
   */
  homes: Array<AgentHome>,
  scannedAtMs: number | null,
  /**
   * Why its last scan failed.
   */
  error: string | null,
  /**
   * What its last scan found that no home on the list covers.
   */
  suggested: Array<FoundHome>,
};

/**
 * What the checks found on a machine. A failed check keeps what the last good one found.
 */
export type MachineAgents = {
  claude: AgentInstall | null,
  codex: AgentInstall | null,
  checkedAt: number | null,
  error: string | null,
  /**
   * Agents being updated right now.
   */
  updating: Array<AgentKind>,
  /**
   * Arbor's reporter, which says when a session is waiting on its user.
   */
  reporter: ReporterStatus,
  /**
   * T3 Code, when it keeps its home here.
   */
  t3: T3Install | null,
  /**
   * Orca, once it's been used here.
   */
  orca: OrcaInstall | null,
};

export type MachineAssignment = {
  api_key_hash: string,
  label: string,
  machine: string,
  pool: string,
};

export type MachineFacts = {
  hostname: string,
  os: string,
  osVersion: string,
  arch: string,
  /**
   * The model identifier on a Mac ("Mac16,8"); the board or product name elsewhere.
   */
  model: string,
  /**
   * What a Mac on Apple silicon calls itself ("MacBook Pro (14-inch, 2024)"); empty elsewhere.
   */
  productName: string,
  chip: string,
  gpu: string,
  cores: number,
  memTotalKb: number,
  diskTotalKb: number,
  swapTotalKb: number | null,
  gpuMemTotalMb: number | null,
  ip: string,
  uptimeS: number | null,
  batteryPct: number | null,
  batteryState: string,
};

export type MachineHealth = {
  machine: string,
  host: MachineHost,
  local: boolean,
  status: HealthStatus,
  score: number | null,
  reason: HealthReason | null,
  facts: MachineFacts | null,
  latest: HealthPoint | null,
  points: Array<HealthPoint>,
  error: string | null,
  lastOkAt: number | null,
  lastAttemptAt: number | null,
  /**
   * Where pings go, from `ssh -G`. None for this machine or behind a jump host, which aren't pinged.
   */
  pingTarget: string | null,
  /**
   * Tailscale's current path to the machine; None when it isn't on the tailnet or is idle.
   */
  path: NetworkPath | null,
  agents: MachineAgents,
};

export type MachineHealthSnapshot = {
  seq: number,
  now: number,
  intervalMs: number,
  sampledAt: number | null,
  historyMs: number,
  machines: Array<MachineHealth>,
};

export type MachineHost = {
  machine: string,
  endpoint: string,
  port: number,
  enabled: boolean,
  source: string,
};

export type MachineLive = {
  machine: string,
  tokens: [number, number, number, number, number, number, number, number, number, number, number, number],
  requests: number,
};

export type MachinePool = {
  /**
   * Empty for a pool not saved yet; the native side gives it one.
   */
  id: string,
  name: string,
  members: Array<PoolMember>,
  /**
   * The most sessions a member may have working now (the live board's count) and still take a run; None is no limit.
   * A member at any one of the three limits is full.
   */
  maxAgents: number | null,
  /**
   * A member at or past this CPU percent is full; None is no limit.
   */
  cpuCeiling: number | null,
  /**
   * A member with this percent of memory free or less is full; None is no limit.
   */
  memFloor: number | null,
  whenFull: PoolWhenFull,
  /**
   * The pool a run goes to when this one is full and `when_full` is Spill.
   */
  spillPool: string | null,
  /**
   * How long a queued run waits for room before it's dropped.
   */
  queueTimeoutMin: number,
};

export type MachineProjects = {
  machine: string,
  homeDir: string,
  scannedAt: number | null,
  /**
   * The scan ran out of time before it reached every repo.
   */
  partial: boolean,
  /**
   * When the last scan fetched first.
   */
  fetchedAt: number | null,
  measuredAt: number | null,
  scanning: boolean,
  measuring: boolean,
  removing: boolean,
  error: string | null,
  repos: Array<ProjectRepo>,
  /**
   * The places the setup repo wants its projects here, from the same scan.
   */
  places: Array<FoundPlace>,
};

export type MachineSessions = {
  /**
   * Empty for the sessions Arbor can't place on a machine.
   */
  machine: string,
  sessions: number,
  /**
   * Their subagent threads.
   */
  subagents: number,
  /**
   * Those that made a request in the last few minutes.
   */
  running: number,
  requests: number,
  totalTokens: number,
  estimatedCost: number,
  /**
   * Requests with a price. Without any, the cost isn't known.
   */
  pricedRequests: number,
  lastActiveAtMs: number,
  /**
   * The most recently active first, which puts the running ones first.
   * Their peak context and compactions aren't worked out.
   */
  latest: Array<UsageSession>,
};

export type MachineTelemetry = {
  machine: string,
  sinceMs: number,
  lastMs: number | null,
  /**
   * Requests since Arbor started.
   */
  requests: number,
  cumulative: boolean,
  /**
   * The port its homes send to, when that isn't where Arbor listens now.
   */
  stalePort: number | null,
};

export type MachineToolchain = {
  machine: string,
  homeDir: string,
  /**
   * From `uname`, like `Darwin` and `arm64`.
   */
  os: string,
  arch: string,
  scannedAt: number | null,
  /**
   * The scan ran out of time before it reached every repo.
   */
  partial: boolean,
  scanning: boolean,
  error: string | null,
  tools: Array<ToolFound>,
  kept: Array<KeptVersion>,
  projects: Array<ProjectToolchain>,
};

export type MachineUsage = {
  machine: string,
  pool: string,
  requests: number,
  tokens: number,
  success: number,
  failures: number,
  canceled: number,
  lastRequest: string | null,
};

export type ManagementRequest = {
  method: string,
  path: string,
  query?: { [key in string]: string },
  body?: JsonValue,
  timeoutMs?: number,
};

/**
 * What a marketplace offers: its name as the list gives it (what plugins' ids end with), and its plugins.
 */
export type MarketplaceCatalog = {
  /**
   * `owner/repo` on GitHub.
   */
  source: string,
  name: string,
  /**
   * How the marketplace shows its name ("Codex official"), when it gives one.
   */
  displayName: string | null,
  plugins: Array<CatalogPlugin>,
  /**
   * When GitHub was asked, in ms.
   */
  readAtMs: number,
};

export type McpAction = "add" | "update" | "remove";

export type McpChange = {
  /**
   * As the scan names it.
   */
  home: string,
  name: string,
  action: McpAction,
};

/**
 * An MCP config file and the shape it's in.
 */
export type McpFormat = "json" | "toml";

export type McpHealth = {
  home: string,
  checkedAt: number,
  servers: Array<McpServerHealth>,
};

export type McpOutcome = "done" | "failed" | "changed" | "removed";

/**
 * The repo's MCP servers and how every machine's homes stand against them.
 */
export type McpRegistry = {
  /**
   * The commit they're read from, the repo's last. None before anything's committed.
   */
  commit: string | null,
  /**
   * The file is in that commit.
   */
  found: boolean,
  /**
   * The file has changes that aren't committed, which count once they are.
   */
  uncommitted: boolean,
  problems: Array<string>,
  servers: Array<ServerView>,
  cells: Array<RegistryCell>,
};

export type McpResult = {
  home: string,
  name: string,
  action: McpAction,
  outcome: McpOutcome,
  message: string,
  /**
   * The backup a change to another agent's file is kept in, which Sync's undo takes it back from.
   */
  backup?: string,
};

export type McpServerHealth = {
  /**
   * As Claude Code lists it: a plugin's servers go by `plugin:<plugin>:<server>`.
   */
  name: string,
  status: McpStatus,
};

/**
 * How an MCP server answered `claude mcp list`.
 */
export type McpStatus = "connected" | "needsAuth" | "failed" | "pending" | "disabled";

export type McpUsageReport = {
  /**
   * The most used first.
   */
  servers: Array<ExtensionUsage>,
  /**
   * The plugins asked about that were used, the most used first.
   */
  plugins: Array<ExtensionUsage>,
  /**
   * Sessions active in the window whose transcripts have been read for tools.
   */
  counted: number,
  /**
   * Those not read yet.
   */
  pending: number,
};

/**
 * What the repo wants of a server, for every machine or one.
 */
export type McpWanted = "default" | "off" | "removed";

/**
 * The pull requests merged in a window, for the weekly digest.
 */
export type MergedPullRequests = {
  /**
   * The most recently worked on first.
   */
  pullRequests: Array<ProjectPullRequest>,
};

export type ModelOverrideEntry = {
  requestedModel: string,
  upstreamModel: string,
  oauthChannel: string,
  provider: string,
  kind: string,
  forceMapping: boolean,
  longContext: boolean,
};

export type ModelPrice = {
  model: string,
  prompt: number,
  completion: number,
  cache: number,
  cacheRead: number,
  cacheCreation: number,
  promptConfigured: boolean,
  completionConfigured: boolean,
  cacheReadConfigured: boolean,
  cacheCreationConfigured: boolean,
  source: string,
  sourceModelId: string,
  updatedAtMs: number,
};

export type ModelPriceSyncResult = {
  imported: number,
  skipped: number,
  /**
   * Used models priced from models.dev because the catalog doesn't have them.
   */
  filled: Array<string>,
  unmatched: Array<string>,
  usedBuiltin: boolean,
};

export type MonthRow = {
  /**
   * yyyy-mm
   */
  month: string,
  machine: string,
  home: string,
  agent: string,
  model: string,
  calls: number,
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
  reasoning: number,
};

/**
 * A pull request a session named, with what GitHub said about it last.
 */
export type NamedPullRequest = {
  url: string,
  /**
   * None until GitHub has been asked about it.
   */
  github: PullRequestState | null,
};

export type NamedPullRequests = {
  /**
   * In the order they were asked for.
   */
  pullRequests: Array<NamedPullRequest>,
  github: GithubStatus,
};

/**
 * How a project says which version it wants.
 */
export type NeedKind = "range" | "pin" | "min" | "python";

/**
 * How Tailscale reaches a machine: "lan" (directly on the local network),
 * "direct" (directly over the internet) or "relay" (through a relay, with its
 * DERP region when there is one).
 */
export type NetworkPath = {
  kind: string,
  relay: string | null,
};

/**
 * What to do with one of Node's versions on a machine.
 */
export type NodeAction = "install" | "uninstall" | "setDefault";

export type NodeChange = {
  /**
   * nvm, fnm, mise, asdf or volta.
   */
  manager: "nvm" | "fnm" | "mise" | "asdf" | "volta",
  /**
   * For an install, a version like `22` or `22.20.0`; otherwise one the last scan found the manager keeping.
   */
  version: string,
  action: NodeAction,
};

export type NodeResult = {
  manager: "nvm" | "fnm" | "mise" | "asdf" | "volta",
  version: string,
  action: NodeAction,
  ok: boolean,
  /**
   * The last thing the version manager said, when it failed.
   */
  message: string | null,
};

export type OAuthBrowserOption = {
  id: string,
  label: string,
};

export type OAuthStartResult = {
  url: string,
  state: string | null,
  opened: boolean,
  openError: string | null,
};

export type OAuthStatusResult = {
  status: string,
  error: string | null,
};

/**
 * Orca on a machine, once it's been used there.
 */
export type OrcaInstall = {
  version: string | null,
  /**
   * Its app or headless server is running, so a run can be handed to it.
   */
  running: boolean,
  /**
   * The agents it could start here: the ones it knows whose commands are installed.
   */
  agents: Array<string>,
};

/**
 * Where a skill's override is set.
 */
export type OverrideSource = "settings" | "policy";

/**
 * What a `skillOverrides` entry in Claude Code's settings does to a skill.
 */
export type OverrideState = "on" | "nameOnly" | "userInvocableOnly" | "off";

/**
 * A folder with a package.json.
 */
export type PackageDir = {
  dir: string,
  lockfile: string | null,
  /**
   * Whether it (or the top of the checkout) has a `node_modules`; None when it wasn't looked at.
   */
  modules: boolean | null,
};

export type PhoneAlert = {
  title: string,
  body: string,
  /**
   * What raised the alert, such as `machineDown`. Webhooks get it as is.
   */
  kind: string,
  /**
   * A problem that wants attention now, such as a machine going down.
   */
  urgent: boolean,
};

/**
 * Where alerts go, as the window keeps it: the service and the settings that aren't secret.
 * Each send carries it, and the app fills in the secrets from its own file.
 */
export type PhoneAlertRoute = { "service": "ntfy", server: string, topic: string, } | { "service": "pushover" } | { "service": "telegram", chatId: string, } | { "service": "webhook" };

export type PhoneAlertSecret = "ntfyToken" | "pushoverUserKey" | "pushoverAppToken" | "telegramBotToken" | "webhookUrl";

/**
 * Which secrets are saved: all the window ever learns about them.
 */
export type PhoneAlertSecretStatus = {
  ntfyToken: boolean,
  pushoverUserKey: boolean,
  pushoverAppToken: boolean,
  telegramBotToken: boolean,
  webhookUrl: boolean,
};

/**
 * A way to bring a project in line on a machine.
 */
export type PlaceFix = "link" | "clone" | "move" | "fastForward" | "fetch";

/**
 * What's at a place the setup repo wants a project.
 */
export type PlaceKind = "missing" | "broken" | "file" | "empty" | "other" | "checkout";

/**
 * How a project stands at its place on one machine.
 */
export type PlaceState = "inPlace" | "linked" | "elsewhere" | "missing" | "blocked" | "notScanned";

/**
 * A checkout of a project on a machine it isn't assigned to.
 */
export type Placed = {
  machine: string,
  path: string,
};

/**
 * What a change does. An apply makes them in this order.
 */
export type PluginAction = "addMarketplace" | "refresh" | "install" | "update" | "enable" | "disable" | "uninstall" | "removeMarketplace";

/**
 * A change in one Claude Code home, as the page asks for it.
 */
export type PluginChange = {
  /**
   * The home, as the scan names it: ~/.claude.
   */
  home: string,
  action: PluginAction,
  /**
   * A plugin as `name@marketplace`, or a marketplace's name.
   */
  target: string,
  /**
   * Where a marketplace being added comes from: `owner/repo` on GitHub.
   */
  source?: string,
  /**
   * A checkout the last Projects scan found, to turn the plugin on or off in its own local
   * settings (Claude Code's local scope) rather than the home's.
   */
  checkout?: string,
};

export type PluginCost = {
  id: string,
  /**
   * Added to every session in the home while the plugin is on.
   */
  alwaysOn: TokenEstimate | null,
  components: Array<ComponentCost>,
  /**
   * What it brings, as Claude Code counts it: `skills`, `agents`, `hooks`, `mcpServers`, `lspServers`.
   */
  counts: { [key in string]: number },
  /**
   * Why Claude Code couldn't say.
   */
  error: string | null,
};

/**
 * What `claude plugin details` said about each plugin installed in one Claude Code home.
 */
export type PluginCosts = {
  home: string,
  measuredAt: number,
  plugins: Array<PluginCost>,
};

/**
 * A plugin a Claude Code home's settings.json still names in enabledPlugins though it isn't installed there, which
 * Claude Code leaves behind when a plugin goes.
 */
export type PluginLeftover = {
  home: string,
  plugin: string,
};

/**
 * How a change went.
 */
export type PluginOutcome = "done" | "already" | "needsYou" | "failed" | "skipped";

export type PluginResult = {
  home: string,
  action: PluginAction,
  target: string,
  /**
   * The checkout it was made in, for a project's value.
   */
  checkout: string | null,
  outcome: PluginOutcome,
  /**
   * What Claude Code said, without anything like a password in an address.
   */
  message: string,
};

/**
 * How a plugin is wanted on a machine.
 */
export type PluginWanted = "on" | "off" | "own" | "removed";

/**
 * Something the machine's managed-settings policy sets, by name alone: a setting, an env
 * variable's name, a hook event, a plugin or a marketplace, named as a home's items are.
 */
export type PolicyKey = {
  kind: ItemKind,
  name: string,
};

export type PoolMember = {
  /**
   * The machine's name as the Machines page lists it.
   */
  machine: string,
  weight: PoolWeight,
};

export type PoolMemberVerdict = {
  machine: string,
  weight: PoolWeight,
  kind: PoolVerdictKind,
  /**
   * Sessions working on it now, as the live board counts them, runs just sent to it included.
   */
  running: number | null,
  cpu: number | null,
  /**
   * Free memory, percent.
   */
  memFree: number | null,
  readingAgeMs: number | null,
  /**
   * Its chance of taking the next run, 0–1; 0 unless eligible.
   */
  share: number,
};

export type PoolPreview = {
  pool: string,
  /**
   * The member most likely to take the next run; None when nobody can.
   */
  likely: string | null,
  members: Array<PoolMemberVerdict>,
  /**
   * How old a reading may be before it's stale, from how often machines are being sampled now.
   */
  freshForMs: number,
  /**
   * Where the next few runs would most likely go if they all started now, each counting as running for the ones
   * after it; None once no member has room. Shows how a burst spreads and when the pool fills.
   */
  plan: Array<string | null>,
};

/**
 * Connecting to a pool over SSH, for its page.
 */
export type PoolSsh = {
  /**
   * The pool's host name, as `ssh` takes it.
   */
  host: string,
  /**
   * Whether the arbor command ssh runs is installed.
   */
  commandReady: boolean,
  /**
   * The line ~/.ssh/config needs for the pool hosts.
   */
  includeLine: string,
  /**
   * Whether ~/.ssh/config has it.
   */
  included: boolean,
  /**
   * The user its host connects as.
   */
  user: string | null,
  members: Array<PoolSshMember>,
  connections: Array<PoolSshConnection>,
};

/**
 * A host name the pool has been reached under, and the member it's pinned to.
 */
export type PoolSshConnection = {
  name: string,
  machine: string,
  /**
   * Connections open now.
   */
  open: number,
  /**
   * When it was pinned to the member.
   */
  pickedAtMs: number,
};

export type PoolSshMember = {
  machine: string,
  readiness: PoolSshReadiness,
};

/**
 * Whether a member can take a connection through its pool's host.
 */
export type PoolSshReadiness = "ready" | "noAddress" | "noHostKey" | "otherUser" | "thisMac";

/**
 * Why a member could or couldn't take the next run.
 */
export type PoolVerdictKind = "eligible" | "manual" | "notListed" | "off" | "noReading" | "unreachable" | "stale" | "agentsFull" | "cpuHigh" | "memoryLow" | "noHarness";

/**
 * How much of a pool's work a member takes.
 */
export type PoolWeight = "prefer" | "normal" | "less" | "manual";

/**
 * What a run does when no member has room.
 */
export type PoolWhenFull = "refuse" | "queue" | "spill";

export type ProductAnalyticsInput = {
  usage: boolean,
  crashReports: boolean,
};

/**
 * Settings › Software's usage data section.
 */
export type ProductAnalyticsSettings = {
  usage: boolean,
  crashReports: boolean,
  noticeShown: boolean,
  /**
   * `DO_NOT_TRACK` or `ARBOR_TELEMETRY=0` is set, which turns both off whatever the switches say.
   */
  blockedByEnv: boolean,
  /**
   * This build can send at all: an official release, which has the key. A build from source never sends.
   */
  available: boolean,
};

/**
 * What the window can send. A closed list: anything else can't be said.
 */
export type ProductEvent = { "event": "page.viewed", page: string, tab: string | null, } | { "event": "feature.used", feature: Feature, kind: string | null, count: number | null, };

export type ProjectBranch = {
  /**
   * Empty for sessions outside git, or on no branch.
   */
  name: string,
  sessions: number,
  active: number,
  requests: number,
  totalTokens: number,
  estimatedCost: number,
  /**
   * Requests with a price. Without any, the cost isn't known.
   */
  pricedRequests: number,
  linesAdded: number,
  linesRemoved: number,
  /**
   * The sessions whose transcripts count the lines they changed: Claude
   * Code's do, Codex's don't.
   */
  sessionsWithLines: number,
  lastActiveAtMs: number,
};

/**
 * A project on one machine.
 */
export type ProjectCell = {
  machine: string,
  /**
   * Where the repo wants it, `~/…` or absolute.
   */
  path: string,
  state: PlaceState,
  /**
   * For Blocked, what's there, and when it's another repo's checkout, that repo.
   */
  blocker: PlaceKind | null,
  blockerRemote: string | null,
  /**
   * Where the place leads, for Linked.
   */
  link: string | null,
  /**
   * The checkout that counts: the place's folder, or the one a link would lead to.
   */
  checkout: string | null,
  /**
   * How that checkout stands.
   */
  status: CheckoutStatus | null,
  /**
   * Its other checkouts on the machine, which are never moved or counted.
   */
  others: Array<string>,
  /**
   * Of the project's own skills, the copies its checkouts and worktrees here should have, and how many of them
   * are missing or out of date. A folder left alone as the project's own counts as in step.
   */
  skillsTotal: number,
  skillsOut: number,
};

/**
 * A project and where it stands on each machine it's on.
 */
export type ProjectDrift = {
  project: string,
  local: boolean,
  archived: boolean,
  remote: string | null,
  branch: string | null,
  cells: Array<ProjectCell>,
  /**
   * Machines it lists that Arbor doesn't watch.
   */
  unknown: Array<string>,
  /**
   * Checkouts on machines it doesn't list.
   */
  unassigned: Array<Placed>,
};

export type ProjectFile = {
  name: string,
  sum: string,
  size: number,
};

export type ProjectFixRequest = {
  project: string,
  fix: PlaceFix,
};

export type ProjectFixResult = {
  project: string,
  fix: PlaceFix,
  outcome: FixOutcome,
  /**
   * Why, for one skipped or failed.
   */
  detail: string | null,
};

export type ProjectFixes = {
  /**
   * The backups the changes went into, oldest first, which Repo › History undoes.
   */
  backups: Array<string>,
  results: Array<ProjectFixResult>,
};

/**
 * A dependency in one of a project's package.json files.
 */
export type ProjectLibrary = {
  /**
   * The folder the package.json is in, from the top of the checkout; empty for the top.
   */
  dir: string,
  name: string,
  wants: string,
  dev: boolean,
  /**
   * The version in `node_modules`; None when it isn't installed or wasn't looked up.
   */
  installed: string | null,
  /**
   * Whether the packages script looked it up, so None means it isn't installed.
   */
  checked: boolean,
};

/**
 * A project's values on one machine, or on each machine of a role.
 */
export type ProjectOnMachine = {
  path: string | null,
  skills: { [key in string]: PluginWanted },
  plugins: { [key in string]: PluginWanted },
  mcp: { [key in string]: PluginWanted },
};

export type ProjectPullRequest = {
  repository: string,
  number: number,
  url: string,
  /**
   * The project of the last session that named it.
   */
  project: string,
  /**
   * The branch it came from: GitHub's word for it, else the branch that
   * session was on.
   */
  branch: string,
  /**
   * The sessions behind it. Each counts once however many pull requests it
   * worked on; its cost and lines are shared out between them.
   */
  sessions: number,
  estimatedCost: number,
  /**
   * Its sessions' requests with a price, each session's counted in full
   * like `sessions`. Without any, the cost isn't known.
   */
  pricedRequests: number,
  linesAdded: number,
  linesRemoved: number,
  lastActiveAtMs: number,
  /**
   * What GitHub said about it last. None until it's been asked.
   */
  github: PullRequestState | null,
};

export type ProjectRepo = {
  /**
   * The main checkout, or a bare repo.
   */
  path: string,
  state: RepoState,
  bare: boolean,
  /**
   * `host/owner/name`, without credentials.
   */
  remote: string | null,
  /**
   * The branch merges are checked against, like `origin/main`.
   */
  defaultBranch: string | null,
  fetchedAt: number | null,
  /**
   * The fetch Arbor asked for didn't work.
   */
  fetchFailed: boolean,
  lastUsedMs: number | null,
  worktrees: Array<ProjectWorktree>,
  files: Array<ProjectFile>,
};

/**
 * A skill only one project's checkouts get, with the fingerprint a scan finds for a copy of it.
 */
export type ProjectSkill = {
  name: string,
  /**
   * With SHA-256 and with `cksum`; None when Arbor can't copy it, and then `problem` says why.
   */
  sum: string | null,
  ck: string | null,
  problem: string | null,
};

/**
 * How bringing a project's skills in line on a machine went.
 */
export type ProjectSkillsOutcome = {
  /**
   * The backup the changes went into, which Repo › History undoes.
   */
  backup: string | null,
  /**
   * Skill folders written or brought up to date, and taken out.
   */
  written: number,
  removed: number,
  /**
   * Folders left alone, each `path: why`.
   */
  skipped: Array<string>,
  failed: Array<string>,
};

/**
 * What one repo on the machine asks for.
 */
export type ProjectToolchain = {
  /**
   * The main checkout.
   */
  path: string,
  /**
   * The folder isn't there any more.
   */
  missing: boolean,
  remote: string | null,
  lastUsedMs: number | null,
  needs: Array<ToolNeed>,
  libraries: Array<ProjectLibrary>,
  /**
   * Dependencies past the ones kept.
   */
  librariesMore: number,
  packages: Array<PackageDir>,
  /**
   * Files Arbor found but couldn't read: too big, or not what their name says.
   */
  unread: Array<string>,
};

/**
 * What a set of sessions adds up to.
 */
export type ProjectTotals = {
  sessions: number,
  active: number,
  requests: number,
  totalTokens: number,
  estimatedCost: number,
  /**
   * Requests with a price. Without any, the cost isn't known.
   */
  pricedRequests: number,
  linesAdded: number,
  linesRemoved: number,
  /**
   * The sessions whose transcripts count the lines they changed: Claude
   * Code's do, Codex's don't.
   */
  sessionsWithLines: number,
  lastActiveAtMs: number,
};

export type ProjectWorktree = {
  path: string,
  main: boolean,
  head: string | null,
  /**
   * None when it's detached.
   */
  branch: string | null,
  locked: boolean,
  prunable: boolean,
  /**
   * Changed tracked files, and untracked ones; None when `git status` failed.
   */
  changed: number | null,
  untracked: number | null,
  upstream: string | null,
  ahead: number | null,
  behind: number | null,
  /**
   * Its upstream branch was deleted, as a merged pull request's usually is.
   */
  gone: boolean,
  /**
   * Its commit is in the default branch.
   */
  merged: boolean,
  committedAt: number | null,
  /**
   * When git last wrote its index or HEAD.
   */
  touchedAt: number | null,
  /**
   * Something on the machine is running in it.
   */
  open: boolean,
  /**
   * Files git is told not to check for changes.
   */
  hidden: number,
  /**
   * Another git checkout is inside its folder.
   */
  nested: boolean,
  /**
   * A rebase, merge, cherry-pick, revert or bisect is under way.
   */
  midway: boolean,
  /**
   * Commits only its own history of HEAD holds.
   */
  unreachable: number,
  /**
   * The last request of a session that ran in it.
   */
  lastUsedMs: number | null,
  /**
   * Ignored files and folders, which go with it: names only.
   */
  ignored: Array<string>,
  ignoredMore: number,
  sizeKb: number | null,
  blocker: Blocker | null,
  /**
   * Plugins its own Claude Code settings turn on or off: .claude/settings.local.json (local,
   * git-ignored, where Arbor sets a project's value) and .claude/settings.json (checked in).
   */
  plugins: Array<CheckoutPlugin>,
  /**
   * Skills those files' skillOverrides turn on or off, or change how they're offered.
   */
  skills: Array<CheckoutSkill>,
  /**
   * Those files whose skillOverrides Claude Code ignores altogether, as one of the values isn't
   * one it knows: `settings.local.json` or `settings.json`.
   */
  ignoredOverrides: Array<string>,
  /**
   * It has no settings.local.json, and Git wouldn't ignore a new one, so Arbor won't create it.
   */
  localSeen: boolean,
  /**
   * MCP servers those files deny by name, which nothing turns back on.
   */
  mcpDenied: Array<CheckoutMcpDeny>,
  /**
   * From the machine's ~/.claude.json, by name only: servers set up for this checkout alone
   * (Claude Code's local scope), and servers turned off here with /mcp.
   */
  mcpLocal: Array<string>,
  mcpDisabled: Array<string>,
  /**
   * The project instruction files Arbor writes in it, as the scan found them.
   */
  instructions: Array<CheckoutInstructions>,
  /**
   * Its AGENTS.md's fingerprint, as cksum gives it, when it has one.
   */
  agentsMd: string | null,
  /**
   * It has a CLAUDE.md or .claude/CLAUDE.md, so Claude Code reads that rather than AGENTS.md.
   */
  claudeMd: boolean,
};

/**
 * Every project's places against what the machines' last scans found.
 */
export type ProjectsDrift = {
  projects: Array<ProjectDrift>,
  unlisted: Array<UnlistedCheckout>,
  machines: Array<DriftMachine>,
};

export type ProxyChecks = {
  /**
   * Whether the core answered. A stopped core isn't checked: its own status says so.
   */
  checked: boolean,
  problems: Array<ProxyProblem>,
};

export type ProxyProblem = {
  kind: ProxyProblemKind,
  /**
   * The management API's HTTP status, the address the proxy listens on, or the line of config.yaml the core
   * couldn't read.
   */
  detail: string | null,
};

export type ProxyProblemKind = "managementRefused" | "usageOff" | "noClientKeys" | "defaultClientKey" | "settingsNotLoaded" | "openToNetwork";

/**
 * The checks on a pull request's latest commit: check runs and commit
 * statuses together.
 */
export type PullRequestChecks = {
  /**
   * GitHub's word for them all: "success", "failure", "error", "pending"
   * or "expected". Empty when it gave none.
   */
  rollup: "" | "success" | "failure" | "error" | "pending" | "expected",
  passed: number,
  /**
   * Failed, errored, timed out or canceled.
   */
  failed: number,
  /**
   * Queued, running, or waiting for someone.
   */
  pending: number,
  /**
   * All of them, skipped and neutral ones too. 0 when GitHub didn't count them.
   */
  total: number,
};

/**
 * A pull request a Claude Code session opened or worked on.
 */
export type PullRequestLink = {
  number: number,
  url: string,
  /**
   * "owner/name".
   */
  repository: string,
};

/**
 * What GitHub last said about a pull request.
 */
export type PullRequestState = {
  /**
   * "open", "merged" or "closed". Empty when GitHub couldn't find it.
   */
  state: "" | "open" | "merged" | "closed",
  draft: boolean,
  title: string,
  baseBranch: string,
  mergedAtMs: number | null,
  closedAtMs: number | null,
  /**
   * "mergeable" or "conflicting". Empty while GitHub is still working it
   * out, and when it didn't say.
   */
  mergeable: "" | "mergeable" | "conflicting",
  /**
   * "approved", "changesRequested" or "reviewRequired". Empty when there's
   * no verdict and none is required. An approval counts even when the
   * branch's rules don't.
   */
  review: "" | "approved" | "changesRequested" | "reviewRequired",
  /**
   * The checks on its latest commit. None without any, or when GitHub didn't say.
   */
  checks: PullRequestChecks | null,
  checkedAtMs: number,
};

/**
 * How a database was opened: read-only beside T3 Code's writer, or as it lies on disk, which is only done while T3 Code
 * is down and kept only when nothing touched the files during the read.
 */
export type ReadMode = "readonly" | "immutable";

export type RecoveredDay = {
  /**
   * yyyy-mm-dd
   */
  day: string,
  machine: string,
  /**
   * Every token Claude Code counted that day, of every kind; 0 when it kept only how many sessions there were.
   */
  tokens: number,
  sessions: number,
};

/**
 * Both counts, added up over the days a machine has both, to show how far apart they run.
 */
export type RecoveredOverlap = {
  claudeCode: number,
  transcripts: number,
};

/**
 * Why Arbor won't change a home's server.
 */
export type RegistryBlock = "name" | "broken";

export type RegistryCell = {
  machine: string,
  /**
   * As the scan names it.
   */
  home: string,
  name: string,
  state: RegistryState,
  /**
   * The repo has a definition of its own for this machine.
   */
  own: boolean,
  /**
   * Why Arbor won't change it, when it won't.
   */
  blocked: RegistryBlock | null,
};

/**
 * How a home's server stands against the repo.
 */
export type RegistryState = "same" | "add" | "update" | "extra";

/**
 * What one release changed, as plain text: from the signed update list for Arbor, from GitHub's releases feed for
 * the core.
 */
export type ReleaseNotes = {
  version: string,
  summary?: string,
  changes: Array<string>,
};

export type RemovalOutcome = "removed" | "gone" | "changed" | "busy" | "skipped" | "failed";

export type RemovalResult = {
  path: string,
  outcome: RemovalOutcome,
  branch: BranchOutcome | null,
  message: string,
};

/**
 * A file's two copies; a missing side hasn't the file, or isn't shown when there's a problem.
 */
export type RepoChange = {
  path: string,
  status: RepoStatus,
  before: string | null,
  after: string | null,
  problem: RepoFileProblem | null,
};

export type RepoCommit = {
  sha: string,
  subject: string,
  atMs: number,
};

/**
 * A file in the setup repo's folder, as the browser lists it.
 */
export type RepoEntry = {
  /**
   * Within the folder: .claude/CLAUDE.md.
   */
  path: string,
  role: RepoRole,
  status: RepoStatus,
  /**
   * The folder's copy's size, or the last commit's for a file that's gone.
   */
  size: number,
  /**
   * Why Arbor won't open it, when it won't.
   */
  problem: RepoFileProblem | null,
};

/**
 * Why Arbor doesn't show a file's text: its name says it may hold a secret, it's over 1 MB, it isn't text, or it's a
 * link or a submodule.
 */
export type RepoFileProblem = "secret" | "large" | "binary" | "link";

/**
 * A project's instructions in the repo: for every machine, or for one.
 */
export type RepoInstructions = {
  /**
   * Lowercase `owner/name`.
   */
  project: string,
  /**
   * The machine's normalized name, or None for every machine.
   */
  machine: string | null,
  /**
   * The text's fingerprint, as Arbor's files name it.
   */
  hash: string,
  size: number,
};

/**
 * A machine as its file in the repo describes it.
 */
export type RepoMachine = {
  /**
   * Its normalized name, from the file's name.
   */
  key: string,
  /**
   * The file, from the repo's root.
   */
  file: string,
  archived: boolean,
  /**
   * How the file names it; the file's name when it doesn't.
   */
  name: string,
  /**
   * The SSH host the file gives. Arbor connects with its own list; this only offers a missing one.
   */
  host: string | null,
  role: string | null,
  /**
   * Where its projects go, `~/…` or absolute.
   */
  codeRoot: string,
  skills: { [key in string]: SkillWanted },
  plugins: { [key in string]: PluginWanted },
  /**
   * Kept for the MCP registry; on or off.
   */
  mcp: { [key in string]: PluginWanted },
};

/**
 * A plugin the repo lists.
 */
export type RepoPlugin = {
  /**
   * `name@marketplace`, as Claude Code names it.
   */
  id: string,
  /**
   * Its marketplace's GitHub repository, when the file gives one.
   */
  source: string | null,
  /**
   * The All machines value: on or off.
   */
  all: PluginWanted,
  /**
   * Machines with a value of their own, by normalized name.
   */
  machines: { [key in string]: PluginWanted },
  /**
   * Projects with a value of their own, by lowercase `owner/name`: applied to each of the
   * project's checkouts in Claude Code's local scope, which wins over the machine's.
   */
  projects: { [key in string]: RepoProjectValue },
};

/**
 * A project as its folder in the repo describes it.
 */
export type RepoProject = {
  /**
   * Lowercase `owner/name`, or `_local/<name>` for one with no remote.
   */
  key: string,
  /**
   * Its folder, from the repo's root.
   */
  folder: string,
  archived: boolean,
  local: boolean,
  /**
   * As the file writes it, which is what a clone uses.
   */
  remote: string | null,
  path: string | null,
  /**
   * None for the remote's default.
   */
  branch: string | null,
  machines: Assignment,
  /**
   * On or off in every checkout.
   */
  skills: { [key in string]: PluginWanted },
  plugins: { [key in string]: PluginWanted },
  mcp: { [key in string]: PluginWanted },
  /**
   * The skills only its checkouts get, from its skills folder.
   */
  ownSkills: Array<ProjectSkill>,
};

/**
 * A project's value for a plugin or a skill: on every machine, and on one (by normalized name), which wins.
 * Only on or off; a project without one follows its machine.
 */
export type RepoProjectValue = {
  all: PluginWanted | null,
  machines: { [key in string]: PluginWanted },
};

/**
 * What a file in the repo is to Arbor.
 */
export type RepoRole = "instructions" | "rule" | "subagent" | "command" | "hookScript" | "skill" | "projectInstructions" | "record" | "other";

export type RepoState = "ok" | "missing" | "notGit";

/**
 * How a file in the folder stands against the last commit.
 */
export type RepoStatus = "same" | "modified" | "added" | "deleted";

/**
 * A file's text, with its SHA-256 to save against; neither when there's no file there or Arbor doesn't show it.
 */
export type RepoText = {
  content: string | null,
  sum: string | null,
  problem: RepoFileProblem | null,
};

/**
 * Every file in the setup repo's folder, committed or not.
 */
export type RepoTree = {
  entries: Array<RepoEntry>,
  /**
   * More files than the browser lists.
   */
  truncated: boolean,
};

export type RepoUpstream = {
  name: string,
  /**
   * Commits here that the upstream hasn't got, and the other way round, as of the last fetch.
   */
  ahead: number,
  behind: number,
};

/**
 * One settings file the reporter is set up in, or taken out of.
 */
export type ReporterFile = {
  agent: AgentKind,
  /**
   * The agent home, with the machine's home as ~.
   */
  home: string,
  /**
   * The settings file, with the machine's home as ~.
   */
  path: string,
  change: FileChange,
  /**
   * Codex's `notify` was already set: the reporter runs it after itself.
   */
  chained: boolean,
  /**
   * Whether the change was made; false for a plan.
   */
  written: boolean,
  /**
   * Why it couldn't be made.
   */
  error: string | null,
};

export type ReporterHome = {
  agent: AgentKind,
  /**
   * With the machine's home as ~.
   */
  home: string,
  reporting: boolean,
};

/**
 * What setting the reporter up or taking it away changes, or changed.
 */
export type ReporterSetup = {
  files: Array<ReporterFile>,
  /**
   * Whether the reporter script itself was put there or taken away.
   */
  reporterChanged: boolean,
};

/**
 * The reporter on a machine, as the agents check last found it.
 */
export type ReporterStatus = {
  /**
   * The reporter script is there.
   */
  installed: boolean,
  /**
   * Each agent home found, and whether its settings run the reporter.
   */
  homes: Array<ReporterHome>,
};

export type RestoreFailure = {
  path: string,
  problem: RestoreProblem,
};

/**
 * Why something set aside couldn't go back.
 */
export type RestoreProblem = "taken" | "changed" | "gone" | "failed";

/**
 * What the harness gave back, to find the run in it later.
 */
export type RunHandle = {
  environmentId?: string,
  projectId?: string,
  threadId?: string,
  /**
   * Orca's terminal handle.
   */
  terminal?: string,
  pid?: number,
  /**
   * The session id given to a Claude Code run on the command line, which Sessions finds it by.
   */
  sessionId?: string,
  /**
   * Where a run on the command line leaves what the agent printed, on its machine, from `~/`.
   */
  log?: string,
  /**
   * The branch and folder name of the run's own worktree, when it was given one.
   */
  worktree?: string,
};

/**
 * What runs the agent.
 */
export type RunHarness = "t3" | "orca" | "headless";

/**
 * Why a run didn't start, or stopped.
 */
export type RunReason = "noPool" | "noRoom" | "noHarness" | "noFolder" | "noModel" | "handOffFailed" | "arborRestarted" | "canceled" | "agentFailed";

/**
 * What to start. The prompt is used to hand the run over and then dropped.
 */
export type RunRequest = {
  pool: string,
  harness: RunHarness,
  /**
   * T3 Code's setup id ("codex_work"), Orca's agent id ("codex"), or for the command line
   * "claude" or "codex".
   */
  setup: string,
  /**
   * Where on the machine the agent works, from `~/` or `/`. Left empty when the run names a repo.
   */
  folder: string,
  /**
   * The repository to work in, as `host/owner/name`: each member's own checkout of it, from its last Projects scan,
   * so the folder can differ from machine to machine. Members without one are left out.
   */
  repo?: string,
  /**
   * Work in a new worktree off the repo's default branch rather than in the checkout itself, so two runs on one
   * machine never edit the same files.
   */
  worktree: boolean,
  prompt: string,
  model?: string,
  /**
   * Start it on the command line when a member has room but not the harness.
   */
  fallback: boolean,
  /**
   * What the harness calls it; named from where it works when left out, never from the prompt.
   */
  title?: string,
  /**
   * The trigger that started it.
   */
  trigger?: string,
};

export type RunState = "queued" | "starting" | "handedOff" | "running" | "exited" | "failed" | "refused" | "timedOut";

/**
 * One saved setting changed; `value` is none when it was removed.
 */
export type SavedStoreChange = {
  name: string,
  value: string | null,
};

/**
 * Everything saved, for the window to read before it draws.
 */
export type SavedStoreSnapshot = {
  values: { [key in string]: string },
  migrated: boolean,
};

/**
 * A schedule as words are made from it. `Custom` is a rule none of these describe; `Elsewhere` is a schedule the
 * owning app keeps where Arbor can't read it.
 */
export type ScheduleSummary = { "kind": "everyMinutes", minutes: number, } | { "kind": "everyHours", hours: number, minute: number, } | { "kind": "daily", hour: number, minute: number, } | { "kind": "weekdays", hour: number, minute: number, } | { "kind": "weekly", days: Array<number>, hour: number, minute: number, } | { "kind": "custom" } | { "kind": "manual" } | { "kind": "elsewhere" };

export type ServerView = {
  name: string,
  claude: DefinitionView | null,
  codex: DefinitionView | null,
  /**
   * The homes it's kept to.
   */
  homes: Array<string> | null,
  /**
   * The other agents it goes to.
   */
  agents: Array<Harness>,
  /**
   * Machines with their own definition, and machines it's kept off.
   */
  own: Array<string>,
  off: Array<string>,
  /**
   * Turned off on every machine, its definitions kept: only a machine with its own gets it.
   */
  allOff: boolean,
  problems: Array<string>,
};

/**
 * How many sessions each choice in the filter menus would show. Each menu
 * counts the sessions matching every other filter.
 */
export type SessionFacets = {
  /**
   * Most sessions first, like the other menus.
   */
  projects: Array<FacetCount>,
  /**
   * The chosen project's branches; none until a project is chosen.
   */
  branches: Array<FacetCount>,
  /**
   * Clients as the list names them without their version, like "Claude Code" or "Codex CLI · AcmeDesk".
   */
  clients: Array<FacetCount>,
  /**
   * Where sessions ran: their key's machine, else the one their transcript is on.
   */
  machines: Array<FacetCount>,
  withPullRequests: number,
  withoutPullRequests: number,
};

export type SessionProject = {
  /**
   * As the Sessions page names it.
   */
  name: string,
  /**
   * "owner/name", when its sessions' remote or pull requests say.
   */
  repository: string | null,
  branches: Array<ProjectBranch>,
  sessions: number,
  active: number,
  requests: number,
  totalTokens: number,
  estimatedCost: number,
  /**
   * Requests with a price. Without any, the cost isn't known.
   */
  pricedRequests: number,
  linesAdded: number,
  linesRemoved: number,
  /**
   * The sessions whose transcripts count the lines they changed: Claude
   * Code's do, Codex's don't.
   */
  sessionsWithLines: number,
  lastActiveAtMs: number,
};

export type SessionProjectsReport = {
  /**
   * The costliest first.
   */
  projects: Array<SessionProject>,
  /**
   * The most recently worked on first.
   */
  pullRequests: Array<ProjectPullRequest>,
  /**
   * Sessions without a project: no transcript says where they ran.
   */
  unplaced: ProjectTotals,
  github: GithubStatus,
  facets?: SessionFacets,
};

/**
 * One request of a session, as `get_usage_session_timeline` returns it.
 */
export type SessionRequest = {
  timestampMs: number,
  /**
   * The session id the request was made in: the session's own, or a subagent's.
   */
  threadId: string,
  model: string,
  reasoningEffort: string,
  /**
   * The tier the request was billed at.
   */
  serviceTier: string,
  latencyMs: number,
  ttftMs: number | null,
  failed: boolean,
  canceled: boolean,
  failureStatus: number,
  /**
   * The start of a failed request's response.
   */
  failure: string,
  /**
   * The request's context: cached tokens are counted in it.
   */
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  /**
   * None when neither the model nor its alias has a price.
   */
  cost: CostParts | null,
  /**
   * Billed at long-context rates.
   */
  longContext: boolean,
  /**
   * Where the request sits in its thread's conversation. None when it
   * carried no context, like a request that failed before it started.
   */
  step: ContextStep | null,
};

/**
 * One session's start.
 */
export type SessionStart = {
  sessionId: string,
  machine: string,
  /**
   * "claude" or "codex", as the transcript scan stored it.
   */
  agent: "claude" | "codex",
  /**
   * The agent home, with the machine's home as ~, as Setup writes it.
   */
  home: string,
  /**
   * The repository it ran in, or empty outside one.
   */
  repo: string,
  model: string,
  tokens: number,
  atMs: number,
};

/**
 * Where a session ran and what it was called, as the Sessions page shows it.
 */
export type SessionTranscript = {
  /**
   * The machine its transcript is on, as the Machines page names it.
   */
  machine: string,
  agent: string,
  /**
   * That machine's home directory, so the page can shorten paths under it.
   */
  home: string,
  /**
   * The agent home the transcript is in, under ~ as Setup writes homes: `~/.claude`, or another home on the machine's agent homes list.
   * Empty until a scan has said.
   */
  agentHome: string,
  /**
   * The folder the session was last working in.
   */
  cwd: string,
  /**
   * The top of the git checkout the folder is in. Empty outside git or when unknown.
   */
  repoRoot: string,
  /**
   * The main checkout, which differs from `repo_root` in a linked worktree.
   */
  mainRepo: string,
  branch: string,
  commitHash: string,
  repositoryUrl: string,
  title: string,
  /**
   * "custom" when the user named the session, "ai" when Claude Code did, "codex" for a Codex thread name.
   */
  titleSource: "" | "custom" | "ai" | "codex",
  pullRequests: Array<PullRequestLink>,
  linesAdded: number | null,
  linesRemoved: number | null,
  compactions: Array<TranscriptCompaction>,
  /**
   * None until the transcript has been read since Arbor began counting tool calls.
   */
  toolUsage: ToolUsage | null,
  /**
   * When the transcript was last read.
   */
  readAtMs: number,
};

/**
 * Something set aside on the machine, waiting to be put back or deleted for good.
 */
export type SetAsideItem = {
  /**
   * The removal it was part of.
   */
  stamp: string,
  item: number,
  group: CleanupGroup,
  /**
   * Where it was, and goes back to.
   */
  path: string,
  atMs: number,
  sizeKb: number | null,
  /**
   * The top of the drive it's kept on (from ~ when it's in the home folder), when that isn't the home folder's.
   */
  volume: string | null,
  /**
   * Something is at its place now, so it can't go back.
   */
  taken: boolean,
};

/**
 * One thing set aside.
 */
export type SetAsideRef = {
  stamp: string,
  item: number,
};

/**
 * One Claude Code home's settings.json, as another change to the settings left it.
 */
export type SettingsEdit = {
  /**
   * The agent home, with the machine's home as ~.
   */
  home: string,
  /**
   * The settings file, with the machine's home as ~.
   */
  path: string,
  change: FileChange,
  written: boolean,
  error: string | null,
};

export type SettingsInEffect = {
  state: InEffect,
  /**
   * What the core still runs differently, when it hasn't loaded the file.
   */
  settings: Array<LiveCoreSetting>,
  /**
   * The line of config.yaml the core said it couldn't read.
   */
  line: number | null,
};

/**
 * A change Arbor made on a machine, from the backup it made first.
 */
export type SetupBackup = {
  id: string,
  atMs: number,
  /**
   * What made it.
   */
  what: ChangeKind,
  /**
   * The repo's commit it came from.
   */
  commit: string | null,
  undoneAtMs: number | null,
  /**
   * For a clean-up, when the last of what it set aside was deleted for good, which leaves nothing to undo.
   */
  deletedAtMs?: number,
  /**
   * Files, and skills' folders in the store.
   */
  files: Array<BackupFile>,
  /**
   * What a change to skills did in each home.
   */
  skills: Array<BackupSkill>,
};

/**
 * An agent home, or the machine's shared ~/.agents, and what's in it.
 */
export type SetupHome = {
  agent: HomeAgent,
  /**
   * With the machine's home as ~.
   */
  path: string,
  items: Array<SetupItem>,
  /**
   * Files in it Arbor couldn't read.
   */
  problems: Array<string>,
  /**
   * Where its skills folder leads, when that's a link: every skill in it is then that folder's.
   */
  skillsLink: string | null,
  /**
   * Skills Claude Code's settings turn off or change for this home, by name.
   */
  skillOverrides: Array<SkillOverride>,
  /**
   * Settings files whose `skillOverrides` Claude Code ignores altogether, because one of its
   * values isn't one it knows.
   */
  ignoredOverrides: Array<string>,
  /**
   * MCP servers its settings.json, or the machine's policy, deny by name: nothing turns them on
   * in a project.
   */
  deniedMcp: Array<string>,
  /**
   * The Codex home this one's entries lead into, for a shadow home. What they hold is left to
   * that home, so the two aren't read as separate homes that drift apart.
   */
  shares: SharedHome | null,
};

/**
 * A Claude Code or Codex on the machine's PATH. The first of each agent is the one that runs.
 */
export type SetupInstall = {
  agent: AgentKind,
  /**
   * With the machine's home as ~.
   */
  path: string,
  /**
   * The file `path` leads to, when that's somewhere else.
   */
  real: string | null,
  /**
   * From `--version`; None when it printed nothing that reads as one.
   */
  version: string | null,
};

export type SetupInventory = {
  machines: Array<SetupMachine>,
};

/**
 * One thing an agent home loads.
 */
export type SetupItem = {
  kind: ItemKind,
  name: string,
  /**
   * The file or folder, with the machine's home as ~. None for something in a settings file.
   */
  path: string | null,
  /**
   * A fingerprint of what it holds. None when it's missing: an @import that leads nowhere, or a
   * link to nothing.
   */
  sum: string | null,
  /**
   * A file's size in bytes.
   */
  size: number | null,
  /**
   * Where a link leads, with the machine's home as ~.
   */
  link: string | null,
  /**
   * What it's set to, where that's safe to show: a setting's value, a plugin's version, an MCP
   * server's transport.
   */
  value: string | null,
  /**
   * A second fact: the host or program of an MCP server, the source of a marketplace.
   */
  note: string | null,
  /**
   * How many it holds: handlers for a hook, entries in a list setting.
   */
  count: number | null,
  /**
   * Whether it's switched on, for plugins; false for an AGENTS.md an override replaces.
   */
  enabled: boolean | null,
  /**
   * Can be shown and compared line by line.
   */
  text: boolean,
  /**
   * None for a skill that's a link to nothing.
   */
  skill: SkillFacts | null,
  import: ImportFacts | null,
};

/**
 * The repo's machines and projects, as its last commit has them.
 */
export type SetupLayers = {
  machines: Array<RepoMachine>,
  projects: Array<RepoProject>,
  problems: Array<LayerProblem>,
};

export type SetupMachine = {
  machine: string,
  local: boolean,
  /**
   * Answering its health samples. Always true for this machine.
   */
  reachable: boolean,
  homes: Array<SetupHome>,
  /**
   * The other harnesses' homes, read for their own instructions, skills, MCP servers and hooks.
   */
  harnessHomes: Array<HarnessHome>,
  installs: Array<SetupInstall>,
  harnessInstalls: Array<HarnessInstall>,
  /**
   * Claude Code's managed-settings policy, when the machine has one.
   */
  policy: ClaudePolicy | null,
  scannedAt: number | null,
  error: string | null,
  scanning: boolean,
};

export type SetupRepo = {
  /**
   * The folder, as it was chosen.
   */
  path: string,
  /**
   * None when no branch is checked out.
   */
  branch: string | null,
  /**
   * None until something is committed.
   */
  head: RepoCommit | null,
  upstream: RepoUpstream | null,
  /**
   * Files it syncs that have changes not committed, which aren't synced until they are.
   */
  uncommitted: Array<string>,
  files: Array<SetupRepoFile>,
  /**
   * The skills it syncs into each machine's store, ~/.agents/skills.
   */
  skills: Array<SetupRepoSkill>,
  /**
   * Other files under .claude, .codex or .agents, which it doesn't sync.
   */
  ignored: Array<string>,
  /**
   * Machines with a value of their own for a skill, from .agents/machines.json: skill → normalized machine → value.
   */
  skillMachines: { [key in string]: { [key in string]: SkillWanted } },
  /**
   * Skills the repo has taken off every machine (.agents/machines.json), which each machine's store has no more
   * business keeping. A skill back in the repo isn't listed.
   */
  removedSkills: Array<string>,
  /**
   * Rules, subagents and commands the repo has taken off every machine, as the scan names them. A file back in the
   * repo isn't listed.
   */
  removedFiles: Array<string>,
  /**
   * Skills the repo keeps but has turned off on every machine (.agents/machines.json), so each machine's store copy
   * is the repo's to take out until they're turned on again.
   */
  offSkills: Array<string>,
  /**
   * Rules, subagents and commands the repo keeps but has turned off on every machine, as the scan names them.
   */
  offFiles: Array<string>,
  /**
   * Machines with a value of their own for a rule, subagent or command, from .agents/machines.json: path as the scan
   * names it → normalized machine → value.
   */
  fileMachines: { [key in string]: { [key in string]: SkillWanted } },
  /**
   * Projects with a value of their own for a skill, from .agents/machines.json: skill → project → value.
   */
  skillProjects: { [key in string]: { [key in string]: RepoProjectValue } },
  /**
   * Projects with a value of their own for an MCP server, from .agents/machines.json: server → project → value.
   */
  mcpProjects: { [key in string]: { [key in string]: RepoProjectValue } },
  /**
   * The plugins .agents/plugins.json lists, with each one's value for every machine and the machines' own.
   */
  plugins: Array<RepoPlugin>,
  /**
   * The Codex plugins .agents/plugins.json lists under `codex`, with each one's value for every machine and the
   * machines' own. Codex's plugins and marketplaces aren't Claude Code's, so they're never compared.
   */
  codexPlugins: Array<RepoPlugin>,
  /**
   * Projects' own instructions, for every machine and for one, from each project's folder (or .agents/projects).
   */
  instructions: Array<RepoInstructions>,
  /**
   * Its machine and project files. Their values are in the maps above already.
   */
  layers: SetupLayers,
};

/**
 * A file the repo syncs, as its last commit has it.
 */
export type SetupRepoFile = {
  /**
   * Where it goes, as the scan names it: ~/.claude/CLAUDE.md.
   */
  path: string,
  kind: SyncFileKind,
  /**
   * Its SHA-256, and its checksum for machines that fingerprint with `cksum`.
   */
  sum: string,
  ck: string,
  size: number,
};

/**
 * A skill the repo syncs into each machine's store, as its last commit has it.
 */
export type SetupRepoSkill = {
  name: string,
  /**
   * Where it goes, as a machine's scan names it: ~/.agents/skills/pdf.
   */
  path: string,
  /**
   * Its fingerprint as a machine's scan gives it, and as a machine without a SHA-256 tool does.
   * None when it can't be synced.
   */
  sum: string | null,
  ck: string | null,
  files: number,
  size: number,
  /**
   * Why it can't be synced: `link` (a link or submodule in it), `name` (a file name the
   * machines' tools would print differently), `secret` (a file whose name says it may hold one),
   * `large` (a file over 1 MB, or over 4 MB or 400 files in all) or `noDoc` (no SKILL.md). The
   * same words a machine sends back when it refuses a skill, so they stay text.
   */
  problem: "link" | "name" | "secret" | "large" | "noDoc" | null,
  /**
   * Where it came from, from .agents/skill-sources.json.
   */
  source: SkillSource | null,
};

export type SetupSkillFile = {
  /**
   * Within the skill's folder.
   */
  path: string,
  sum: string,
  size: number,
  /**
   * None when it isn't shown.
   */
  content: string | null,
  /**
   * Why it isn't shown.
   */
  hidden: HiddenReason | null,
};

/**
 * A file's content, for comparing.
 */
export type SetupText = {
  /**
   * None when it's over 256 KB or isn't text.
   */
  content: string | null,
  size: number,
};

/**
 * Another Codex home on the machine that this one's entries are links into, the way T3 Code
 * builds a shadow home: every entry but its sign-in leads to the same entry in the home it shares.
 */
export type SharedHome = {
  /**
   * The home it shares, with the machine's home as ~.
   */
  home: string,
  /**
   * Its entries that lead there, by name. What's in them is that home's, and shows there.
   */
  entries: Array<string>,
};

/**
 * What a change does to a skill in one home.
 */
export type SkillAction = "link" | "useStore" | "adopt" | "remove";

/**
 * A change to a skill in one home, as the page asks for it.
 */
export type SkillChange = {
  /**
   * The home, as the scan names it: ~/.claude.
   */
  home: string,
  /**
   * The skill's folder name.
   */
  name: string,
  action: SkillAction,
  /**
   * What the last scan found by that name in the home, and in the store: `-`
   * for nothing, `D` and a skill folder's fingerprint, `L` and where a link leads.
   */
  homeBefore: string,
  storeBefore: string,
};

/**
 * A skill's folder, as the scan found it.
 */
export type SkillFacts = {
  files: number,
  /**
   * It has a SKILL.md, without which the agents don't load it.
   */
  hasDoc: boolean,
  /**
   * The name its front matter gives, which should match its folder.
   */
  declaredName: string | null,
  /**
   * How long its description is, in bytes.
   */
  descriptionChars: number,
  /**
   * How long its when_to_use is, in bytes, which Claude Code lists after the description.
   */
  whenToUseChars: number,
  /**
   * Only a person can invoke it (`disable-model-invocation: true`), so Claude Code leaves it out
   * of the skills it lists for the model.
   */
  manualOnly: boolean,
  /**
   * Where `npx skills` installed it from, for a shared skill: "owner/repo".
   */
  source: string | null,
};

/**
 * A skill Claude Code's settings turn off, or change how it's offered to the model.
 */
export type SkillOverride = {
  /**
   * The skill's folder name, which is what Claude Code goes by.
   */
  name: string,
  state: OverrideState,
  source: OverrideSource,
  /**
   * The file that sets it, with the machine's home as ~.
   */
  file: string,
};

/**
 * Where a skill came from, as `npx skills` records it: a repo, the path to its SKILL.md there, and
 * the git tree its folder was when it was installed or last updated.
 */
export type SkillSource = {
  /**
   * "owner/repo" for one on GitHub.
   */
  source: string,
  sourceType: string,
  sourceUrl: string | null,
  /**
   * The branch or tag it follows, when it's not the repo's default.
   */
  ref: string | null,
  skillPath: string | null,
  skillFolderHash: string | null,
};

/**
 * How much a skill was used in the sessions active lately, by the name it was used by.
 */
export type SkillUsage = {
  name: string,
  /**
   * The sessions that used it, whether a model called for it or a person typed or picked it.
   */
  sessions: number,
  /**
   * The times Claude Code's model called for it.
   */
  calls: number,
  /**
   * When the latest of those sessions was last active.
   */
  lastMs: number,
  /**
   * Its sessions by the machine each ran on.
   */
  machines: { [key in string]: number },
};

export type SkillUsageReport = {
  /**
   * The most called first.
   */
  skills: Array<SkillUsage>,
  /**
   * Sessions active in the window whose transcripts have been read for skills.
   */
  counted: number,
  /**
   * Those still to be read for them, which are read a few at a time.
   */
  pending: number,
};

/**
 * A machine's own value for a skill.
 */
export type SkillWanted = "off" | "own";

export type SkipReason = "noSqlite3" | "migrationRange" | "schema" | "unreadable";

/**
 * Why a database wasn't read, and the newest migration it had when that's known.
 */
export type Skipped = {
  reason: SkipReason,
  migration: number | null,
};

/**
 * Settings › Software: the app's own settings, kept by the desktop app and never by the core.
 */
export type SoftwareSettings = {
  closeBehavior: WindowsCloseBehavior,
  autostartEnabled: boolean,
  startCoreOnLaunch: boolean,
  silentStartEnabled: boolean,
};

export type SoftwareSettingsInput = {
  closeBehavior: WindowsCloseBehavior,
  autostartEnabled: boolean,
  startCoreOnLaunch: boolean,
  silentStartEnabled: boolean,
};

/**
 * How a skill in the repo stands against its source.
 */
export type SourceCheck = {
  name: string,
  source: string,
  ref: string | null,
  state: SourceState,
  /**
   * Why it's unchecked or couldn't be checked.
   */
  detail: string | null,
  /**
   * When GitHub was asked.
   */
  checkedAtMs: number | null,
};

/**
 * How the repo's copy of a skill stands against its source.
 */
export type SourceState = "current" | "update" | "changedHere" | "gone" | "unchecked" | "error";

export type SpeedAliasEntry = {
  sourceModel: string,
  alias: string,
  serviceTier: string,
  provider: string,
  kind: string,
  oauthChannel: string | null,
};

export type Spend = {
  cost: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  sessions: number,
};

export type SpendGroup = {
  name: string,
  cost: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  sessions: number,
};

export type StartingContext = {
  /**
   * Oldest first.
   */
  sessions: Array<SessionStart>,
  /**
   * Sessions read in the window whose home a scan hasn't said yet.
   */
  unplaced: number,
  truncated: boolean,
};

/**
 * A file or skill to write on a machine, or to remove from it, as the page asks.
 */
export type SyncChange = {
  /**
   * As the scan names it: ~/.claude/CLAUDE.md, or ~/.agents/skills/pdf for a skill.
   */
  path: string,
  /**
   * Remove the machine's copy, rather than write the repo's.
   */
  remove: boolean,
  /**
   * Its fingerprint on the machine as the last scan found it, or None when it wasn't there.
   */
  before: string | null,
};

export type SyncFailure = {
  path: string,
  /**
   * `changed`: it isn't what the last scan found, so nothing was changed. `failed`: it couldn't be written.
   */
  reason: string,
};

/**
 * The kind of file a path in the home folder is, when the repo syncs it:
 * A kind of file the setup repo syncs.
 */
export type SyncFileKind = "instructions" | "rule" | "subagent" | "command" | "hookScript";

/**
 * How a change, or undoing one, went.
 */
export type SyncOutcome = {
  /**
   * The backup made first, which undoing the change needs.
   */
  backup: string | null,
  /**
   * Files written, restored or removed, as the scan names them.
   */
  done: Array<string>,
  failed: Array<SyncFailure>,
};

export type SystemLocale = {
  /**
   * A BCP 47 tag such as "en-AU".
   */
  locale: string,
  /**
   * "h23" when the user wants 24-hour time, otherwise "h12".
   */
  hourCycle: string,
};

/**
 * One of T3 Code's databases on a machine, as last read.
 */
export type T3Channel = {
  machine: string,
  channel: T3ChannelKind,
  /**
   * When it was last read, or found unchanged, in Arbor's clock.
   */
  readAtMs: number,
  /**
   * T3 Code's server is running: its runtime file names a live process that started when it says.
   */
  serverRunning: boolean,
  readMode: ReadMode,
  skipped: Skipped | null,
  threads: Array<T3Thread>,
};

/**
 * Where on a machine T3 Code keeps its state: the app's `~/.t3/userdata`, or `$T3CODE_HOME/userdata`.
 */
export type T3ChannelKind = "userdata" | "custom";

/**
 * T3 Code on a machine: it keeps its home there.
 */
export type T3Install = {
  /**
   * From its app, or the npm package behind its `t3` command.
   */
  version: string | null,
  /**
   * Its server is up (the pid it left in `server-runtime.json` is alive), so a run can be handed to it.
   */
  running: boolean,
  /**
   * Its provider setups ("Codex · Hub"), by the id a thread names one with. Only ids, drivers, names and
   * whether each is on leave the machine; their settings and environment never do.
   */
  setups: Array<HarnessSetup>,
};

/**
 * One of T3 Code's compatibility policies: for T3 Code versions in `t3_code_range`, what it makes
 * of each range of the agent's versions.
 */
export type T3Policy = {
  agent: AgentKind,
  t3CodeRange: string,
  recommendedRange: string | null,
  recommendedVersion: string | null,
  ranges: Array<T3Range>,
};

export type T3Range = {
  range: string,
  /**
   * `unknown`, `supported`, `graceful`, `unsupported` or `broken`.
   */
  status: string,
};

/**
 * A thread, as far as the board needs it: ids, statuses, counts and times, all in Arbor's clock.
 */
export type T3Thread = {
  threadId: string,
  projectId: string,
  workspaceRoot: string | null,
  /**
   * The provider T3 Code runs the thread with (`claudeAgent`, `codex`, …): the one whose cursor gave the agent
   * session id, else the session's.
   */
  provider: string | null,
  sessionStatus: string | null,
  sessionUpdatedAtMs: number | null,
  pendingApprovals: number,
  pendingQuestions: number,
  /**
   * When the oldest pending approval began.
   */
  approvalSinceMs: number | null,
  /**
   * When the newest pending approval began: one asked for after a snooze wakes it, though an older one still waits.
   */
  latestApprovalAtMs: number | null,
  /**
   * When Arbor first saw it asking a question. The real time is only in T3 Code's activities, which aren't read.
   */
  questionSeenAtMs: number | null,
  interactionMode: string,
  hasActionablePlan: boolean,
  turn: T3Turn | null,
  latestUserMessageAtMs: number | null,
  /**
   * Filed away in T3 Code.
   */
  settled: boolean,
  t3SnoozedUntilMs: number | null,
  t3SnoozedAtMs: number | null,
  updatedAtMs: number,
  /**
   * Claude's session UUID or Codex's thread id, from the resume cursor.
   */
  agentSessionId: string | null,
  arborSession: ArborSession | null,
  /**
   * T3 Code's title for it, only while Thread names is on.
   */
  title: string | null,
};

/**
 * A thread's latest turn.
 */
export type T3Turn = {
  state: string,
  requestedAtMs: number,
  startedAtMs: number | null,
  completedAtMs: number | null,
};

/**
 * What Claude Code spent over a time, split every way it says.
 */
export type TelemetryBreakdown = {
  total: Spend,
  machines: Array<SpendGroup>,
  skills: Array<SpendGroup>,
  plugins: Array<SpendGroup>,
  mcpServers: Array<SpendGroup>,
  agents: Array<SpendGroup>,
  sources: Array<SpendGroup>,
  models: Array<SpendGroup>,
  versions: Array<SpendGroup>,
  firstHourMs: number | null,
  lastHourMs: number | null,
};

/**
 * What setting a machine up did, or would do.
 */
export type TelemetrySetup = {
  /**
   * Where its homes send their metrics.
   */
  endpoints: Array<string>,
  files: Array<SettingsEdit>,
};

export type TelemetryStatus = {
  enabled: boolean,
  port: number,
  /**
   * Where it listens, like *:8319, or None when it isn't.
   */
  listening: string | null,
  error: string | null,
  /**
   * Whether other machines can reach it: the proxy is open to the network.
   */
  lan: boolean,
  machines: Array<MachineTelemetry>,
};

export type ThinkingAliasEntry = {
  sourceModel: string,
  alias: string,
  effort: string | null,
  provider: string,
  kind: string,
  oauthChannel: string | null,
};

export type ThinkingAliasSource = {
  id: string,
  model: string,
  displayName: string | null,
  provider: string,
  kind: string,
  protocol: string,
  reasoningLevels: Array<string>,
};

/**
 * This Mac as the machine list names it, or would once it's added, and whether it's there yet.
 */
export type ThisMac = {
  /**
   * The name its sessions and setup are filed under.
   */
  name: string,
  /**
   * The machine list has it, under `name`.
   */
  listed: boolean,
};

/**
 * Claude Code's estimate of some tokens, rounded as it prints them.
 */
export type TokenEstimate = {
  tokens: number,
  /**
   * It only said there are fewer than `tokens`.
   */
  under: boolean,
};

/**
 * A tool a shell on the machine finds.
 */
export type ToolFound = {
  tool: string,
  path: string,
  /**
   * None when it didn't answer, or didn't say a version.
   */
  version: string | null,
};

/**
 * A version of a tool one of a project's files asks for.
 */
export type ToolNeed = {
  tool: string,
  /**
   * As the file writes it; empty when a lockfile only says the tool is used.
   */
  wants: string,
  kind: NeedKind,
  /**
   * The file, from the top of the checkout.
   */
  file: string,
  /**
   * Where in the file, like `engines.node`.
   */
  field: string | null,
};

/**
 * What a session called, by tool name alone: never what went into a call or came back.
 */
export type ToolUsage = {
  /**
   * The session's own calls, by tool name.
   */
  tools: { [key in string]: number },
  /**
   * Its subagents' calls, by tool name. Claude Code keeps each subagent in a transcript of its own.
   */
  subagentTools: { [key in string]: number },
  /**
   * The subagents it started, by the type each was asked for. Codex doesn't give them one.
   */
  subagents: { [key in string]: number },
  /**
   * The skills it and its subagents called for, by name, from Claude Code's Skill calls.
   */
  skills: { [key in string]: number },
  /**
   * Every skill it used, by name: called for by Claude Code's model, typed by a person, or
   * picked in Codex. Missing from what was stored before Arbor noted them, so those
   * transcripts are read again.
   */
  usedSkills: Array<string>,
};

/**
 * A compaction as the agent recorded it.
 */
export type TranscriptCompaction = {
  atMs: number,
  /**
   * "auto" or "manual" from Claude Code; empty from Codex, which doesn't record it.
   */
  trigger: "" | "auto" | "manual",
  preTokens: number | null,
  postTokens: number | null,
  durationMs: number | null,
};

/**
 * What picking a row does once the window is shown; the window carries it out.
 */
export type TrayAction = {
  "kind": "openMachine",
  machine: string,
};

/**
 * The status dot drawn before a row, colored like the UI's status dots. `Blank` keeps a row's text
 * in line with dotted rows beside it.
 */
export type TrayDot = "green" | "amber" | "red" | "gray" | "blank";

/**
 * One row of the tray menu. A row with children opens them as a sub-menu, and one with empty text
 * is a separator. Rows are shown dimmed unless they have an action.
 */
export type TrayRow = {
  text: string,
  dot?: TrayDot,
  action?: TrayAction,
  children?: Array<TrayRow>,
};

export type TraySection = "limits" | "machines" | "sessions";

/**
 * The background runner on one machine, as its last look found it.
 */
export type UdianOnMachine = {
  /**
   * The build it needs, like `darwin-arm64`; null when Arbor carries none for the machine's system.
   */
  target: string | null,
  /**
   * The version installed, or null when it isn't.
   */
  version: string | null,
  /**
   * Its daemon answered.
   */
  live: boolean,
  /**
   * The fingerprint of its skill in the machine's store, `~/.agents/skills/ultradian`, or null when it has none.
   */
  skill: string | null,
};

/**
 * A checkout a scan found whose repo isn't one of the setup repo's projects.
 */
export type UnlistedCheckout = {
  machine: string,
  path: string,
  /**
   * `host/owner/name`; None for a repo with no remote.
   */
  remote: string | null,
};

/**
 * Which releases the app updates to. Stable is the release GitHub marks as the latest. Nightly also takes the
 * prereleases built from main, `X.Y.Z-nightly.YYYYMMDD.N`, and moves to a stable release once one is newer. Dev takes
 * the builds this Mac makes of main itself (dev_builds.rs), never GitHub's.
 */
export type UpdateChannel = "stable" | "nightly" | "dev";

/**
 * A range's requests by the credential that served them, found by the auth index each carries, so the Breakdown can
 * name each one with its account's profile: two credentials with one email (a Claude and a Codex sign-in) stay apart.
 * Requests with no index are counted under their source, as that's all there is to name them by.
 */
export type UsageAccountCategory = {
  /**
   * The credential's auth index, trimmed; empty for requests that carry none.
   */
  authIndex: string,
  /**
   * What the core calls the account (its email, or a masked key), for when no profile is found for the index.
   */
  label: string,
  requests: number,
  failures: number,
  tokens: number,
};

export type UsageAnalysis = {
  models: Array<UsageCategory>,
  providers: Array<UsageCategory>,
  /**
   * By the source text the core records, which the Source filter matches on.
   */
  sources: Array<UsageCategory>,
  accounts: Array<UsageAccountCategory>,
  apiKeys: Array<UsageCategory>,
};

export type UsageCategory = {
  key: string,
  label: string,
  requests: number,
  failures: number,
  tokens: number,
};

/**
 * What `get_usage_collector_status` reports about copying the core's requests into the local database.
 */
export type UsageCollectorStatus = {
  state: CollectorState,
  message: string,
  lastCollectedAt: string | null,
  totalRecords: number,
};

/**
 * Database sizes around a compaction, each the file plus its write-ahead log as
 * `get_usage_storage_info` counts them.
 */
export type UsageCompactionResult = {
  bytesBefore: number,
  bytesAfter: number,
  /**
   * True when a read kept the closing checkpoint from finishing. The rebuilt
   * pages then wait in the write-ahead log until SQLite checkpoints as the last
   * connection closes, and `bytes_after` is the size the file shrinks to then.
   */
  shrinkPending: boolean,
};

export type UsageEventPage = {
  items: Array<UsageRecord>,
  total: number,
  page: number,
  pageSize: number,
  totalPages: number,
};

export type UsageFiveMinutePoint = {
  /**
   * When the block starts. Blocks are counted from the Unix epoch, which keeps them on
   * local 5-minute boundaries in every timezone, since every offset is a whole 5 minutes.
   */
  startMs: number,
  requests: number,
  success: number,
  failure: number,
  canceled: number,
  tokens: number,
};

export type UsageOverview = {
  totalRequests: number,
  successCount: number,
  failureCount: number,
  canceledCount: number,
  successRate: number,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalTokens: number,
  rpm: number,
  tpm: number,
  tps: number,
  tpsSampleCount: number,
  averageLatencyMs: number,
  cacheHitRate: number,
  estimatedCost: number,
  pricedRequests: number,
  timeline: Array<UsageTimelinePoint>,
  /**
   * The range in 5-minute blocks, for a range with both ends and no longer than
   * FIVE_MINUTE_TIMELINE_MAX_MS; empty otherwise, where the hourly timeline is fine enough.
   */
  fiveMinuteTimeline: Array<UsageFiveMinutePoint>,
  machines: Array<MachineUsage>,
  machineLive: Array<MachineLive>,
  analysis?: UsageAnalysis,
};

export type UsagePriceRow = {
  model: string,
  requests: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalTokens: number,
  estimatedCost: number,
  price: ModelPrice | null,
};

export type UsagePricing = {
  rows: Array<UsagePriceRow>,
  totalCost: number,
  totalRequests: number,
  pricedRequests: number,
  savedPrices: number,
};

export type UsageQuery = {
  /**
   * Requests sent with a key assigned to this machine. Sessions are matched
   * whole, by where they ran: their key's machine, else where their
   * transcript is.
   */
  machine?: string,
  pool?: string,
  start?: string,
  end?: string,
  model?: string,
  provider?: string,
  source?: string,
  api_key_hash?: string,
  /**
   * Only requests sent with this credential, by its auth index.
   */
  auth_index?: string,
  /**
   * Only requests to models whose name contains this, like "opus" for a
   * limit that only counts Opus.
   */
  model_family?: string,
  failed?: boolean,
  canceled?: boolean,
  page?: number,
  page_size?: number,
  /**
   * Matches this session and every session descended from it.
   */
  session?: string,
  /**
   * Session list order: "recent" (the default), "cost", "tokens" or "requests".
   */
  sort?: string,
  /**
   * Sessions only: words that each have to be somewhere in a session's
   * title, project, folder, branch, pull requests, ids, client, machine or
   * models.
   */
  search?: string,
  /**
   * Sessions only: the project, as the Sessions page names it.
   */
  project?: string,
  branch?: string,
  /**
   * Sessions only: the client, as the Sessions page names it without its
   * version, like "Claude Code" or "Codex CLI · AcmeDesk".
   */
  client?: string,
  /**
   * Sessions only: "with" for sessions that opened or worked on a pull
   * request, "without" for the rest.
   */
  pull_requests?: string,
  /**
   * Sessions only: also count the sessions behind each choice in the
   * filter menus.
   */
  facets?: boolean,
  /**
   * Requests only: the column the Requests list is ordered by, and which
   * way. Newest first when unset.
   */
  request_order?: UsageRequestOrder,
  /**
   * Overview only: include the Breakdown categories in the same request-table pass.
   */
  include_analysis?: boolean,
};

export type UsageRecord = {
  id: string,
  timestamp: string,
  latency_ms: number,
  ttft_ms: number | null,
  source: string,
  source_display: string,
  auth_index: string,
  failed: boolean,
  canceled: boolean,
  failure_status: number,
  failure_body: string,
  provider: string,
  api_group_key?: string,
  model: string,
  alias: string,
  client_ip: string | null,
  x_forwarded_for: string | null,
  user_agent: string | null,
  machine: string,
  pool: string,
  reasoning_effort: string,
  service_tier: string,
  response_service_tier: string,
  executor_type: string,
  endpoint: string,
  auth_type: string,
  api_key_hash: string,
  api_key_display: string,
  api_key_remark: string,
  request_id: string,
  generate?: boolean,
  cached_tokens?: number,
  collector_source?: string,
  tokens: UsageTokenStats,
};

export type UsageRepairResult = {
  scanned: number,
  repaired: number,
  deleted: number,
  backupPath: string | null,
};

export type UsageRequestOrder = {
  by: UsageRequestSortKey,
  descending: boolean,
};

/**
 * A column the Requests list can be ordered by: the ones the database holds
 * as they're shown, so the order is the database's and every page follows on.
 */
export type UsageRequestSortKey = "time" | "input" | "output" | "cache" | "reasoning" | "total" | "ttft" | "latency";

export type UsageRetentionResult = {
  retentionDays: number,
  recordsAffected: number,
};

/**
 * A root session. Its thread fields add up every thread in `threads`.
 */
export type UsageSession = {
  provider: string,
  machine: string,
  pool: string,
  apiKeyHash: string,
  active: boolean,
  hasOwnRequests: boolean,
  subagents: number,
  threads: Array<UsageSessionThread>,
  /**
   * Where the session ran and what it was called, from its transcript. None until one is found.
   */
  transcript: SessionTranscript | null,
  id: string,
  parentId: string | null,
  depth: number,
  models: Array<string>,
  providers: Array<string>,
  userAgent: string | null,
  /**
   * The largest context the thread's conversation reached, in input tokens.
   * Like `compactions`, it covers the whole thread whatever the filters: a
   * thread missing some of its requests would show drops that never happened.
   */
  peakContext: number,
  /**
   * How often the thread's context was compacted. A session's own count is
   * its main thread's.
   */
  compactions: number,
  startedAtMs: number,
  lastActiveAtMs: number,
  requests: number,
  failures: number,
  canceled: number,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalTokens: number,
  estimatedCost: number,
  pricedRequests: number,
};

export type UsageSessionPage = {
  items: Array<UsageSession>,
  total: number,
  page: number,
  pageSize: number,
  totalPages: number,
  summary: UsageSessionSummary,
  /**
   * Only when the query asks for them.
   */
  facets?: SessionFacets,
};

export type UsageSessionSummary = {
  sessions: number,
  subagentThreads: number,
  active: number,
  requests: number,
  totalTokens: number,
  estimatedCost: number,
  /**
   * Requests with a price. Without any, the cost isn't known.
   */
  pricedRequests: number,
  untrackedRequests: number,
};

export type UsageSessionThread = {
  id: string,
  parentId: string | null,
  depth: number,
  models: Array<string>,
  providers: Array<string>,
  userAgent: string | null,
  /**
   * The largest context the thread's conversation reached, in input tokens.
   * Like `compactions`, it covers the whole thread whatever the filters: a
   * thread missing some of its requests would show drops that never happened.
   */
  peakContext: number,
  /**
   * How often the thread's context was compacted. A session's own count is
   * its main thread's.
   */
  compactions: number,
  startedAtMs: number,
  lastActiveAtMs: number,
  requests: number,
  failures: number,
  canceled: number,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  totalTokens: number,
  estimatedCost: number,
  pricedRequests: number,
};

/**
 * Every request of one session, its subagents' included, in the order they were made.
 */
export type UsageSessionTimeline = {
  /**
   * The session as the list shows it, over its whole history. None when it has no requests.
   */
  session: UsageSession | null,
  requests: Array<SessionRequest>,
  /**
   * True when the session has more than SESSION_TIMELINE_LIMIT requests and only the first are here.
   */
  truncated: boolean,
  /**
   * For each model in the session with long-context rates, the input size they start above.
   */
  longContextThresholds: { [key in string]: number },
};

export type UsageStorageInfo = {
  retentionDays: number,
  fileBytes: number,
  walBytes: number,
  freeBytes: number,
  recordCount: number,
  oldestTimestamp: string | null,
};

export type UsageTimelinePoint = {
  hour: string,
  /**
   * When the hour's first request happened. `hour` is a label in the timezone the Mac had when
   * the requests were recorded; this lets the chart place the hour after a timezone change.
   */
  firstTimestampMs: number | null,
  requests: number,
  success: number,
  failure: number,
  canceled: number,
  tokens: number,
};

export type UsageTokenStats = {
  input_tokens: number,
  output_tokens: number,
  reasoning_tokens: number,
  cache_read_tokens: number,
  cache_creation_tokens: number,
  total_tokens: number,
};

export type WaitKind = "permission" | "question" | "waiting";

/**
 * What the app does when its window is closed.
 */
export type WindowsCloseBehavior = "ask" | "exit" | "minimize-to-tray";

export type WorktreeRemoval = {
  repo: string,
  path: string,
  /**
   * The commit the page showed, which must still be checked out.
   */
  head: string,
};

/**
 * A zoom step and the factor the webview is zoomed by for it.
 */
export type ZoomLevel = {
  step: number,
  factor: number,
};
