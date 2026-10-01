//! `arbor`: Arbor from the command line, and `arbor mcp`, the same for agents.
//!
//! The running app owns everything (config.yaml, usage.db, the archive, the SSH runs), so the command line never opens
//! those itself. It's the same program as the app, started under the name `arbor` (a link in ~/.local/bin) or as
//! `Arbor cli …`; it sends each request over a private socket to the running app, which runs it the way the window
//! would, through the same commands, locks, guarded writes and events, so an open window updates by itself. What the
//! window works out itself (limits, caps, routing, Sync's plan, alerts) the app asks the window for (`bridge`).
//!
//! In the app: `server` answers the socket, `dispatch` runs a request, `commands` (generated) calls the app's commands,
//! `bridge` asks the window, `redact` hides secrets, `audit` records what was asked and `settings` holds the switches.
//! In `arbor`: `args` reads the command line, `client` talks to the socket, `render` prints answers and `mcp` serves
//! agents.

mod args;
pub(crate) mod audit;
pub(crate) mod bridge;
mod client;
mod commands;
mod help;
pub(crate) mod dispatch;
mod mcp;
mod protocol;
mod redact;
mod render;
pub(crate) mod server;
pub(crate) mod settings;

use std::path::PathBuf;

/// Points `arbor` and the app at another socket, for a development build or a test.
/// The skill that teaches agents `arbor`: `arbor skill` prints it, and Settings or `arbor skill install` puts it in
/// this Mac's agent homes (`usage::machine_health::cli_skill`).
pub(crate) const SKILL: &str = include_str!("skill.md");

const SOCKET_ENV: &str = "ARBOR_CLI_SOCKET";
const SOCKET_FILE: &str = "arbor.sock";
/// A socket's path can't be longer than this on macOS (sun_path is 104 bytes, with room for the end).
const MAX_SOCKET_PATH: usize = 100;

/// The command line's folder in the app's data folder: the socket, the switches and the activity log.
pub(crate) fn cli_dir() -> Result<PathBuf, String> {
    Ok(crate::core_base_dir()?.join("cli"))
}

/// Where the app answers. Both sides work it out the same way, so `arbor` finds the app without asking anything.
pub(crate) fn socket_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(SOCKET_ENV).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let path = cli_dir()?.join(SOCKET_FILE);
    if path.as_os_str().len() <= MAX_SOCKET_PATH {
        return Ok(path);
    }
    // A home folder with a very long name: the socket goes in this user's private temporary folder instead, under a
    // name tied to the data folder so two copies of Arbor don't share one.
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(path.as_os_str().as_encoded_bytes());
    let short: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
    Ok(std::env::temp_dir().join(format!("arbor-{short}.sock")))
}

/// The command line's arguments when this run is `arbor` rather than the app: started through a link named `arbor`, or
/// as `Arbor cli …`.
pub(crate) fn command_line_arguments() -> Option<Vec<String>> {
    let mut args = std::env::args_os().map(|arg| arg.to_string_lossy().into_owned());
    let program = args.next()?;
    let rest: Vec<String> = args.collect();
    let real_name = std::env::current_exe().ok().and_then(|exe| exe.canonicalize().ok()).and_then(|exe| exe.file_name().map(|name| name.to_string_lossy().into_owned()));
    cli_arguments(&program, real_name.as_deref(), rest)
}

/// A development build's program is itself called `arbor`, so only a link by that name to a program called something
/// else (the app's `Arbor`) is the command line; started under its own name it's still the app.
fn cli_arguments(program: &str, real_name: Option<&str>, rest: Vec<String>) -> Option<Vec<String>> {
    let name = std::path::Path::new(program).file_name()?.to_string_lossy().into_owned();
    if name == settings::COMMAND_NAME && real_name.is_some_and(|real| real != settings::COMMAND_NAME) {
        return Some(rest);
    }
    match rest.split_first() {
        Some((first, others)) if first == "cli" => Some(others.to_vec()),
        _ => None,
    }
}

/// Runs `arbor` and gives its exit code.
pub(crate) fn run(arguments: Vec<String>) -> i32 {
    client::run(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rest(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn the_link_and_the_cli_word_are_the_command_line_and_a_dev_build_is_the_app() {
        assert_eq!(cli_arguments("/Users/casey/.local/bin/arbor", Some("Arbor"), rest(&["status"])), Some(rest(&["status"])));
        assert_eq!(cli_arguments("arbor", Some("Arbor"), rest(&[])), Some(rest(&[])));
        assert_eq!(cli_arguments("target/debug/arbor", Some("arbor"), rest(&[])), None);
        assert_eq!(cli_arguments("/Applications/Arbor.app/Contents/MacOS/Arbor", Some("Arbor"), rest(&[])), None);
        assert_eq!(cli_arguments("Arbor", Some("Arbor"), rest(&["cli", "doctor"])), Some(rest(&["doctor"])));
        assert_eq!(cli_arguments("Arbor", Some("Arbor"), rest(&["--portable-update-helper", "x"])), None);
    }
}

/// A fresh folder of its own for a test.
#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    // Short, since a socket made inside it has to fit in a socket path.
    let dir = std::env::temp_dir().join(format!("acli-{name}-{}", stamp % 1_000_000_000));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
