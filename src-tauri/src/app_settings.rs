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

/// Open at login is the app itself registered with macOS (SMAppService), which Login Items lists under Arbor's own
/// name and icon. Turning it off in System Settings leaves it needing approval there, which reads as off here.
pub(crate) fn app_autostart_enabled(_app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: the main app's service is a plain query with no arguments.
        let status = unsafe { SMAppService::mainAppService().status() };
        Ok(status == SMAppServiceStatus::Enabled)
    }
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

pub(crate) fn set_app_autostart_enabled(
    _app: &tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_service_management::SMAppService;
        // SAFETY: registering or unregistering the running app's own login item; neither takes arguments.
        let service = unsafe { SMAppService::mainAppService() };
        let result = if enabled {
            unsafe { service.registerAndReturnError() }
        } else {
            unsafe { service.unregisterAndReturnError() }
        };
        result.map_err(|error| {
            let verb = if enabled { "turn on" } else { "turn off" };
            format!(
                "Couldn't {verb} Open at login: {}. Check Arbor in System Settings › General › Login Items.",
                error.localizedDescription()
            )
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Err("Open at login is only available on macOS".to_string())
    }
}

/// Whether an open-at-login plist starts the app in `macos_dir`: by its own name, or by cpa-gui, the name versions up
/// to 1.0 ran as and later ones keep only as a link to Arbor. The autostart plugin that wrote it put each argument in
/// a plain <string>, the program first.
fn legacy_login_item_starts(contents: &str, macos_dir: &Path, app_name: &str) -> bool {
    [app_name, "cpa-gui"].iter().any(|program| {
        contents.contains(&format!(
            "<string>{}</string>",
            macos_dir.join(program).display()
        ))
    })
}

/// Earlier versions opened at login through a LaunchAgent plist that ran the app's binary, which Login Items
/// lists as an anonymous program with a generic icon. One that starts this copy of the app is swapped for the app's
/// own registration. The plist's job is left loaded, since it may be what started this very process; it goes at the
/// next sign-in.
pub(crate) fn move_legacy_login_item(app: &tauri::AppHandle) {
    let Ok(executable) = env::current_exe().and_then(fs::canonicalize) else {
        return;
    };
    let (Some(macos_dir), Some(home)) = (executable.parent(), env::var_os("HOME")) else {
        return;
    };
    let app_name = &app.package_info().name;
    let item = PathBuf::from(home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{app_name}.plist"));
    let Ok(contents) = fs::read_to_string(&item) else {
        return;
    };
    if !legacy_login_item_starts(&contents, macos_dir, app_name) {
        return;
    }
    if let Err(error) = set_app_autostart_enabled(app, true) {
        eprintln!("Couldn't move Open at login to Login Items: {error}");
        return;
    }
    if let Err(error) = fs::remove_file(&item) {
        eprintln!("Couldn't remove the old open-at-login item: {error}");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_legacy_login_item_moves_only_when_it_starts_this_app() {
        let dir = Path::new("/Applications/Arbor.app/Contents/MacOS");
        let item = |program: &str| {
            format!("<plist><dict><key>ProgramArguments</key><array><string>{program}</string></array></dict></plist>")
        };
        assert!(legacy_login_item_starts(
            &item("/Applications/Arbor.app/Contents/MacOS/Arbor"),
            dir,
            "Arbor"
        ));
        assert!(legacy_login_item_starts(
            &item("/Applications/Arbor.app/Contents/MacOS/cpa-gui"),
            dir,
            "Arbor"
        ));
        // Another copy of the app keeps its own item.
        assert!(!legacy_login_item_starts(
            &item("/Users/cam/Applications/Arbor.app/Contents/MacOS/Arbor"),
            dir,
            "Arbor"
        ));
        assert!(!legacy_login_item_starts(
            &item("/Applications/Arbor.app/Contents/MacOS/Arbor-helper"),
            dir,
            "Arbor"
        ));
    }
}
