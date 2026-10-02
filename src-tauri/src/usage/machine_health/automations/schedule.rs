//! Schedules as RRULEs, the way the Codex app and Orca keep them, read for the few shapes a schedule takes: every few
//! minutes, every few hours at a minute, or at a time of day on some days of the week. Times are this Mac's own, as
//! Arbor runs its automations from here. A rule of another shape is shown as it is and can't be run by Arbor.

use super::ScheduleSummary;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};

/// A rule Arbor can run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Rule {
    EveryMinutes(u32),
    EveryHours { hours: u32, minute: u32 },
    /// `days` from Sunday, 0; all seven for every day.
    Days { days: Vec<u8>, hour: u32, minute: u32 },
}

const BYDAY: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const KNOWN: [&str; 6] = ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYSECOND", "BYDAY"];

/// The rule an RRULE describes, with or without its `RRULE:` start, or None for one of another shape.
pub(super) fn parse(rrule: &str) -> Option<Rule> {
    let body = rrule.trim();
    let body = body.strip_prefix("RRULE:").or_else(|| body.strip_prefix("rrule:")).unwrap_or(body);
    let mut parts = std::collections::BTreeMap::new();
    for part in body.split(';').filter(|part| !part.is_empty()) {
        let (key, value) = part.split_once('=')?;
        let key = key.trim().to_ascii_uppercase();
        if !KNOWN.contains(&key.as_str()) {
            return None;
        }
        parts.insert(key, value.trim().to_ascii_uppercase());
    }
    let number = |key: &str, fallback: u32| -> Option<u32> { parts.get(key).map_or(Some(fallback), |value| value.parse().ok()) };
    let interval = number("INTERVAL", 1)?.max(1);
    let minute = number("BYMINUTE", 0)?;
    let hour = number("BYHOUR", 0)?;
    if number("BYSECOND", 0)? != 0 || minute > 59 || hour > 23 {
        return None;
    }
    let days = match parts.get("BYDAY") {
        Some(days) => {
            let mut parsed = days
                .split(',')
                .map(|day| BYDAY.iter().position(|name| *name == day.trim()).map(|at| at as u8))
                .collect::<Option<Vec<u8>>>()?;
            parsed.sort_unstable();
            parsed.dedup();
            Some(parsed)
        }
        None => None,
    };
    match parts.get("FREQ").map(String::as_str) {
        Some("MINUTELY") if !parts.contains_key("BYHOUR") && !parts.contains_key("BYMINUTE") && days.is_none() => {
            (interval <= 24 * 60).then_some(Rule::EveryMinutes(interval))
        }
        Some("HOURLY") if !parts.contains_key("BYHOUR") && days.is_none() => (interval <= 24).then_some(Rule::EveryHours { hours: interval, minute }),
        Some("DAILY") if interval == 1 && parts.contains_key("BYHOUR") => Some(Rule::Days { days: days.unwrap_or_else(|| (0..7).collect()), hour, minute }),
        Some("WEEKLY") if interval == 1 && parts.contains_key("BYHOUR") => days.filter(|days| !days.is_empty()).map(|days| Rule::Days { days, hour, minute }),
        _ => None,
    }
}

/// What the list says about a rule; one Arbor can't read is Custom.
pub(super) fn summary(rrule: &str) -> ScheduleSummary {
    match parse(rrule) {
        Some(Rule::EveryMinutes(minutes)) => ScheduleSummary::EveryMinutes { minutes },
        Some(Rule::EveryHours { hours, minute }) => ScheduleSummary::EveryHours { hours, minute },
        Some(Rule::Days { days, hour, minute }) if days.len() == 7 => ScheduleSummary::Daily { hour, minute },
        Some(Rule::Days { days, hour, minute }) if days == [1, 2, 3, 4, 5] => ScheduleSummary::Weekdays { hour, minute },
        Some(Rule::Days { days, hour, minute }) => ScheduleSummary::Weekly { days, hour, minute },
        None => ScheduleSummary::Custom,
    }
}

