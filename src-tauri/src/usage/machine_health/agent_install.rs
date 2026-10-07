//! How Claude Code or Codex was installed on a machine, read from where its
//! binary really is and a few read-only probes (see `agents::CHECK_SCRIPT`),
//! and the command that updates it the same way. After T3 Code's
//! `apps/server/src/provider/providerMaintenance.ts`: every method but the
//! agent's own `update` needs evidence that its tool owns that path. npm's
//! layout names the package; Homebrew has to say the keg is its own under the
//! prefix it uses; mise has to name the tool the binary comes from. Anything
//! unproven updates with `<agent> update`, so a package manager is never run
//! against an install it didn't make.

use super::agents::{AgentKind, UPDATE_SCRIPT};
use ts_rs::TS;
use super::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InstallMethod {
    /// The agent's own installer, which it updates itself.
    Native,
    Homebrew,
    Npm,
    Bun,
    Pnpm,
    Mise,
    #[default]
    Unknown,
}

/// What the check's probes said beside the paths.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Probes {
    /// `brew --prefix`, with links resolved.
    pub(super) brew_prefix: Option<String>,
    /// What `brew list` says is installed: `formula` or `cask`, and its name.
    pub(super) brew_owner: Option<(String, String)>,
    /// The tool `mise which --plugin` names.
    pub(super) mise_tool: Option<String>,
    /// Where `mise which` leads, with links resolved.
    pub(super) mise_real: Option<String>,
}

/// How an install is updated.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) enum UpdatePlan {
    /// `<agent> update`.
    #[default]
    SelfUpdate,
    Homebrew { cask: bool, name: String },
    /// With the npm next to the Node under `prefix`, into `prefix`.
    Npm { prefix: String },
    Bun,
    Pnpm,
    Mise { tool: String },
}

impl AgentKind {
    pub(super) fn package(self) -> &'static str {
        match self {
            Self::Claude => "@anthropic-ai/claude-code",
            Self::Codex => "@openai/codex",
        }
    }
}

fn lower(path: &str) -> String {
    path.to_ascii_lowercase()
}

fn is_native(agent: AgentKind, path: &str) -> bool {
    let path = lower(path);
    match agent {
        AgentKind::Claude => path.ends_with("/.local/bin/claude") || path.contains("/.local/share/claude/"),
        // The standalone installer lays out `<CODEX_HOME>/packages/standalone/…`.
        AgentKind::Codex => path.contains("/packages/standalone/"),
    }
}

fn is_bun(path: &str) -> bool {
    let path = lower(path);
    path.contains("/.bun/bin/") || path.contains("/.bun/install/global/")
}

fn is_pnpm(path: &str) -> bool {
    let path = lower(path);
    ["/.local/share/pnpm/", "/library/pnpm/", "/pnpm/global/"].iter().any(|dir| path.contains(dir))
}

fn is_mise_shim(path: &str) -> bool {
    lower(path).contains("/mise/shims/")
}

/// The npm global prefix a package lives under, from its entry point's real path:
/// `<prefix>/lib/node_modules/<package>/…`. A project's own node_modules isn't a global install,
/// and neither is mise's npm backend, which lays tools out the same way inside `installs/<tool>/<version>`
/// (globals under mise's own Node are npm's, though).
pub(super) fn npm_prefix(real: &str, package: &str) -> Option<String> {
    let lowered = lower(real);
    let segment = format!("/lib/node_modules/{}/", package.to_ascii_lowercase());
    let at = lowered.rfind(&segment)?;
    let before = &lowered[..at];
    if before.contains("/node_modules/") {
        return None;
    }
    let mut parts = before.rsplit('/');
    let (_version, tool, installs) = (parts.next(), parts.next(), parts.next());
    if installs == Some("installs") && parts.next() == Some("mise") && tool != Some("node") {
        return None;
    }
    Some(if at == 0 { "/".to_string() } else { real[..at].to_string() })
}

