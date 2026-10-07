use super::*;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSString};
use std::collections::HashMap;
use tauri::menu::{IconMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};

/// Emitted with a `TrayAction` when one of the menu's actions is picked, after the window is shown.
pub(crate) const TRAY_ACTION_EVENT: &str = "tray-action";

/// The rows the app shows in the tray menu under "Open Main Window", in sections that each end with
/// a separator: the limits, then the machines, then the sessions running now.
pub(crate) struct TrayRowsState {
    menu: Menu<tauri::Wry>,
    sections: Mutex<TraySections>,
    /// The action behind each menu item id that has one. Apart from `sections`, and only ever held for a moment,
    /// because a rebuild holds `sections` while it waits on the main thread, where a click looks its action up.
    actions: Mutex<HashMap<String, TrayAction>>,
}

#[derive(Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TraySection {
    Limits,
    Machines,
    Sessions,
}

const TRAY_SECTION_COUNT: usize = 3;

/// One row of the tray menu. A row with children opens them as a sub-menu, and one with empty text
/// is a separator. Rows are shown dimmed unless they have an action.
#[derive(Clone, PartialEq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayRow {
    text: String,
    #[serde(default)]
    #[ts(optional)]
    dot: Option<TrayDot>,
    #[serde(default)]
    #[ts(optional)]
    action: Option<TrayAction>,
    #[serde(default)]
    #[ts(optional)]
    children: Option<Vec<TrayRow>>,
}

/// The status dot drawn before a row, colored like the UI's status dots. `Blank` keeps a row's text
/// in line with dotted rows beside it.
#[derive(Clone, Copy, PartialEq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrayDot {
    Green,
    Amber,
    Red,
    Gray,
    Blank,
}

/// What picking a row does once the window is shown; the window carries it out.
#[derive(Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TrayAction {
    OpenMachine { machine: String },
}

#[derive(Default)]
struct TraySections {
    rows: [Vec<TrayRow>; TRAY_SECTION_COUNT],
    /// The items each section's rows were built into, row for row, so rows of the same shape are updated in place.
    built: [Vec<TrayItem>; TRAY_SECTION_COUNT],
    /// Every item in the menu below "Open Main Window", separators included, in order: what a rebuild removes.
    items: Vec<MenuItemKind<tauri::Wry>>,
}

/// A row's menu item, its id (empty for a separator) and its sub-menu's items.
struct TrayItem<Item = MenuItemKind<tauri::Wry>> {
    id: String,
    item: Item,
    children: Vec<TrayItem<Item>>,
}

/// Whether `new` can be shown by changing `old`'s items in place: the same rows, separators, sub-menus and dotted rows
/// in the same places. A plain item can't gain a dot, so a dot coming or going needs new items.
fn same_shape(old: &[TrayRow], new: &[TrayRow]) -> bool {
    old.len() == new.len()
        && old.iter().zip(new).all(|(old, new)| {
            old.text.is_empty() == new.text.is_empty()
                && old.dot.is_some() == new.dot.is_some()
                && has_children(old) == has_children(new)
                && same_shape(children_of(old), children_of(new))
        })
}

fn has_children(row: &TrayRow) -> bool {
    row.children.as_ref().is_some_and(|children| !children.is_empty())
}

fn children_of(row: &TrayRow) -> &[TrayRow] {
    row.children.as_deref().unwrap_or_default()
}

/// How many items an update of `old` to `new` touches in place: one per row whose text, dot or action changed.
#[cfg(test)]
fn changed_items(old: &[TrayRow], new: &[TrayRow]) -> usize {
    old.iter()
        .zip(new)
        .map(|(old, new)| {
            usize::from(old.text != new.text || old.dot != new.dot || old.action.is_some() != new.action.is_some())
                + changed_items(children_of(old), children_of(new))
        })
        .sum()
}

/// Shows `new` on the items built for `old`, which has the same shape, setting only what changed.
fn update_items(items: &[TrayItem], old: &[TrayRow], new: &[TrayRow]) -> Result<(), String> {
    let fail = |error: tauri::Error| error.to_string();
    for ((built, old), new) in items.iter().zip(old).zip(new) {
        if new.text.is_empty() {
            continue;
        }
        let dot = (old.dot != new.dot).then(|| new.dot.map(tray_dot_image));
        let enabled = (old.action.is_some() != new.action.is_some()).then(|| new.action.is_some());
        match &built.item {
            MenuItemKind::Submenu(submenu) => {
                if old.text != new.text {
                    submenu.set_text(&new.text).map_err(fail)?;
                }
                if let Some(icon) = dot {
                    submenu.set_icon(icon).map_err(fail)?;
                }
            }
            MenuItemKind::Icon(item) => {
                if old.text != new.text {
                    item.set_text(&new.text).map_err(fail)?;
                }
                if let Some(icon) = dot {
                    item.set_icon(icon).map_err(fail)?;
                }
                if let Some(enabled) = enabled {
                    item.set_enabled(enabled).map_err(fail)?;
                }
            }
            MenuItemKind::MenuItem(item) => {
                if old.text != new.text {
                    item.set_text(&new.text).map_err(fail)?;
                }
                if let Some(enabled) = enabled {
                    item.set_enabled(enabled).map_err(fail)?;
                }
            }
            _ => {}
        }
        update_items(&built.children, children_of(old), children_of(new))?;
    }
    Ok(())
}

