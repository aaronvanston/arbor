use super::*;
use tauri_plugin_dialog::DialogExt;

/// The longest file name offered to the save dialog.
const PAGE_FILE_NAME_MAX: usize = 120;

/// The name the page is offered under: a plain file name ending in `.html`, nothing that reaches another folder.
pub(crate) fn page_file_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let plain = !name.is_empty()
        && name.len() <= PAGE_FILE_NAME_MAX
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control);
    if !plain || !name.to_ascii_lowercase().ends_with(".html") {
        return Err(format!("Not a name for the page: {name}"));
    }
    Ok(name.to_string())
}

/// A page to open or show: an `.html` file that's there. Nothing else is opened, so this can't start a program.
pub(crate) fn saved_page(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let html = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"));
    if !path.is_absolute() || !html || !path.is_file() {
        return Err(format!("Not a saved page: {}", path_to_string(&path)));
    }
    Ok(path)
}

/// Asks where to save the weekly digest's page, starting in Downloads, and writes it there.
/// Returns where it went, or nothing when the save was canceled.
#[tauri::command]
pub(crate) async fn save_digest_page(
    app: tauri::AppHandle,
    file_name: String,
    html: String,
    file_type: String,
) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(page_file_name(&file_name)?)
        .add_filter(file_type, &["html"]);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let (chosen, answer) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = chosen.send(path);
    });
    let Some(path) = answer.await.ok().flatten() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|error| format!("Can't save the page there: {error}"))?;
    fs::write(&path, html)
        .map_err(|error| format!("Failed to write {}: {error}", path_to_string(&path)))?;
    Ok(Some(path_to_string(&path)))
}

/// Opens a saved page in the browser, or shows it in Finder.
#[tauri::command]
pub(crate) fn open_saved_page(app: tauri::AppHandle, path: String, reveal: bool) -> Result<(), String> {
    let path = saved_page(&path)?;
    let opened = if reveal {
        app.opener().reveal_item_in_dir(&path).map_err(|error| error.to_string())
    } else {
        crate::system_open::open_with_system(&app, &path_to_string(&path), None)
    };
    opened.map_err(|error| format!("Failed to open {}: {error}", path_to_string(&path)))
}