/// The Homebrew keg or cask a real path is in: `<prefix>/Cellar/<name>/<version>/…` or
/// `<prefix>/Caskroom/<name>/<version>/…`, as (prefix, cask, name).
pub(super) fn homebrew_keg(real: &str) -> Option<(String, bool, String)> {
    let parts: Vec<&str> = real.split('/').collect();
    // The last Cellar or Caskroom with a name, a version and something in it after it.
    let index = (0..parts.len().saturating_sub(3)).rev().find(|&index| {
        let part = parts[index].to_ascii_lowercase();
        index > 0 && (part == "cellar" || part == "caskroom") && !parts[index + 1].is_empty() && !parts[index + 2].is_empty()
    })?;
    let prefix = parts[..index].join("/");
    let cask = parts[index].eq_ignore_ascii_case("caskroom");
    Some((if prefix.is_empty() { "/".into() } else { prefix }, cask, parts[index + 1].to_string()))
}

/// A name that can go in a command as it is.
fn plain_name(name: &str, extra: &[char]) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-' | '+') || extra.contains(&c))
}

/// The tool mise says the binary comes from, when mise is really what gives it. Globals under mise's own
/// Node belong to npm, and come back as `Err` with that Node's real path.
fn mise_tool(real: &str, probes: &Probes) -> Option<Result<String, String>> {
    let (tool, gives) = (probes.mise_tool.as_deref()?.trim(), probes.mise_real.as_deref()?);
    if matches!(tool, "node" | "core:node") {
        return Some(Err(gives.to_string()));
    }
    // mise must give this very binary, not another version of the tool.
    (gives == real && plain_name(tool, &['/', ':'])).then(|| Ok(tool.to_string()))
}

/// The binary the install at `path` (leading to `real`) runs. A mise shim leads to mise itself and runs whatever
/// mise gives, whichever tool installed that: a global under mise's own Node is npm's, but still reached through
/// the shim.
pub(super) fn runs<'a>(path: &str, real: &'a str, probes: &'a Probes) -> &'a str {
    match probes.mise_real.as_deref() {
        Some(gives) if is_mise_shim(path) => gives,
        _ => real,
    }
}

/// How the install at `path` (leading to `real`) was made, and how to update it the same way.
pub(super) fn classify(agent: AgentKind, path: &str, real: &str, probes: &Probes) -> (InstallMethod, UpdatePlan) {
    let paths = [path, real];
    if paths.iter().any(|path| is_native(agent, path)) {
        return (InstallMethod::Native, UpdatePlan::SelfUpdate);
    }
    if paths.iter().any(|path| is_bun(path)) {
        return (InstallMethod::Bun, UpdatePlan::Bun);
    }
    if paths.iter().any(|path| is_pnpm(path)) {
        return (InstallMethod::Pnpm, UpdatePlan::Pnpm);
    }
    // A shim is mise's own binary; what it runs is what counts.
    let real = if is_mise_shim(path) {
        match mise_tool(probes.mise_real.as_deref().unwrap_or_default(), probes) {
            Some(Ok(tool)) => return (InstallMethod::Mise, UpdatePlan::Mise { tool }),
            Some(Err(gives)) => gives,
            None => return (InstallMethod::Unknown, UpdatePlan::SelfUpdate),
        }
    } else {
        real.to_string()
    };
    // npm's layout names the package, so it outranks a keg the path only passes through: a Homebrew
    // Node keeps its globals under Cellar/node/<version>/lib/node_modules.
    if let Some(prefix) = npm_prefix(&real, agent.package()) {
        return (InstallMethod::Npm, UpdatePlan::Npm { prefix });
    }
    if lower(&real).contains("/mise/installs/") {
        return match mise_tool(&real, probes) {
            Some(Ok(tool)) => (InstallMethod::Mise, UpdatePlan::Mise { tool }),
            _ => (InstallMethod::Unknown, UpdatePlan::SelfUpdate),
        };
    }
    if let Some((prefix, cask, name)) = homebrew_keg(&real) {
        let kind = if cask { "cask" } else { "formula" };
        let brew_prefix_matches = probes.brew_prefix.as_deref().is_some_and(|brew| brew.eq_ignore_ascii_case(&prefix));
        let brew_owns = probes.brew_owner.as_ref().is_some_and(|(owner_kind, owner)| owner_kind == kind && *owner == name);
        if brew_prefix_matches && brew_owns && !(name == "mise" && !cask) && plain_name(&name, &[]) {
            return (InstallMethod::Homebrew, UpdatePlan::Homebrew { cask, name });
        }
    }
    (InstallMethod::Unknown, UpdatePlan::SelfUpdate)
}