/// The action behind each item built for `rows`, by its id.
fn collect_actions<Item>(items: &[TrayItem<Item>], rows: &[TrayRow], actions: &mut HashMap<String, TrayAction>) {
    for (built, row) in items.iter().zip(rows) {
        if has_children(row) {
            collect_actions(&built.children, children_of(row), actions);
        } else if let Some(action) = &row.action {
            actions.insert(built.id.clone(), action.clone());
        }
    }
}

impl TrayRowsState {
    fn new(menu: Menu<tauri::Wry>) -> Self {
        Self {
            menu,
            sections: Mutex::new(TraySections::default()),
            actions: Mutex::new(HashMap::new()),
        }
    }

    fn action(&self, id: &str) -> Option<TrayAction> {
        self.actions.lock().ok()?.get(id).cloned()
    }
}

#[tauri::command]
pub(crate) async fn set_tray_rows(
    app: tauri::AppHandle,
    section: TraySection,
    rows: Vec<TrayRow>,
) -> Result<(), String> {
    let Some(state) = app.try_state::<TrayRowsState>() else {
        return Ok(());
    };
    let index = section as usize;
    let mut sections = state.sections.lock().map_err(|error| error.to_string())?;
    if sections.rows[index] == rows {
        return Ok(());
    }

    // A machine's readings and check time change every health round while its rows stay the same shape, so most
    // updates only set the text that changed. Building every item again each time made a new image for each dotted
    // row and churned the menu's memory up to a couple of times a minute.
    let built_for_rows = sections.built[index].len() == sections.rows[index].len();
    if built_for_rows && !rows.is_empty() && same_shape(&sections.rows[index], &rows) {
        update_items(&sections.built[index], &sections.rows[index], &rows)?;
        sections.rows[index] = rows;
        let mut actions = HashMap::new();
        for (built, rows) in sections.built.iter().zip(&sections.rows) {
            collect_actions(built, rows, &mut actions);
        }
        if let Ok(mut current) = state.actions.lock() {
            *current = actions;
        }
        return Ok(());
    }
    sections.rows[index] = rows;

    // Every section moves when one above it changes length, so all are put back.
    let TraySections { rows, built, items } = &mut *sections;
    for item in items.drain(..) {
        state.menu.remove(&item).map_err(|error| error.to_string())?;
    }
    let mut actions = HashMap::new();
    let mut position = 1;
    for (section_rows, section_built) in rows.iter().zip(built.iter_mut()) {
        section_built.clear();
        if section_rows.is_empty() {
            continue;
        }
        for row in section_rows {
            let item = tray_item(&app, row, &mut actions)?;
            state
                .menu
                .insert(&item.item, position)
                .map_err(|error| error.to_string())?;
            items.push(item.item.clone());
            section_built.push(item);
            position += 1;
        }
        let separator = PredefinedMenuItem::separator(&app).map_err(|error| error.to_string())?;
        state
            .menu
            .insert(&separator, position)
            .map_err(|error| error.to_string())?;
        items.push(MenuItemKind::Predefined(separator));
        position += 1;
    }
    if let Ok(mut current) = state.actions.lock() {
        *current = actions;
    }
    Ok(())
}

/// Builds a row's menu item, and its sub-menu's, noting the action behind each id.
fn tray_item(
    app: &tauri::AppHandle,
    row: &TrayRow,
    actions: &mut HashMap<String, TrayAction>,
) -> Result<TrayItem, String> {
    let fail = |error: tauri::Error| error.to_string();
    if row.text.is_empty() {
        let separator = PredefinedMenuItem::separator(app).map_err(fail)?;
        return Ok(TrayItem { id: String::new(), item: MenuItemKind::Predefined(separator), children: Vec::new() });
    }
    let id = format!("tray-row-{}", next_tray_item_id());
    let icon = row.dot.map(tray_dot_image);
    if let Some(children) = row.children.as_ref().filter(|children| !children.is_empty()) {
        let submenu = Submenu::with_id(app, &id, &row.text, true).map_err(fail)?;
        let mut built = Vec::with_capacity(children.len());
        for child in children {
            let child = tray_item(app, child, actions)?;
            submenu.append(&child.item).map_err(fail)?;
            built.push(child);
        }
        if icon.is_some() {
            submenu.set_icon(icon).map_err(fail)?;
        }
        return Ok(TrayItem { id, item: MenuItemKind::Submenu(submenu), children: built });
    }
    let enabled = row.action.is_some();
    if let Some(action) = &row.action {
        actions.insert(id.clone(), action.clone());
    }
    let item = match icon {
        Some(icon) => MenuItemKind::Icon(
            IconMenuItem::with_id(app, &id, &row.text, enabled, Some(icon), None::<&str>).map_err(fail)?,
        ),
        None => MenuItemKind::MenuItem(MenuItem::with_id(app, &id, &row.text, enabled, None::<&str>).map_err(fail)?),
    };
    Ok(TrayItem { id, item, children: Vec::new() })
}

