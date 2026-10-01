//! What the command line may do, and putting `arbor` on the PATH. Both are Settings › Software › Command line; the
//! switches are kept beside the socket in the app's data folder, and the command line can't change them itself.

use super::audit;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use ts_rs::TS;

const SETTINGS_FILE: &str = "settings.json";
/// The name the command is linked under, and the one `main` looks for to run as the command line.
pub(crate) const COMMAND_NAME: &str = "arbor";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CliSettings {
    /// Whether the app answers the command line at all.
    pub(crate) enabled: bool,
    /// Whether it may change things, or only look.
    pub(crate) changes: bool,
}

impl Default for CliSettings {
    fn default() -> Self {
        Self { enabled: true, changes: true }
    }
}

fn read_from(dir: &Path) -> CliSettings {
    fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_to(dir: &Path, settings: CliSettings) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(dir.join(SETTINGS_FILE), text).map_err(|error| format!("Couldn't save the command line settings: {error}"))
}

/// The switches as saved; both on when nothing is.
pub(crate) fn read() -> CliSettings {
    super::cli_dir().map(|dir| read_from(&dir)).unwrap_or_default()
}

/// Where `arbor` stands on this Mac.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CliInstallState")]
pub(crate) enum InstallState {
    /// The link is there and runs this copy of Arbor.
    Installed,
    /// Nothing is at the link's place yet.
    Missing,
    /// A link runs another copy of Arbor, such as one moved or deleted since.
    Elsewhere,
    /// Something else is there, which Arbor leaves alone.
    Taken,
    /// This Arbor can't be linked to: it's a development build, or macOS is running it from a temporary copy.
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CliInstall")]
pub(crate) struct Install {
    pub(crate) state: InstallState,
    /// Where the link goes.
    pub(crate) link_path: String,
    /// What the link there runs now, when it's a link.
    pub(crate) target: Option<String>,
    /// The program a link should run: this copy of Arbor.
    pub(crate) executable: Option<String>,
}

/// This copy of Arbor's program, when it's an installed app a link can point at.
pub(crate) fn linkable_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let text = exe.to_string_lossy();
    let in_bundle = exe.parent().is_some_and(|dir| crate::macos_app_resources_dir(dir).is_some());
    (in_bundle && !text.contains("/AppTranslocation/")).then_some(exe)
}

fn link_path(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join(COMMAND_NAME)
}

/// Whether a link's target is an Arbor app's program, so replacing it can't take someone else's `arbor`.
fn runs_arbor(target: &Path) -> bool {
    let text = target.to_string_lossy();
    text.ends_with(".app/Contents/MacOS/Arbor")
}

pub(crate) fn install_status(home: &Path, executable: Option<&Path>) -> Install {
    let link = link_path(home);
    let target = fs::read_link(&link).ok();
    let state = match (executable, &target) {
        (None, _) => InstallState::Unavailable,
        (Some(exe), Some(target)) if target == exe => InstallState::Installed,
        (Some(_), Some(target)) if runs_arbor(target) => InstallState::Elsewhere,
        (Some(_), Some(_)) => InstallState::Taken,
        (Some(_), None) if link.symlink_metadata().is_ok() => InstallState::Taken,
        (Some(_), None) => InstallState::Missing,
    };
    Install {
        state,
        link_path: link.to_string_lossy().into_owned(),
        target: target.map(|target| target.to_string_lossy().into_owned()),
        executable: executable.map(|exe| exe.to_string_lossy().into_owned()),
    }
}

/// Links `~/.local/bin/arbor` to this Arbor, replacing only a link to another Arbor.
pub(crate) fn install_link(home: &Path, executable: Option<&Path>) -> Result<Install, String> {
    let status = install_status(home, executable);
    let Some(exe) = executable else {
        return Err("Only an installed Arbor, opened from Applications, can add the arbor command.".into());
    };
    let link = link_path(home);
    match status.state {
        InstallState::Installed => return Ok(status),
        InstallState::Taken => {
            return Err(format!("Something else is already at {}, so Arbor left it alone.", link.display()));
        }
        InstallState::Elsewhere => {
            fs::remove_file(&link).map_err(|error| format!("Couldn't replace {}: {error}", link.display()))?;
        }
        InstallState::Missing | InstallState::Unavailable => {}
    }
    if let Some(dir) = link.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
    }
    std::os::unix::fs::symlink(exe, &link).map_err(|error| format!("Couldn't link {}: {error}", link.display()))?;
    Ok(install_status(home, executable))
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "Can't find your home folder".to_string())
}

/// Everything Settings › Software › Command line shows.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliOverview {
    pub(crate) settings: CliSettings,
    pub(crate) install: Install,
    /// The latest requests, newest first.
    pub(crate) activity: Vec<audit::Entry>,
}

#[tauri::command]
pub(crate) fn get_cli_overview() -> Result<CliOverview, String> {
    let dir = super::cli_dir()?;
    Ok(CliOverview {
        settings: read_from(&dir),
        install: install_status(&home()?, linkable_executable().as_deref()),
        activity: audit::recent(&dir, audit::RECENT),
    })
}

#[tauri::command]
pub(crate) fn save_cli_settings(settings: CliSettings) -> Result<CliSettings, String> {
    write_to(&super::cli_dir()?, settings)?;
    Ok(settings)
}

/// Puts `arbor` on the PATH, at ~/.local/bin/arbor.
#[tauri::command]
pub(crate) fn install_cli_link() -> Result<CliInstallResult, String> {
    install_link(&home()?, linkable_executable().as_deref()).map(|install| CliInstallResult { install })
}

/// What `install_cli_link` did.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliInstallResult {
    pub(crate) install: Install,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_app(home: &Path, name: &str) -> PathBuf {
        let exe = home.join(format!("{name}.app/Contents/MacOS/Arbor"));
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "").unwrap();
        exe
    }

    #[test]
    fn the_switches_start_on_and_read_back_as_saved() {
        let dir = super::super::test_dir("settings");
        assert_eq!(read_from(&dir), CliSettings { enabled: true, changes: true });
        write_to(&dir, CliSettings { enabled: true, changes: false }).unwrap();
        assert_eq!(read_from(&dir), CliSettings { enabled: true, changes: false });
    }

    #[test]
    fn the_link_is_added_and_moves_with_arbor_but_never_takes_another_arbor_command() {
        let home = super::super::test_dir("install");
        let exe = fake_app(&home, "Arbor");
        assert_eq!(install_status(&home, None).state, InstallState::Unavailable);
        assert!(install_link(&home, None).is_err());
        assert_eq!(install_status(&home, Some(&exe)).state, InstallState::Missing);
        assert_eq!(install_link(&home, Some(&exe)).unwrap().state, InstallState::Installed);

        let moved = fake_app(&home, "Moved/Arbor");
        assert_eq!(install_status(&home, Some(&moved)).state, InstallState::Elsewhere);
        assert_eq!(install_link(&home, Some(&moved)).unwrap().state, InstallState::Installed);

        fs::remove_file(link_path(&home)).unwrap();
        fs::write(link_path(&home), "#!/bin/sh\n").unwrap();
        assert_eq!(install_status(&home, Some(&exe)).state, InstallState::Taken);
        assert!(install_link(&home, Some(&exe)).is_err());
        assert_eq!(fs::read_to_string(link_path(&home)).unwrap(), "#!/bin/sh\n");
    }
}
