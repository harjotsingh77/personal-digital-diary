//! Writing streaks and totals. Only entry *dates* are needed, which are the
//! one piece of plaintext metadata, so this never touches the data key.

use rusqlite::Connection;
use serde::Serialize;

use crate::entries::validate_date;
use crate::error::AppResult;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Consecutive days written, ending today — or yesterday, so the streak
    /// isn't shown as broken before you've had a chance to write today.
    pub current_streak: u32,
    pub longest_streak: u32,
    pub total_entries: u32,
    pub written_today: bool,
}

/// Days since 1970-01-01 for a valid `YYYY-MM-DD` (Howard Hinnant's algorithm).
pub fn day_number(date: &str) -> i64 {
    let y: i64 = date[0..4].parse().unwrap_or(1970);
    let m: i64 = date[5..7].parse().unwrap_or(1);
    let d: i64 = date[8..10].parse().unwrap_or(1);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `today` comes from the frontend so it matches the user's local timezone.
pub fn compute(conn: &Connection, today: &str) -> AppResult<Stats> {
    validate_date(today)?;
    let mut stmt = conn.prepare("SELECT entry_date FROM entries ORDER BY entry_date")?;
    let days: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .map(|d| day_number(&d))
        .collect();
    Ok(from_days(&days, day_number(today)))
}

/// Pure core of [`compute`]: `days` must be sorted ascending and unique.
fn from_days(days: &[i64], today: i64) -> Stats {
    let mut longest = 0u32;
    let mut run = 0u32;
    for (i, &d) in days.iter().enumerate() {
        run = if i > 0 && days[i - 1] == d - 1 { run + 1 } else { 1 };
        longest = longest.max(run);
    }

    let written_today = days.binary_search(&today).is_ok();
    let mut current = 0u32;
    let mut cursor = if written_today { today } else { today - 1 };
    while days.binary_search(&cursor).is_ok() {
        current += 1;
        cursor -= 1;
    }

    Stats { current_streak: current, longest_streak: longest, total_entries: days.len() as u32, written_today }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_numbers() {
        assert_eq!(day_number("1970-01-01"), 0);
        assert_eq!(day_number("2000-03-01") - day_number("2000-02-28"), 2); // leap year
        assert_eq!(day_number("2026-01-01") - day_number("2025-12-31"), 1);
    }

    #[test]
    fn streaks() {
        let t = 100;
        // Written 97, 98, 99, 100 → streak 4.
        assert_eq!(from_days(&[90, 97, 98, 99, 100], t).current_streak, 4);
        // Not yet today but yesterday & before → streak still alive.
        let s = from_days(&[98, 99], t);
        assert_eq!((s.current_streak, s.written_today), (2, false));
        // Gap of a day → broken.
        assert_eq!(from_days(&[97, 98], t).current_streak, 0);
        assert_eq!(from_days(&[1, 2, 3, 4, 10, 11], t).longest_streak, 4);
        assert_eq!(from_days(&[], t), Stats { current_streak: 0, longest_streak: 0, total_entries: 0, written_today: false });
    }
}
