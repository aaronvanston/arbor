//! The coding-agent harnesses Arbor knows, and what it knows about each: where it keeps its home and sessions, the
//! instruction files and skill folders it reads, where its MCP servers are set, and how Arbor starts it with a
//! prompt. One entry per harness; everything that names a harness's folders or command reads it from here, and a
//! machine's own homes are still the agent homes list (`agent_homes`), which starts from these defaults.
//!
//! Each fact was checked against the harness's own docs or source. A harness Arbor can't start yet has no launcher,
//! and one whose sessions Arbor can't read yet has no sessions home.

use super::agent_homes::AgentHomeKind;
use super::*;

/// A harness, by the id the other apps that start agents (Orca, the Codex app) give it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Harness {
    #[default]
    Claude,
    Codex,
    Pi,
    PrimeAgent,
    OpenCode,
    Droid,
    Amp,
    Gemini,
    /// One Arbor doesn't know, which another app named.
    Other,
}

impl Harness {
    pub(crate) const ALL: [Harness; 8] =
        [Harness::Claude, Harness::Codex, Harness::Pi, Harness::PrimeAgent, Harness::OpenCode, Harness::Droid, Harness::Amp, Harness::Gemini];

    /// The harness another app names by `id`, as Orca's `agentId` or a draft spells it.
    pub(crate) fn from_id(id: &str) -> Harness {
        let id = id.trim().to_ascii_lowercase();
        Harness::ALL
            .into_iter()
            .find(|harness| {
                let spec = harness.spec();
                spec.id == id || spec.aliases.contains(&id.as_str())
            })
            .unwrap_or(Harness::Other)
    }

    pub(crate) fn spec(self) -> &'static HarnessSpec {
        CATALOG.iter().find(|spec| spec.harness == self).unwrap_or(&OTHER)
    }

    /// Arbor can start an automation with it.
    pub(crate) fn launches(self) -> bool {
        self.spec().launcher.is_some()
    }
}

/// How Arbor starts a harness with a prompt; each has its own words for a session, a model and access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Launcher {
    Claude,
    Codex,
    /// `droid exec`, with the prompt from a file and an autonomy level.
    Droid,
    /// Pi and the harnesses built from it: `-p` with the prompt as its message. They never ask before running a
    /// command, so they can't be held to edits.
    Pi {
        binary: &'static str,
        /// It takes `--cwd`; one that doesn't is started in the folder.
        cwd_flag: bool,
        /// It takes `--thinking` for the effort.
        thinking: bool,
    },
}

impl Launcher {
    /// It can be held to editing files, for an automation that isn't given full access.
    pub(crate) fn limits_edits(self) -> bool {
        !matches!(self, Launcher::Pi { .. })
    }
}

/// An MCP config file and the shape it's in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum McpFormat {
    Json,
    Toml,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct McpConfig {
    /// From `~/`, or from the home when it starts with neither.
    pub(crate) path: &'static str,
    pub(crate) format: McpFormat,
    /// The key the servers sit under.
    pub(crate) key: &'static str,
}

/// Where a harness keeps its sessions, as an agent home: the variable that moves it, then its default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SessionsHome {
    pub(crate) kind: AgentHomeKind,
    pub(crate) env: Option<&'static str>,
    pub(crate) default: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HarnessSpec {
    pub(crate) harness: Harness,
    /// Its id, as other apps and its own command line spell it.
    pub(crate) id: &'static str,
    /// Other spellings other apps use.
    pub(crate) aliases: &'static [&'static str],
    /// Its command, for finding it on a machine.
    pub(crate) binary: &'static str,
    /// Where it keeps its settings: the variable that moves it, then its default.
    pub(crate) home_env: Option<&'static str>,
    pub(crate) home: &'static str,
    /// Where its sessions are, when Arbor reads them.
    pub(crate) sessions: Option<SessionsHome>,
    /// What its home is listed as on the agent homes list, for Sync to read; none for one Sync doesn't read.
    pub(crate) home_kind: Option<AgentHomeKind>,
    /// The instruction file it reads for every project, from `~/`.
    pub(crate) global_instructions: Option<&'static str>,
    /// The instruction files it reads in a project, in the order it prefers them.
    pub(crate) project_instructions: &'static [&'static str],
    /// The folders it loads skills from, from `~/`.
    pub(crate) skills: &'static [&'static str],
    pub(crate) mcp: Option<McpConfig>,
    /// The file in its home it keeps hooks in, keyed by event the way Claude Code's are; none for one whose hooks
    /// are code (Pi's extensions, OpenCode's and Amp's plugins), which Sync doesn't read.
    pub(crate) hooks: Option<&'static str>,
    /// What prints its version after its command.
    pub(crate) version_arg: &'static str,
    /// Its own command that updates it, after its command; none for one Arbor updates another way (Claude Code and
    /// Codex, by how they were installed) or not at all.
    pub(crate) update_arg: Option<&'static str>,
    pub(crate) launcher: Option<Launcher>,
}

