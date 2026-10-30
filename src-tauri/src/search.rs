//! Full-text search and tag listing. Entries are encrypted, so there is no
//! SQL index to query — instead every entry is decrypted in memory and
//! matched here. That's fast for any realistic diary (thousands of entries).

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::crypto::Key;
use crate::entries::{self, EntryPayload, EntrySummary};
use crate::error::AppResult;

const SNIPPET_BEFORE: usize = 60;
const SNIPPET_LEN: usize = 220;
const ON_THIS_DAY_MONTHS: i32 = 6;

/// Narrows a search. Dates are inclusive `YYYY-MM-DD`; unset means no limit.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub mood: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub favourite: bool,
}

impl Filters {
    fn is_empty(&self) -> bool {
        self.mood.is_none() && self.from.is_none() && self.to.is_none() && !self.favourite
    }

    fn matches(&self, date: &str, p: &EntryPayload) -> bool {
        self.mood.as_ref().is_none_or(|m| p.mood.as_ref() == Some(m))
            && self.from.as_ref().is_none_or(|f| date >= f.as_str())
            && self.to.as_ref().is_none_or(|t| date <= t.as_str())
            && (!self.favourite || p.favourite)
    }
}

/// Query syntax: plain words must all appear (title, text, tags or voice note
/// transcripts, case-insensitive); `#tag` words require that exact tag.
/// With no words, filters alone choose the results.
pub fn search(conn: &Connection, key: &Key, query: &str, filters: &Filters) -> AppResult<Vec<EntrySummary>> {
    let (tags, words): (Vec<String>, Vec<String>) = query
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .partition(|w| w.starts_with('#') && w.len() > 1);
    let tags: Vec<String> = tags.into_iter().map(|t| t[1..].to_string()).collect();
    if tags.is_empty() && words.is_empty() && filters.is_empty() {
        return Ok(vec![]);
    }

    let mut hits = Vec::new();
    for (date, _, updated, payload) in entries::list_payloads(conn, key, None)? {
        if !filters.matches(&date, &payload) || !tags.iter().all(|t| payload.tags.contains(t)) {
            continue;
        }
        let transcripts: Vec<&str> = payload.voice_notes.iter().map(|n| n.transcript.as_str()).collect();
        let haystack = format!("{}\n{}\n{}\n{}", payload.title, payload.text, payload.tags.join(" "), transcripts.join("\n")).to_lowercase();
        if !words.iter().all(|w| haystack.contains(w.as_str())) {
            continue;
        }
        let snippet = words.first().and_then(|w| {
            snippet_around(&payload.text, w).or_else(|| transcripts.iter().find_map(|t| snippet_around(t, w)))
        });
        let mut summary = EntrySummary::from(date, updated, payload);
        if let Some(s) = snippet {
            summary.preview = s;
        }
        hits.push(summary);
    }
    Ok(hits)
}

/// A preview window starting a little before the first match of `word`.
fn snippet_around(text: &str, word: &str) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower: Vec<char> = flat.to_lowercase().chars().collect();
    let chars: Vec<char> = flat.chars().collect();
    if lower.len() != chars.len() {
        return None; // case-mapping changed lengths; fall back to the normal preview
    }
    let needle: Vec<char> = word.chars().collect();
    let pos = lower.windows(needle.len()).position(|w| w == needle.as_slice())?;
    let start = pos.saturating_sub(SNIPPET_BEFORE);
    // Snap the start forward to a word boundary.
    let start = if start == 0 { 0 } else { chars[start..pos].iter().position(|c| *c == ' ').map_or(start, |i| start + i + 1) };
    let end = (start + SNIPPET_LEN).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 { s.insert(0, '…'); }
    if end < chars.len() { s.push('…'); }
    Some(s)
}

