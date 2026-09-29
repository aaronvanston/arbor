use super::*;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSString};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

/// The lines the app shows in the tray menu under "Open Main Window", in
/// sections that each end with a separator: the limits, then the sessions
/// running now.
pub(crate) struct TrayLinesState {
    menu: Menu<tauri::Wry>,
    sections: Mutex<TraySections>,
}

const TRAY_SECTIONS: [&str; 2] = ["limits", "sessions"];

#[derive(Default)]
struct TraySections {
    lines: [Vec<String>; TRAY_SECTIONS.len()],
    items: Vec<MenuItem<tauri::Wry>>,
    separators: Vec<PredefinedMenuItem<tauri::Wry>>,
}

impl TrayLinesState {
    fn new(menu: Menu<tauri::Wry>) -> Self {
        Self {
            menu,
            sections: Mutex::new(TraySections::default()),
        }
    }
}

#[tauri::command]
pub(crate) async fn set_tray_lines(
    app: tauri::AppHandle,
    section: String,
    lines: Vec<String>,
) -> Result<(), String> {
    let Some(state) = app.try_state::<TrayLinesState>() else {
        return Ok(());
    };
    let index = TRAY_SECTIONS
        .iter()
        .position(|name| *name == section)
        .ok_or_else(|| format!("There is no tray menu section called {section}."))?;
    let mut sections = state.sections.lock().map_err(|error| error.to_string())?;
    if sections.lines[index] == lines {
        return Ok(());
    }
    sections.lines[index] = lines;

    // Every section moves when one above it changes length, so all are put back.
    let TraySections {
        lines,
        items,
        separators,
    } = &mut *sections;
    for item in items.drain(..) {
        state.menu.remove(&item).map_err(|error| error.to_string())?;
    }
    for separator in separators.drain(..) {
        state
            .menu
            .remove(&separator)
            .map_err(|error| error.to_string())?;
    }
    let mut position = 1;
    for (name, section_lines) in TRAY_SECTIONS.iter().zip(lines.iter()) {
        if section_lines.is_empty() {
            continue;
        }
        for (line_index, line) in section_lines.iter().enumerate() {
            let item = MenuItem::with_id(
                &app,
                format!("tray-{name}-{line_index}"),
                line,
                false,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?;
            state
                .menu
                .insert(&item, position)
                .map_err(|error| error.to_string())?;
            items.push(item);
            position += 1;
        }
        let separator = PredefinedMenuItem::separator(&app).map_err(|error| error.to_string())?;
        state
            .menu
            .insert(&separator, position)
            .map_err(|error| error.to_string())?;
        separators.push(separator);
        position += 1;
    }
    Ok(())
}

/// Dot radius and the transparent gap cut around it, as fractions of the icon's size.
const STATUS_DOT_RADIUS: f32 = 0.18;
const STATUS_DOT_GAP: f32 = 0.05;

/// The indicator the tray icon is showing, so its dot can be redrawn when the menu bar changes color.
static TRAY_INDICATOR: Mutex<String> = Mutex::new(String::new());

/// Marks the tray icon with a dot while a provider's status page reports a problem, colored like
/// the sidebar's: red for an outage, amber for degraded or unclear, blue for maintenance.
#[tauri::command]
pub(crate) async fn set_tray_status(app: tauri::AppHandle, indicator: String) -> Result<(), String> {
    if let Ok(mut current) = TRAY_INDICATOR.lock() {
        current.clone_from(&indicator);
    }
    show_tray_status(&app, &indicator)
}

/// Draws the dot again in the menu bar's current ink, after the system's light or dark appearance
/// changes. Nothing to do while no dot shows, since the template mark follows the menu bar itself.
#[cfg(target_os = "macos")]
pub(crate) fn refresh_tray_status(app: &tauri::AppHandle) {
    let indicator = TRAY_INDICATOR.lock().map(|indicator| indicator.clone()).unwrap_or_default();
    if status_dot_color(&indicator).is_none() {
        return;
    }
    if let Err(error) = show_tray_status(app, &indicator) {
        eprintln!("Failed to redraw the tray status dot: {error}");
    }
}

fn show_tray_status(app: &tauri::AppHandle, indicator: &str) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(MACOS_TRAY_ID) else {
        return Ok(());
    };
    // A template image is drawn in one color, the menu bar's, so while a dot shows the mark is
    // drawn in that ink by hand and the dot keeps its own color.
    let mark = macos_tray_mark();
    let Some(color) = status_dot_color(indicator) else {
        tray.set_icon(Some(mark)).map_err(|error| error.to_string())?;
        return tray.set_icon_as_template(true).map_err(|error| error.to_string());
    };
    let (width, height) = (mark.width(), mark.height());
    let inked = with_ink(mark.rgba(), macos_menu_bar_ink(&tray));
    tray.set_icon_as_template(false).map_err(|error| error.to_string())?;
    tray.set_icon(Some(tauri::image::Image::new_owned(
        with_status_dot(&inked, width, height, color),
        width,
        height,
    )))
    .map_err(|error| error.to_string())
}

