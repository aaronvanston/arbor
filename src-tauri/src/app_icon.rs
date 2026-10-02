//! The Dock icon's color. Nightly and dev builds are packaged with their own icon (Amber and Signal, from
//! `icons/channels/`, picked by scripts/build-release.sh), so Finder and Launchpad tell them from stable too. While
//! Arbor runs, Settings › Appearance can put any of the colors in the Dock instead; macOS only lets an app change its
//! icon while it runs, so a closed Arbor always shows its build's own. The choice is saved in config.toml.

use super::*;
use crate::build_channel::{build_channel, BuildChannel};

/// A color for the icon, or auto for the running build's own.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AppIconChoice {
    #[default]
    Auto,
    Forest,
    Amber,
    Sky,
    Ember,
    Signal,
    Paper,
    Mono,
}

/// What's saved, and the icon it shows in the Dock (never auto).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppIconSetting {
    choice: AppIconChoice,
    shown: AppIconChoice,
}

/// config.toml's choice. A value this version doesn't know, as from a newer version an update rolled back from, reads
/// as auto rather than failing the whole file.
pub(crate) fn deserialize_app_icon<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<AppIconChoice, D::Error> {
    let text = String::deserialize(deserializer)?;
    Ok(
        serde_json::from_value(serde_json::Value::String(text.trim().to_string()))
            .unwrap_or_default(),
    )
}

/// The icon each kind of build is packaged with.
pub(crate) fn build_icon(channel: BuildChannel) -> AppIconChoice {
    match channel {
        BuildChannel::Stable => AppIconChoice::Forest,
        BuildChannel::Nightly => AppIconChoice::Amber,
        BuildChannel::Dev => AppIconChoice::Signal,
    }
}

pub(crate) fn shown_icon(choice: AppIconChoice, channel: BuildChannel) -> AppIconChoice {
    if choice == AppIconChoice::Auto {
        build_icon(channel)
    } else {
        choice
    }
}

/// The image to put in the Dock, or None to leave the bundle's own. A debug build has no bundle icon of its own to
/// leave, so it always gets one.
fn dock_image(
    choice: AppIconChoice,
    channel: BuildChannel,
    debug_build: bool,
) -> Option<&'static [u8]> {
    let shown = shown_icon(choice, channel);
    if shown == build_icon(channel) && !debug_build {
        return None;
    }
    Some(match shown {
        AppIconChoice::Auto | AppIconChoice::Forest => {
            include_bytes!("../icons/variants/forest.png")
        }
        AppIconChoice::Amber => include_bytes!("../icons/variants/amber.png"),
        AppIconChoice::Sky => include_bytes!("../icons/variants/sky.png"),
        AppIconChoice::Ember => include_bytes!("../icons/variants/ember.png"),
        AppIconChoice::Signal => include_bytes!("../icons/variants/signal.png"),
        AppIconChoice::Paper => include_bytes!("../icons/variants/paper.png"),
        AppIconChoice::Mono => include_bytes!("../icons/variants/mono.png"),
    })
}

fn running_channel(app: &tauri::AppHandle) -> BuildChannel {
    build_channel(&app.package_info().version, cfg!(debug_assertions))
}

/// Puts `choice` in the Dock, on the main thread, which AppKit requires.
pub(crate) fn show_app_icon(app: &tauri::AppHandle, choice: AppIconChoice) {
    let image = dock_image(choice, running_channel(app), cfg!(debug_assertions));
    #[cfg(target_os = "macos")]
    {
        if objc2::MainThreadMarker::new().is_some() {
            set_dock_image(image);
        } else if let Err(error) = app.run_on_main_thread(move || set_dock_image(image)) {
            eprintln!("Failed to change the Dock icon: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = image;
}

#[cfg(target_os = "macos")]
fn set_dock_image(image: Option<&'static [u8]>) {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let image =
        image.and_then(|bytes| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)));
    // SAFETY: on the main thread, with an image AppKit retains, or none to go back to the bundle's icon.
    unsafe { app.setApplicationIconImage(image.as_deref()) };
}

/// At launch, before the window shows.
pub(crate) fn apply_saved_app_icon(app: &tauri::AppHandle) {
    match app.state::<GuiConfigState>().snapshot() {
        Ok(config) => show_app_icon(app, config.app_icon),
        Err(error) => eprintln!("Failed to read the app icon setting: {error}"),
    }
}

fn setting(app: &tauri::AppHandle, choice: AppIconChoice) -> AppIconSetting {
    AppIconSetting {
        choice,
        shown: shown_icon(choice, running_channel(app)),
    }
}

#[tauri::command]
pub(crate) fn get_app_icon(app: tauri::AppHandle) -> Result<AppIconSetting, String> {
    let choice = app.state::<GuiConfigState>().snapshot()?.app_icon;
    Ok(setting(&app, choice))
}

/// Settings › Appearance: save the choice and show it in the Dock straight away.
#[tauri::command]
pub(crate) fn set_app_icon(
    app: tauri::AppHandle,
    choice: AppIconChoice,
) -> Result<AppIconSetting, String> {
    let config = app.state::<GuiConfigState>().update(|config| {
        config.app_icon = choice;
        Ok(())
    })?;
    show_app_icon(&app, config.app_icon);
    Ok(setting(&app, config.app_icon))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_is_the_build_own_icon() {
        assert_eq!(
            shown_icon(AppIconChoice::Auto, BuildChannel::Stable),
            AppIconChoice::Forest
        );
        assert_eq!(
            shown_icon(AppIconChoice::Auto, BuildChannel::Nightly),
            AppIconChoice::Amber
        );
        assert_eq!(
            shown_icon(AppIconChoice::Auto, BuildChannel::Dev),
            AppIconChoice::Signal
        );
        assert_eq!(
            shown_icon(AppIconChoice::Paper, BuildChannel::Nightly),
            AppIconChoice::Paper
        );
    }

    #[test]
    fn a_packaged_build_keeps_its_bundle_icon_unless_another_is_picked() {
        assert!(dock_image(AppIconChoice::Auto, BuildChannel::Stable, false).is_none());
        assert!(dock_image(AppIconChoice::Amber, BuildChannel::Nightly, false).is_none());
        assert!(dock_image(AppIconChoice::Forest, BuildChannel::Nightly, false).is_some());
        assert!(dock_image(AppIconChoice::Mono, BuildChannel::Stable, false).is_some());
        // A debug build has no packaged icon, so even auto is set.
        assert!(dock_image(AppIconChoice::Auto, BuildChannel::Dev, true).is_some());
    }

    #[test]
    fn an_unknown_saved_icon_reads_as_auto() {
        #[derive(Deserialize)]
        struct File {
            #[serde(deserialize_with = "deserialize_app_icon")]
            icon: AppIconChoice,
        }
        let read = |text: &str| toml::from_str::<File>(text).unwrap().icon;
        assert_eq!(read("icon = \"amber\""), AppIconChoice::Amber);
        assert_eq!(read("icon = \"auto\""), AppIconChoice::Auto);
        assert_eq!(read("icon = \"holographic\""), AppIconChoice::Auto);
    }
}
