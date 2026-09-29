//! Arbor's bundle id, and the move of data kept under the id earlier versions used.
//!
//! macOS names an app's folders after its bundle id: its data under ~/Library/Application Support, and the window's
//! saved state under ~/Library/WebKit. Earlier versions ran as `com.cpa.gui`, the id Arbor was forked with, which
//! EasyCLIProxyAPI still uses. The first launch as `onl.arbor.app` moves Arbor's data into the new folder and copies
//! the window's state; a folder that belongs to EasyCLIProxyAPI is left alone.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// The bundle id `tauri.conf.json` gives the app; a test checks the two agree.
pub(crate) const APP_IDENTIFIER: &str = "onl.arbor.app";
const LEGACY_IDENTIFIER: &str = "com.cpa.gui";

/// Files only Arbor keeps in its data folder.
const ARBOR_ONLY_FILES: [&str; 4] = [
    "product-analytics.json",
    "agent-telemetry.json",
    "phone-alert-secrets.json",
    "session-archive",
];
/// Settings only Arbor writes to config.toml. Every version since the zoom setting writes `zoom-step`.
const ARBOR_ONLY_SETTINGS: [&str; 3] = ["zoom-step", "client-key-names", "paused-api-keys"];

fn application_support(home: &Path) -> PathBuf {
    home.join("Library").join("Application Support")
}

/// The installed app's data folder. It's the new id's, unless Arbor's data is still in the old folder because moving it
/// failed; then Arbor keeps running from there.
pub(crate) fn macos_data_dir(home: &Path) -> PathBuf {
    let support = application_support(home);
    let current = support.join(APP_IDENTIFIER);
    let legacy = support.join(LEGACY_IDENTIFIER);
    if !current.exists() && holds_arbor_data(&legacy) {
        legacy
    } else {
        current
    }
}

/// Whether a folder under the old id is Arbor's rather than EasyCLIProxyAPI's.
fn holds_arbor_data(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    ARBOR_ONLY_FILES.iter().any(|name| dir.join(name).exists())
        || fs::read_to_string(dir.join(super::GUI_CONFIG_FILE)).is_ok_and(|content| {
            content.lines().any(|line| {
                ARBOR_ONLY_SETTINGS.iter().any(|key| {
                    line.trim_start()
                        .strip_prefix(key)
                        .is_some_and(|rest| rest.trim_start().starts_with('='))
                })
            })
        })
}

/// Moves Arbor's data from the old id's folder to the new one's, once, and says whether it did. The old path is left
/// as a link to the new folder, because some things still name it: the core an update kept running, the old version if
/// an update is rolled back, and any setting that saved a full path. The window's state is copied rather than moved, so
/// a rolled-back version still has its own.
pub(crate) fn move_legacy_data(home: &Path) -> Result<bool, String> {
    let support = application_support(home);
    let current = support.join(APP_IDENTIFIER);
    let legacy = support.join(LEGACY_IDENTIFIER);
    if fs::symlink_metadata(&current).is_ok() {
        return Ok(false);
    }
    let legacy_is_folder = fs::symlink_metadata(&legacy).is_ok_and(|metadata| metadata.is_dir());
    if !legacy_is_folder || !holds_arbor_data(&legacy) {
        return Ok(false);
    }
    // A failed copy only costs the window's saved choices, so it doesn't hold the data back.
    if let Err(error) = copy_window_state(home) {
        eprintln!("Couldn't copy the window's saved state from {LEGACY_IDENTIFIER}: {error}");
    }
    fs::rename(&legacy, &current).map_err(|error| {
        format!(
            "Couldn't move {} to {}: {error}",
            legacy.display(),
            current.display()
        )
    })?;
    if let Err(error) = std::os::unix::fs::symlink(&current, &legacy) {
        eprintln!("Couldn't leave a link at {}: {error}", legacy.display());
    }
    Ok(true)
}

/// Copies WebKit's storage for the old id (the webview's localStorage, where most of the window's choices are kept) to
/// the new id's folder, unless that one exists already. It goes in whole or not at all.
fn copy_window_state(home: &Path) -> io::Result<()> {
    let webkit = home.join("Library").join("WebKit");
    let from = webkit.join(LEGACY_IDENTIFIER);
    let to = webkit.join(APP_IDENTIFIER);
    if !from.is_dir() || fs::symlink_metadata(&to).is_ok() {
        return Ok(());
    }
    let partial = webkit.join(format!("{APP_IDENTIFIER}.partial"));
    let _ = fs::remove_dir_all(&partial);
    let copied = copy_tree(&from, &partial).and_then(|()| fs::rename(&partial, &to));
    if copied.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    copied
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        } else if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(entry.path())?, &target)?;
        }
        // Anything else, like a socket, belongs to a running WebKit rather than to what it saved.
    }
    Ok(())
}

/// The move, for the installed app at launch, before anything reads the data folder or opens the window. A
/// development build keeps its data beside its executable and has nothing to move.
pub(crate) fn move_legacy_data_at_launch() {
    let Ok(executable_dir) = super::executable_dir() else {
        return;
    };
    if super::macos_app_resources_dir(&executable_dir).is_none() {
        return;
    }
    let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()).map(PathBuf::from) else {
        return;
    };
    match move_legacy_data(&home) {
        Ok(true) => eprintln!("Moved Arbor's data from {LEGACY_IDENTIFIER} to {APP_IDENTIFIER}"),
        Ok(false) => {}
        Err(error) => eprintln!("Arbor's data stays in its old folder for now: {error}"),
    }
}