/// The menu bar icon: Arbor's mark in the micro cut, black on clear, 36 px for 18 pt. macOS draws it
/// as a template image, in the menu bar's own color.
#[cfg(target_os = "macos")]
fn macos_tray_mark() -> tauri::image::Image<'static> {
    tauri::include_image!("icons/tray/arbor-template.png")
}

/// The color macOS draws template images in on this menu bar: white on a dark one, black on a light
/// one, at the 85% the system uses for menu bar icons.
#[cfg(target_os = "macos")]
fn macos_menu_bar_ink<R: tauri::Runtime>(tray: &TrayIcon<R>) -> [u8; 4] {
    let dark = tray
        .with_inner_tray_icon(|tray_icon| {
            let mtm = MainThreadMarker::new()?;
            let button = tray_icon.ns_status_item()?.button(mtm)?;
            // SAFETY: AppKit's appearance names are immutable NSString constants.
            let (aqua, dark_aqua) = unsafe { (NSAppearanceNameAqua, NSAppearanceNameDarkAqua) };
            let best = button
                .effectiveAppearance()
                .bestMatchFromAppearancesWithNames(&NSArray::from_slice(&[aqua, dark_aqua]))?;
            Some(best.isEqualToString(dark_aqua))
        })
        .ok()
        .flatten()
        .unwrap_or(false);
    if dark {
        [0xff, 0xff, 0xff, 217]
    } else {
        [0x00, 0x00, 0x00, 217]
    }
}

/// Repaints every pixel of an RGBA image in one color, scaling its coverage by the color's alpha.
fn with_ink(rgba: &[u8], ink: [u8; 4]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|pixel| {
            let alpha = (u16::from(pixel[3]) * u16::from(ink[3]) + 127) / 255;
            [ink[0], ink[1], ink[2], alpha as u8]
        })
        .collect()
}

/// How many sessions are waiting on their user and how many alerts are unread, kept apart so each can
/// change without losing the other: the fleet board sets the first and the alert history the second.
struct TrayBadge {
    waiting: u32,
    unread: u32,
}

static TRAY_BADGE: Mutex<TrayBadge> = Mutex::new(TrayBadge {
    waiting: 0,
    unread: 0,
});

/// The count beside the menu bar icon: the sessions waiting on their user when there are any, since
/// those need an answer, otherwise the unread alerts. Nothing at zero, and capped so the icon
/// doesn't grow wide.
fn tray_title(waiting: u32, unread: u32) -> Option<String> {
    match if waiting > 0 { waiting } else { unread } {
        0 => None,
        count @ 1..=99 => Some(count.to_string()),
        _ => Some("99+".to_string()),
    }
}

/// The tooltip: the app's name, then each count that isn't zero, since the number beside the icon
/// only shows one of them.
fn tray_tooltip(waiting: u32, unread: u32) -> String {
    let mut text = "Arbor".to_string();
    if waiting > 0 {
        text.push_str(&format!(" · {waiting} waiting on you"));
    }
    match unread {
        0 => {}
        1 => text.push_str(" · 1 unread alert"),
        count => text.push_str(&format!(" · {count} unread alerts")),
    }
    text
}

