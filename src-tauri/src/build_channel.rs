//! Which kind of build is running, read from its own version; app_icon.rs colors the Dock by it. A nightly is
//! `X.Y.Z-nightly.YYYYMMDD.N`, a dev build is a debug build or a `-dev` prerelease, and anything else is stable.
//! The update channel setting isn't consulted: it says what Arbor updates to, not what's running.

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
}
