//! Unified catalog grouping for "Listen and Watch": movies, series, albums,
//! artists, tracks, and clips. Mirrors the grouping, merging, folding, sleeve
//! hash, 6-slot per-artist hue wheel, and monogram rules from `src/ui.js`.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use peartube::worker::Entry;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoKind {
    Movie,
    Series,
    Clip,
}

#[derive(Clone, Debug)]
pub struct VideoItem {
    pub entry: Entry,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct VideoTile {
    pub key: String,
    pub kind: VideoKind,
    pub imdb: Option<String>,
    pub title: String,
    pub year: Option<String>,
    pub items: Vec<VideoItem>,
    pub saved: usize,
    pub partial: bool,
}

impl VideoTile {
    pub fn seasons(&self) -> Vec<u32> {
        self.items
            .iter()
            .filter_map(|i| i.season)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub fn subtitle_line(&self, format_bytes_fn: fn(u64) -> String) -> String {
        let n = self.items.len();
        match self.kind {
            VideoKind::Series => {
                let s = self.seasons().len();
                if s > 1 {
                    format!("{} · {}", plural(s, "season", "seasons"), plural(n, "episode", "episodes"))
                } else {
                    plural(n, "episode", "episodes")
                }
            }
            VideoKind::Movie => {
                let second = if n > 1 {
                    format!("{n} versions")
                } else {
                    format_bytes_fn(self.items.first().map_or(0, |i| i.entry.size))
                };
                if let Some(y) = &self.year {
                    format!("{y} · {second}")
                } else {
                    format!("Movie · {second}")
                }
            }
            VideoKind::Clip => {
                let sz = format_bytes_fn(self.items.first().map_or(0, |i| i.entry.size));
                format!("Clip · {sz}")
            }
        }
    }

    pub fn state_label(&self) -> String {
        if self.saved == self.items.len() {
            "Saved here".to_string()
        } else if self.saved > 0 || self.partial {
            match self.kind {
                VideoKind::Series => format!("{} saved here", self.saved),
                _ => "Partly saved".to_string(),
            }
        } else {
            "On the network".to_string()
        }
    }
}

#[derive(Clone, Debug)]
pub struct AlbumTrack {
    pub entry: Entry,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub copies: usize,
    pub alts: Vec<Entry>,
}

#[derive(Clone, Debug)]
pub struct AlbumTile {
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub releases: usize,
    pub all_keys: Vec<String>,
    pub items: Vec<AlbumTrack>,
    pub saved: usize,
    pub partial: bool,
    pub seed: u32,
    pub hue: u32,
    pub monogram: String,
    pub all_yt: bool,
}

impl AlbumTile {
    pub fn total_bytes(&self) -> u64 {
        self.items.iter().map(|i| i.entry.size).sum()
    }

    pub fn discs(&self) -> usize {
        self.items
            .iter()
            .filter_map(|i| i.season)
            .collect::<BTreeSet<_>>()
            .len()
    }

    pub fn state_label(&self) -> String {
        if self.saved == self.items.len() {
            "Saved here".to_string()
        } else if self.saved > 0 || self.partial {
            format!("{} of {} saved here", self.saved, self.items.len())
        } else {
            "On the network".to_string()
        }
    }
}

#[derive(Clone, Debug)]
pub struct ArtistGroup {
    pub key: String,
    pub name: String,
    pub album_keys: Vec<String>,
    pub sleeves: Vec<(u32, u32, String)>,
    pub track_count: usize,
    pub saved_tracks: usize,
}

#[derive(Clone, Debug)]
pub struct TrackRow {
    pub entry: Entry,
    pub album_key: String,
    pub album_title: String,
    pub artist: String,
    pub track_no: String,
    pub track_name: String,
    pub hue: u32,
    pub seed: u32,
    pub monogram: String,
    pub is_yt: bool,
    pub saved: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub albums: Vec<AlbumTile>,
    pub artists: Vec<ArtistGroup>,
    pub tracks: Vec<TrackRow>,
    pub movies: Vec<VideoTile>,
    pub series: Vec<VideoTile>,
    pub clips: Vec<VideoTile>,
}

impl Catalog {
    pub fn is_empty(&self) -> bool {
        self.albums.is_empty()
            && self.movies.is_empty()
            && self.series.is_empty()
            && self.clips.is_empty()
    }

