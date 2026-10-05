//! ⌘Q on macOS. Quitting stops the core every machine's agents go through, so while it runs the
//! first ⌘Q only warns and a second one soon after quits. Choosing Quit from the menu with the
//! mouse isn't an accident, so it quits straight away.

use super::*;
#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};

/// How long after the first ⌘Q a second one quits: long enough to read the warning and press again.
const QUIT_GUARD_WINDOW: Duration = Duration::from_millis(3_000);
#[cfg(target_os = "macos")]
const QUIT_GUARD_ARMED_EVENT: &str = "quit-guard-armed";
/// Not "quit": the tray menu's own Quit uses that id and hears every menu event.
#[cfg(target_os = "macos")]
pub(crate) const QUIT_MENU_ID: &str = "app-quit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuitPress {
    Quit,
    /// Held back: warn, and quit if another press comes within the window.
    Warn,
}

#[derive(Debug)]
pub(crate) struct QuitGuard {
    enabled: bool,
    armed_at: Option<Instant>,
}

impl Default for QuitGuard {
    fn default() -> Self {
        // On until the interface says otherwise, so a ⌘Q before it has loaded is still caught.
        Self {
            enabled: true,
            armed_at: None,
        }
    }
}

impl QuitGuard {
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.armed_at = None;
    }

    /// What a ⌘Q at `now` does. `core_running` is only asked when the answer depends on it, since
    /// finding a core Arbor didn't start itself means listing processes.
    pub(crate) fn press(&mut self, now: Instant, core_running: impl FnOnce() -> bool) -> QuitPress {
        let armed_at = self.armed_at.take();
        if !self.enabled {
            return QuitPress::Quit;
        }
        if armed_at
            .is_some_and(|armed_at| now.saturating_duration_since(armed_at) <= QUIT_GUARD_WINDOW)
        {
            return QuitPress::Quit;
        }
        if !core_running() {
            return QuitPress::Quit;
        }
        self.armed_at = Some(now);
        QuitPress::Warn
    }
}

#[derive(Default)]
pub(crate) struct QuitGuardState(Mutex<QuitGuard>);