/// A new number on every call, so no two items the menu has held share an id.
fn next_tray_item_id() -> usize {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Shows the window and hands it the action picked in the tray menu, if the item has one.
pub(crate) fn run_tray_action(app_handle: &tauri::AppHandle, id: &str) {
    let Some(action) = app_handle
        .try_state::<TrayRowsState>()
        .and_then(|state| state.action(id))
    else {
        return;
    };
    #[cfg(target_os = "macos")]
    show_main_window(app_handle);
    if let Err(error) = app_handle.emit(TRAY_ACTION_EVENT, action) {
        eprintln!("Failed to pass on the tray menu action: {error}");
    }
}

/// The dot image's size in pixels: drawn 18 pt high, which is how muda sizes every menu item image,
/// so 36 px is sharp on a Retina screen, and narrower than tall so the text sits close.
const TRAY_DOT_WIDTH: u32 = 24;
const TRAY_DOT_HEIGHT: u32 = 36;
const TRAY_DOT_RADIUS: f32 = 7.0;

fn tray_dot_color(dot: TrayDot) -> Option<[u8; 3]> {
    match dot {
        TrayDot::Green => Some([0x00, 0xc9, 0x50]),
        TrayDot::Amber => Some([0xfe, 0x9a, 0x00]),
        TrayDot::Red => Some([0xfb, 0x2c, 0x36]),
        TrayDot::Gray => Some([0x8e, 0x8e, 0x93]),
        TrayDot::Blank => None,
    }
}

/// A round dot on clear, anti-aliased by coverage; all clear for `Blank`.
fn tray_dot_pixels(dot: TrayDot) -> Vec<u8> {
    let color = tray_dot_color(dot);
    let (center_x, center_y) = (TRAY_DOT_WIDTH as f32 / 2.0, TRAY_DOT_HEIGHT as f32 / 2.0);
    (0..TRAY_DOT_HEIGHT)
        .flat_map(|y| (0..TRAY_DOT_WIDTH).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let Some([red, green, blue]) = color else {
                return [0; 4];
            };
            let distance = (x as f32 + 0.5 - center_x).hypot(y as f32 + 0.5 - center_y);
            let coverage = (TRAY_DOT_RADIUS - distance + 0.5).clamp(0.0, 1.0);
            [red, green, blue, (coverage * 255.0).round() as u8]
        })
        .collect()
}