/// Sets the tray's number and tooltip, changing the waiting count or unread count given and keeping
/// the other.
fn update_tray_badge<R: tauri::Runtime>(
    tray: &tauri::tray::TrayIcon<R>,
    waiting: Option<u32>,
    unread: Option<u32>,
) -> Result<(), String> {
    let (waiting, unread) = match TRAY_BADGE.lock() {
        Ok(mut badge) => {
            if let Some(waiting) = waiting {
                badge.waiting = waiting;
            }
            if let Some(unread) = unread {
                badge.unread = unread;
            }
            (badge.waiting, badge.unread)
        }
        Err(_) => (waiting.unwrap_or_default(), unread.unwrap_or_default()),
    };
    let text = tray_tooltip(waiting, unread);
    tray.set_title(tray_title(waiting, unread))
        .map_err(|error| error.to_string())?;
    if let Err(error) = tray.set_tooltip(Some(&text)) {
        eprintln!("Failed to update the tray tooltip: {error}");
    }
    Ok(())
}

/// Shows how many alerts are unread, since the tray icon is all there is once the window is closed
/// and the Dock icon gone: as a number beside the icon on macOS when no session is waiting, and in
/// the tooltip.
#[tauri::command]
pub(crate) async fn set_tray_unread(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(MACOS_TRAY_ID) else {
        return Ok(());
    };
    update_tray_badge(&tray, None, Some(count))
}

/// Shows how many sessions are waiting on their user, from the fleet board: as the number beside
/// the icon on macOS, ahead of the unread alerts, and in the tooltip.
#[tauri::command]
pub(crate) async fn set_tray_waiting(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(MACOS_TRAY_ID) else {
        return Ok(());
    };
    update_tray_badge(&tray, Some(count), None)
}

/// The sRGB values of the red, amber and blue the UI uses for status.
fn status_dot_color(indicator: &str) -> Option<[u8; 3]> {
    match indicator {
        "major" | "critical" => Some([0xfb, 0x2c, 0x36]),
        "minor" | "unknown" => Some([0xfe, 0x9a, 0x00]),
        "maintenance" => Some([0x2b, 0x7f, 0xff]),
        _ => None,
    }
}

/// Paints a dot into the bottom-right corner of an RGBA image, with a transparent gap cut around it
/// so it stands apart from the icon on light and dark menu bars. Edges are anti-aliased by coverage.
fn with_status_dot(rgba: &[u8], width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
    let mut pixels = rgba.to_vec();
    let size = width.min(height) as f32;
    let radius = size * STATUS_DOT_RADIUS;
    let outer = radius + size * STATUS_DOT_GAP;
    let (center_x, center_y) = (width as f32 - outer, height as f32 - outer);
    let left = (center_x - outer).floor().max(0.0) as u32;
    let top = (center_y - outer).floor().max(0.0) as u32;
    for y in top..height {
        for x in left..width {
            let distance = (x as f32 + 0.5 - center_x).hypot(y as f32 + 0.5 - center_y);
            let cut = (outer - distance + 0.5).clamp(0.0, 1.0);
            if cut == 0.0 {
                continue;
            }
            let index = (y as usize * width as usize + x as usize) * 4;
            let Some(pixel) = pixels.get_mut(index..index + 4) else {
                continue;
            };
            let dot = (radius - distance + 0.5).clamp(0.0, 1.0);
            let below = f32::from(pixel[3]) / 255.0 * (1.0 - cut);
            let alpha = dot + below * (1.0 - dot);
            if alpha > 0.0 {
                for channel in 0..3 {
                    let value = (f32::from(color[channel]) * dot
                        + f32::from(pixel[channel]) * below * (1.0 - dot))
                        / alpha;
                    pixel[channel] = value.round().clamp(0.0, 255.0) as u8;
                }
            }
            pixel[3] = (alpha * 255.0).round() as u8;
        }
    }
    pixels
}

#[cfg(target_os = "macos")]
const MACOS_TRAY_ID: &str = "macos-tray";

#[cfg(target_os = "macos")]
#[derive(Default)]
pub(crate) struct MacosTrayClickState {
    last_click: Option<Instant>,
    sequence: u64,
}

