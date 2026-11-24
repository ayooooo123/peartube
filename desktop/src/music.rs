//! Music queue state machine, persistence (`music-state.json`), and headless
//! audio playback using `player::AppleBackend::new()` (no NSView or transparent
//! window required).

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_channel::mpsc::{UnboundedReceiver, unbounded};
use peartube::playback::CODECS;
use peartube::soundfont;
use peartube::worker::{DATA_DIR, Entry};
use player::{AppleBackend, AudioOutputMode, Event, Player, PlayerOptions, State};
use serde::{Deserialize, Serialize};

use crate::catalog::{AlbumTile, TrackRow, track_name, track_no};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    One,
}

impl RepeatMode {
    pub fn cycle(self) -> Self {
        match self {
            RepeatMode::Off => RepeatMode::All,
            RepeatMode::All => RepeatMode::One,
            RepeatMode::One => RepeatMode::Off,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            RepeatMode::Off => "Repeat off",
            RepeatMode::All => "Repeat all",
            RepeatMode::One => "Repeat one",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackItem {
    pub entry: Entry,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_key: String,
    pub hue: u32,
    pub seed: u32,
    pub monogram: String,
    pub track_no: String,
}

impl TrackItem {
    pub fn from_album(album: &AlbumTile) -> Vec<TrackItem> {
        album
            .items
            .iter()
            .map(|item| {
                let artist = item
                    .entry
                    .music
                    .as_ref()
                    .and_then(|m| m.artist.as_deref())
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| album.artist.clone());
                TrackItem {
                    entry: item.entry.clone(),
                    title: track_name(&item.entry),
                    artist,
                    album: album.album.clone(),
                    album_key: album.key.clone(),
                    hue: album.hue,
                    seed: album.seed,
                    monogram: album.monogram.clone(),
                    track_no: track_no(&item.entry),
                }
            })
            .collect()
    }

    pub fn from_track_row(row: &TrackRow) -> TrackItem {
        TrackItem {
            entry: row.entry.clone(),
            title: row.track_name.clone(),
            artist: row.artist.clone(),
            album: row.album_title.clone(),
            album_key: row.album_key.clone(),
            hue: row.hue,
            seed: row.seed,
            monogram: row.monogram.clone(),
            track_no: row.track_no.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviousAction {
    Restart,
    Track,
    None,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicQueue {
    pub queue: Vec<TrackItem>,
    pub order: Vec<usize>,
    pub index: usize,
    pub source_label: String,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    pub paused_for_video: bool,
    pub saved_position_ms: u64,
    pub saved_duration_ms: u64,
}

fn default_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15)
}

fn shuffle_slice(slice: &mut [usize], mut seed: u64) {
    if slice.len() <= 1 {
        return;
    }
    if seed == 0 {
        seed = 0x9e37_79b9_7f4a_7c15;
    }
    // Fisher-Yates using xorshift64*
    for i in (1..slice.len()).rev() {
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        let rnd = seed.wrapping_mul(0x2545_f491_4f6c_dd1d);
        let j = (rnd as usize) % (i + 1);
        slice.swap(i, j);
    }
}

impl MusicQueue {
    pub fn load() -> Self {
        let mut loaded: Self = std::fs::read(DATA_DIR.join("music-state.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        loaded.sanitize();
        loaded
    }

    pub fn save(&self) {
        let file = DATA_DIR.join("music-state.json");
        let tmp = file.with_extension("json.tmp");
        let _ = std::fs::create_dir_all(&*DATA_DIR);
        if let Ok(bytes) = serde_json::to_vec(self)
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &file);
        }
    }

    fn sanitize(&mut self) {
        let len = self.queue.len();
        self.order.retain(|&idx| idx < len);
        if len == 0 {
            self.order.clear();
            self.index = 0;
            self.paused_for_video = false;
            return;
        }
        if self.order.is_empty() {
            self.order = (0..len).collect();
        }
        if self.index >= self.order.len() {
            self.index = 0;
        }
    }

    pub fn has_list(&self) -> bool {
        !self.order.is_empty() && !self.queue.is_empty()
    }

    pub fn current(&self) -> Option<&TrackItem> {
        let q_idx = *self.order.get(self.index)?;
        self.queue.get(q_idx)
    }

    pub fn position_label(&self) -> String {
        if self.order.is_empty() {
            "0 of 0".to_string()
        } else {
            format!("{} of {}", self.index + 1, self.order.len())
        }
    }

    pub fn played_items(&self) -> Vec<(usize, &TrackItem)> {
        self.order
            .iter()
            .enumerate()
            .take(self.index)
            .filter_map(|(o_idx, &q_idx)| self.queue.get(q_idx).map(|t| (o_idx, t)))
            .collect()
    }

    pub fn up_next(&self) -> Vec<(usize, &TrackItem)> {
        if self.index + 1 >= self.order.len() {
            return Vec::new();
        }
        self.order
            .iter()
            .enumerate()
            .skip(self.index + 1)
            .filter_map(|(o_idx, &q_idx)| self.queue.get(q_idx).map(|t| (o_idx, t)))
            .collect()
    }

    pub fn play_list(
        &mut self,
        items: Vec<TrackItem>,
        start_index: usize,
        source_label: impl Into<String>,
        shuffle_override: Option<bool>,
    ) -> Option<&TrackItem> {
        self.play_list_with_seed(items, start_index, source_label, shuffle_override, default_seed())
    }

    pub fn play_list_with_seed(
        &mut self,
        items: Vec<TrackItem>,
        start_index: usize,
        source_label: impl Into<String>,
        shuffle_override: Option<bool>,
        seed: u64,
    ) -> Option<&TrackItem> {
        if items.is_empty() {
            return None;
        }
        let start = start_index.min(items.len() - 1);
        if let Some(shuf) = shuffle_override {
            self.shuffle = shuf;
        }
        self.queue = items;
        self.source_label = source_label.into();
        self.paused_for_video = false;
        self.saved_position_ms = 0;
        self.saved_duration_ms = 0;

        if self.shuffle {
            let mut rest: Vec<usize> = (0..self.queue.len()).filter(|&i| i != start).collect();
            shuffle_slice(&mut rest, seed);
            let mut order = Vec::with_capacity(self.queue.len());
            order.push(start);
            order.extend(rest);
            self.order = order;
            self.index = 0;
        } else {
            self.order = (0..self.queue.len()).collect();
            self.index = start;
        }
        self.current()
    }

    /// Inserts `items` right after the currently playing track.
    /// Returns `true` if the queue was empty and playback should start now.
    pub fn play_next(&mut self, items: Vec<TrackItem>, fallback_source: impl Into<String>) -> bool {
        if items.is_empty() {
            return false;
        }
        if !self.has_list() {
            self.play_list(items, 0, fallback_source, None);
            return true;
        }
        let base = self.queue.len();
        let count = items.len();
        self.queue.extend(items);
        let insert_at = (self.index + 1).min(self.order.len());
        let new_indices = base..(base + count);
        self.order.splice(insert_at..insert_at, new_indices);
        false
    }

    /// Appends `items` to the end of `Up next`.
    /// Returns `true` if the queue was empty and playback should start now.
    pub fn play_last(&mut self, items: Vec<TrackItem>, fallback_source: impl Into<String>) -> bool {
        if items.is_empty() {
            return false;
        }
        if !self.has_list() {
            self.play_list(items, 0, fallback_source, None);
            return true;
        }
        let base = self.queue.len();
        let count = items.len();
        self.queue.extend(items);
        self.order.extend(base..(base + count));
        false
    }

    pub fn next(&mut self, from_ended: bool) -> Option<&TrackItem> {
        if !self.has_list() {
            return None;
        }
        self.paused_for_video = false;
        if from_ended && self.repeat == RepeatMode::One {
            self.saved_position_ms = 0;
            return self.current();
        }
        if self.index + 1 < self.order.len() {
            self.index += 1;
            self.saved_position_ms = 0;
            self.current()
        } else if self.repeat == RepeatMode::All {
            self.index = 0;
            self.saved_position_ms = 0;
            self.current()
        } else {
            None
        }
    }

    pub fn previous(&mut self, current_pos_ms: u64) -> PreviousAction {
        if !self.has_list() {
            return PreviousAction::None;
        }
        self.paused_for_video = false;
        if current_pos_ms > 3_000 {
            self.saved_position_ms = 0;
            return PreviousAction::Restart;
        }
        if self.index > 0 {
            self.index -= 1;
            self.saved_position_ms = 0;
            PreviousAction::Track
        } else if self.repeat == RepeatMode::All && self.order.len() > 1 {
            self.index = self.order.len() - 1;
            self.saved_position_ms = 0;
            PreviousAction::Track
        } else {
            self.saved_position_ms = 0;
            PreviousAction::Restart
        }
    }

    pub fn jump_to_order(&mut self, order_idx: usize) -> Option<&TrackItem> {
        if order_idx >= self.order.len() {
            return None;
        }
        self.index = order_idx;
        self.paused_for_video = false;
        self.saved_position_ms = 0;
        self.current()
    }

    /// Rule 14: Shuffle is a switch. On: tracks after the current one come mixed.
    /// Off: the original list order comes back after this track.
    pub fn toggle_shuffle(&mut self) {
        self.toggle_shuffle_with_seed(default_seed());
    }

    pub fn toggle_shuffle_with_seed(&mut self, seed: u64) {
        self.shuffle = !self.shuffle;
        if !self.has_list() {
            return;
        }
        let Some(&cur_q) = self.order.get(self.index) else {
            return;
        };
        if self.shuffle {
            if self.index + 1 < self.order.len() {
                shuffle_slice(&mut self.order[self.index + 1..], seed);
            }
        } else {
            self.order = (0..self.queue.len()).collect();
            self.index = cur_q.min(self.order.len().saturating_sub(1));
        }
    }

    pub fn cycle_repeat(&mut self) {
        self.repeat = self.repeat.cycle();
    }

    pub fn remove_at(&mut self, order_idx: usize) -> bool {
        if order_idx >= self.order.len() {
            return false;
        }
        self.order.remove(order_idx);
        if self.order.is_empty() {
            self.queue.clear();
            self.index = 0;
            self.source_label.clear();
            self.paused_for_video = false;
            return true;
        }
        if order_idx < self.index {
            self.index -= 1;
        } else if self.index >= self.order.len() {
            self.index = self.order.len() - 1;
        }
        true
    }

    pub fn clear_up_next(&mut self) {
        if !self.has_list() {
            return;
        }
        self.order.truncate(self.index + 1);
    }

    pub fn pause_for_video(&mut self, position_ms: u64, duration_ms: u64) {
        if !self.has_list() {
            return;
        }
        self.paused_for_video = true;
        self.saved_position_ms = position_ms;
        if duration_ms > 0 {
            self.saved_duration_ms = duration_ms;
        }
    }

    pub fn clear_paused_for_video(&mut self) {
        self.paused_for_video = false;
    }

    pub fn stop(&mut self) {
        self.queue.clear();
        self.order.clear();
        self.index = 0;
        self.source_label.clear();
        self.paused_for_video = false;
        self.saved_position_ms = 0;
        self.saved_duration_ms = 0;
    }
}

/// Live audio player handle backed by `player::AppleBackend::new()` with no
/// NSView or transparent window.
#[derive(Default)]
pub struct MusicAudio {
    player: Option<Arc<Player>>,
    pub pending_seek_ms: Option<u64>,
    pub current_key: Option<String>,
}

impl Drop for MusicAudio {
    fn drop(&mut self) {
        if let Some(p) = self.player.take() {
            std::thread::spawn(move || {
                drop(p);
                peartube::worker::release_unused_memory();
            });
        }
    }
}

impl MusicAudio {
    pub fn is_open(&self) -> bool {
        self.player.is_some()
    }

    pub fn open_track(&mut self, track: &TrackItem, start_pos_ms: u64) -> UnboundedReceiver<Event> {
        self.close();
        let (tx, rx) = unbounded::<Event>();
        let options = PlayerOptions {
            soundfont: soundfont::path(),
            audio_mode: AudioOutputMode::Auto,
            steep_dsd_filter: true,
            ..PlayerOptions::default()
        };
        let backend = AppleBackend::new();
        let player = Player::open(&track.entry.stream_url, backend, CODECS.clone(), options, move |event| {
            let _ = tx.unbounded_send(event);
        });
        self.player = Some(Arc::new(player));
        self.current_key = Some(track.entry.key.clone());
        self.pending_seek_ms = (start_pos_ms > 0).then_some(start_pos_ms);
        rx
    }

    pub fn play(&self) {
        if let Some(p) = &self.player {
            p.play();
        }
    }

    pub fn pause(&self) {
        if let Some(p) = &self.player {
            p.pause();
        }
    }

    pub fn seek(&mut self, to: Duration) {
        self.pending_seek_ms = None;
        if let Some(p) = &self.player {
            p.seek(to);
        }
    }

    pub fn apply_pending_seek(&mut self, st: &State) {
        if let (Some(ms), Some(_dur)) = (self.pending_seek_ms, st.duration) {
            self.pending_seek_ms = None;
            if let Some(p) = &self.player {
                p.seek(Duration::from_millis(ms));
            }
        }
    }

    pub fn state(&self) -> State {
        self.player.as_ref().map(|p| p.state()).unwrap_or_default()
    }

    pub fn close(&mut self) {
        self.pending_seek_ms = None;
        self.current_key = None;
        if let Some(old) = self.player.take() {
            std::thread::spawn(move || {
                drop(old);
                peartube::worker::release_unused_memory();
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(n: usize) -> TrackItem {
        TrackItem {
            entry: Entry {
                key: format!("k{n}"),
                id: format!("mb:alb:s01e{n:02}"),
                title: "Artist · Album".to_string(),
                stream_url: format!("http://127.0.0.1:8175/blob/k{n}"),
                ..Entry::default()
            },
            title: format!("Track {n}"),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_key: "album:mb:alb".to_string(),
            hue: 120,
            seed: 42,
            monogram: "AL".to_string(),
            track_no: format!("{n:02}"),
        }
    }

    #[test]
    fn play_list_starts_from_selected_row_and_builds_up_next() {
        let mut q = MusicQueue::default();
        let list = vec![track(1), track(2), track(3), track(4)];
        q.play_list_with_seed(list, 1, "Album", Some(false), 7);
        assert_eq!(q.current().unwrap().title, "Track 2");
        assert_eq!(q.position_label(), "2 of 4");
        let up: Vec<_> = q.up_next().into_iter().map(|(_, t)| t.title.as_str()).collect();
        assert_eq!(up, vec!["Track 3", "Track 4"]);
    }

    #[test]
    fn shuffle_switch_mixes_upcoming_and_restores_list_order_off() {
        let mut q = MusicQueue::default();
        let list = (1..=6).map(track).collect();
        q.play_list_with_seed(list, 1, "Album", Some(false), 123);
        assert_eq!(q.current().unwrap().title, "Track 2");

        // Turn shuffle ON: current stays Track 2; upcoming tracks (3..=6) stay in tail
        q.toggle_shuffle_with_seed(999);
        assert!(q.shuffle);
        assert_eq!(q.current().unwrap().title, "Track 2");
        let tail_ids: Vec<usize> = q.order[q.index + 1..].to_vec();
        assert_eq!(tail_ids.len(), 4);
        assert!(tail_ids.contains(&2) && tail_ids.contains(&3) && tail_ids.contains(&4) && tail_ids.contains(&5));

        // Turn shuffle OFF: original list order comes back after Track 2
        q.toggle_shuffle_with_seed(999);
        assert!(!q.shuffle);
        assert_eq!(q.current().unwrap().title, "Track 2");
        assert_eq!(q.order, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(q.index, 1);
    }

    #[test]
    fn repeat_modes_and_navigation() {
        let mut q = MusicQueue::default();
        q.play_list_with_seed(vec![track(1), track(2)], 1, "Album", Some(false), 1);
        assert_eq!(q.repeat, RepeatMode::Off);
        assert!(q.next(true).is_none());

        q.cycle_repeat();
        assert_eq!(q.repeat, RepeatMode::All);
        assert_eq!(q.next(true).unwrap().title, "Track 1");

        q.cycle_repeat();
        assert_eq!(q.repeat, RepeatMode::One);
        // On ended, Repeat One repeats current track
        assert_eq!(q.next(true).unwrap().title, "Track 1");
        // Explicit Next advances past Repeat One
        assert_eq!(q.next(false).unwrap().title, "Track 2");

        // Previous restarts if >3s into track
        assert_eq!(q.previous(5_000), PreviousAction::Restart);
        assert_eq!(q.current().unwrap().title, "Track 2");
        // Previous goes back if <=3s
        assert_eq!(q.previous(1_000), PreviousAction::Track);
        assert_eq!(q.current().unwrap().title, "Track 1");
    }

    #[test]
    fn play_next_play_last_remove_and_clear() {
        let mut q = MusicQueue::default();
        q.play_list_with_seed(vec![track(1), track(2)], 0, "Album", Some(false), 1);
        assert!(!q.play_next(vec![track(10)], "Single"));
        assert!(!q.play_last(vec![track(20)], "Single"));
        let titles: Vec<_> = q.order.iter().map(|&i| q.queue[i].title.as_str()).collect();
        assert_eq!(titles, vec!["Track 1", "Track 10", "Track 2", "Track 20"]);

        // Remove Track 2 (order_idx 2)
        assert!(q.remove_at(2));
        let titles: Vec<_> = q.order.iter().map(|&i| q.queue[i].title.as_str()).collect();
        assert_eq!(titles, vec!["Track 1", "Track 10", "Track 20"]);

        // Clear empties Up next while keeping current track
        q.clear_up_next();
        assert_eq!(q.order.len(), 1);
        assert_eq!(q.current().unwrap().title, "Track 1");
    }

    #[test]
    fn paused_for_video_preserves_track_position_and_queue() {
        let mut q = MusicQueue::default();
        q.play_list_with_seed(vec![track(1), track(2)], 0, "Blue Train", Some(false), 1);
        q.pause_for_video(42_500, 180_000);
        assert!(q.paused_for_video);
        assert_eq!(q.saved_position_ms, 42_500);
        assert_eq!(q.saved_duration_ms, 180_000);
        assert_eq!(q.current().unwrap().title, "Track 1");
        assert_eq!(q.up_next().len(), 1);

        q.clear_paused_for_video();
        assert!(!q.paused_for_video);
    }
}
