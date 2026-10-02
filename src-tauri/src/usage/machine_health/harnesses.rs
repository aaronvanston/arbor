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
    /// The instruction file it reads for every project, from `~/`.
    pub(crate) global_instructions: Option<&'static str>,
    /// The instruction files it reads in a project, in the order it prefers them.
    pub(crate) project_instructions: &'static [&'static str],
    /// The folders it loads skills from, from `~/`.
    pub(crate) skills: &'static [&'static str],
    pub(crate) mcp: Option<McpConfig>,
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
    global_instructions: None,
    project_instructions: &[],
    skills: &[],
    mcp: None,
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
        global_instructions: Some("~/.claude/CLAUDE.md"),
        project_instructions: &["CLAUDE.md", ".claude/CLAUDE.md"],
        skills: &["~/.claude/skills"],
        mcp: Some(McpConfig { path: "~/.claude.json", format: McpFormat::Json, key: "mcpServers" }),
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
        global_instructions: Some("~/.codex/AGENTS.md"),
        project_instructions: &["AGENTS.md"],
        skills: &["~/.agents/skills", "~/.codex/skills"],
        mcp: Some(McpConfig { path: "config.toml", format: McpFormat::Toml, key: "mcp_servers" }),
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
        global_instructions: Some("~/.pi/agent/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.pi/agent/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "mcp.json", format: McpFormat::Json, key: "mcpServers" }),
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
        global_instructions: Some("~/.prime/agent/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.prime/agent/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "settings.json", format: McpFormat::Json, key: "mcpServers" }),
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
        global_instructions: Some("~/.config/opencode/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.config/opencode/skills", "~/.claude/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "opencode.json", format: McpFormat::Json, key: "mcp" }),
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
        global_instructions: Some("~/.factory/AGENTS.md"),
        project_instructions: &["AGENTS.md", "CLAUDE.md"],
        skills: &["~/.factory/skills", "~/.agents/skills"],
        mcp: Some(McpConfig { path: "mcp.json", format: McpFormat::Json, key: "mcpServers" }),
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
        global_instructions: Some("~/.config/amp/AGENTS.md"),
        project_instructions: &["AGENTS.md", "AGENT.md", "CLAUDE.md"],
        skills: &["~/.config/amp/skills", "~/.config/agents/skills", "~/.agents/skills", "~/.claude/skills"],
        mcp: Some(McpConfig { path: "settings.json", format: McpFormat::Json, key: "amp.mcpServers" }),
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
        global_instructions: None,
        project_instructions: &[],
        skills: &[],
        mcp: None,
        launcher: None,
    },
];

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
    /// Arbor can start an automation with it.
    pub(crate) automations: bool,
    /// Arbor can hold it to editing files; one that can't only runs with full access.
    pub(crate) limits_edits: bool,
}

/// Inside the home when the path doesn't start from `~/`.
fn in_home(spec: &HarnessSpec, path: &str) -> String {
    if path.starts_with("~/") || path.starts_with('/') { path.to_string() } else { format!("{}/{path}", spec.home) }
}

fn info(spec: &HarnessSpec) -> HarnessInfo {
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
        automations: spec.launcher.is_some(),
        limits_edits: spec.launcher.is_some_and(Launcher::limits_edits),
    }
}

/// Every harness Arbor knows, for Settings › Agent homes.
pub(crate) fn infos() -> Vec<HarnessInfo> {
    CATALOG.iter().map(info).collect()
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
        let codex = info(Harness::Codex.spec());
        assert_eq!(codex.mcp.as_deref(), Some("~/.codex/config.toml"));
        let claude = info(Harness::Claude.spec());
        assert_eq!(claude.mcp.as_deref(), Some("~/.claude.json"));
        assert!(claude.limits_edits);
        assert!(!info(Harness::Pi.spec()).limits_edits);
        assert!(!info(Harness::Amp.spec()).automations);
    }
}
