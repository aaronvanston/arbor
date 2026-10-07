//! When Arbor updates a machine's Grove probe by itself: only where a probe is already installed and its release is
//! known, only to the newer release this build carries (never down), at most once per carried release per machine, and
//! after a failure only once its backoff has passed. A failed update leaves the old probe streaming.

/// The first wait after a failed update; each failure after it doubles the wait, up to `BACKOFF_MAX_MS`.
const BACKOFF_FIRST_MS: i64 = 15 * 60 * 1000;
const BACKOFF_MAX_MS: i64 = 24 * 60 * 60 * 1000;

/// How updating one machine's probe to a carried release went.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Attempt {
    /// The carried release it was for; another release starts over.
    pub(crate) bundled: String,
    pub(crate) failures: u32,
    pub(crate) last_ms: i64,
    /// Why the last try failed, until one works.
    pub(crate) error: Option<String>,
    pub(crate) done: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Next {
    Nothing,
    Update,
    /// A try failed and its backoff hasn't passed.
    Wait,
}

/// Whether `installed` is an older release than `bundled`. Releases are compared as semver, where a prerelease comes
/// before its release; either one unreadable is never older, so nothing is updated on a guess.
pub(crate) fn is_older(installed: &str, bundled: &str) -> bool {
    let parse = |version: &str| semver::Version::parse(version.trim().trim_start_matches('v')).ok();
    matches!((parse(installed), parse(bundled)), (Some(installed), Some(bundled)) if installed < bundled)
}

/// How long after `failures` failed tries the next may start.
pub(crate) fn backoff_ms(failures: u32) -> i64 {
    let doublings = failures.saturating_sub(1).min(16);
    (BACKOFF_FIRST_MS << doublings).min(BACKOFF_MAX_MS)
}

/// What to do about one machine's probe. `installed` is None where there's no probe or its release isn't known.
pub(crate) fn next(installed: Option<&str>, bundled: &str, attempt: Option<&Attempt>, now_ms: i64) -> Next {
    let Some(installed) = installed else {
        return Next::Nothing;
    };
    if !is_older(installed, bundled) {
        return Next::Nothing;
    }
    match attempt.filter(|attempt| attempt.bundled == bundled) {
        None => Next::Update,
        Some(attempt) if attempt.done => Next::Nothing,
        Some(attempt) if now_ms - attempt.last_ms >= backoff_ms(attempt.failures) => Next::Update,
        Some(_) => Next::Wait,
    }
}

/// The attempt after one try to update to `bundled` ended with `result`.
pub(crate) fn record(previous: Option<&Attempt>, bundled: &str, now_ms: i64, result: Result<(), String>) -> Attempt {
    let failures = previous.filter(|attempt| attempt.bundled == bundled).map_or(0, |attempt| attempt.failures);
    match result {
        Ok(()) => Attempt { bundled: bundled.to_string(), failures, last_ms: now_ms, error: None, done: true },
        Err(error) => Attempt { bundled: bundled.to_string(), failures: failures + 1, last_ms: now_ms, error: Some(error), done: false },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_compare_as_semver_with_prereleases_first() {
        assert!(is_older("0.1.2", "0.1.3"));
        assert!(is_older("0.1.9", "0.1.10"), "numbers, not text");
        assert!(is_older("0.1.3-rc.1", "0.1.3"), "a prerelease comes before its release");
        assert!(!is_older("0.1.3", "0.1.3"));
        assert!(!is_older("0.2.0", "0.1.3"), "never down");
        assert!(!is_older("unknown", "0.1.3"));
    }

    /// An older probe is updated; the same or a newer one, or one whose release isn't known, is left. A failure waits
    /// out its backoff, longer each time, and a success isn't tried again for that release; a newer carried release
    /// starts over.
    #[test]
    fn an_older_probe_is_updated_once_and_a_failure_backs_off() {
        let bundled = "0.1.3";
        assert_eq!(next(Some("0.1.2"), bundled, None, 0), Next::Update);
        assert_eq!(next(Some("0.1.3"), bundled, None, 0), Next::Nothing);
        assert_eq!(next(Some("0.1.4"), bundled, None, 0), Next::Nothing);
        assert_eq!(next(None, bundled, None, 0), Next::Nothing, "no probe, or its release unknown");

        let failed = record(None, bundled, 1_000, Err("ssh: connect to host cedar-01 port 22: Operation timed out".into()));
        assert_eq!((failed.failures, failed.done, failed.error.is_some()), (1, false, true));
        assert_eq!(next(Some("0.1.2"), bundled, Some(&failed), 1_000 + BACKOFF_FIRST_MS - 1), Next::Wait);
        assert_eq!(next(Some("0.1.2"), bundled, Some(&failed), 1_000 + BACKOFF_FIRST_MS), Next::Update);
        let again = record(Some(&failed), bundled, 2_000, Err("still down".into()));
        assert_eq!(again.failures, 2);
        assert_eq!(next(Some("0.1.2"), bundled, Some(&again), 2_000 + BACKOFF_FIRST_MS), Next::Wait, "twice as long");
        assert_eq!(backoff_ms(40), BACKOFF_MAX_MS);

        let done = record(Some(&again), bundled, 3_000, Ok(()));
        assert_eq!((done.done, done.error.as_deref()), (true, None));
        assert_eq!(next(Some("0.1.2"), bundled, Some(&done), i64::MAX), Next::Nothing, "once per carried release");
        assert_eq!(next(Some("0.1.3"), "0.1.4", Some(&done), 3_000), Next::Update, "a newer carried release starts over");
    }
}