    pub fn album_by_key(&self, key: &str) -> Option<&AlbumTile> {
        self.albums.iter().find(|a| a.key == key)
    }

    pub fn artist_by_key(&self, key: &str) -> Option<&ArtistGroup> {
        self.artists.iter().find(|a| a.key == key)
    }

    pub fn video_by_key(&self, key: &str) -> Option<&VideoTile> {
        self.movies
            .iter()
            .chain(self.series.iter())
            .chain(self.clips.iter())
            .find(|v| v.key == key)
    }
}

pub fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

pub fn is_saved(entry: &Entry) -> bool {
    entry.local || (entry.size > 0 && entry.cached_bytes >= entry.size)
}

pub fn is_yt(entry: &Entry) -> bool {
    entry.id.starts_with("yt:")
}

pub fn is_music_entry(entry: &Entry) -> bool {
    parse_imdb_id(&entry.id).is_none() && entry.season.is_some()
}

pub fn track_name(entry: &Entry) -> String {
    if let Some(title) = entry
        .music
        .as_ref()
        .and_then(|m| m.title.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return title.to_string();
    }
    if let Some(last) = entry.id.rsplit(':').next().filter(|s| !s.is_empty()) {
        return last.to_uppercase();
    }
    if !entry.title.is_empty() {
        return entry.title.clone();
    }
    "Track".to_string()
}

pub fn track_no(entry: &Entry) -> String {
    match (entry.season, entry.episode) {
        (Some(s), Some(e)) => {
            if s > 1 {
                format!("{s}-{e:02}")
            } else {
                format!("{e:02}")
            }
        }
        _ => String::new(),
    }
}

/// Formats remaining time in human units matching `design/unified-library.md`
/// (`1 h 36 min left`, `31 min left`).
pub fn format_time_left(remaining_ms: u64) -> String {
    let total_mins = (remaining_ms + 30_000) / 60_000;
    if total_mins == 0 {
        return "Less than 1 min left".to_string();
    }
    let hours = total_mins / 60;
    let mins = total_mins % 60;
    if hours > 0 && mins > 0 {
        format!("{hours} h {mins} min left")
    } else if hours > 0 {
        format!("{hours} h left")
    } else {
        format!("{mins} min left")
    }
}

/// Parses `^imdb:(tt[0-9]+)(?::s([0-9]+)e([0-9]+))?$`.
fn parse_imdb_id(id: &str) -> Option<(&str, Option<u32>, Option<u32>)> {
    let rest = id.strip_prefix("imdb:")?;
    let (tt, suffix) = match rest.find(':') {
        Some(idx) => (&rest[..idx], Some(&rest[idx + 1..])),
        None => (rest, None),
    };
    let digits = tt.strip_prefix("tt")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match suffix {
        None => Some((tt, None, None)),
        Some(se) => {
            let s_rest = se.strip_prefix('s')?;
            let e_idx = s_rest.find('e')?;
            let s_part = &s_rest[..e_idx];
            let e_part = &s_rest[e_idx + 1..];
            if s_part.is_empty()
                || e_part.is_empty()
                || !s_part.bytes().all(|b| b.is_ascii_digit())
                || !e_part.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            let s = s_part.parse::<u32>().ok()?;
            let e = e_part.parse::<u32>().ok()?;
            Some((tt, Some(s), Some(e)))
        }
    }
}

/// Strips a trailing `\s+S[0-9]+E[0-9]+$` (case-insensitive) from a title.
fn strip_se_suffix(title: &str) -> String {
    let trimmed = title.trim_end();
    let Some(space_idx) = trimmed.rfind(|c: char| c.is_whitespace()) else {
        return trimmed.to_string();
    };
    let tail = &trimmed[space_idx + 1..];
    let bytes = tail.as_bytes();
    if bytes.len() >= 4 && matches!(bytes[0], b's' | b'S') {
        if let Some(e_pos) = bytes[1..].iter().position(|&b| matches!(b, b'e' | b'E')) {
            let s_digits = &bytes[1..1 + e_pos];
            let e_digits = &bytes[2 + e_pos..];
            if !s_digits.is_empty()
                && !e_digits.is_empty()
                && s_digits.iter().all(u8::is_ascii_digit)
                && e_digits.iter().all(u8::is_ascii_digit)
            {
                return trimmed[..space_idx].trim_end().to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Latin & Greek base characters whose combining diacritics fold away in `fold()`.
fn is_accent_base(c: char) -> bool {
    matches!(
        c,
        'A'..='Z'
            | 'a'..='z'
            | '\u{00C0}'..='\u{024F}'
            | '\u{1E00}'..='\u{1EFF}'
            | '\u{2C60}'..='\u{2C7F}'
            | '\u{A720}'..='\u{A7FF}'
            | '\u{0370}'..='\u{03FF}'
            | '\u{1F00}'..='\u{1FFF}'
    )
}

/// Maps common precomposed lowercase Latin/Greek letters to their unaccented
/// base character while leaving Cyrillic (`й`, `ё`) and non-Latin/Greek scripts
/// intact, matching `src/ui.js`'s `fold`.
fn strip_precomposed_latin_greek(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' | 'ŧ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        // Greek accents & final sigma
        'ά' | 'ἀ' | 'ἁ' | 'ἂ' | 'ἃ' | 'ἄ' | 'ἅ' | 'ἆ' | 'ἇ' | 'ὰ' | '\u{1F71}' => 'α',
        'έ' | 'ἐ' | 'ἑ' | 'ἒ' | 'ἓ' | 'ἔ' | 'ἕ' | 'ὲ' => 'ε',
        'ή' | 'ἠ' | 'ἡ' | 'ἢ' | 'ἣ' | 'ἤ' | 'ἥ' | 'ἦ' | 'ἧ' | 'ὴ' => 'η',
        'ί' | 'ϊ' | 'ΐ' | 'ἰ' | 'ἱ' | 'ἲ' | 'ἳ' | 'ἴ' | 'ἵ' | 'ἶ' | 'ἷ' | 'ὶ' => 'ι',
        'ό' | 'ὀ' | 'ὁ' | 'ὂ' | 'ὃ' | 'ὄ' | 'ὅ' | 'ὸ' => 'ο',
        'ύ' | 'ϋ' | 'ΰ' | 'ὐ' | 'ὑ' | 'ὒ' | 'ὓ' | 'ὔ' | 'ὕ' | 'ὖ' | 'ὗ' | 'ὺ' => 'υ',
        'ώ' | 'ὠ' | 'ὡ' | 'ὢ' | 'ὣ' | 'ὤ' | 'ὥ' | 'ὦ' | 'ὧ' | 'ὼ' => 'ω',
        'ς' => 'σ',
        // Fullwidth ASCII letters & digits
        '\u{FF10}'..='\u{FF19}' => char::from_u32(c as u32 - 0xFF10 + '0' as u32).unwrap_or(c),
        '\u{FF21}'..='\u{FF3A}' => char::from_u32(c as u32 - 0xFF21 + 'a' as u32).unwrap_or(c),
        '\u{FF41}'..='\u{FF5A}' => char::from_u32(c as u32 - 0xFF41 + 'a' as u32).unwrap_or(c),
        other => other,
    }
}

/// Folds case, width, punctuation, and Latin/Greek diacritics while preserving
/// non-Latin/Greek marks (such as Cyrillic `й`/`ё`), matching `src/ui.js`.
pub fn fold(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_base: Option<char> = None;
    let mut prev_space = true;

    for raw in lower.chars() {
        // Combining diacritical mark block U+0300..=U+036F
        if ('\u{0300}'..='\u{036F}').contains(&raw) {
            if let Some(base) = last_base {
                if !is_accent_base(base) {
                    out.push(raw);
                }
            }
            continue;
        }
        let c = strip_precomposed_latin_greek(raw);
        if c.is_alphanumeric() {
            out.push(c);
            last_base = Some(c);
            prev_space = false;
        } else {
            last_base = None;
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// FNV-1a over UTF-16 code units with final avalanche, matching `src/ui.js`'s `sleeveHash`.
pub fn sleeve_hash(s: &str) -> u32 {
    let mut x: u32 = 2166136261;
    for unit in s.encode_utf16() {
        x = (x ^ (unit as u32)).wrapping_mul(16777619);
    }
    x ^= x >> 16;
    x = x.wrapping_mul(0x85ebca6b);
    x ^= x >> 13;
    x = x.wrapping_mul(0xc2b2ae35);
    x ^ (x >> 16)
}

const SMALL_WORDS: &[&str] = &[
    "a", "an", "the", "of", "and", "in", "on", "to", "for", "le", "la", "les", "de", "der", "die", "das",
];

/// Two-letter monogram from significant words in an album or title name.
pub fn monogram(name: &str) -> String {
    let words: Vec<&str> = name
        .split(|c: char| c.is_whitespace() || matches!(c, '·' | ':' | '/' | '-'))
        .filter(|w| !w.is_empty())
        .collect();
    let big: Vec<&str> = words
        .iter()
        .copied()
        .filter(|w| {
            let low = w.to_lowercase();
            !SMALL_WORDS.contains(&low.as_str())
        })
        .collect();
    let source = if big.is_empty() { &words } else { &big };
    let picked: String = source
        .iter()
        .filter_map(|w| w.chars().next())
        .filter(|c| c.is_alphanumeric())
        .take(2)
        .collect();
    if picked.is_empty() {
        "♪".to_string()
    } else {
        picked.to_uppercase()
    }
}

struct RawAlbumBucket {
    key: String,
    items: Vec<AlbumTrack>,
}

/// Groups raw worker entries into Albums, Artists, Tracks, Movies, Series, and Clips.
pub fn build_catalog(entries: &[Entry]) -> Catalog {
    let mut video_map: HashMap<String, VideoTile> = HashMap::new();
    let mut raw_albums: HashMap<String, RawAlbumBucket> = HashMap::new();

    for e in entries {
        if let Some((imdb, season, episode)) = parse_imdb_id(&e.id) {
            let (kind, key) = if season.is_some() {
                (VideoKind::Series, format!("show:{imdb}"))
            } else {
                (VideoKind::Movie, format!("movie:{imdb}"))
            };
            let tile = video_map.entry(key.clone()).or_insert_with(|| VideoTile {
                key,
                kind,
                imdb: Some(imdb.to_string()),
                title: if !e.base_title.is_empty() {
                    e.base_title.clone()
                } else {
                    strip_se_suffix(&e.title)
                },
                year: e.year.clone(),
                items: Vec::new(),
                saved: 0,
                partial: false,
            });
            if tile.year.is_none() && e.year.is_some() {
                tile.year = e.year.clone();
            }
            tile.items.push(VideoItem {
                entry: e.clone(),
                season,
                episode,
            });
        } else if e.season.is_some() {
            let key = format!("album:{}", e.series_key);
            let bucket = raw_albums.entry(key.clone()).or_insert_with(|| RawAlbumBucket {
                key,
                items: Vec::new(),
            });
            bucket.items.push(AlbumTrack {
                entry: e.clone(),
                season: e.season,
                episode: e.episode,
                copies: 1,
                alts: Vec::new(),
            });
        } else {
            let key = format!("v:{}/{}", e.id, e.sha256);
            let tile = video_map.entry(key.clone()).or_insert_with(|| VideoTile {
                key,
                kind: VideoKind::Clip,
                imdb: None,
                title: strip_se_suffix(&e.title),
                year: e.year.clone(),
                items: Vec::new(),
                saved: 0,
                partial: false,
            });
            tile.items.push(VideoItem {
                entry: e.clone(),
                season: e.season,
                episode: e.episode,
            });
        }
    }

    let mut movies = Vec::new();
    let mut series = Vec::new();
    let mut clips = Vec::new();
    for mut tile in video_map.into_values() {
        tile.items.sort_by(|a, b| {
            a.season
                .unwrap_or(0)
                .cmp(&b.season.unwrap_or(0))
                .then_with(|| a.episode.unwrap_or(0).cmp(&b.episode.unwrap_or(0)))
                .then_with(|| b.entry.size.cmp(&a.entry.size))
        });
        tile.saved = tile.items.iter().filter(|i| is_saved(&i.entry)).count();
        tile.partial = tile
            .items
            .iter()
            .any(|i| !is_saved(&i.entry) && i.entry.cached_bytes > 0);
        match tile.kind {
            VideoKind::Movie => movies.push(tile),
            VideoKind::Series => series.push(tile),
            VideoKind::Clip => clips.push(tile),
        }
    }

    let sort_videos = |list: &mut Vec<VideoTile>| {
        list.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(|| a.key.cmp(&b.key))
        });
    };
    sort_videos(&mut movies);
    sort_videos(&mut series);
    sort_videos(&mut clips);

    let albums = merge_albums(raw_albums.into_values().collect());

    // Build artists from merged albums
    let mut artist_buckets: BTreeMap<String, (String, Vec<&AlbumTile>)> = BTreeMap::new();
    for album in &albums {
        let a_key = fold(&album.artist);
        let display = if album.artist.trim().is_empty() {
            "Unknown artist".to_string()
        } else {
            album.artist.clone()
        };
        let slot = artist_buckets
            .entry(a_key)
            .or_insert_with(|| (display, Vec::new()));
        slot.1.push(album);
    }

    let mut artists: Vec<ArtistGroup> = artist_buckets
        .into_iter()
        .map(|(key, (name, list))| {
            let track_count: usize = list.iter().map(|a| a.items.len()).sum();
            let saved_tracks: usize = list.iter().map(|a| a.saved).sum();
            let sleeves: Vec<(u32, u32, String)> = list
                .iter()
                .take(3)
                .map(|a| (a.hue, a.seed, a.monogram.clone()))
                .collect();
            let album_keys = list.iter().map(|a| a.key.clone()).collect();
            ArtistGroup {
                key,
                name,
                album_keys,
                sleeves,
                track_count,
                saved_tracks,
            }
        })
        .collect();
    artists.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.key.cmp(&b.key))
    });

    // Build flat track rows
    let mut tracks = Vec::new();
    for album in &albums {
        for item in &album.items {
            let artist = item
                .entry
                .music
                .as_ref()
                .and_then(|m| m.artist.as_deref())
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| album.artist.clone());
            tracks.push(TrackRow {
                entry: item.entry.clone(),
                album_key: album.key.clone(),
                album_title: album.album.clone(),
                artist,
                track_no: track_no(&item.entry),
                track_name: track_name(&item.entry),
                hue: album.hue,
                seed: album.seed,
                monogram: album.monogram.clone(),
                is_yt: is_yt(&item.entry),
                saved: is_saved(&item.entry),
            });
        }
    }

    Catalog {
        albums,
        artists,
        tracks,
        movies,
        series,
        clips,
    }
}

fn merge_albums(buckets: Vec<RawAlbumBucket>) -> Vec<AlbumTile> {
    struct Group {
        artist: String,
        album: String,
        parts: Vec<RawAlbumBucket>,
    }

    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for bucket in buckets {
        let mut votes: HashMap<(String, String), usize> = HashMap::new();
        for item in &bucket.items {
            let a = item
                .entry
                .music
                .as_ref()
                .and_then(|m| m.artist.as_deref())
                .unwrap_or("")
                .to_string();
            let prefix = if a.is_empty() {
                String::new()
            } else {
                format!("{a} · ")
            };
            let name = if !prefix.is_empty() && item.entry.title.starts_with(&prefix) {
                item.entry.title[prefix.len()..].to_string()
            } else {
                item.entry.title.clone()
            };
            *votes.entry((a, name)).or_insert(0) += 1;
        }
        let Some(((top_a, top_name), _)) = votes.into_iter().max_by(|(k1, n1), (k2, n2)| {
            n1.cmp(n2)
                .then_with(|| k2.0.cmp(&k1.0))
                .then_with(|| k2.1.cmp(&k1.1))
        }) else {
            continue;
        };
        let id = format!("{}\n{}", fold(&top_a), fold(&top_name));
        let g = groups.entry(id).or_insert_with(|| Group {
            artist: top_a,
            album: top_name,
            parts: Vec::new(),
        });
        g.parts.push(bucket);
    }

    let mut albums: Vec<AlbumTile> = groups
        .into_values()
        .map(|mut g| {
            g.parts.sort_by(|x, y| {
                y.items
                    .len()
                    .cmp(&x.items.len())
                    .then_with(|| x.key.cmp(&y.key))
            });
            let primary_key = g.parts[0].key.clone();
            let releases = g
                .parts
                .iter()
                .filter(|p| !p.items.iter().all(|i| is_yt(&i.entry)))
                .count();
            let all_keys: Vec<String> = g
                .parts
                .iter()
                .flat_map(|p| p.items.iter().map(|i| i.entry.key.clone()))
                .collect();

            let mut all: Vec<AlbumTrack> = g.parts.into_iter().flat_map(|p| p.items).collect();
            all.sort_by(|a, b| {
                a.season
                    .unwrap_or(0)
                    .cmp(&b.season.unwrap_or(0))
                    .then_with(|| a.episode.unwrap_or(0).cmp(&b.episode.unwrap_or(0)))
                    .then_with(|| is_saved(&b.entry).cmp(&is_saved(&a.entry)))
                    .then_with(|| b.entry.size.cmp(&a.entry.size))
            });

            let mut deduped: Vec<AlbumTrack> = Vec::new();
            for item in all {
                let merge = deduped.last().is_some_and(|prev| {
                    prev.season == item.season
                        && prev.episode == item.episode
                        && fold(&track_name(&prev.entry)) == fold(&track_name(&item.entry))
                });
                if merge {
                    if let Some(prev) = deduped.last_mut() {
                        prev.copies += 1;
                        prev.alts.push(item.entry);
                    }
                } else {
                    deduped.push(item);
                }
            }

            // Merge yt: copies onto matching named non-yt tracks.
            let mut named_idx: HashMap<String, usize> = HashMap::new();
            for (idx, item) in deduped.iter().enumerate() {
                if !is_yt(&item.entry) {
                    let fk = fold(&track_name(&item.entry));
                    named_idx.entry(fk).or_insert(idx);
                }
            }

            let mut absorbed = vec![false; deduped.len()];
            for idx in 0..deduped.len() {
                let is_pure_yt = is_yt(&deduped[idx].entry)
                    && !deduped[idx].alts.iter().any(|a| !is_yt(a));
                if !is_pure_yt {
                    continue;
                }
                let fk = fold(&track_name(&deduped[idx].entry));
                let Some(&twin_idx) = named_idx.get(&fk) else {
                    continue;
                };
                if twin_idx == idx {
                    continue;
                }
                absorbed[idx] = true;
                let yt_saved = is_saved(&deduped[idx].entry);
                let twin_saved = is_saved(&deduped[twin_idx].entry);
                let yt_copies = deduped[idx].copies;
                let yt_alts = std::mem::take(&mut deduped[idx].alts);
                let yt_entry = deduped[idx].entry.clone();
                if yt_saved && !twin_saved {
                    let old_twin = std::mem::replace(&mut deduped[twin_idx].entry, yt_entry);
                    deduped[twin_idx].alts.push(old_twin);
                } else {
                    deduped[twin_idx].alts.push(yt_entry);
                }
                deduped[twin_idx].copies += yt_copies;
                deduped[twin_idx].alts.extend(yt_alts);
            }

            let rows: Vec<AlbumTrack> = deduped
                .into_iter()
                .enumerate()
                .filter_map(|(idx, item)| (!absorbed[idx]).then_some(item))
                .collect();

            let saved = rows.iter().filter(|i| is_saved(&i.entry)).count();
            let partial = rows
                .iter()
                .any(|i| !is_saved(&i.entry) && i.entry.cached_bytes > 0);
            let all_yt = !rows.is_empty()
                && rows
                    .iter()
                    .all(|i| is_yt(&i.entry) && !i.alts.iter().any(|a| !is_yt(a)));
            let title = if g.artist.is_empty() {
                g.album.clone()
            } else {
                format!("{} · {}", g.artist, g.album)
            };
            let seed = sleeve_hash(&format!("{}\n{}", fold(&g.artist), fold(&g.album)));
            let mono = monogram(&g.album);

            AlbumTile {
                key: primary_key,
                title,
                artist: g.artist,
                album: g.album,
                releases,
                all_keys,
                items: rows,
                saved,
                partial,
                seed,
                hue: 0,
                monogram: mono,
                all_yt,
            }
        })
        .collect();

    // 6-slot per-artist hue wheel
    let mut by_artist: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, album) in albums.iter().enumerate() {
        by_artist.entry(fold(&album.artist)).or_default().push(idx);
    }
    for mut idxs in by_artist.into_values() {
        idxs.sort_by_key(|&i| albums[i].seed);
        let mut used = [false; 6];
        for i in idxs {
            let seed = albums[i].seed;
            let mut slot = ((seed % 360) / 60) as usize;
            for _ in 0..6 {
                if !used[slot] {
                    break;
                }
                slot = (slot + 1) % 6;
            }
            used[slot] = true;
            albums[i].hue = (slot as u32) * 60 + ((seed >> 11) % 36);
        }
    }