/// How any harness's install looks to have been made, from its paths alone, for the clean-up list to show. It's only
/// what the layout suggests: nothing is ever run against an install on this word, as updating one needs `classify`'s
/// proof from the tools themselves.
pub(super) fn method_from_paths(agent: Option<AgentKind>, path: &str, real: &str) -> InstallMethod {
    let paths = [path, real];
    if agent.is_some_and(|agent| paths.iter().any(|path| is_native(agent, path))) {
        InstallMethod::Native
    } else if paths.iter().any(|path| is_bun(path)) {
        InstallMethod::Bun
    } else if paths.iter().any(|path| is_pnpm(path)) {
        InstallMethod::Pnpm
    } else if paths.iter().any(|path| is_mise_shim(path) || lower(path).contains("/mise/installs/")) {
        InstallMethod::Mise
    } else if lower(real).contains("/lib/node_modules/") && !lower(real).contains("/node_modules/.bin/") {
        InstallMethod::Npm
    } else if homebrew_keg(real).is_some() {
        InstallMethod::Homebrew
    } else {
        InstallMethod::Unknown
    }
}

/// A word that pastes into a POSIX shell as one argument.
pub(super) fn shell_word(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '@' | ':' | '=' | '+' | ',')) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// The command an update runs, as its user is shown it before saying yes.
pub(super) fn update_command(agent: AgentKind, plan: &UpdatePlan) -> String {
    let package = agent.package();
    match plan {
        UpdatePlan::SelfUpdate => format!("{} update", agent.command()),
        UpdatePlan::Homebrew { cask: true, name } => format!("brew upgrade --cask {}", shell_word(name)),
        UpdatePlan::Homebrew { cask: false, name } => format!("brew upgrade {}", shell_word(name)),
        // npm 12 skips install scripts unless they're allowed, and Claude Code's finishes its install.
        // An older npm warns about the setting and goes on.
        UpdatePlan::Npm { prefix } => format!("npm install -g --prefix {} --allow-scripts={package} {package}@latest", shell_word(prefix)),
        UpdatePlan::Bun => format!("bun add -g {package}@latest"),
        UpdatePlan::Pnpm => format!("pnpm add -g {package}@latest"),
        UpdatePlan::Mise { tool } => format!("mise upgrade {}", shell_word(tool)),
    }
}

// Each follows AGENT_ENV with `agent` and `bin` set, and runs the command `update_command` shows.
const FIND_MISE: &str = r##"mise=$(command -v mise 2>/dev/null || true)
if [ -z "$mise" ] && [ -x "$HOME/.local/bin/mise" ]; then mise=$HOME/.local/bin/mise; fi
if [ -z "$mise" ]; then printf 'mise is not installed where Arbor looks for it\n' >&2; exit 127; fi
"##;