impl QuitGuardState {
    fn guard(&self) -> std::sync::MutexGuard<'_, QuitGuard> {
        // Two plain fields: a panic elsewhere can't leave them half-written.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[tauri::command]
pub(crate) fn set_quit_guard(state: tauri::State<'_, QuitGuardState>, enabled: bool) {
    state.guard().set_enabled(enabled);
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitGuardArmed {
    window_ms: u64,
}

/// Tauri's default macOS menu with Arbor's own Quit, zoom, Check for Updates and Settings items. The built-in Quit ends the app
/// without asking the event loop first, so nothing could hold it back.
#[cfg(target_os = "macos")]
pub(crate) fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let quit = MenuItem::with_id(
        app,
        QUIT_MENU_ID,
        format!("Quit {}", package.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_submenu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &MenuItem::with_id(
                app,
                app_menu::CHECK_FOR_UPDATES_MENU_ID,
                "Check for Updates…",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                app_menu::SETTINGS_MENU_ID,
                "Settings…",
                true,
                Some(app_menu::SETTINGS_ACCELERATOR),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;
    // Text fields rely on these for undo, clipboard and select all.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    // Arbor's own items rather than the webview's, which WKWebView doesn't have; zoom.rs keeps the
    // level. The id lets it find Zoom In and Zoom Out again to gray them out at either end.
    let view = Submenu::with_id_and_items(
        app,
        zoom::VIEW_SUBMENU_ID,
        "View",
        true,
        &[
            &MenuItem::with_id(
                app,
                zoom::ACTUAL_SIZE_MENU_ID,
                "Actual Size",
                true,
                Some(zoom::ACTUAL_SIZE_ACCELERATOR),
            )?,
            &MenuItem::with_id(
                app,
                zoom::ZOOM_IN_MENU_ID,
                "Zoom In",
                true,
                Some(zoom::ZOOM_IN_ACCELERATOR),
            )?,
            &MenuItem::with_id(
                app,
                zoom::ZOOM_OUT_MENU_ID,
                "Zoom Out",
                true,
                Some(zoom::ZOOM_OUT_ACCELERATOR),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    // The ids let Tauri hand these to macOS as the app's Window and Help menus.
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(app, &[&app_submenu, &file, &edit, &view, &window, &help])
}

/// Whether an event is a mouse click with ⌘ up: Quit chosen from the menu rather than ⌘Q.
#[cfg(target_os = "macos")]
fn is_menu_click(
    kind: objc2_app_kit::NSEventType,
    modifiers: objc2_app_kit::NSEventModifierFlags,
) -> bool {
    use objc2_app_kit::{NSEventModifierFlags, NSEventType};
    matches!(
        kind,
        NSEventType::LeftMouseDown
            | NSEventType::LeftMouseUp
            | NSEventType::RightMouseDown
            | NSEventType::RightMouseUp
            | NSEventType::OtherMouseDown
            | NSEventType::OtherMouseUp
    ) && !modifiers.contains(NSEventModifierFlags::Command)
}

/// Whether Quit was chosen from the menu with the mouse. The menu event reaches Arbor a moment
/// after the click or key press, so anything but a plain click, and ⌘ still held, counts as ⌘Q:
/// a mistake here only means a click that still warns, never a ⌘Q that quits at once.
#[cfg(target_os = "macos")]
fn quit_chosen_with_the_mouse() -> bool {
    use objc2_app_kit::{NSApplication, NSEvent};
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return false;
    };
    NSApplication::sharedApplication(mtm)
        .currentEvent()
        // ⌘ held now, not only in the event, also means a key press.
        .is_some_and(|event| {
            is_menu_click(
                event.r#type(),
                event.modifierFlags() | NSEvent::modifierFlags_class(),
            )
        })
}

/// Arbor's Quit menu item, ⌘Q. Quitting goes through `exit`, so the core is still stopped on the
/// way out as before.
#[cfg(target_os = "macos")]
pub(crate) fn press_quit(app: &tauri::AppHandle) {
    if quit_chosen_with_the_mouse() {
        app.exit(0);
        return;
    }
    let press = app
        .state::<QuitGuardState>()
        .guard()
        .press(Instant::now(), || {
            managed_core_is_running(app.state::<CoreProcessState>().inner())
        });
    if press == QuitPress::Quit {
        app.exit(0);
        return;
    }
    // Hidden or minimized, the window would warn where no one sees it.
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            show_main_window(app);
        }
    }
    let armed = QuitGuardArmed {
        window_ms: QUIT_GUARD_WINDOW.as_millis() as u64,
    };
    if let Err(error) = app.emit(QUIT_GUARD_ARMED_EVENT, armed) {
        eprintln!("Failed to show the quit warning: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(start: Instant, milliseconds: u64) -> Instant {
        start + Duration::from_millis(milliseconds)
    }

    #[test]
    fn a_first_press_warns_while_the_core_runs_and_a_second_soon_after_quits() {
        let start = Instant::now();
        let mut guard = QuitGuard::default();
        assert_eq!(guard.press(start, || true), QuitPress::Warn);
        assert_eq!(guard.press(after(start, 600), || true), QuitPress::Quit);
    }

    #[test]
    fn the_second_press_counts_up_to_the_end_of_the_window() {
        let start = Instant::now();
        let mut guard = QuitGuard::default();
        guard.press(start, || true);
        assert_eq!(guard.press(after(start, 3_000), || true), QuitPress::Quit);

        let mut guard = QuitGuard::default();
        guard.press(start, || true);
        assert_eq!(guard.press(after(start, 3_001), || true), QuitPress::Warn);
    }

    #[test]
    fn a_late_second_press_warns_again_and_a_third_soon_after_quits() {
        let start = Instant::now();
        let mut guard = QuitGuard::default();
        guard.press(start, || true);
        assert_eq!(guard.press(after(start, 4_000), || true), QuitPress::Warn);
        assert_eq!(guard.press(after(start, 4_900), || true), QuitPress::Quit);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_a_plain_click_counts_as_choosing_quit_from_the_menu() {
        use objc2_app_kit::{NSEventModifierFlags as Flags, NSEventType as Kind};
        assert!(is_menu_click(Kind::LeftMouseUp, Flags::empty()));
        assert!(is_menu_click(Kind::LeftMouseDown, Flags::Option));
        assert!(is_menu_click(Kind::RightMouseUp, Flags::empty()));
        // ⌘Q itself, whichever of its events is current when the menu event arrives.
        assert!(!is_menu_click(Kind::KeyDown, Flags::Command));
        assert!(!is_menu_click(Kind::KeyUp, Flags::empty()));
        assert!(!is_menu_click(Kind::FlagsChanged, Flags::empty()));
        // A click with ⌘ down, or anything else, is taken as ⌘Q.
        assert!(!is_menu_click(Kind::LeftMouseUp, Flags::Command));
        assert!(!is_menu_click(Kind::MouseMoved, Flags::empty()));
        assert!(!is_menu_click(Kind::AppKitDefined, Flags::empty()));
    }

    #[test]
    fn quits_straight_away_when_the_core_is_not_running() {
        let start = Instant::now();
        let mut guard = QuitGuard::default();
        assert_eq!(guard.press(start, || false), QuitPress::Quit);
        // Nothing was armed, so a core that has started since is warned about afresh.
        assert_eq!(guard.press(after(start, 200), || true), QuitPress::Warn);
    }

    #[test]
    fn quits_straight_away_when_the_guard_is_off_without_looking_for_the_core() {
        let mut guard = QuitGuard::default();
        guard.set_enabled(false);
        assert_eq!(
            guard.press(Instant::now(), || panic!(
                "the core shouldn't be looked for"
            )),
            QuitPress::Quit
        );
    }

    #[test]
    fn the_second_press_quits_without_looking_for_the_core_again() {
        let start = Instant::now();
        let mut guard = QuitGuard::default();
        guard.press(start, || true);
        assert_eq!(
            guard.press(after(start, 300), || panic!(
                "the core shouldn't be looked for"
            )),
            QuitPress::Quit
        );
    }

    #[test]
    fn changing_the_setting_forgets_a_first_press() {
        let start = Instant::now();
        let mut guard = QuitGuard::default();
        guard.press(start, || true);
        guard.set_enabled(true);
        assert_eq!(guard.press(after(start, 300), || true), QuitPress::Warn);

        guard.set_enabled(false);
        guard.set_enabled(true);
        assert_eq!(guard.press(after(start, 600), || true), QuitPress::Warn);
    }
}
