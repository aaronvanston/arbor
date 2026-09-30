use super::*;

#[tauri::command]
pub(crate) async fn get_core_status(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = app.state::<GuiConfigState>().snapshot()?;
        current_core_status(
            Some(app.state::<CoreProcessState>().inner()),
            Some(config.port),
        )
    })
    .await
    .map_err(|error| format!("Core status background task failed: {error}"))?
}

pub(crate) fn emit_core_status(app: &tauri::AppHandle, status: &CoreStatus) {
    let _ = app.emit(CORE_STATUS_EVENT, status);
}

#[tauri::command]
pub(crate) fn get_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<GuiSettings, String> {
    let config = gui_config_state.snapshot()?;
    Ok(GuiSettings::from(&config))
}

pub(crate) fn app_autostart_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("Failed to read system autostart state: {error}"))
}

pub(crate) fn set_app_autostart_enabled(
    app: &tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| format!("Failed to enable autostart: {error}"))
    } else {
        manager
            .disable()
            .map_err(|error| format!("Failed to disable autostart: {error}"))
    }
}

/// Versions up to 1.0 ran as Contents/MacOS/cpa-gui, and an open-at-login item they made starts the app by that name,
/// which later versions keep only as a link to Arbor. Writing the item again points it at Arbor itself, the name Login
/// Items then shows. Only an item that starts this copy of the app through the old name is rewritten.
pub(crate) fn repoint_legacy_login_item(app: &tauri::AppHandle) {
    let Ok(executable) = env::current_exe().and_then(fs::canonicalize) else {
        return;
    };
    let (Some(macos_dir), Some(home)) = (executable.parent(), env::var_os("HOME")) else {
        return;
    };
    let item = PathBuf::from(home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", app.package_info().name));
    let Ok(contents) = fs::read_to_string(&item) else {
        return;
    };
    // The autostart plugin writes each of the item's arguments as a plain <string>, the program first.
    let legacy_program = format!("<string>{}</string>", macos_dir.join("cpa-gui").display());
    if contents.contains(&legacy_program) {
        if let Err(error) = set_app_autostart_enabled(app, true) {
            eprintln!("Couldn't point the open-at-login item at Arbor: {error}");
        }
    }
}

pub(crate) fn software_settings(
    app: &tauri::AppHandle,
    config: &GuiConfigFile,
) -> Result<SoftwareSettings, String> {
    Ok(SoftwareSettings {
        close_behavior: config.close_behavior,
        autostart_enabled: app_autostart_enabled(app)?,
        start_core_on_launch: config.start_core_on_launch,
        silent_start_enabled: config.silent_start,
    })
}

#[tauri::command]
pub(crate) fn get_software_settings(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<SoftwareSettings, String> {
    let config = gui_config_state.snapshot()?;
    software_settings(&app, &config)
}

#[tauri::command]
pub(crate) fn save_software_settings(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: SoftwareSettingsInput,
) -> Result<SoftwareSettings, String> {
    let previous_config = gui_config_state.snapshot()?;
    let previous_autostart_enabled = app_autostart_enabled(&app)?;
    let autostart_changed = previous_autostart_enabled != settings.autostart_enabled;

    if autostart_changed {
        set_app_autostart_enabled(&app, settings.autostart_enabled)?;
    }

    let config = if previous_config.close_behavior == settings.close_behavior
        && previous_config.start_core_on_launch == settings.start_core_on_launch
        && previous_config.silent_start == settings.silent_start_enabled
    {
        previous_config
    } else {
        match gui_config_state.set_software_preferences(
            settings.close_behavior,
            settings.start_core_on_launch,
            settings.silent_start_enabled,
        ) {
            Ok(config) => config,
            Err(error) => {
                let rollback_error = autostart_changed
                    .then(|| set_app_autostart_enabled(&app, previous_autostart_enabled).err())
                    .flatten();
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{error}; also failed to roll back autostart settings: {rollback_error}")
                    }
                    None => error,
                });
            }
        }
    };

    software_settings(&app, &config)
}