/// The script that updates an agent the way it was installed.
pub(super) fn update_script(agent: AgentKind, plan: &UpdatePlan) -> String {
    let command = update_command(agent, plan);
    let setup = match plan {
        UpdatePlan::SelfUpdate => return format!("agent={}\n{UPDATE_SCRIPT}", agent.command()),
        UpdatePlan::Homebrew { .. } => "brew=$(command -v brew 2>/dev/null || true)\n\
             if [ -z \"$brew\" ]; then printf 'Homebrew is not installed where Arbor looks for it\\n' >&2; exit 127; fi\n\
             export NONINTERACTIVE=1 HOMEBREW_NO_ENV_HINTS=1\n"
            .to_string(),
        // The npm beside the Node that owns the install, when there is one there.
        UpdatePlan::Npm { prefix } => format!("PATH={}/bin:$PATH\nexport PATH\n", shell_word(prefix.trim_end_matches('/'))),
        UpdatePlan::Bun => String::new(),
        // pnpm puts its global binaries in PNPM_HOME, which non-interactive shells often leave unset.
        UpdatePlan::Pnpm => format!(
            "bin=$(command -v {} 2>/dev/null || true)\n\
             case \"$bin\" in /*) PNPM_HOME=${{PNPM_HOME:-${{bin%/*}}}}; PATH=\"$PNPM_HOME:$PATH\"; export PNPM_HOME PATH ;; esac\n",
            agent.command()
        ),
        UpdatePlan::Mise { .. } => format!("{FIND_MISE}export MISE_YES=1\n"),
    };
    let run = match plan {
        UpdatePlan::Homebrew { .. } => command.replacen("brew", "\"$brew\"", 1),
        UpdatePlan::Mise { .. } => command.replacen("mise", "\"$mise\"", 1),
        _ => command,
    };
    format!("{setup}{run} </dev/null 2>&1\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probes(fields: &[(&str, &str)]) -> Probes {
        let get = |key: &str| fields.iter().find(|(name, _)| *name == key).map(|(_, value)| value.to_string());
        Probes {
            brew_prefix: get("brew_prefix"),
            brew_owner: get("brew_owner").and_then(|owner| owner.split_once(' ').map(|(kind, name)| (kind.into(), name.into()))),
            mise_tool: get("mise_tool"),
            mise_real: get("mise_real"),
        }
    }

    fn method(agent: AgentKind, path: &str, real: &str, fields: &[(&str, &str)]) -> (InstallMethod, String) {
        let (method, plan) = classify(agent, path, real, &probes(fields));
        (method, update_command(agent, &plan))
    }

    #[test]
    fn native_installs_update_themselves() {
        assert_eq!(
            method(AgentKind::Claude, "/Users/a/.local/bin/claude", "/Users/a/.local/share/claude/versions/2.1.281", &[]),
            (InstallMethod::Native, "claude update".into()),
        );
        assert_eq!(
            method(AgentKind::Codex, "/home/a/.local/bin/codex", "/home/a/.codex/packages/standalone/0.157.0/bin/codex", &[]),
            (InstallMethod::Native, "codex update".into()),
        );
    }

    #[test]
    fn npm_installs_update_into_the_prefix_that_holds_them() {
        assert_eq!(
            method(AgentKind::Codex, "/home/a/.npm-global/bin/codex", "/home/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js", &[]),
            (InstallMethod::Npm, "npm install -g --prefix /home/a/.npm-global --allow-scripts=@openai/codex @openai/codex@latest".into()),
        );
        // A Homebrew Node's globals are npm's, not Homebrew's.
        assert_eq!(
            method(AgentKind::Claude, "/opt/homebrew/bin/claude", "/opt/homebrew/Cellar/node/24.1.0/lib/node_modules/@anthropic-ai/claude-code/cli.js", &[("brew_prefix", "/opt/homebrew"), ("brew_owner", "formula node")]),
            (InstallMethod::Npm, "npm install -g --prefix /opt/homebrew/Cellar/node/24.1.0 --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest".into()),
        );
        // A prefix with a space in it is quoted.
        assert_eq!(
            method(AgentKind::Codex, "/Users/a/My Tools/bin/codex", "/Users/a/My Tools/lib/node_modules/@openai/codex/bin/codex.js", &[]).1,
            "npm install -g --prefix '/Users/a/My Tools' --allow-scripts=@openai/codex @openai/codex@latest",
        );
        assert_eq!(shell_word("it's"), r"'it'\''s'");
        // A project's own node_modules isn't a global install.
        assert_eq!(npm_prefix("/src/app/node_modules/x/lib/node_modules/@openai/codex/bin/codex.js", "@openai/codex"), None);
        assert_eq!(npm_prefix("/usr/lib/node_modules/@openai/codex/bin/codex.js", "@openai/codex").as_deref(), Some("/usr"));
    }

    #[test]
    fn bun_and_pnpm_are_known_by_where_they_keep_globals() {
        assert_eq!(
            method(AgentKind::Codex, "/Users/a/.bun/bin/codex", "/Users/a/.bun/install/global/node_modules/@openai/codex/bin/codex.js", &[]),
            (InstallMethod::Bun, "bun add -g @openai/codex@latest".into()),
        );
        assert_eq!(
            method(AgentKind::Claude, "/Users/a/Library/pnpm/claude", "/Users/a/Library/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.281/node_modules/@anthropic-ai/claude-code/cli.js", &[]),
            (InstallMethod::Pnpm, "pnpm add -g @anthropic-ai/claude-code@latest".into()),
        );
    }

    #[test]
    fn homebrew_counts_only_once_brew_says_the_keg_is_its_own() {
        let real = "/opt/homebrew/Caskroom/codex/0.157.0/codex-aarch64-apple-darwin";
        let owned = [("brew_prefix", "/opt/homebrew"), ("brew_owner", "cask codex")];
        assert_eq!(method(AgentKind::Codex, "/opt/homebrew/bin/codex", real, &owned), (InstallMethod::Homebrew, "brew upgrade --cask codex".into()));
        assert_eq!(
            method(AgentKind::Claude, "/usr/local/bin/claude", "/usr/local/Cellar/claude-code/2.1.281/bin/claude", &[("brew_prefix", "/usr/local"), ("brew_owner", "formula claude-code")]),
            (InstallMethod::Homebrew, "brew upgrade claude-code".into()),
        );
        // Another brew's prefix, brew not saying it's installed, or no brew at all: not proven.
        for fields in [
            &[("brew_prefix", "/usr/local"), ("brew_owner", "cask codex")][..],
            &[("brew_prefix", "/opt/homebrew")][..],
            &[("brew_prefix", "/opt/homebrew"), ("brew_owner", "formula codex")][..],
            &[][..],
        ] {
            assert_eq!(method(AgentKind::Codex, "/opt/homebrew/bin/codex", real, fields), (InstallMethod::Unknown, "codex update".into()), "{fields:?}");
        }
        assert_eq!(homebrew_keg("/opt/homebrew/Cellar/mise/2026.9.1/bin/mise"), Some(("/opt/homebrew".into(), false, "mise".into())));
        assert_eq!(homebrew_keg("/opt/homebrew/Cellar/codex"), None);
    }

    #[test]
    fn mise_counts_when_it_names_the_tool_that_gives_the_binary() {
        let shim = "/Users/a/.local/share/mise/shims/codex";
        let installed = "/Users/a/.local/share/mise/installs/npm-openai-codex/0.157.0/lib/node_modules/@openai/codex/bin/codex.js";
        let tool = [("mise_tool", "npm:@openai/codex"), ("mise_real", installed)];
        // Through a shim, which leads to mise itself (here from Homebrew).
        assert_eq!(method(AgentKind::Codex, shim, "/opt/homebrew/Cellar/mise/2026.9.1/bin/mise", &tool), (InstallMethod::Mise, "mise upgrade npm:@openai/codex".into()));
        // Or its install directory on PATH: npm's layout inside a mise tool is still mise's.
        assert_eq!(method(AgentKind::Codex, "/Users/a/.local/share/mise/installs/npm-openai-codex/0.157.0/bin/codex", installed, &tool), (InstallMethod::Mise, "mise upgrade npm:@openai/codex".into()));
        // A global under mise's own Node is npm's.
        let node = "/Users/a/.local/share/mise/installs/node/24.1.0/lib/node_modules/@openai/codex/bin/codex.js";
        assert_eq!(
            method(AgentKind::Codex, shim, "/opt/homebrew/bin/mise", &[("mise_tool", "node"), ("mise_real", node)]),
            (InstallMethod::Npm, "npm install -g --prefix /Users/a/.local/share/mise/installs/node/24.1.0 --allow-scripts=@openai/codex @openai/codex@latest".into()),
        );
        // mise not answering, or giving another version than the one on PATH: not proven.
        assert_eq!(method(AgentKind::Codex, shim, "/opt/homebrew/Cellar/mise/2026.9.1/bin/mise", &[("brew_prefix", "/opt/homebrew"), ("brew_owner", "formula mise")]).0, InstallMethod::Unknown);
        assert_eq!(method(AgentKind::Codex, "/x/mise/installs/codex/0.150.0/bin/codex", "/x/mise/installs/codex/0.150.0/bin/codex", &[("mise_tool", "codex"), ("mise_real", "/x/mise/installs/codex/0.157.0/bin/codex")]).0, InstallMethod::Unknown);
    }

    #[test]
    fn anything_else_updates_with_the_agents_own_command() {
        assert_eq!(method(AgentKind::Claude, "/usr/bin/claude", "/usr/bin/claude", &[]), (InstallMethod::Unknown, "claude update".into()));
        assert_eq!(method(AgentKind::Claude, "/Users/a/.claude/local/claude", "/Users/a/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js", &[]).0, InstallMethod::Unknown);
    }
}