    albums.sort_by(|a, b| {
        let cmp = a.album.to_lowercase().cmp(&b.album.to_lowercase());
        if cmp == Ordering::Equal {
            a.title.to_lowercase().cmp(&b.title.to_lowercase())
        } else {
            cmp
        }
    });
    albums
}

#[cfg(test)]
mod tests {
    use super::*;
    use peartube::worker::MusicMeta;

    fn mk_entry(
        key: &str,
        id: &str,
        title: &str,
        size: u64,
        local: bool,
        season: Option<u32>,
        episode: Option<u32>,
        series_key: &str,
        music: Option<(&str, &str)>,
    ) -> Entry {
        Entry {
            key: key.to_string(),
            id: id.to_string(),
            title: title.to_string(),
            size,
            sha256: format!("sha-{key}"),
            local,
            season,
            episode,
            series_key: series_key.to_string(),
            base_title: title.to_string(),
            stream_url: format!("http://127.0.0.1:8175/blob/{key}"),
            music: music.map(|(t, a)| MusicMeta {
                title: Some(t.to_string()),
                artist: Some(a.to_string()),
            }),
            ..Entry::default()
        }
    }

    #[test]
    fn classifies_movies_series_albums_and_clips() {
        let entries = vec![
            mk_entry("m1", "imdb:tt0133093", "The Matrix", 4_000, true, None, None, "imdb:tt0133093", None),
            mk_entry("m2", "imdb:tt0133093", "The Matrix", 8_000, false, None, None, "imdb:tt0133093", None),
            mk_entry("s1", "imdb:tt0903747:s01e02", "Breaking Bad S01E02", 1_500, false, Some(1), Some(2), "imdb:tt0903747", None),
            mk_entry("s2", "imdb:tt0903747:s01e01", "Breaking Bad S01E01", 1_600, true, Some(1), Some(1), "imdb:tt0903747", None),
            mk_entry("a1", "mb:rel1:s01e01", "John Coltrane · Blue Train", 40_000, true, Some(1), Some(1), "mb:rel1", Some(("Blue Train", "John Coltrane"))),
            mk_entry("c1", "clip:demo1", "Skate Reel", 900, false, None, None, "clip:demo1", None),
        ];

        let cat = build_catalog(&entries);
        assert_eq!(cat.movies.len(), 1);
        assert_eq!(cat.movies[0].items.len(), 2);
        // Larger movie version sorts first
        assert_eq!(cat.movies[0].items[0].entry.key, "m2");

        assert_eq!(cat.series.len(), 1);
        assert_eq!(cat.series[0].items.len(), 2);
        assert_eq!(cat.series[0].items[0].episode, Some(1));
        assert_eq!(cat.series[0].items[1].episode, Some(2));

        assert_eq!(cat.albums.len(), 1);
        assert_eq!(cat.albums[0].album, "Blue Train");
        assert_eq!(cat.albums[0].artist, "John Coltrane");
        assert_eq!(cat.artists.len(), 1);
        assert_eq!(cat.tracks.len(), 1);

        assert_eq!(cat.clips.len(), 1);
        assert_eq!(cat.clips[0].title, "Skate Reel");
    }

