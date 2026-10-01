//! Which kind of build is running, read from its own version, and the Dock badge that marks it. A nightly is
//! `X.Y.Z-nightly.YYYYMMDD.N`, a dev build is a debug build or a `-dev` prerelease, and anything else is stable, which
//! stays unmarked. The update channel setting isn't consulted: it says what Arbor updates to, not what's running.

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuildChannel {
    Stable,
    Nightly,
    Dev,
}

pub(crate) fn build_channel(version: &semver::Version, debug_build: bool) -> BuildChannel {
    let pre = version.pre.as_str();
    if debug_build || pre == "dev" || pre.starts_with("dev.") {
        BuildChannel::Dev
    } else if pre == "nightly" || pre.starts_with("nightly.") {
        BuildChannel::Nightly
    } else {
        BuildChannel::Stable
    }
}

/// The Dock shows this while Arbor runs, so a nightly or dev build is told apart from stable without opening it.
pub(crate) fn dock_badge_label(channel: BuildChannel) -> Option<&'static str> {
    match channel {
        BuildChannel::Stable => None,
        BuildChannel::Nightly => Some("Nightly"),
        BuildChannel::Dev => Some("Dev"),
    }
}

pub(crate) fn apply_dock_badge(app_handle: &tauri::AppHandle) {
    let channel = build_channel(&app_handle.package_info().version, cfg!(debug_assertions));
    let Some(label) = dock_badge_label(channel) else {
        return;
    };
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.set_badge_label(Some(label.to_string())) {
        eprintln!("Failed to mark the Dock icon with the build channel: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel_of(version: &str, debug_build: bool) -> BuildChannel {
        build_channel(&semver::Version::parse(version).expect("version"), debug_build)
    }

    #[test]
    fn reads_the_channel_from_the_version() {
        assert_eq!(channel_of("1.0.27", false), BuildChannel::Stable);
        assert_eq!(channel_of("1.0.27-nightly.20261002.1", false), BuildChannel::Nightly);
        assert_eq!(channel_of("1.0.27-dev.20261002.1", false), BuildChannel::Dev);
        assert_eq!(channel_of("1.0.27-nightlyish", false), BuildChannel::Stable);
    }

    #[test]
    fn a_debug_build_is_dev_whatever_its_version() {
        assert_eq!(channel_of("1.0.27", true), BuildChannel::Dev);
        assert_eq!(channel_of("1.0.27-nightly.20261002.1", true), BuildChannel::Dev);
    }

    #[test]
    fn stable_has_no_dock_badge() {
        assert_eq!(dock_badge_label(BuildChannel::Stable), None);
        assert_eq!(dock_badge_label(BuildChannel::Nightly), Some("Nightly"));
        assert_eq!(dock_badge_label(BuildChannel::Dev), Some("Dev"));
    }
}
