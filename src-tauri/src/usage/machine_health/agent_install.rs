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

/// How an install can be taken off its machine, when Arbor can prove what made it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Uninstall {
    /// The agent's own installer: its command and the folder of versions it keeps, both moved aside like any folder.
    Native { link: String, folder: String },
    Npm { prefix: String, package: String },
    Bun { package: String },
    Pnpm { package: String },
    Homebrew { prefix: String, cask: bool, name: String },
}

/// The package a global install's real path names: what follows its last `node_modules/`, scope and all.
fn package_after_node_modules(real: &str) -> Option<String> {
    let after = &real[real.rfind("/node_modules/")? + "/node_modules/".len()..];
    let mut parts = after.split('/');
    let first = parts.next()?;
    let package = if first.starts_with('@') { format!("{first}/{}", parts.next()?) } else { first.to_string() };
    (plain_name(&package, &['/']) && !package.starts_with('.')).then_some(package)
}

/// How the install at `path` (leading to `real`) comes off, from the same layout proof `classify` goes by: npm's,
/// bun's and pnpm's global folders name the package, a Homebrew keg its formula or cask, and Claude Code's and Codex's
/// own installers their versions folders in `home`. None for anything else, mise included, which is left to the user.
/// The script that acts proves it again on the machine (brew owning the keg, the package folder still there).
pub(crate) fn uninstall_plan(agent: Option<AgentKind>, path: &str, real: &str, home: &str) -> Option<Uninstall> {
    let home = home.trim_end_matches('/');
    let in_home = |dir: &str| dir.starts_with(&format!("{home}/")) && !dir.split('/').any(|part| part == "..");
    match agent {
        Some(AgentKind::Claude) if is_native(AgentKind::Claude, path) || is_native(AgentKind::Claude, real) => {
            let folder = format!("{home}/.local/share/claude");
            return (path == format!("{home}/.local/bin/claude") && real.starts_with(&format!("{folder}/"))).then(|| Uninstall::Native { link: path.into(), folder });
        }
        // Codex's standalone installer keeps each version under <CODEX_HOME>/packages/standalone and links its command
        // to the current one; only that folder and the link are set aside. Everything else in CODEX_HOME is the home
        // (sessions, settings, sign-in), which is the agent homes list's to keep or remove, not the installer's.
        Some(AgentKind::Codex) if is_native(AgentKind::Codex, path) || is_native(AgentKind::Codex, real) => {
            let at = real.find("/packages/standalone/")?;
            let folder = format!("{}/packages/standalone", &real[..at]);
            return (in_home(&folder) && in_home(path) && path != real).then(|| Uninstall::Native { link: path.into(), folder });
        }
        _ => {}
    }
    let lowered = lower(real);
    if lowered.contains("/mise/") || is_mise_shim(path) {
        return None;
    }
    if lowered.contains("/.bun/install/global/node_modules/") {
        return package_after_node_modules(real).map(|package| Uninstall::Bun { package });
    }
    if is_pnpm(real) {
        return package_after_node_modules(real).map(|package| Uninstall::Pnpm { package });
    }
    if let Some(package) = package_after_node_modules(real) {
        if let Some(prefix) = npm_prefix(real, &package) {
            return Some(Uninstall::Npm { prefix, package });
        }
    }
    homebrew_keg(real).filter(|(_, _, name)| plain_name(name, &[]) && name != "mise").map(|(prefix, cask, name)| Uninstall::Homebrew { prefix, cask, name })
}

/// The command an uninstall runs, as the confirmation shows it; none for a native install, which is set aside instead.
pub(crate) fn uninstall_command(plan: &Uninstall) -> Option<String> {
    Some(match plan {
        Uninstall::Native { .. } => return None,
        Uninstall::Npm { prefix, package } => format!("npm uninstall -g --prefix {} {}", shell_word(prefix), shell_word(package)),
        Uninstall::Bun { package } => format!("bun remove -g {}", shell_word(package)),
        Uninstall::Pnpm { package } => format!("pnpm remove -g {}", shell_word(package)),
        Uninstall::Homebrew { cask: true, name, .. } => format!("brew uninstall --cask {}", shell_word(name)),
        Uninstall::Homebrew { cask: false, name, .. } => format!("brew uninstall {}", shell_word(name)),
    })
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
    fn an_install_comes_off_only_the_way_its_layout_proves_it_was_made() {
        let home = "/Users/cam";
        let plan = |agent, path: &str, real: &str| uninstall_plan(agent, path, real, home);
        assert_eq!(
            plan(Some(AgentKind::Claude), "/Users/cam/.local/bin/claude", "/Users/cam/.local/share/claude/versions/2.4.12"),
            Some(Uninstall::Native { link: "/Users/cam/.local/bin/claude".into(), folder: "/Users/cam/.local/share/claude".into() })
        );
        assert_eq!(
            plan(Some(AgentKind::Codex), "/Users/cam/.local/bin/codex", "/Users/cam/.codex/packages/standalone/0.161.0/bin/codex"),
            Some(Uninstall::Native { link: "/Users/cam/.local/bin/codex".into(), folder: "/Users/cam/.codex/packages/standalone".into() })
        );
        assert_eq!(
            plan(None, "/Users/cam/.bun/bin/amp", "/Users/cam/.bun/install/global/node_modules/@sourcegraph/amp/dist/main.js"),
            Some(Uninstall::Bun { package: "@sourcegraph/amp".into() })
        );
        assert_eq!(
            plan(None, "/Users/cam/Library/pnpm/pi", "/Users/cam/Library/pnpm/global/5/.pnpm/@earendil+pi@0.9.1/node_modules/@earendil/pi/dist/cli.js"),
            Some(Uninstall::Pnpm { package: "@earendil/pi".into() })
        );
        assert_eq!(
            plan(None, "/usr/local/bin/droid", "/usr/local/lib/node_modules/droid/bin/droid.js"),
            Some(Uninstall::Npm { prefix: "/usr/local".into(), package: "droid".into() })
        );
        assert_eq!(
            plan(Some(AgentKind::Codex), "/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.161.0/codex"),
            Some(Uninstall::Homebrew { prefix: "/opt/homebrew".into(), cask: true, name: "codex".into() })
        );
        // mise, a project's own node_modules, a bare binary, and Claude Code's installer outside the home: not proven.
        assert_eq!(plan(Some(AgentKind::Codex), "/Users/cam/.local/share/mise/shims/codex", "/opt/homebrew/bin/mise"), None);
        assert_eq!(plan(None, "/src/app/node_modules/.bin/pi", "/src/app/node_modules/x/lib/node_modules/pi/cli.js"), None);
        assert_eq!(plan(None, "/usr/bin/opencode", "/usr/bin/opencode"), None);
        assert_eq!(plan(Some(AgentKind::Claude), "/opt/tools/.local/bin/claude", "/opt/tools/.local/share/claude/versions/1"), None);
        assert_eq!(uninstall_command(&Uninstall::Homebrew { prefix: "/opt/homebrew".into(), cask: false, name: "claude-code".into() }).as_deref(), Some("brew uninstall claude-code"));
    }

    #[test]
    fn anything_else_updates_with_the_agents_own_command() {
        assert_eq!(method(AgentKind::Claude, "/usr/bin/claude", "/usr/bin/claude", &[]), (InstallMethod::Unknown, "claude update".into()));
        assert_eq!(method(AgentKind::Claude, "/Users/a/.claude/local/claude", "/Users/a/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js", &[]).0, InstallMethod::Unknown);
    }
}