const OTHER: HarnessSpec = HarnessSpec {
    harness: Harness::Other,
    id: "other",
    aliases: &[],
    binary: "",
    home_env: None,
    home: "",
    sessions: None,
    home_kind: None,
    global_instructions: None,
    project_instructions: &[],
    skills: &[],
    mcp: None,
    hooks: None,
    version_arg: "--version",
    update_arg: None,
    launcher: None,
};

/// The harnesses, in the order Arbor lists them. Sources for each fact: the harness's docs (code.claude.com, the
/// Codex config reference, earendil-works/pi's docs, Prime Agent's bundled docs, opencode.ai, docs.factory.com,
/// ampcode.com, gemini-cli's configuration reference) and each command's own `--help`.
pub(crate) const CATALOG: &[HarnessSpec] = &[
    HarnessSpec {
        harness: Harness::Claude,
        id: "claude",
        aliases: &["claude-code", "claudecode"],
        binary: "claude",
        home_env: Some("$CLAUDE_CONFIG_DIR"),
        home: "~/.claude",
        sessions: Some(SessionsHome { kind: AgentHomeKind::Claude, env: Some("$CLAUDE_CONFIG_DIR"), default: "~/.claude" }),
        home_kind: Some(AgentHomeKind::Claude),
        global_instructions: Some("~/.claude/CLAUDE.md"),
        project_instructions: &["CLAUDE.md", ".claude/CLAUDE.md"],
        skills: &["~/.claude/skills"],
        mcp: Some(McpConfig { path: "~/.claude.json", format: McpFormat::Json, key: "mcpServers" }),
        hooks: None,
        version_arg: "--version",
        update_arg: None,
        launcher: Some(Launcher::Claude),
    },
    HarnessSpec {
        harness: Harness::Codex,
        id: "codex",
        aliases: &["openai-codex", "codex-cli"],
        binary: "codex",
        home_env: Some("$CODEX_HOME"),
        home: "~/.codex",
        sessions: Some(SessionsHome { kind: AgentHomeKind::Codex, env: Some("$CODEX_HOME"), default: "~/.codex" }),
        home_kind: Some(AgentHomeKind::Codex),
        global_instructions: Some("~/.codex/AGENTS.md"),
        project_instructions: &["AGENTS.md"],
        skills: &["~/.agents/skills", "~/.codex/skills"],
        mcp: Some(McpConfig { path: "config.toml", format: McpFormat::Toml, key: "mcp_servers" }),
        hooks: None,
        version_arg: "--version",
        update_arg: None,
        launcher: Some(Launcher::Codex),
    },
    HarnessSpec {
        harness: Harness::Pi,
        id: "pi",
        aliases: &["pi-coding-agent"],
        binary: "pi",
        home_env: Some("$PI_CODING_AGENT_DIR"),
        home: "~/.pi/agent",
        sessions: Some(SessionsHome { kind: AgentHomeKind::Pi, env: Some("$PI_CODING_AGENT_SESSION_DIR"), default: "~/.pi/agent/sessions" }),
        home_kind: Some(AgentHomeKind::PiAgent),
        global_instructions: Some("~/.pi/agent/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.pi/agent/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "mcp.json", format: McpFormat::Json, key: "mcpServers" }),
        hooks: None,
        version_arg: "--version",
        update_arg: Some("update"),
        launcher: Some(Launcher::Pi { binary: "pi", cwd_flag: false, thinking: false }),
    },
    HarnessSpec {
        harness: Harness::PrimeAgent,
        id: "prime-agent",
        aliases: &["primeagent", "prime"],
        binary: "prime-agent",
        home_env: Some("$PRIME_AGENT_CODING_AGENT_DIR"),
        home: "~/.prime/agent",
        // Its sessions are one flat file each, which the Pi reader doesn't take yet.
        sessions: None,
        home_kind: Some(AgentHomeKind::PrimeAgent),
        global_instructions: Some("~/.prime/agent/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.prime/agent/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "settings.json", format: McpFormat::Json, key: "mcpServers" }),
        hooks: None,
        version_arg: "--version",
        update_arg: Some("update"),
        launcher: Some(Launcher::Pi { binary: "prime-agent", cwd_flag: true, thinking: true }),
    },
    HarnessSpec {
        harness: Harness::OpenCode,
        id: "opencode",
        aliases: &["open-code", "sst-opencode"],
        binary: "opencode",
        // `OPENCODE_CONFIG_DIR` adds a folder rather than moving this one.
        home_env: None,
        home: "~/.config/opencode",
        // Kept in a SQLite database Arbor doesn't read yet.
        sessions: None,
        home_kind: Some(AgentHomeKind::OpenCode),
        global_instructions: Some("~/.config/opencode/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.config/opencode/skills", "~/.claude/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "opencode.json", format: McpFormat::Json, key: "mcp" }),
        hooks: None,
        version_arg: "--version",
        update_arg: Some("upgrade"),
        launcher: None,
    },
    HarnessSpec {
        harness: Harness::Droid,
        id: "droid",
        aliases: &["factory", "factory-droid"],
        binary: "droid",
        home_env: None,
        home: "~/.factory",
        sessions: None,
        home_kind: Some(AgentHomeKind::Droid),
        global_instructions: Some("~/.factory/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.factory/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "mcp.json", format: McpFormat::Json, key: "mcpServers" }),
        hooks: Some("hooks.json"),
        version_arg: "--version",
        update_arg: Some("update"),
        launcher: Some(Launcher::Droid),
    },
    HarnessSpec {
        harness: Harness::Amp,
        id: "amp",
        aliases: &["ampcode", "amp-cli"],
        binary: "amp",
        home_env: None,
        home: "~/.config/amp",
        // Amp keeps its threads on ampcode.com.
        sessions: None,
        home_kind: Some(AgentHomeKind::Amp),
        global_instructions: Some("~/.config/amp/AGENTS.md"),
        project_instructions: &["AGENTS.md", "AGENT.md", "CLAUDE.md"],
        skills: &["~/.config/amp/skills", "~/.config/agents/skills", "~/.agents/skills", "~/.claude/skills"],
        mcp: Some(McpConfig { path: "settings.json", format: McpFormat::Json, key: "amp.mcpServers" }),
        hooks: None,
        version_arg: "version",
        update_arg: Some("update"),
        launcher: None,
    },
    HarnessSpec {
        harness: Harness::Gemini,
        id: "gemini",
        aliases: &["gemini-cli"],
        binary: "gemini",
        // `GEMINI_CLI_HOME` moves the folder this one is in.
        home_env: None,
        home: "~/.gemini",
        sessions: None,
        home_kind: None,
        global_instructions: None,
        project_instructions: &[],
        skills: &[],
        mcp: None,
        hooks: None,
        version_arg: "--version",
        update_arg: None,
        launcher: None,
    },
];

/// Each machine's store of skills, which every harness but Claude Code loads itself.
pub(crate) const STORE: &str = "~/.agents/skills";

impl HarnessSpec {
    /// It loads the machine's store itself, so a store skill needs no link in its home.
    pub(crate) fn loads_store(&self) -> bool {
        self.skills.contains(&STORE)
    }

    /// A path the catalog gives from `~/`, from the harness's home instead, so a home on the list that isn't the
    /// default reads its own. None when the path isn't in the home.
    fn in_own_home(&self, path: &'static str) -> Option<&'static str> {
        path.strip_prefix(self.home).and_then(|rest| rest.strip_prefix('/')).filter(|rest| !rest.is_empty())
    }
}

impl AgentHomeKind {
    /// The harness a home on the list belongs to.
    pub(crate) fn harness(self) -> Harness {
        if self == AgentHomeKind::ClaudeDesktop {
            return Harness::Claude;
        }
        CATALOG
            .iter()
            .find(|spec| spec.home_kind == Some(self) || spec.sessions.is_some_and(|home| home.kind == self))
            .map_or(Harness::Other, |spec| spec.harness)
    }
}

/// Defines `harness_home kind folder`, which the setup scan runs on each home with Sync on that isn't Claude Code's or
/// Codex's: the harness's own instructions file and its own skills folder, in the home the list has.
pub(crate) fn files_script() -> String {
    let mut script = String::from("harness_home() {\n  case \"$1\" in\n");
    for spec in CATALOG {
        let Some(kind) = spec.home_kind.filter(|kind| !kind.has_settings()) else {
            continue;
        };
        let mut reads = Vec::new();
        if let Some(file) = spec.global_instructions.and_then(|path| spec.in_own_home(path)) {
            reads.push(format!("emit_file instructions \"$2/{file}\""));
        }
        if let Some(folder) = spec.skills.iter().find_map(|path| spec.in_own_home(path)) {
            reads.push(format!("emit_skills \"$2/{folder}\""));
        }
        // The whole file goes back, to be read in Arbor: only the servers' names, how each is reached and a
        // fingerprint of the rest come out of it.
        if let Some(mcp) = spec.mcp.filter(|mcp| !mcp.path.starts_with("~/") && !mcp.path.starts_with('/')) {
            reads.push(format!("emit_data harnessmcp \"$2/{}\"", mcp.path));
        }
        // Without its hooks file, it reads the hooks in its settings.
        if let Some(file) = spec.hooks {
            reads.push(format!(
                "if [ -f \"$2/{file}\" ]; then emit_data eventhooks \"$2/{file}\"; else emit_data hooks \"$2/settings.json\"; fi"
            ));
        }
        if !reads.is_empty() {
            script.push_str(&format!("    {}) {} ;;\n", kind.shell_name(), reads.join("; ")));
        }
    }
    script.push_str("  esac\n}\n");
    script
}

/// `install_version`, which prints the version of the agent whose command is `$1`, run from `$2`, and the commands
/// the installs scan looks for: Claude Code's and Codex's, then every other harness Sync reads.
pub(crate) fn installs_script() -> String {
    let others: Vec<&HarnessSpec> = CATALOG.iter().filter(|spec| spec.home_kind.is_some_and(|kind| !kind.has_settings())).collect();
    let mut script = String::from("install_version() {\n  case \"$1\" in\n");
    for spec in others.iter().filter(|spec| spec.version_arg != "--version") {
        script.push_str(&format!("    {}) \"$2\" {} ;;\n", spec.binary, spec.version_arg));
    }
    script.push_str("    *) \"$2\" --version ;;\n  esac\n}\n");
    let binaries: Vec<&str> = ["claude", "codex"].into_iter().chain(others.iter().map(|spec| spec.binary)).collect();
    script.push_str(&format!("install_agents='{}'\n", binaries.join(" ")));
    script
}

/// The instruction files of the harnesses besides Claude Code and Codex that the setup repo keeps, from the home
/// folder: each in its harness's default home.
pub(crate) fn repo_instructions() -> impl Iterator<Item = &'static str> {
    CATALOG
        .iter()
        .filter(|spec| spec.home_kind.is_some_and(|kind| !kind.has_settings()))
        .filter_map(|spec| spec.global_instructions?.strip_prefix("~/"))
}

/// The default homes of those harnesses, from the home folder, each ending in a slash.
pub(crate) fn repo_homes() -> impl Iterator<Item = String> {
    CATALOG
        .iter()
        .filter(|spec| spec.home_kind.is_some_and(|kind| !kind.has_settings()))
        .filter_map(|spec| spec.home.strip_prefix("~/").map(|home| format!("{home}/")))
}

/// A harness as Settings › Agent homes shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessInfo {
    pub(crate) harness: Harness,
    pub(crate) binary: String,
    /// Where it keeps its settings, with the variable that moves it.
    pub(crate) home: String,
    #[ts(optional)]
    pub(crate) home_env: Option<String>,
    /// Where Arbor reads its sessions; none when it can't yet.
    #[ts(optional)]
    pub(crate) sessions: Option<String>,
    #[ts(optional)]
    pub(crate) global_instructions: Option<String>,
    pub(crate) project_instructions: Vec<String>,
    pub(crate) skills: Vec<String>,
    /// Its MCP config file, when it has one, the key its servers sit under and the file's shape.
    #[ts(optional)]
    pub(crate) mcp: Option<String>,
    #[ts(optional)]
    pub(crate) mcp_key: Option<String>,
    #[ts(optional)]
    pub(crate) mcp_format: Option<McpFormat>,
    /// Sync reads its home.
    pub(crate) sync: bool,
    /// Arbor can start an automation with it.
    pub(crate) automations: bool,
    /// Arbor can hold it to editing files; one that can't only runs with full access.
    pub(crate) limits_edits: bool,
    /// Arbor shows it outside this list: Claude Code and Codex always, any other once a machine has it.
    pub(crate) found: bool,
    /// The machines whose last setup scan found its command or its home, by name.
    pub(crate) found_on: Vec<String>,
}

/// Inside the home when the path doesn't start from `~/`.
fn in_home(spec: &HarnessSpec, path: &str) -> String {
    if path.starts_with("~/") || path.starts_with('/') { path.to_string() } else { format!("{}/{path}", spec.home) }
}

fn info(spec: &HarnessSpec, found_on: &FoundOn) -> HarnessInfo {
    HarnessInfo {
        harness: spec.harness,
        binary: spec.binary.to_string(),
        home: spec.home.to_string(),
        home_env: spec.home_env.map(str::to_string),
        sessions: spec.sessions.map(|sessions| sessions.default.to_string()),
        global_instructions: spec.global_instructions.map(str::to_string),
        project_instructions: spec.project_instructions.iter().map(|name| name.to_string()).collect(),
        skills: spec.skills.iter().map(|path| path.to_string()).collect(),
        mcp: spec.mcp.map(|mcp| in_home(spec, mcp.path)),
        mcp_key: spec.mcp.map(|mcp| mcp.key.to_string()),
        mcp_format: spec.mcp.map(|mcp| mcp.format),
        sync: spec.home_kind.is_some_and(AgentHomeKind::syncs),
        automations: spec.launcher.is_some(),
        limits_edits: spec.launcher.is_some_and(Launcher::limits_edits),
        found: is_found(spec.harness, found_on),
        found_on: found_on.get(&spec.harness).cloned().unwrap_or_default(),
    }
}

/// Every harness Arbor knows, for Settings › Agent homes.
pub(crate) fn infos(found_on: &FoundOn) -> Vec<HarnessInfo> {
    CATALOG.iter().map(|spec| info(spec, found_on)).collect()
}

/// The machines each harness is on, by name, as the last setup scan of each found it (`setup::harnesses_found`).
pub(crate) type FoundOn = BTreeMap<Harness, Vec<String>>;

/// Whether Arbor shows `harness` anywhere but its list of the harnesses it knows. A feature tied to a named app stays
/// hidden until a machine has it, so one nobody installed doesn't fill every machine's lists; Claude Code and Codex are
/// what Arbor is for, so they always count, before any machine has been scanned too.
pub(crate) fn is_found(harness: Harness, found_on: &FoundOn) -> bool {
    matches!(harness, Harness::Claude | Harness::Codex) || found_on.get(&harness).is_some_and(|machines| !machines.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_harness_has_one_entry_and_reads_back_by_its_ids() {
        for harness in Harness::ALL {
            assert_eq!(CATALOG.iter().filter(|spec| spec.harness == harness).count(), 1, "{harness:?}");
            let spec = harness.spec();
            assert_eq!(Harness::from_id(spec.id), harness);
            for alias in spec.aliases {
                assert_eq!(Harness::from_id(alias), harness);
            }
        }
        assert_eq!(Harness::from_id("Claude"), Harness::Claude);
        assert_eq!(Harness::from_id("someone-elses-agent"), Harness::Other);
        assert!(!Harness::Other.launches());
    }

    #[test]
    fn the_standard_homes_are_the_ones_arbor_reads_sessions_from() {
        let homes: Vec<_> = CATALOG.iter().filter_map(|spec| spec.sessions).map(|home| home.kind).collect();
        assert_eq!(homes, [AgentHomeKind::Claude, AgentHomeKind::Codex, AgentHomeKind::Pi]);
        for spec in CATALOG {
            for kind in spec.home_kind.into_iter().chain(spec.sessions.map(|home| home.kind)) {
                assert_eq!(kind.harness(), spec.harness, "{kind:?}");
            }
        }
    }

    #[test]
    fn every_harness_sync_reads_keeps_its_skills_in_its_homes_skills_folder() {
        // Skill changes put a home's skills in <home>/skills, so a harness Sync reads has to keep them there.
        for spec in CATALOG.iter().filter(|spec| spec.home_kind.is_some()) {
            let own = spec.skills.iter().find_map(|path| spec.in_own_home(path));
            assert!(own.is_none_or(|folder| folder == "skills"), "{}: {own:?}", spec.id);
        }
        assert!(!Harness::Claude.spec().loads_store() && Harness::Codex.spec().loads_store() && Harness::Droid.spec().loads_store());
    }

    #[test]
    fn the_other_harnesses_homes_are_read_for_their_own_instructions_skills_servers_and_hooks() {
        let script = files_script();
        assert!(script.contains(r#"pi-agent) emit_file instructions "$2/AGENTS.md"; emit_skills "$2/skills"; "#), "{script}");
        assert!(script.contains(r#"opencode) emit_file instructions "$2/AGENTS.md"; emit_skills "$2/skills"; "#), "{script}");
        assert!(!script.contains("claude)") && !script.contains("codex)"), "{script}");
        assert!(!script.contains("gemini"), "{script}");
        assert!(script.contains(r#"emit_data harnessmcp "$2/mcp.json""#) && script.contains(r#"emit_data harnessmcp "$2/opencode.json""#), "{script}");
        assert!(script.contains(r#"if [ -f "$2/hooks.json" ]; then emit_data eventhooks "$2/hooks.json"; else emit_data hooks "$2/settings.json"; fi"#), "{script}");
        assert_eq!(script.matches("eventhooks").count(), 1, "only Droid keeps hooks in a file: {script}");
    }

    #[test]
    fn the_installs_scan_looks_for_every_agent_sync_reads_and_asks_each_its_own_way() {
        let script = installs_script();
        assert!(script.contains("install_agents='claude codex pi prime-agent opencode droid amp'"), "{script}");
        assert!(script.contains(r#"    amp) "$2" version ;;"#) && script.contains(r#"    *) "$2" --version ;;"#), "{script}");
    }

    #[test]
    fn paths_start_from_home_and_mcp_files_from_their_home() {
        for spec in CATALOG {
            assert!(spec.home.starts_with("~/"), "{}", spec.id);
            for path in spec.skills.iter().chain(spec.global_instructions.iter()) {
                assert!(path.starts_with("~/"), "{path}");
            }
            if let Some(env) = spec.home_env {
                assert!(env.starts_with('$'), "{env}");
            }
        }
        let none = FoundOn::new();
        let codex = info(Harness::Codex.spec(), &none);
        assert_eq!(codex.mcp.as_deref(), Some("~/.codex/config.toml"));
        let claude = info(Harness::Claude.spec(), &none);
        assert_eq!(claude.mcp.as_deref(), Some("~/.claude.json"));
        assert!(claude.limits_edits);
        assert!(!info(Harness::Pi.spec(), &none).limits_edits);
        assert!(!info(Harness::Amp.spec(), &none).automations);
    }

    #[test]
    fn only_claude_code_and_codex_count_as_found_until_a_machine_has_another() {
        let none = FoundOn::new();
        let found: Vec<_> = infos(&none).into_iter().filter(|info| info.found).map(|info| info.harness).collect();
        assert_eq!(found, [Harness::Claude, Harness::Codex]);
        let on = FoundOn::from([(Harness::Droid, vec!["cam-mbp".to_string()]), (Harness::Amp, Vec::new())]);
        let infos = infos(&on);
        let droid = infos.iter().find(|info| info.harness == Harness::Droid).unwrap();
        assert!(droid.found && droid.found_on == ["cam-mbp"]);
        assert!(!infos.iter().find(|info| info.harness == Harness::Amp).unwrap().found, "no machine has it");
        assert!(infos.iter().find(|info| info.harness == Harness::Claude).unwrap().found_on.is_empty());
    }
}