#[cfg(target_os = "macos")]
pub(crate) fn set_macos_dock_visible(app_handle: &tauri::AppHandle, visible: bool) {
    if let Err(error) = app_handle.set_dock_visibility(visible) {
        eprintln!("Failed to update Dock icon state: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn show_main_window_on_main_thread(app_handle: &tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    settle_launch_show(app_handle);
    set_macos_dock_visible(app_handle, true);
    if let Err(error) = window.show() {
        eprintln!("Failed to show main window: {error}");
        set_macos_dock_visible(app_handle, false);
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

#[cfg(target_os = "macos")]
pub(crate) fn show_main_window(app_handle: &tauri::AppHandle) {
    if MainThreadMarker::new().is_some() {
        show_main_window_on_main_thread(app_handle);
        return;
    }

    let app_handle = app_handle.clone();
    if let Err(error) = app_handle.clone().run_on_main_thread(move || {
        show_main_window_on_main_thread(&app_handle);
    }) {
        eprintln!("Failed to schedule main window display: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn show_macos_tray_menu<R: tauri::Runtime>(tray: &TrayIcon<R>) {
    let result = tray.with_inner_tray_icon(|tray_icon| {
        let Some(status_item) = tray_icon.ns_status_item() else {
            return;
        };
        let mtm = MainThreadMarker::new().expect("tray menu must be shown on the main thread");
        if let Some(menu) = status_item.menu(mtm) {
            #[allow(deprecated)]
            status_item.popUpStatusItemMenu(&menu);
        }
    });

    if let Err(error) = result {
        eprintln!("Failed to show tray menu: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn setup_macos_tray(app: &mut tauri::App<tauri::Wry>) -> tauri::Result<()> {
    let open_main_window = MenuItem::with_id(
        app,
        "open-main-window",
        "Open Main Window",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_main_window, &quit])?;
    app.manage(TrayLinesState::new(menu.clone()));
    let click_state = Arc::new(Mutex::new(MacosTrayClickState::default()));
    let double_click_interval = Duration::from_secs_f64(NSEvent::doubleClickInterval());

    let tray = TrayIconBuilder::with_id(MACOS_TRAY_ID)
        .icon(macos_tray_mark())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            "open-main-window" => show_main_window(app_handle),
            "quit" => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if !matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                return;
            }

            let now = Instant::now();
            let Ok(mut state) = click_state.lock() else {
                eprintln!("Failed to read tray click state");
                return;
            };
            state.sequence += 1;
            let sequence = state.sequence;

            if state
                .last_click
                .is_some_and(|last_click| now.duration_since(last_click) <= double_click_interval)
            {
                state.last_click = None;
                drop(state);
                show_main_window(tray.app_handle());
                return;
            }

            state.last_click = Some(now);
            drop(state);

            let app_handle = tray.app_handle().clone();
            let click_state = Arc::clone(&click_state);
            let tray_id = tray.id().clone();
            thread::spawn(move || {
                thread::sleep(double_click_interval);
                let should_show_menu = match click_state.lock() {
                    Ok(mut state) if state.sequence == sequence => {
                        state.last_click = None;
                        true
                    }
                    Ok(_) => false,
                    Err(_) => {
                        eprintln!("Failed to read tray click state");
                        false
                    }
                };
                if !should_show_menu {
                    return;
                }

                if let Some(tray) = app_handle.tray_by_id(&tray_id) {
                    show_macos_tray_menu(&tray);
                }
            });
        })
        .build(app)?;

    // A fixed autosave name gives the menu bar item a stable identity, so macOS remembers its
    // position and the System Settings menu bar toggle across launches. Cmd-drag removal stays
    // off on purpose: Arbor has no in-app way to bring a removed icon back.
    if let Err(error) = tray.with_inner_tray_icon(|tray_icon| {
        if let Some(status_item) = tray_icon.ns_status_item() {
            status_item.setAutosaveName(Some(&NSString::from_str(MACOS_TRAY_ID)));
        }
    }) {
        eprintln!("Failed to set the menu bar icon autosave name: {error}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, pixel: [u8; 4]) -> Vec<u8> {
        pixel.repeat((width * height) as usize)
    }

    fn pixel_at(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let index = ((y * width + x) * 4) as usize;
        rgba[index..index + 4].try_into().unwrap()
    }

    #[test]
    fn unread_count_shows_beside_the_icon_only_when_there_is_one() {
        assert_eq!(tray_title(0, 0), None);
        assert_eq!(tray_title(0, 1).as_deref(), Some("1"));
        assert_eq!(tray_title(0, 99).as_deref(), Some("99"));
        assert_eq!(tray_title(0, 100).as_deref(), Some("99+"));
    }

    #[test]
    fn sessions_waiting_on_you_take_the_number_ahead_of_unread_alerts() {
        assert_eq!(tray_title(2, 0).as_deref(), Some("2"));
        assert_eq!(tray_title(2, 5).as_deref(), Some("2"));
        assert_eq!(tray_title(120, 5).as_deref(), Some("99+"));
        // Once nothing waits, the unread alerts come back.
        assert_eq!(tray_title(0, 5).as_deref(), Some("5"));
    }

    #[test]
    fn tooltip_adds_the_unread_alerts_to_the_app_name() {
        assert_eq!(tray_tooltip(0, 0), "Arbor");
        assert_eq!(tray_tooltip(0, 1), "Arbor · 1 unread alert");
        assert_eq!(tray_tooltip(0, 12), "Arbor · 12 unread alerts");
    }

    #[test]
    fn tooltip_names_both_the_sessions_waiting_and_the_unread_alerts() {
        assert_eq!(tray_tooltip(2, 3), "Arbor · 2 waiting on you · 3 unread alerts");
        assert_eq!(tray_tooltip(1, 0), "Arbor · 1 waiting on you");
    }

    #[test]
    fn status_dot_sits_bottom_right_with_a_transparent_gap_around_it() {
        let (width, height) = (100, 100);
        let icon = solid(width, height, [255, 255, 255, 255]);
        let marked = with_status_dot(&icon, width, height, [0xfb, 0x2c, 0x36]);
        assert_eq!(marked.len(), icon.len());
        // A radius of 18 and a gap of 5 put the center at (77, 77).
        assert_eq!(pixel_at(&marked, width, 76, 76), [0xfb, 0x2c, 0x36, 255]);
        // About 20.5 from the center: past the dot, inside the gap.
        assert_eq!(pixel_at(&marked, width, 97, 76)[3], 0);
        assert_eq!(pixel_at(&marked, width, 10, 10), [255, 255, 255, 255]);
        assert_eq!(pixel_at(&marked, width, 76, 50), [255, 255, 255, 255]);
    }

    #[test]
    fn status_dot_edges_blend_into_transparent_corners() {
        let (width, height) = (64, 64);
        let marked = with_status_dot(&solid(width, height, [0, 0, 0, 0]), width, height, [0x2b, 0x7f, 0xff]);
        assert_eq!(pixel_at(&marked, width, 49, 49), [0x2b, 0x7f, 0xff, 255]);
        let painted = marked.chunks(4).filter(|pixel| pixel[3] > 0).collect::<Vec<_>>();
        assert!(painted.iter().any(|pixel| pixel[3] < 255), "the dot's edge should be anti-aliased");
        assert!(painted.iter().all(|pixel| pixel[..3] == [0x2b, 0x7f, 0xff]));
    }

    #[test]
    fn ink_repaints_the_mark_and_keeps_its_coverage() {
        let mark = [0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128];
        assert_eq!(
            with_ink(&mark, [255, 255, 255, 217]),
            vec![255, 255, 255, 217, 255, 255, 255, 0, 255, 255, 255, 109]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn menu_bar_mark_is_a_36_pixel_template_with_the_mark_on_clear() {
        let mark = macos_tray_mark();
        assert_eq!((mark.width(), mark.height()), (36, 36));
        let pixels = mark.rgba().chunks_exact(4).collect::<Vec<_>>();
        assert!(pixels.iter().all(|pixel| pixel[..3] == [0, 0, 0]), "a template is black on clear");
        assert_eq!(pixels[0][3], 0, "the corner is clear");
        let covered = pixels.iter().filter(|pixel| pixel[3] > 127).count();
        assert!((250..700).contains(&covered), "the mark covers {covered} of 1296 pixels");
    }

    #[test]
    fn status_dot_leaves_a_short_buffer_alone() {
        let short = vec![255; 10];
        assert_eq!(with_status_dot(&short, 64, 64, [0, 0, 0]), short);
    }
}
