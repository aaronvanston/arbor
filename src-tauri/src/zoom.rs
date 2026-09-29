//! The window's zoom: Actual Size, Zoom In and Zoom Out in the View menu (⌘0, ⌘= and ⌘−), the row on
//! Settings › Appearance and the search palette's actions. WKWebView has no zoom keys of its own and
//! Tauri can't read a level back, so Arbor keeps it: saved as a step in its settings file, put on the
//! main webview with `set_zoom` before the window shows (and again on every page load), and sent to
//! the page, whose Mac title row divides its sizes by the factor to stay in points (styles.css).

use super::*;

/// T3's steps: each is 1.2^(n/2), so 83%, 91%, 100%, 110%, 120%, 131% and 144%. The Mac window
/// buttons don't zoom, so the 52pt title row keeps its size on screen while the 28px controls in it
/// grow; at 144% they're 40pt, which leaves them room.
pub(crate) const ZOOM_MIN_STEP: i32 = -2;
pub(crate) const ZOOM_MAX_STEP: i32 = 4;

/// Sent with the new `ZoomLevel` whenever the level changes, from the menu or from the page.
pub(crate) const ZOOM_CHANGED_EVENT: &str = "zoom-changed";

pub(crate) const VIEW_SUBMENU_ID: &str = "view";
pub(crate) const ACTUAL_SIZE_MENU_ID: &str = "view-actual-size";
pub(crate) const ZOOM_IN_MENU_ID: &str = "view-zoom-in";
pub(crate) const ZOOM_OUT_MENU_ID: &str = "view-zoom-out";
pub(crate) const ACTUAL_SIZE_ACCELERATOR: &str = "CmdOrCtrl+0";
pub(crate) const ZOOM_IN_ACCELERATOR: &str = "CmdOrCtrl+=";
pub(crate) const ZOOM_OUT_ACCELERATOR: &str = "CmdOrCtrl+-";

/// A zoom step and the factor the webview is zoomed by for it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZoomLevel {
    step: i32,
    factor: f64,
}

impl ZoomLevel {
    pub(crate) fn at(step: i32) -> Self {
        let step = clamp_zoom_step(step);
        Self {
            step,
            factor: zoom_factor(step),
        }
    }

    fn can_zoom_in(self) -> bool {
        self.step < ZOOM_MAX_STEP
    }

    fn can_zoom_out(self) -> bool {
        self.step > ZOOM_MIN_STEP
    }
}

pub(crate) fn clamp_zoom_step(step: i32) -> i32 {
    step.clamp(ZOOM_MIN_STEP, ZOOM_MAX_STEP)
}

pub(crate) fn zoom_factor(step: i32) -> f64 {
    1.2_f64.powf(f64::from(clamp_zoom_step(step)) / 2.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ZoomChange {
    In,
    Out,
    Reset,
}

impl ZoomChange {
    fn step_from(self, step: i32) -> i32 {
        clamp_zoom_step(match self {
            Self::In => step.saturating_add(1),
            Self::Out => step.saturating_sub(1),
            Self::Reset => 0,
        })
    }
}

/// The change a View menu item makes, or None for an item that isn't one of the zoom's.
pub(crate) fn menu_zoom_change(id: &str) -> Option<ZoomChange> {
    match id {
        ACTUAL_SIZE_MENU_ID => Some(ZoomChange::Reset),
        ZOOM_IN_MENU_ID => Some(ZoomChange::In),
        ZOOM_OUT_MENU_ID => Some(ZoomChange::Out),
        _ => None,
    }
}

impl GuiConfigState {
    /// Moves the saved step in one write, so two changes in a row can't both start from the same one.
    fn change_zoom_step(&self, change: impl FnOnce(i32) -> i32) -> Result<ZoomLevel, String> {
        let config = self.update(|config| {
            config.zoom_step = clamp_zoom_step(change(config.zoom_step));
            Ok(())
        })?;
        Ok(ZoomLevel::at(config.zoom_step))
    }
}

/// Zooms the main webview and grays out Zoom In or Zoom Out at either end.
fn apply_zoom(app: &tauri::AppHandle, level: ZoomLevel) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.set_zoom(level.factor) {
            eprintln!("Failed to zoom the window: {error}");
        }
    }
    #[cfg(target_os = "macos")]
    sync_zoom_menu(app, level);
}