    #[test]
    fn merges_albums_across_releases_and_dedups_youtube() {
        let entries = vec![
            // Release A (2 tracks, remote)
            mk_entry("r1t1", "mb:rel-a:s01e01", "Miles Davis · Kind of Blue", 50_000, false, Some(1), Some(1), "mb:rel-a", Some(("So What", "Miles Davis"))),
            mk_entry("r1t2", "mb:rel-a:s01e02", "Miles Davis · Kind of Blue", 45_000, false, Some(1), Some(2), "mb:rel-a", Some(("Freddie Freeloader", "Miles Davis"))),
            // Release B (duplicate track 1, local — should win over remote)
            mk_entry("r2t1", "discogs:rel-b:s01e01", "Miles Davis · Kind of Blue", 48_000, true, Some(1), Some(1), "discogs:rel-b", Some(("So What", "Miles Davis"))),
            // YouTube copy of track 2 under a different track number, local — should merge onto track 2 and win as saved copy
            mk_entry("yt1", "yt:abc123:s01e09", "Miles Davis · Kind of Blue", 8_000, true, Some(1), Some(9), "yt:abc123", Some(("Freddie Freeloader", "Miles Davis"))),
        ];

        let cat = build_catalog(&entries);
        assert_eq!(cat.albums.len(), 1);
        let album = &cat.albums[0];
        assert_eq!(album.items.len(), 2);
        // Track 1 picked the saved release B copy
        assert_eq!(album.items[0].entry.key, "r2t1");
        assert_eq!(album.items[0].copies, 2);
        // Track 2 merged YouTube copy and swapped to saved copy
        assert_eq!(album.items[1].entry.key, "yt1");
        assert_eq!(album.items[1].copies, 2);
        assert_eq!(album.items[1].alts.len(), 1);
        assert_eq!(album.items[1].alts[0].key, "r1t2");
        assert_eq!(album.releases, 2); // YouTube part does not count as a release
        assert_eq!(album.all_keys.len(), 4);
    }