/// Each dot's pixels, drawn once: a dotted row's image is made from them every time its item is built or recolored.
fn tray_dot_image(dot: TrayDot) -> tauri::image::Image<'static> {
    static PIXELS: std::sync::OnceLock<[Vec<u8>; 5]> = std::sync::OnceLock::new();
    let pixels = PIXELS.get_or_init(|| {
        [TrayDot::Green, TrayDot::Amber, TrayDot::Red, TrayDot::Gray, TrayDot::Blank].map(tray_dot_pixels)
    });
    let index = match dot {
        TrayDot::Green => 0,
        TrayDot::Amber => 1,
        TrayDot::Red => 2,
        TrayDot::Gray => 3,
        TrayDot::Blank => 4,
    };
    tauri::image::Image::new(&pixels[index], TRAY_DOT_WIDTH, TRAY_DOT_HEIGHT)
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
    app.manage(TrayRowsState::new(menu.clone()));
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
            id => run_tray_action(app_handle, id),
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
    fn row_dots_are_round_and_centered_and_blank_is_clear() {
        let green = tray_dot_pixels(TrayDot::Green);
        assert_eq!(green.len(), (TRAY_DOT_WIDTH * TRAY_DOT_HEIGHT * 4) as usize);
        assert_eq!(pixel_at(&green, TRAY_DOT_WIDTH, 12, 18), [0x00, 0xc9, 0x50, 255]);
        assert_eq!(pixel_at(&green, TRAY_DOT_WIDTH, 0, 0)[3], 0);
        assert_eq!(pixel_at(&green, TRAY_DOT_WIDTH, 12, 2)[3], 0, "the dot stays clear of the top");
        assert!(green.chunks(4).any(|pixel| pixel[3] > 0 && pixel[3] < 255), "the dot's edge should be anti-aliased");
        assert!(tray_dot_pixels(TrayDot::Blank).iter().all(|byte| *byte == 0));
    }

    /// The machines' section as the window sends it (services/glance.ts), for `machines` machines at a moment's readings.
    fn machine_rows(machines: usize, cpu: usize, checked: &str) -> Vec<TrayRow> {
        let row = |text: String| TrayRow { text, dot: None, action: None, children: None };
        let mut rows = vec![row("Machines".into())];
        for machine in 0..machines {
            let name = format!("cam-{machine}");
            let mut agent = row("Claude Code 2.4.1 · 2 running".into());
            agent.dot = Some(TrayDot::Blank);
            let mut open = row("Open machine page".into());
            open.action = Some(TrayAction::OpenMachine { machine: name.clone() });
            rows.push(TrayRow {
                text: format!("{name} · 2 working"),
                dot: Some(TrayDot::Green),
                action: None,
                children: Some(vec![
                    row(format!("Healthy · {}", 100 - cpu / 4)),
                    row(String::new()),
                    row(format!("CPU {}% · load 1.2", cpu + machine)),
                    row(format!("Memory {}% · 40 GB of 64 GB", 60 + cpu % 3)),
                    row("Disk 61% · 180 GB free".into()),
                    row(String::new()),
                    agent,
                    row(format!("Checked {checked}")),
                    row(String::new()),
                    open,
                ]),
            });
        }
        rows
    }

    fn items_in(rows: &[TrayRow]) -> usize {
        rows.iter().map(|row| 1 + items_in(children_of(row))).sum()
    }

    #[test]
    fn a_health_round_changes_only_the_readings_in_place() {
        let before = machine_rows(5, 40, "8:47:34 am");
        let after = machine_rows(5, 47, "8:48:34 am");
        assert!(same_shape(&before, &after));
        // Before, every item in the section was built again each round: 56 for five machines, 25 of them dotted.
        assert_eq!(items_in(&after), 56);
        // Now only the score, CPU, memory and check time of each machine are set: no items or images made.
        assert_eq!(changed_items(&before, &after), 5 * 4);
    }

    #[test]
    fn rows_of_another_shape_are_built_again() {
        let base = machine_rows(2, 40, "now");
        assert!(!same_shape(&base, &machine_rows(3, 40, "now")), "a machine added");
        let mut no_dot = base.clone();
        no_dot[1].dot = None;
        assert!(!same_shape(&base, &no_dot), "a dot can't be taken off a dotted item");
        let mut fewer = base.clone();
        if let Some(children) = fewer[1].children.as_mut() {
            children.remove(3);
        }
        assert!(!same_shape(&base, &fewer), "a reading gone from a sub-menu");
        let mut recolored = base.clone();
        recolored[1].dot = Some(TrayDot::Red);
        assert!(same_shape(&base, &recolored), "a dot changing color is set in place");
        assert_eq!(changed_items(&base, &recolored), 1);
    }

    #[test]
    fn actions_follow_the_items_built_for_their_rows() {
        let rows = machine_rows(1, 40, "now");
        let built = |id: &str, children: Vec<TrayItem<()>>| TrayItem { id: id.into(), item: (), children };
        let sub = (0..10).map(|n| built(&format!("child-{n}"), Vec::new())).collect();
        let items = vec![built("header", Vec::new()), built("machine", sub)];
        let mut actions = HashMap::new();
        collect_actions(&items, &rows, &mut actions);
        assert_eq!(actions.len(), 1);
        assert!(actions.get("child-9") == Some(&TrayAction::OpenMachine { machine: "cam-0".into() }));
    }

    #[test]
    fn rows_read_with_or_without_a_dot_action_or_sub_menu() {
        let rows: Vec<TrayRow> = serde_json::from_str(
            r#"[{"text":"Machines"},{"text":"lab","dot":"amber","children":[{"text":""},{"text":"Open machine page","action":{"kind":"openMachine","machine":"lab"}}]}]"#,
        )
        .unwrap();
        assert!(rows[0].dot.is_none() && rows[0].action.is_none() && rows[0].children.is_none());
        assert!(rows[1].dot == Some(TrayDot::Amber));
        let children = rows[1].children.as_ref().unwrap();
        assert!(children[1].action == Some(TrayAction::OpenMachine { machine: "lab".into() }));
        assert_eq!(
            serde_json::to_string(&TrayAction::OpenMachine { machine: "lab".into() }).unwrap(),
            r#"{"kind":"openMachine","machine":"lab"}"#
        );
    }

    #[test]
    fn status_dot_leaves_a_short_buffer_alone() {
        let short = vec![255; 10];
        assert_eq!(with_status_dot(&short, 64, 64, [0, 0, 0]), short);
    }
}