#[cfg(target_os = "macos")]
fn sync_zoom_menu(app: &tauri::AppHandle, level: ZoomLevel) {
    let Some(view) = app
        .menu()
        .and_then(|menu| menu.get(VIEW_SUBMENU_ID))
        .and_then(|item| item.as_submenu().cloned())
    else {
        return;
    };
    for (id, enabled) in [
        (ZOOM_IN_MENU_ID, level.can_zoom_in()),
        (ZOOM_OUT_MENU_ID, level.can_zoom_out()),
    ] {
        if let Some(item) = view.get(id).and_then(|item| item.as_menuitem().cloned()) {
            if let Err(error) = item.set_enabled(enabled) {
                eprintln!("Failed to update the {id} menu item: {error}");
            }
        }
    }
}

/// The saved level, put on the window at launch before it's shown.
pub(crate) fn apply_saved_zoom(app: &tauri::AppHandle) {
    match app.state::<GuiConfigState>().snapshot() {
        Ok(config) => apply_zoom(app, ZoomLevel::at(config.zoom_step)),
        Err(error) => eprintln!("Failed to read the saved zoom: {error}"),
    }
}

/// Puts the saved level on the main webview again as a page starts loading, so a reload can't leave
/// the page at one zoom while the settings, and the page's own sizes, say another.
pub(crate) fn reapply_zoom_on_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if webview.label() != "main" || payload.event() != tauri::webview::PageLoadEvent::Started {
        return;
    }
    let Some(state) = webview.try_state::<GuiConfigState>() else {
        return;
    };
    if let Ok(config) = state.snapshot() {
        if let Err(error) = webview.set_zoom(ZoomLevel::at(config.zoom_step).factor) {
            eprintln!("Failed to zoom the window: {error}");
        }
    }
}

/// Puts a level that's been saved on the window and the menu, and tells the page.
fn show_zoom(app: &tauri::AppHandle, level: ZoomLevel) {
    apply_zoom(app, level);
    if let Err(error) = app.emit(ZOOM_CHANGED_EVENT, level) {
        eprintln!("Failed to tell the page about the zoom: {error}");
    }
}

fn change_zoom(
    app: &tauri::AppHandle,
    change: impl FnOnce(i32) -> i32,
) -> Result<ZoomLevel, String> {
    let level = app.state::<GuiConfigState>().change_zoom_step(change)?;
    show_zoom(app, level);
    Ok(level)
}

/// The level a settings file changed outside Arbor moves the window to, or None when, within the range, it's the
/// one the window is at already.
fn external_zoom_change(before: i32, after: i32) -> Option<ZoomLevel> {
    let (before, after) = (ZoomLevel::at(before), ZoomLevel::at(after));
    (before != after).then_some(after)
}

/// The settings file was edited, or restored from a copy, with another zoom while Arbor was open. The window, the
/// menu and the page go to it as they would for a change made here; otherwise they'd stay where they were while the
/// next ⌘− stepped from a level nobody could see, and a reload jumped to it without a word.
pub(crate) fn follow_external_zoom(app: &tauri::AppHandle, before: i32, after: i32) {
    if let Some(level) = external_zoom_change(before, after) {
        show_zoom(app, level);
    }
}

/// A zoom item chosen in the View menu, by mouse or by its keys.
pub(crate) fn press_zoom(app: &tauri::AppHandle, change: ZoomChange) {
    if let Err(error) = change_zoom(app, |step| change.step_from(step)) {
        eprintln!("Failed to save the zoom: {error}");
    }
}