    #[test]
    fn six_slot_hue_wheel_separates_same_artist_albums() {
        let mut entries = Vec::new();
        for idx in 1..=6u32 {
            let key = format!("a{idx}");
            let sk = format!("mb:r{idx}");
            let title = format!("Miles Davis · Album {idx}");
            entries.push(mk_entry(
                &key,
                &format!("mb:r{idx}:s01e01"),
                &title,
                10_000,
                true,
                Some(1),
                Some(1),
                &sk,
                Some(("Track 1", "Miles Davis")),
            ));
        }

        let cat = build_catalog(&entries);
        assert_eq!(cat.albums.len(), 6);
        let slots: BTreeSet<u32> = cat.albums.iter().map(|a| a.hue / 60).collect();
        assert_eq!(slots.len(), 6, "all 6 albums by one artist must take distinct 60-deg slots");
    }

    #[test]
    fn fold_and_monogram_match_rules() {
        assert_eq!(fold("Café Del Mar!"), "cafe del mar");
        assert_eq!(fold("Björk — Homogenic"), "bjork homogenic");
        assert_eq!(fold("İstanbul / ı"), "istanbul i");
        assert_eq!(fold("Τέλος"), "τελοσ");
        // Cyrillic й and ё keep their identity
        assert_eq!(fold("Ёлка и Йошкар-Ола"), "ёлка и йошкар ола");
        assert_eq!(monogram("Kind of Blue"), "KB");
        assert_eq!(monogram("The Dark Side of the Moon"), "DS");
        assert_eq!(monogram("of the"), "OT");
        assert_eq!(monogram("!!!"), "♪");
        assert_eq!(format_time_left(96 * 60_000), "1 h 36 min left");
        assert_eq!(format_time_left(31 * 60_000), "31 min left");
    }
}
