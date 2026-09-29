//! The main window at launch. tauri.conf.json creates it hidden; it's shown once the page reports
//! its first paint (`frontend_ready`), on the page's own background color, so it never opens on
//! an empty or wrongly colored frame. A page that never loads still gets its window after a short
//! wait, and a silent start keeps it hidden until it's opened from the tray.

use super::*;
use tauri::window::Color;

/// How long launch waits for the page before showing the window anyway.
const FRONTEND_READY_FALLBACK: Duration = Duration::from_millis(1_500);

/// The page's `--background` token in sRGB. WINDOW_BACKGROUND in src/theme.ts and the pre-paint
/// script in index.html use the same values.
const LIGHT_BACKGROUND: Color = Color(0xfc, 0xfc, 0xfc, 0xff);
const DARK_BACKGROUND: Color = Color(0x0a, 0x0a, 0x0a, 0xff);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LaunchWindow {
    /// Silent start: the window waits in the tray until it's opened from there.
    StayHidden,
    /// Shown when the page has painted, or after `fallback` if it never says so.
    ShowWhenReady { fallback: Duration },
}

pub(crate) fn launch_window(start_hidden: bool) -> LaunchWindow {
    if start_hidden {
        LaunchWindow::StayHidden
    } else {
        LaunchWindow::ShowWhenReady {
            fallback: FRONTEND_READY_FALLBACK,
        }
    }
}

/// The window color for the theme the page resolved (`light` or `dark`); anything else is ignored.
pub(crate) fn page_background(theme: &str) -> Option<Color> {
    match theme {
        "light" => Some(LIGHT_BACKGROUND),
        "dark" => Some(DARK_BACKGROUND),
        _ => None,
    }
}

/// Without word from the page, the system appearance is the best guess at its theme.
pub(crate) fn system_background(theme: tauri::Theme) -> Color {
    match theme {
        tauri::Theme::Dark => DARK_BACKGROUND,
        _ => LIGHT_BACKGROUND,
    }
}

/// Whether launch still owes the window its first show. The page's signal and the fallback race
/// for it, and only the first shows the window; opening it from the tray or Dock settles it too,
/// so a late signal can't bring back a window closed in the meantime.
#[derive(Default)]
pub(crate) struct LaunchShowState(AtomicBool);

impl LaunchShowState {
    fn arm(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// True for exactly one caller after `arm`.
    pub(crate) fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

/// The window has been shown some other way, so launch no longer shows it.
pub(crate) fn settle_launch_show(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<LaunchShowState>() {
        state.take();
    }
}

pub(crate) fn configure_initial_main_window(
    app_handle: &tauri::AppHandle,
    start_hidden: bool,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Main window does not exist".to_string())?;

    // The Dock icon shows now; the window follows once the page has painted.
    #[cfg(target_os = "macos")]
    set_macos_dock_visible(app_handle, !start_hidden);

    match launch_window(start_hidden) {
        LaunchWindow::StayHidden => window
            .hide()
            .map_err(|error| format!("Failed to hide main window during silent startup: {error}")),
        LaunchWindow::ShowWhenReady { fallback } => {
            app_handle.state::<LaunchShowState>().arm();
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(fallback).await;
                let main_thread_handle = app_handle.clone();
                let scheduled = app_handle.run_on_main_thread(move || {
                    let Some(window) = main_thread_handle.get_webview_window("main") else {
                        return;
                    };
                    if !main_thread_handle.state::<LaunchShowState>().take() {
                        return;
                    }
                    eprintln!("The interface didn't report its first paint; showing the main window anyway");
                    let background = window
                        .theme()
                        .map(system_background)
                        .unwrap_or(LIGHT_BACKGROUND);
                    reveal_at_launch(&window, background);
                });
                if let Err(error) = scheduled {
                    eprintln!("Failed to schedule showing the main window: {error}");
                }
            });
            Ok(())
        }
    }
}

fn reveal_at_launch(window: &tauri::WebviewWindow, background: Color) {
    // Paints the frame's first moments, and anything the page hasn't drawn yet, in the page's color.
    if let Err(error) = window.set_background_color(Some(background)) {
        eprintln!("Failed to set the main window background: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("Failed to show main window: {error}");
        return;
    }
    if window.is_minimized().unwrap_or(false) {
        if let Err(error) = window.unminimize() {
            eprintln!("Failed to restore main window: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        eprintln!("Failed to focus main window: {error}");
    }
}

/// The page has committed and painted its first frame, in `theme` (`light` or `dark`). Shows the
/// window if launch is still waiting for it; after that, including on reloads, it does nothing.
#[tauri::command]
pub(crate) fn frontend_ready(
    window: tauri::WebviewWindow,
    launch: tauri::State<'_, LaunchShowState>,
    theme: Option<String>,
) {
    if window.label() != "main" || !launch.take() {
        return;
    }
    let background = theme
        .as_deref()
        .and_then(page_background)
        .or_else(|| window.theme().ok().map(system_background))
        .unwrap_or(LIGHT_BACKGROUND);
    reveal_at_launch(&window, background);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_of_the_page_and_the_fallback_shows_the_window() {
        let state = LaunchShowState::default();
        assert!(!state.take(), "nothing is owed before launch arms it");
        state.arm();
        assert!(state.take());
        assert!(!state.take());
    }
}