/// The first time after `after_ms` the rule falls on, in this Mac's time. Minutes and hours count from midnight, so
/// "every 30 minutes" is on the hour and half past, whenever it was saved.
pub(super) fn next_after(rule: &Rule, after_ms: i64) -> Option<i64> {
    next_after_in(&Local, rule, after_ms)
}

pub(super) fn next_after_in<Tz: TimeZone>(zone: &Tz, rule: &Rule, after_ms: i64) -> Option<i64> {
    let after = zone.timestamp_millis_opt(after_ms).single()?;
    let at = |date: NaiveDate, hour: u32, minute: u32| -> Option<DateTime<Tz>> {
        // A time a clock change skips takes the hour after; one it repeats, the first.
        let naive = date.and_hms_opt(hour, minute, 0)?;
        zone.from_local_datetime(&naive).earliest().or_else(|| zone.from_local_datetime(&(naive + Duration::hours(1))).earliest())
    };
    let today = after.date_naive();
    for offset in 0..9 {
        let date = today + Duration::days(offset);
        let times: Vec<(u32, u32)> = match rule {
            Rule::EveryMinutes(every) => (0..24 * 60).step_by(*every as usize).map(|total| (total / 60, total % 60)).collect(),
            Rule::EveryHours { hours, minute } => (0..24).step_by(*hours as usize).map(|hour| (hour, *minute)).collect(),
            Rule::Days { days, hour, minute } => {
                if days.contains(&(date.weekday().num_days_from_sunday() as u8)) { vec![(*hour, *minute)] } else { Vec::new() }
            }
        };
        for (hour, minute) in times {
            if let Some(when) = at(date, hour, minute) {
                if when.timestamp_millis() > after_ms {
                    return Some(when.timestamp_millis());
                }
            }
        }
    }
    None
}

/// A rule as the dialog writes it, for tests to check a rule reads back as itself.
#[cfg(test)]
pub(super) fn rule_text(rule: &Rule) -> String {
    match rule {
        Rule::EveryMinutes(every) => format!("FREQ=MINUTELY;INTERVAL={every}"),
        Rule::EveryHours { hours, minute } => format!("FREQ=HOURLY;INTERVAL={hours};BYMINUTE={minute}"),
        Rule::Days { days, hour, minute } => {
            let names: Vec<&str> = days.iter().filter_map(|day| BYDAY.get(*day as usize).copied()).collect();
            format!("FREQ=WEEKLY;BYDAY={};BYHOUR={hour};BYMINUTE={minute}", names.join(","))
        }
    }
}