/// The level the page draws its first frame at.
#[tauri::command]
pub(crate) fn get_zoom_level(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ZoomLevel, String> {
    Ok(ZoomLevel::at(gui_config_state.snapshot()?.zoom_step))
}

/// Settings › Appearance and the palette: go to `step`, brought within the range, and save it.
#[tauri::command]
pub(crate) fn set_zoom_level(app: tauri::AppHandle, step: i32) -> Result<ZoomLevel, String> {
    change_zoom(&app, |_| step)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_steps_are_t3s_from_83_to_144_percent() {
        let percents = (ZOOM_MIN_STEP..=ZOOM_MAX_STEP)
            .map(|step| (zoom_factor(step) * 100.0).round() as i32)
            .collect::<Vec<_>>();
        assert_eq!(percents, vec![83, 91, 100, 110, 120, 131, 144]);
        assert_eq!(zoom_factor(0), 1.0);
        assert!((zoom_factor(2) - 1.2).abs() < 1e-12);
    }

    #[test]
    fn a_step_past_either_end_stops_there() {
        assert_eq!(clamp_zoom_step(-9), ZOOM_MIN_STEP);
        assert_eq!(clamp_zoom_step(9), ZOOM_MAX_STEP);
        assert_eq!(clamp_zoom_step(i32::MAX), ZOOM_MAX_STEP);
        assert_eq!(ZoomLevel::at(7), ZoomLevel::at(ZOOM_MAX_STEP));
        assert_eq!(ZoomChange::In.step_from(ZOOM_MAX_STEP), ZOOM_MAX_STEP);
        assert_eq!(ZoomChange::Out.step_from(ZOOM_MIN_STEP), ZOOM_MIN_STEP);
        assert_eq!(ZoomChange::In.step_from(i32::MAX), ZOOM_MAX_STEP);
        assert_eq!(ZoomChange::In.step_from(1), 2);
        assert_eq!(ZoomChange::Out.step_from(1), 0);
        assert_eq!(ZoomChange::Reset.step_from(3), 0);
    }

    #[test]
    fn zoom_in_and_out_are_grayed_out_only_at_their_own_end() {
        assert!(!ZoomLevel::at(ZOOM_MAX_STEP).can_zoom_in());
        assert!(ZoomLevel::at(ZOOM_MAX_STEP).can_zoom_out());
        assert!(!ZoomLevel::at(ZOOM_MIN_STEP).can_zoom_out());
        assert!(ZoomLevel::at(ZOOM_MIN_STEP).can_zoom_in());
        assert!(ZoomLevel::at(0).can_zoom_in() && ZoomLevel::at(0).can_zoom_out());
    }

    #[test]
    fn each_zoom_menu_item_makes_its_own_change_and_other_items_none() {
        assert_eq!(
            menu_zoom_change(ACTUAL_SIZE_MENU_ID),
            Some(ZoomChange::Reset)
        );
        assert_eq!(menu_zoom_change(ZOOM_IN_MENU_ID), Some(ZoomChange::In));
        assert_eq!(menu_zoom_change(ZOOM_OUT_MENU_ID), Some(ZoomChange::Out));
        #[cfg(target_os = "macos")]
        assert_eq!(menu_zoom_change(quit_guard::QUIT_MENU_ID), None);
        // The tray menu's items reach the same handler.
        for other in ["quit", "open-main-window", "tray-limits-0", VIEW_SUBMENU_ID, ""] {
            assert_eq!(menu_zoom_change(other), None);
        }
    }

    #[test]
    fn a_settings_file_changed_outside_arbor_moves_the_zoom_only_to_a_new_level() {
        assert_eq!(external_zoom_change(0, 3), Some(ZoomLevel::at(3)));
        assert_eq!(external_zoom_change(2, 0), Some(ZoomLevel::at(0)));
        // Out of range, it goes to the end it's past, as a change made in Arbor would.
        assert_eq!(external_zoom_change(0, 12), Some(ZoomLevel::at(ZOOM_MAX_STEP)));
        assert_eq!(external_zoom_change(0, -40), Some(ZoomLevel::at(ZOOM_MIN_STEP)));
        // An edit to something else, or one past the end the window is already at, leaves it be.
        assert_eq!(external_zoom_change(1, 1), None);
        assert_eq!(external_zoom_change(ZOOM_MAX_STEP, 12), None);
        assert_eq!(external_zoom_change(ZOOM_MIN_STEP, i32::MIN), None);
    }

    /// Tauri reads a menu item's accelerator as muda's key-code `Accelerator` and quietly drops one
    /// it can't read, which would leave the item with no keys at all.
    #[test]
    fn the_zoom_keys_are_accelerators_tauri_can_read_and_plus_is_not() {
        use muda::accelerator::{Accelerator, Code, Modifiers};
        let read = |accelerator: &str| accelerator.parse::<Accelerator>();
        let command = Modifiers::SUPER;
        for (accelerator, key) in [
            (ACTUAL_SIZE_ACCELERATOR, Code::Digit0),
            (ZOOM_IN_ACCELERATOR, Code::Equal),
            (ZOOM_OUT_ACCELERATOR, Code::Minus),
        ] {
            let parsed = read(accelerator).unwrap();
            assert_eq!((parsed.modifiers(), parsed.key()), (command, key));
        }
        // T3 also zooms in on ⌘+ with a hidden second item. Tauri's menu items can't take it: a
        // physical key code has no plus of its own, and muda can't hide an item on macOS anyway.
        for plus in ["CmdOrCtrl+Plus", "CmdOrCtrl++"] {
            assert!(read(plus).is_err(), "{plus} now parses; ⌘+ could be added");
        }
    }
}
