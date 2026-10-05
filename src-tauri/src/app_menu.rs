//! The app menu's own items beside About: Check for Updates… and Settings… (⌘,), as other Mac apps
//! have them. Picking one shows the window and hands it the action, since the window owns both the
//! update checks and Settings.

use super::*;

/// Emitted with an `AppMenuAction` when one of the app menu's own items is picked, after the window is shown.
#[cfg(target_os = "macos")]
const APP_MENU_ACTION_EVENT: &str = "app-menu-action";
#[cfg(target_os = "macos")]
pub(crate) const CHECK_FOR_UPDATES_MENU_ID: &str = "app-check-for-updates";
#[cfg(target_os = "macos")]
pub(crate) const SETTINGS_MENU_ID: &str = "app-settings";
#[cfg(target_os = "macos")]
pub(crate) const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";

/// What an app menu item asks the window to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppMenuAction {
    /// Open Settings › Updates and check for both a new Arbor and a new core.
    CheckForUpdates,
    OpenSettings,
}

#[cfg(target_os = "macos")]
fn menu_action(id: &str) -> Option<AppMenuAction> {
    match id {
        CHECK_FOR_UPDATES_MENU_ID => Some(AppMenuAction::CheckForUpdates),
        SETTINGS_MENU_ID => Some(AppMenuAction::OpenSettings),
        _ => None,
    }
}

/// Shows the window and hands it the action behind an app menu item; any other id is left alone.
#[cfg(target_os = "macos")]
pub(crate) fn run_app_menu_action(app_handle: &tauri::AppHandle, id: &str) {
    let Some(action) = menu_action(id) else {
        return;
    };
    show_main_window(app_handle);
    if let Err(error) = app_handle.emit(APP_MENU_ACTION_EVENT, action) {
        eprintln!("Failed to pass on the app menu action: {error}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_menus_own_items_have_an_action() {
        assert_eq!(
            menu_action(CHECK_FOR_UPDATES_MENU_ID),
            Some(AppMenuAction::CheckForUpdates)
        );
        assert_eq!(menu_action(SETTINGS_MENU_ID), Some(AppMenuAction::OpenSettings));
        assert_eq!(menu_action(quit_guard::QUIT_MENU_ID), None);
        assert_eq!(menu_action("quit"), None);
    }
}