/// The hour and minute of a time, for tests to read a run's time by.
#[cfg(test)]
fn clock<Tz: TimeZone>(zone: &Tz, ms: i64) -> (u32, u32, u32) {
    use chrono::Timelike;
    let when = zone.timestamp_millis_opt(ms).unwrap();
    (when.day(), when.hour(), when.minute())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn ms(zone: &FixedOffset, day: u32, hour: u32, minute: u32) -> i64 {
        // 2026-10-01 is a Thursday.
        zone.with_ymd_and_hms(2026, 10, day, hour, minute, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn reads_the_shapes_the_codex_app_and_orca_write() {
        assert_eq!(parse("RRULE:FREQ=HOURLY;INTERVAL=1"), Some(Rule::EveryHours { hours: 1, minute: 0 }));
        assert_eq!(parse("FREQ=MINUTELY;INTERVAL=5"), Some(Rule::EveryMinutes(5)));
        assert_eq!(parse("RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=1;BYMINUTE=0;BYSECOND=0"), Some(Rule::Days { days: (0..7).collect(), hour: 1, minute: 0 }));
        assert_eq!(parse("FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=SU,MO,TU,WE,TH,FR,SA"), Some(Rule::Days { days: (0..7).collect(), hour: 9, minute: 0 }));
        assert_eq!(parse("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0"), Some(Rule::Days { days: vec![1, 2, 3, 4, 5], hour: 6, minute: 0 }));
        assert_eq!(parse("FREQ=HOURLY;INTERVAL=4"), Some(Rule::EveryHours { hours: 4, minute: 0 }));
    }

    #[test]
    fn leaves_rules_of_other_shapes_alone() {
        assert_eq!(parse("FREQ=MONTHLY;BYMONTHDAY=1"), None);
        assert_eq!(parse("FREQ=DAILY;INTERVAL=2;BYHOUR=9"), None);
        assert_eq!(parse("FREQ=DAILY;BYHOUR=9;BYSECOND=30"), None);
        assert_eq!(parse("FREQ=WEEKLY;BYDAY=XX;BYHOUR=9"), None);
        assert_eq!(parse("not a rule"), None);
        assert_eq!(summary("FREQ=YEARLY"), ScheduleSummary::Custom);
    }

    #[test]
    fn says_what_each_shape_is() {
        assert_eq!(summary("FREQ=DAILY;BYHOUR=17;BYMINUTE=0"), ScheduleSummary::Daily { hour: 17, minute: 0 });
        assert_eq!(summary("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"), ScheduleSummary::Weekdays { hour: 9, minute: 0 });
        assert_eq!(summary("FREQ=WEEKLY;BYDAY=SU;BYHOUR=3;BYMINUTE=0"), ScheduleSummary::Weekly { days: vec![0], hour: 3, minute: 0 });
        assert_eq!(summary("FREQ=HOURLY;INTERVAL=1;BYMINUTE=15"), ScheduleSummary::EveryHours { hours: 1, minute: 15 });
        assert_eq!(rule_text(&Rule::Days { days: vec![1, 3], hour: 9, minute: 5 }), "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=5");
    }

    #[test]
    fn finds_the_next_time_from_midnight() {
        let zone = FixedOffset::east_opt(10 * 3600).unwrap();
        let every_30 = Rule::EveryMinutes(30);
        assert_eq!(clock(&zone, next_after_in(&zone, &every_30, ms(&zone, 1, 9, 10)).unwrap()), (1, 9, 30));
        // Exactly on a time is past it.
        assert_eq!(clock(&zone, next_after_in(&zone, &every_30, ms(&zone, 1, 9, 30)).unwrap()), (1, 10, 0));
        let hourly_15 = Rule::EveryHours { hours: 1, minute: 15 };
        assert_eq!(clock(&zone, next_after_in(&zone, &hourly_15, ms(&zone, 1, 23, 20)).unwrap()), (2, 0, 15));
        let every_4 = Rule::EveryHours { hours: 4, minute: 0 };
        assert_eq!(clock(&zone, next_after_in(&zone, &every_4, ms(&zone, 1, 9, 0)).unwrap()), (1, 12, 0));
    }

    #[test]
    fn skips_to_the_next_day_it_runs_on() {
        let zone = FixedOffset::east_opt(10 * 3600).unwrap();
        // Thursday 18:00, weekdays at 9: Friday.
        let weekdays = parse("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0").unwrap();
        assert_eq!(clock(&zone, next_after_in(&zone, &weekdays, ms(&zone, 1, 18, 0)).unwrap()), (2, 9, 0));
        // Friday 18:00: Monday the 5th.
        assert_eq!(clock(&zone, next_after_in(&zone, &weekdays, ms(&zone, 2, 18, 0)).unwrap()), (5, 9, 0));
        // Sundays at 3, from Thursday: the 4th.
        let sundays = parse("FREQ=WEEKLY;BYDAY=SU;BYHOUR=3;BYMINUTE=0").unwrap();
        assert_eq!(clock(&zone, next_after_in(&zone, &sundays, ms(&zone, 1, 12, 0)).unwrap()), (4, 3, 0));
    }

    #[test]
    fn a_day_with_a_clock_change_still_has_its_run() {
        // Sydney's clocks go from 2:00 to 3:00 on 2026-10-04, so on a Mac there 2:30 that day takes 3:30.
        let rule = Rule::Days { days: (0..7).collect(), hour: 2, minute: 30 };
        let zone = Local;
        // Whatever this Mac's zone, the next run is found and is after the start.
        let start = zone.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap().timestamp_millis();
        let next = next_after_in(&zone, &rule, start).unwrap();
        assert!(next > start && next - start <= 25 * 3_600_000);
    }
}