/// Earlier entries worth resurfacing on `today`: the same date in past years,
/// and the same day of the month over the last few months. Newest first.
pub fn on_this_day(conn: &Connection, key: &Key, today: &str) -> AppResult<Vec<EntrySummary>> {
    entries::validate_date(today)?;
    let (year, month, day) = (&today[..4], &today[5..7], &today[8..]);
    let (y, m): (i32, i32) = (year.parse().unwrap_or(0), month.parse().unwrap_or(0));
    let this_month = y * 12 + m;
    Ok(entries::list_payloads(conn, key, None)?
        .into_iter()
        .filter(|(date, ..)| {
            if date.as_str() >= today || &date[8..] != day {
                return false;
            }
            let (ey, em): (i32, i32) = (date[..4].parse().unwrap_or(0), date[5..7].parse().unwrap_or(0));
            &date[5..7] == month || this_month - (ey * 12 + em) <= ON_THIS_DAY_MONTHS
        })
        .map(|(date, _, updated, p)| EntrySummary::from(date, updated, p))
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRef {
    pub id: String,
    pub date: String,
}

/// Every photo in the diary with the day it belongs to, newest day first.
pub fn photos(conn: &Connection, key: &Key) -> AppResult<Vec<PhotoRef>> {
    Ok(entries::list_payloads(conn, key, None)?
        .into_iter()
        .flat_map(|(date, _, _, p)| p.photos.into_iter().map(move |id| PhotoRef { id, date: date.clone() }))
        .collect())
}

#[derive(Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// Every tag in use with how many entries carry it, most used first.
pub fn tags(conn: &Connection, key: &Key) -> AppResult<Vec<TagCount>> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (_, _, _, p) in entries::list_payloads(conn, key, None)? {
        for t in p.tags {
            *counts.entry(t).or_default() += 1;
        }
    }
    let mut out: Vec<TagCount> = counts.into_iter().map(|(tag, count)| TagCount { tag, count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto, db};

    fn setup() -> (Connection, Key) {
        let conn = db::init(Connection::open_in_memory().unwrap()).unwrap();
        let key = crypto::random_key();
        let add = |d: &str, title: &str, text: &str, tags: &[&str]| {
            let p = EntryPayload {
                title: title.into(),
                text: text.into(),
                tags: tags.iter().map(|t| t.to_string()).collect(),
                ..Default::default()
            };
            entries::save(&conn, &key, d, &p).unwrap();
        };
        add("2026-10-01", "Beach", "Swam in the cold sea with Maya", &["travel", "friends"]);
        add("2026-10-02", "Work", "Long meeting about the roadmap", &["work"]);
        add("2026-10-03", "", "Dinner with maya and Arjun", &["friends"]);
        (conn, key)
    }

    fn dates(hits: Vec<EntrySummary>) -> Vec<String> {
        hits.into_iter().map(|h| h.date).collect()
    }

    #[test]
    fn words_and_tags() {
        let (conn, key) = setup();
        assert_eq!(dates(search(&conn, &key, "MAYA", &Filters::default()).unwrap()), ["2026-10-03", "2026-10-01"]);
        assert_eq!(dates(search(&conn, &key, "maya #travel", &Filters::default()).unwrap()), ["2026-10-01"]);
        assert_eq!(dates(search(&conn, &key, "#work", &Filters::default()).unwrap()), ["2026-10-02"]);
        assert_eq!(dates(search(&conn, &key, "beach", &Filters::default()).unwrap()), ["2026-10-01"]); // title match
        assert!(search(&conn, &key, "maya roadmap", &Filters::default()).unwrap().is_empty());
        assert!(search(&conn, &key, "   ", &Filters::default()).unwrap().is_empty());
    }

    #[test]
    fn filters_narrow_and_work_without_words() {
        let (conn, key) = setup();
        let range = Filters { from: Some("2026-10-02".into()), to: Some("2026-10-02".into()), ..Default::default() };
        assert_eq!(dates(search(&conn, &key, "", &range).unwrap()), ["2026-10-02"]);
        assert!(search(&conn, &key, "maya", &range).unwrap().is_empty());

        let mut p = entries::get(&conn, &key, "2026-10-01").unwrap().unwrap().payload;
        p.mood = Some("good".into());
        p.favourite = true;
        entries::save(&conn, &key, "2026-10-01", &p).unwrap();
        let mood = Filters { mood: Some("good".into()), ..Default::default() };
        assert_eq!(dates(search(&conn, &key, "", &mood).unwrap()), ["2026-10-01"]);
        let fav = Filters { favourite: true, ..Default::default() };
        assert_eq!(dates(search(&conn, &key, "", &fav).unwrap()), ["2026-10-01"]);
    }

    #[test]
    fn transcripts_are_searched() {
        let (conn, key) = setup();
        let mut p = entries::get(&conn, &key, "2026-10-02").unwrap().unwrap().payload;
        p.voice_notes = vec![entries::VoiceNote { id: "a".repeat(32), transcript: "the lighthouse at dusk".into(), ..Default::default() }];
        entries::save(&conn, &key, "2026-10-02", &p).unwrap();
        let hits = search(&conn, &key, "lighthouse", &Filters::default()).unwrap();
        assert_eq!(hits[0].date, "2026-10-02");
        assert!(hits[0].preview.contains("lighthouse"));
    }

    #[test]
    fn on_this_day_finds_past_years_and_recent_months() {
        let (conn, key) = setup();
        let add = |d: &str| {
            let p = EntryPayload { text: "x".into(), photos: vec![format!("photo-{d}")], ..Default::default() };
            entries::save(&conn, &key, d, &p).unwrap();
        };
        for d in ["2020-10-15", "2025-10-15", "2026-08-15", "2025-08-15", "2026-10-14", "2027-10-15"] {
            add(d);
        }
        let got = dates(on_this_day(&conn, &key, "2026-10-15").unwrap());
        assert_eq!(got, ["2026-08-15", "2025-10-15", "2020-10-15"]);
        let all = photos(&conn, &key).unwrap();
        assert_eq!((all[0].date.as_str(), all[0].id.as_str()), ("2027-10-15", "photo-2027-10-15"));
    }

    #[test]
    fn tag_counts() {
        let (conn, key) = setup();
        let t = tags(&conn, &key).unwrap();
        assert_eq!((t[0].tag.as_str(), t[0].count), ("friends", 2));
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn snippet_starts_near_match() {
        let text = format!("{} needle here", "word ".repeat(40));
        let s = snippet_around(&text, "needle").unwrap();
        assert!(s.starts_with('…') && s.contains("needle"));
    }
}
