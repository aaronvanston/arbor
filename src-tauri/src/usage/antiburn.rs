//! Antiburn, a desktop app for looking into agent sessions. It reads the transcripts on the Mac it runs on, so the
//! session page offers it for a session whose transcript is here, and says where to get it when it isn't installed.
//! Antiburn has no link to a session, so opening it opens the app.

use super::machine_health::t3_threads;
use super::machine_health::MachineHealthState;
use super::*;

/// Antiburn's bundle id, which its Info.plist carries whether it's written as XML or binary.
const BUNDLE_ID: &[u8] = b"ai.antiburn.desktop";

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AntiburnStatus {
    /// Antiburn is in /Applications or ~/Applications.
    installed: bool,
    /// This Mac, as the Machines page names it, so the page can tell a session's transcript is on it.
    this_machine: String,
}

/// Where Antiburn is on this Mac: its installer puts it in /Applications, and a copy dragged in may be in
/// ~/Applications.
fn installed_app() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications"));
    [Some(PathBuf::from("/Applications")), home].into_iter().flatten().map(|folder| folder.join("antiburn.app")).find(|app| is_antiburn(app))
}

fn is_antiburn(app: &Path) -> bool {
    fs::read(app.join("Contents").join("Info.plist")).is_ok_and(|plist| plist.windows(BUNDLE_ID.len()).any(|window| window == BUNDLE_ID))
}

#[tauri::command]
pub(crate) async fn get_antiburn(state: tauri::State<'_, MachineHealthState>) -> Result<AntiburnStatus, String> {
    Ok(AntiburnStatus { installed: installed_app().is_some(), this_machine: t3_threads::this_machine(&state) })
}

#[tauri::command]
pub(crate) async fn open_antiburn(app: tauri::AppHandle) -> Result<(), String> {
    let path = installed_app().ok_or("Antiburn isn't in Applications on this Mac")?;
    crate::system_open::open_with_system(&app, &path.to_string_lossy(), None).map_err(|error| format!("Failed to open Antiburn: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_plist(name: &str, plist: Option<&str>) -> PathBuf {
        let app = std::env::temp_dir().join(format!("arbor-antiburn-{name}-{}", std::process::id())).join("antiburn.app");
        let _ = fs::remove_dir_all(&app);
        fs::create_dir_all(app.join("Contents")).unwrap();
        if let Some(plist) = plist {
            fs::write(app.join("Contents").join("Info.plist"), plist).unwrap();
        }
        app
    }

    #[test]
    fn only_an_app_whose_plist_names_antiburn_counts() {
        let antiburn = app_with_plist("real", Some("<key>CFBundleIdentifier</key>\n<string>ai.antiburn.desktop</string>"));
        let other = app_with_plist("other", Some("<key>CFBundleIdentifier</key>\n<string>dev.example.antiburn</string>"));
        let empty = app_with_plist("empty", None);
        assert!(is_antiburn(&antiburn));
        assert!(!is_antiburn(&other));
        assert!(!is_antiburn(&empty));
        for app in [antiburn, other, empty] {
            let _ = fs::remove_dir_all(app.parent().unwrap());
        }
    }
}
