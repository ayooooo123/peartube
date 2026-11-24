//! Loopback HTTP/1.1 JSON client for the peer's own local API (`status.api_url`),
//! URL extraction (`peartube://add?url=…`, `peartube://…`, 64-hex keys, `http(s)://…`),
//! typed source-search/acquisition/shelf/settings models, and visited-shelf persistence.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_channel::oneshot;
use peartube::worker::{DATA_DIR, MusicMeta};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const LONG_TIMEOUT: Duration = Duration::from_secs(45);

/// All four supported source providers in display order.
pub const ALL_SOURCES: &[(&str, &str)] = &[
    ("soulseek", "Soulseek"),
    ("youtube", "YouTube"),
    ("soundcloud", "SoundCloud"),
    ("rumble", "Rumble"),
];

/// Supported creator-discovery sources in display order.
pub const DISCOVER_SOURCES: &[(&str, &str)] = &[
    ("youtube", "YouTube"),
    ("soundcloud", "SoundCloud"),
    ("rumble", "Rumble"),
];

/// Preset topic chips shown in Discover v2.
pub const DISCOVER_TOPICS: &[&str] = &[
    "Music",
    "Tech",
    "Science",
    "Podcasts",
    "Gaming",
    "Documentary",
];

/// Runs a blocking closure on a dedicated OS thread and resolves via a futures oneshot
/// so 45-second HTTP calls never occupy GPUI's background executor threads.
pub async fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("peartube-api".into())
        .spawn(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("Spawn API thread: {e}"))?;
    rx.await.map_err(|_| "Local API request cancelled".to_string())
}

/// Minimal HTTP/1.1 JSON client talking to the peer's loopback server (`http://127.0.0.1:<port>`).
#[derive(Clone, Debug)]
pub struct ApiClient {
    base_url: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let trimmed = base_url.into().trim_end_matches('/').to_string();
        ApiClient { base_url: trimmed }
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.request("GET", path, None, DEFAULT_TIMEOUT)
    }

    pub fn post(&self, path: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
        self.request("POST", path, Some(body), timeout)
    }

    pub fn put(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.request("PUT", path, Some(body), DEFAULT_TIMEOUT)
    }

    pub fn delete(&self, path: &str) -> Result<Value, String> {
        self.request("DELETE", path, None, DEFAULT_TIMEOUT)
    }

    fn parse_authority(&self) -> Result<&str, String> {
        let rest = self
            .base_url
            .strip_prefix("http://")
            .ok_or_else(|| format!("Unsupported local API URL: {}", self.base_url))?;
        let authority = rest.split('/').next().unwrap_or("");
        if authority.is_empty() {
            return Err("Empty local API host".into());
        }
        Ok(authority)
    }

    fn request(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Value, String> {
        let resp = self.request_raw(method, path, body, timeout, "application/json")?;
        parse_json_response(&resp)
    }

    fn request_raw(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        accept: &str,
    ) -> Result<HttpResponse, String> {
        let authority = self.parse_authority()?;
        let addr = authority
            .to_socket_addrs()
            .map_err(|e| format!("Resolve {authority}: {e}"))?
            .next()
            .ok_or_else(|| format!("No address for {authority}"))?;

        let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|e| format!("Connect local API ({authority}): {e}"))?;
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

        let path_part = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        let body_bytes = match body {
            Some(v) => serde_json::to_vec(v).map_err(|e| format!("Encode JSON: {e}"))?,
            None => Vec::new(),
        };

        let mut req = format!(
            "{method} {path_part} HTTP/1.1\r\nHost: {authority}\r\nAccept: {accept}\r\nConnection: close\r\n"
        );
        if body.is_some() {
            req.push_str("Content-Type: application/json\r\n");
            req.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
        }
        req.push_str("\r\n");

        stream
            .write_all(req.as_bytes())
            .map_err(|e| format!("Write request headers: {e}"))?;
        if !body_bytes.is_empty() {
            stream
                .write_all(&body_bytes)
                .map_err(|e| format!("Write request body: {e}"))?;
        }
        let _ = stream.flush();

        let mut raw = Vec::with_capacity(4096);
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if raw.len() + n > MAX_RESPONSE_BYTES {
                        return Err("Local API response exceeded size limit".into());
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(format!("Read local API response: {e}")),
            }
        }

        parse_http_response(&raw)
    }

    pub fn get_bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        let resp = self.request_raw("GET", path, None, DEFAULT_TIMEOUT, "*/*")?;
        if (200..300).contains(&resp.status) {
            Ok(resp.body)
        } else {
            Err(format!("Local API returned HTTP {}", resp.status))
        }
    }

    // ---- High-level typed endpoints ----

    pub fn identify(&self, url: &str) -> Result<IdentifyResult, String> {
        let val = self.post("/v1/identify", &json!({ "url": url }), LONG_TIMEOUT)?;
        IdentifyResult::from_value(val)
    }

    pub fn acquire(&self, req: &AcquireRequest) -> Result<AcquireJob, String> {
        let mut payload = json!({
            "id": req.id,
            "title": req.title,
            "source": {
                "url": req.url,
                "page": req.page,
                "audio": req.audio,
            },
        });
        if let Some(music) = &req.music {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("music".into(), serde_json::to_value(music).unwrap_or(Value::Null));
            }
        }
        let val = self.post("/v1/acquire", &payload, DEFAULT_TIMEOUT)?;
        let job_val = val.get("job").cloned().unwrap_or(val);
        serde_json::from_value(job_val).map_err(|e| format!("Parse acquire reply: {e}"))
    }

    pub fn list_jobs(&self) -> Result<Vec<AcquireJob>, String> {
        let val = self.get("/v1/jobs")?;
        let arr = val.get("jobs").cloned().unwrap_or(Value::Array(Vec::new()));
        serde_json::from_value(arr).map_err(|e| format!("Parse jobs list: {e}"))
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<Value, String> {
        self.delete(&format!("/v1/jobs/{job_id}"))
    }

    pub fn list_plugins(&self) -> Result<Vec<PluginInfo>, String> {
        let val = self.get("/v1/plugins")?;
        let arr = val.get("plugins").cloned().unwrap_or(Value::Array(Vec::new()));
        serde_json::from_value(arr).map_err(|e| format!("Parse plugins list: {e}"))
    }

    pub fn search_sources(&self, query: &str, sources: &[String]) -> Result<SourceSearchResult, String> {
        let payload = json!({
            "query": query,
            "sources": sources,
            "stream": false,
        });
        let val = self.post("/v1/search/sources", &payload, LONG_TIMEOUT)?;
        SourceSearchResult::from_value(val)
    }

    pub fn browse_soulseek(&self, peer: &str, refresh: bool) -> Result<SoulseekShelf, String> {
        let payload = json!({
            "peer": peer,
            "username": peer,
            "refresh": refresh,
        });
        let val = self.post("/v1/providers/soulseek/browse", &payload, LONG_TIMEOUT)?;
        SoulseekShelf::from_value(val, peer)
    }

    pub fn mirror_soulseek(&self, peer: &str, files: &[SoulseekCandidate], title: Option<&str>) -> Result<Value, String> {
        let file_specs: Vec<Value> = files
            .iter()
            .map(|f| {
                json!({
                    "filename": f.filename,
                    "size": f.size,
                })
            })
            .collect();
        let mut payload = json!({
            "peer": peer,
            "username": peer,
            "files": file_specs,
        });
        if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("title".into(), Value::String(t.trim().to_string()));
            }
        }
        self.post("/v1/providers/soulseek/mirror", &payload, DEFAULT_TIMEOUT)
    }

    pub fn mirror_youtube(&self, cand: &YoutubeCandidate, fallback_artist: &str) -> Result<Value, String> {
        let (artist, track_title) = split_artist_title(&cand.title, cand.channel.as_deref().or(Some(fallback_artist)));
        let payload = json!({
            "artist": artist,
            "album": track_title,
            "videoId": cand.video_id,
            "title": cand.title,
            "url": cand.url,
            "tracks": [{
                "videoId": cand.video_id,
                "title": track_title,
                "track": 1,
            }],
        });
        self.post("/v1/providers/youtube/mirror", &payload, DEFAULT_TIMEOUT)
    }

    pub fn mirror_soundcloud(&self, cand: &SoundcloudCandidate, fallback_artist: &str) -> Result<Value, String> {
        let (artist, track_title) = split_artist_title(&cand.title, cand.artist.as_deref().or(Some(fallback_artist)));
        let payload = json!({
            "url": cand.url,
            "trackId": cand.id,
            "id": cand.id,
            "title": cand.title,
            "artist": artist,
            "album": track_title,
            "audio": true,
            "tracks": [{
                "url": cand.url,
                "trackId": cand.id,
                "id": cand.id,
                "title": track_title,
                "track": 1,
            }],
        });
        self.post("/v1/providers/soundcloud/mirror", &payload, DEFAULT_TIMEOUT)
    }

    pub fn mirror_rumble(&self, cand: &RumbleCandidate, audio_only: bool, fallback_artist: &str) -> Result<Value, String> {
        let (artist, track_title) = split_artist_title(&cand.title, cand.channel.as_deref().or(Some(fallback_artist)));
        let payload = json!({
            "url": cand.url,
            "rumbleId": cand.id,
            "id": cand.id,
            "title": cand.title,
            "channel": cand.channel,
            "artist": artist,
            "album": track_title,
            "audio": audio_only,
        });
        self.post("/v1/providers/rumble/mirror", &payload, DEFAULT_TIMEOUT)
    }

    pub fn get_soulseek_settings(&self) -> Result<SoulseekSettings, String> {
        let val = self.get("/v1/settings")?;
        Ok(SoulseekSettings::from_value(&val))
    }

    pub fn save_soulseek_settings(
        &self,
        user: &str,
        password: Option<&str>,
        share: bool,
        uses_slsk_keys: bool,
    ) -> Result<SoulseekSettings, String> {
        let build_body = |legacy: bool| -> Value {
            let mut map = serde_json::Map::new();
            if legacy {
                map.insert("slskUser".into(), Value::String(user.trim().to_string()));
                if let Some(pass) = password {
                    map.insert("slskPass".into(), Value::String(pass.to_string()));
                }
                map.insert("slskShare".into(), Value::Bool(share));
            } else {
                map.insert("soulseekUser".into(), Value::String(user.trim().to_string()));
                if let Some(pass) = password {
                    map.insert("soulseekPassword".into(), Value::String(pass.to_string()));
                }
                map.insert("soulseekShare".into(), Value::Bool(share));
            }
            Value::Object(map)
        };

        let first = self.put("/v1/settings", &build_body(uses_slsk_keys));
        match first {
            Ok(val) => Ok(SoulseekSettings::from_value(&val)),
            Err(err) if err.to_ascii_lowercase().contains("unknown setting") => {
                let val = self.put("/v1/settings", &build_body(!uses_slsk_keys))?;
                Ok(SoulseekSettings::from_value(&val))
            }
            Err(err) => Err(err),
        }
    }

    // ---- Discover v2 endpoints ----

    #[allow(dead_code)]
    pub fn list_discover_creators(&self) -> Result<Vec<DiscoverCreator>, String> {
        let val = self.get("/v1/discover/creators")?;
        let arr = val.get("creators").cloned().unwrap_or(Value::Array(Vec::new()));
        serde_json::from_value(arr).map_err(|e| format!("Parse discover creators: {e}"))
    }

    pub fn follow_discover_creator(&self, req: &DiscoverFollowRequest) -> Result<DiscoverFollowResponse, String> {
        let mut map = serde_json::Map::new();
        map.insert("url".into(), Value::String(req.url.trim().to_string()));
        if let Some(source) = req.source.as_deref().filter(|s| !s.trim().is_empty()) {
            map.insert("source".into(), Value::String(source.trim().to_string()));
        }
        if let Some(name) = req.name.as_deref().filter(|s| !s.trim().is_empty()) {
            map.insert("name".into(), Value::String(name.trim().to_string()));
        }
        if let Some(channel_id) = req.channel_id.as_deref().filter(|s| !s.trim().is_empty()) {
            map.insert("channelId".into(), Value::String(channel_id.trim().to_string()));
        }
        if let Some(handle) = req.handle.as_deref().filter(|s| !s.trim().is_empty()) {
            map.insert("handle".into(), Value::String(handle.trim().to_string()));
        }
        let val = self.post("/v1/discover/creators", &Value::Object(map), LONG_TIMEOUT)?;
        serde_json::from_value(val).map_err(|e| format!("Parse follow creator reply: {e}"))
    }

    pub fn unfollow_discover_creator(&self, creator_id: &str) -> Result<DiscoverUnfollowResponse, String> {
        let encoded = percent_encode_component(creator_id);
        let val = self.delete(&format!("/v1/discover/creators/{encoded}"))?;
        serde_json::from_value(val).map_err(|e| format!("Parse unfollow creator reply: {e}"))
    }

    pub fn get_discover_feed(
        &self,
        source: Option<&str>,
        creator: Option<&str>,
        refresh: bool,
        limit: usize,
    ) -> Result<DiscoverFeed, String> {
        let mut params = Vec::new();
        if let Some(src) = source.filter(|s| !s.trim().is_empty()) {
            params.push(format!("source={}", percent_encode_component(src.trim())));
        }
        if let Some(cid) = creator.filter(|s| !s.trim().is_empty()) {
            params.push(format!("creator={}", percent_encode_component(cid.trim())));
        }
        if refresh {
            params.push("refresh=1".to_string());
        }
        params.push(format!("limit={}", limit.clamp(1, 100)));
        let path = format!("/v1/discover/feed?{}", params.join("&"));
        let val = self.request("GET", &path, None, LONG_TIMEOUT)?;
        serde_json::from_value(val).map_err(|e| format!("Parse discover feed: {e}"))
    }

    pub fn browse_discover(
        &self,
        query: &str,
        sources: &[&str],
        limit: usize,
    ) -> Result<DiscoverBrowseResult, String> {
        let payload = json!({
            "query": query.trim(),
            "sources": sources,
            "limit": limit.clamp(1, 20),
        });
        let val = self.post("/v1/discover/browse", &payload, LONG_TIMEOUT)?;
        serde_json::from_value(val).map_err(|e| format!("Parse discover browse reply: {e}"))
    }
}

// ---- HTTP/1.1 wire parser (pure, unit-tested) ----

pub fn parse_http_response(raw: &[u8]) -> Result<HttpResponse, String> {
    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "Incomplete HTTP response headers".to_string())?;
    let header_bytes = &raw[..header_end];
    let body_raw = &raw[header_end + 4..];

    let header_str = std::str::from_utf8(header_bytes).map_err(|_| "Non-UTF-8 HTTP headers".to_string())?;
    let mut lines = header_str.split("\r\n");
    let status_line = lines.next().ok_or_else(|| "Missing HTTP status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("Invalid HTTP status line: {status_line}"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let key = name.trim().to_ascii_lowercase();
            let val = value.trim();
            if key == "content-length" {
                content_length = val.parse::<usize>().ok();
            } else if key == "transfer-encoding" && val.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }

    let body = if chunked {
        decode_chunked(body_raw)?
    } else if let Some(len) = content_length {
        if body_raw.len() < len {
            return Err(format!(
                "Truncated HTTP body: expected {len} bytes, got {}",
                body_raw.len()
            ));
        }
        body_raw[..len].to_vec()
    } else {
        body_raw.to_vec()
    };

    Ok(HttpResponse { status, body })
}

pub fn decode_chunked(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let crlf = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| "Malformed chunked HTTP response: missing chunk size line".to_string())?;
        let size_line = std::str::from_utf8(&data[..crlf])
            .map_err(|_| "Invalid UTF-8 in chunk size".to_string())?;
        let hex_part = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(hex_part, 16)
            .map_err(|_| format!("Invalid chunk size: {hex_part}"))?;
        data = &data[crlf + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size + 2 {
            return Err("Truncated chunked HTTP response".to_string());
        }
        out.extend_from_slice(&data[..size]);
        if &data[size..size + 2] != b"\r\n" {
            return Err("Malformed chunk terminator".to_string());
        }
        data = &data[size + 2..];
    }
    Ok(out)
}

fn parse_json_response(resp: &HttpResponse) -> Result<Value, String> {
    if (200..300).contains(&resp.status) {
        if resp.status == 204 || resp.body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&resp.body).map_err(|e| format!("Invalid JSON from local API: {e}"))
    } else {
        if let Ok(val) = serde_json::from_slice::<Value>(&resp.body) {
            if let Some(msg) = val.get("error").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return Err(msg.to_string());
            }
            if let Some(msg) = val.get("message").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return Err(msg.to_string());
            }
        }
        let snippet = String::from_utf8_lossy(&resp.body).trim().chars().take(180).collect::<String>();
        if snippet.is_empty() {
            Err(format!("Local API returned HTTP {}", resp.status))
        } else {
            Err(format!("Local API returned HTTP {}: {snippet}", resp.status))
        }
    }
}

// ---- URL extraction & percent decoding ----

pub fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn strip_trailing_url_punct(s: &str) -> &str {
    s.trim_end_matches(|c: char| matches!(c, ')' | ']' | '>' | ',' | '.' | ';' | '"' | '\''))
}

pub fn is_web_url(s: &str) -> bool {
    let lower = s.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// If `input` is a `peartube://add?url=<encoded>` deep link, returns the decoded target URL.
pub fn unwrap_peartube_add(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("peartube://add") {
        return None;
    }
    let query = trimmed.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k.eq_ignore_ascii_case("url") && !v.is_empty() {
                let decoded = percent_decode(v).trim().to_string();
                if is_web_url(&decoded) {
                    return Some(decoded);
                }
            }
        }
    }
    None
}

/// Extracts a usable PearTube link, 64-character hex channel key, `peartube://add?url=…` target,
/// or `http(s)://…` URL from pasted text or deep-link input.
pub fn extract_shared_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(target) = unwrap_peartube_add(trimmed) {
        return Some(target);
    }
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(trimmed.to_ascii_lowercase());
    }
    if trimmed.to_ascii_lowercase().starts_with("peartube://") {
        return Some(trimmed.to_string());
    }
    if is_web_url(trimmed) && !trimmed.contains(char::is_whitespace) {
        return Some(strip_trailing_url_punct(trimmed).to_string());
    }
    for token in trimmed.split_whitespace() {
        let clean = token.trim_matches(|c: char| matches!(c, '<' | '>' | '(' | ')' | '[' | ']' | '"' | '\''));
        if let Some(target) = unwrap_peartube_add(clean) {
            return Some(target);
        }
        let lower = clean.to_ascii_lowercase();
        if lower.starts_with("peartube://") {
            return Some(strip_trailing_url_punct(clean).to_string());
        }
        if lower.starts_with("https://") || lower.starts_with("http://") {
            let url = strip_trailing_url_punct(clean);
            if url.len() > 8 {
                return Some(url.to_string());
            }
        }
    }
    None
}

// ---- Typed API models ----

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdentifyLink {
    pub kind: String,
    pub name: String,
    pub site: String,
    pub uploader: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub size: Option<u64>,
    pub resolution: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdentifyParsed {
    pub title: String,
    pub year: Option<u32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub ext: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdentifyCandidate {
    pub id: String,
    pub title: String,
    pub name: String,
    pub year: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdentifyPlain {
    pub id: String,
    pub title: String,
}

/// Reply from `POST /v1/identify`. Supports both the flat shape
/// (`{ kind, site, title, author, duration, audioOnly, id, music, match }`)
/// and the nested `src/identify.js` shape (`{ link, parsed, candidates, match, plain }`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdentifyResult {
    pub kind: Option<String>,
    pub site: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub duration: Option<f64>,
    pub audio_only: Option<bool>,
    pub id: Option<String>,
    pub music: Option<MusicMeta>,
    #[serde(rename = "match")]
    pub matched: Option<String>,
    pub link: Option<IdentifyLink>,
    pub parsed: Option<IdentifyParsed>,
    pub candidates: Vec<IdentifyCandidate>,
    pub plain: Option<IdentifyPlain>,
}

impl IdentifyResult {
    pub fn from_value(val: Value) -> Result<Self, String> {
        serde_json::from_value(val).map_err(|e| format!("Parse identify response: {e}"))
    }

    pub fn is_page(&self) -> bool {
        let k = self
            .kind
            .as_deref()
            .or_else(|| self.link.as_ref().map(|l| l.kind.as_str()))
            .unwrap_or("page");
        !k.eq_ignore_ascii_case("file")
    }

    pub fn effective_site(&self, url: &str) -> String {
        let raw = self
            .site
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                self.link
                    .as_ref()
                    .map(|l| l.site.as_str())
                    .filter(|s| !s.trim().is_empty())
            });
        if let Some(s) = raw {
            return pretty_site_name(s);
        }
        if !self.is_page() {
            return "Direct file".to_string();
        }
        let lower = url.to_ascii_lowercase();
        if lower.contains("soundcloud.com") || lower.contains("on.soundcloud.com") {
            "SoundCloud".into()
        } else if lower.contains("youtube.com") || lower.contains("youtu.be") {
            "YouTube".into()
        } else if lower.contains("rumble.com") {
            "Rumble".into()
        } else if lower.contains("bandcamp.com") {
            "Bandcamp".into()
        } else {
            "Web link".into()
        }
    }

    pub fn effective_title(&self, fallback_url: &str) -> String {
        if let Some(m) = self.matched.as_deref() {
            if let Some(c) = self.candidates.iter().find(|c| c.id == m && !c.title.trim().is_empty()) {
                return c.title.trim().to_string();
            }
        }
        for candidate in [
            self.title.as_deref(),
            self.music.as_ref().and_then(|m| m.title.as_deref()),
            self.plain.as_ref().map(|p| p.title.as_str()),
            self.link.as_ref().map(|l| l.name.as_str()),
            self.parsed.as_ref().map(|p| p.title.as_str()),
        ] {
            if let Some(s) = candidate.map(str::trim).filter(|s| !s.is_empty()) {
                return s.to_string();
            }
        }
        fallback_url.to_string()
    }

    pub fn effective_author(&self) -> Option<String> {
        for candidate in [
            self.author.as_deref(),
            self.music.as_ref().and_then(|m| m.artist.as_deref()),
            self.link.as_ref().map(|l| l.uploader.as_str()),
        ] {
            if let Some(s) = candidate.map(str::trim).filter(|s| !s.is_empty()) {
                return Some(s.to_string());
            }
        }
        None
    }

    pub fn effective_duration_secs(&self) -> Option<u64> {
        let d = self
            .duration
            .or_else(|| self.link.as_ref().and_then(|l| l.duration))?;
        if d.is_finite() && d > 0.0 {
            Some(d.round() as u64)
        } else {
            None
        }
    }

    pub fn effective_id(&self, fallback_url: &str) -> String {
        if let Some(m) = self.matched.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return m.to_string();
        }
        if let Some(id) = self.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return id.to_string();
        }
        if let Some(id) = self
            .plain
            .as_ref()
            .map(|p| p.id.trim())
            .filter(|s| !s.is_empty())
        {
            return id.to_string();
        }
        format!("clip:{:016x}", fnv1a_64(fallback_url.as_bytes()))
    }

    pub fn default_audio_only(&self, url: &str) -> bool {
        if let Some(flag) = self.audio_only {
            return flag;
        }
        let site = self.effective_site(url).to_ascii_lowercase();
        if matches!(site.as_str(), "soundcloud" | "bandcamp" | "mixcloud" | "audiomack") {
            return true;
        }
        if let Some(ext) = self.parsed.as_ref().map(|p| p.ext.to_ascii_lowercase()) {
            if matches!(ext.as_str(), "mp3" | "flac" | "m4a" | "ogg" | "opus" | "wav" | "aac") {
                return true;
            }
        }
        let lower = url.to_ascii_lowercase();
        lower.contains("soundcloud.com") || lower.contains("bandcamp.com")
    }

    pub fn music_meta(&self, audio_only: bool, fallback_url: &str) -> Option<MusicMeta> {
        if let Some(m) = &self.music {
            if m.title.is_some() || m.artist.is_some() {
                return Some(m.clone());
            }
        }
        if audio_only {
            let title = self.effective_title(fallback_url);
            let artist = self.effective_author();
            return Some(MusicMeta {
                title: Some(title),
                artist,
            });
        }
        None
    }
}

fn pretty_site_name(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "youtube" | "youtu.be" => "YouTube".into(),
        "soundcloud" => "SoundCloud".into(),
        "rumble" => "Rumble".into(),
        "bandcamp" => "Bandcamp".into(),
        "vimeo" => "Vimeo".into(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => "Web link".into(),
            }
        }
    }
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[derive(Clone, Debug)]
pub struct AcquireRequest {
    pub id: String,
    pub title: String,
    pub url: String,
    pub page: bool,
    pub audio: bool,
    pub music: Option<MusicMeta>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AcquireJob {
    pub job_id: String,
    pub id: Option<String>,
    pub title: String,
    pub plugin: String,
    pub source: Option<String>,
    pub status: String,
    pub phase: Option<String>,
    pub peer: Option<String>,
    pub file: Option<String>,
    pub file_index: Option<u64>,
    pub file_count: Option<u64>,
    pub queue_place: Option<u64>,
    pub speed: Option<u64>,
    pub bytes: u64,
    pub total: Option<u64>,
    pub size: Option<u64>,
    pub error: Option<String>,
    pub note: Option<String>,
    pub created: Option<u64>,
}

impl AcquireJob {
    pub fn is_active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "queued" | "running" | "copying" | "transferring" | "announcing"
        )
    }

    pub fn is_done(&self) -> bool {
        self.status == "done"
    }

    pub fn is_failed(&self) -> bool {
        self.status == "failed"
    }

    pub fn progress_fraction(&self) -> Option<f32> {
        if let Some(total) = self.total.filter(|&t| t > 0) {
            return Some((self.bytes as f32 / total as f32).clamp(0.0, 1.0));
        }
        if let (Some(idx), Some(count)) = (self.file_index, self.file_count) {
            if count > 1 && idx >= 1 {
                let done = idx.saturating_sub(1);
                return Some((done as f32 / count as f32).clamp(0.0, 1.0));
            }
        }
        if self.is_done() {
            return Some(1.0);
        }
        None
    }

    pub fn status_label(&self) -> String {
        match self.status.as_str() {
            "queued" => match self.queue_place {
                Some(q) if q > 0 => format!("Queued (#{q})"),
                _ => "Queued".into(),
            },
            "running" => "Downloading".into(),
            "copying" => "Copying from peers".into(),
            "transferring" => match (self.file_index, self.file_count) {
                (Some(i), Some(n)) if n > 1 => format!("Downloading {i}/{n}"),
                _ => "Downloading".into(),
            },
            "announcing" => match self.phase.as_deref() {
                Some("importing") => "Adding to library".into(),
                _ => "Finishing".into(),
            },
            "done" => "Saved".into(),
            "failed" => "Failed".into(),
            "cancelled" => "Cancelled".into(),
            other => other.to_string(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginInfo {
    pub name: String,
    pub description: String,
    pub searchable: bool,
    pub status: Option<String>,
    pub available: Option<bool>,
    pub configured: Option<bool>,
    pub connected: Option<bool>,
    pub active_jobs: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct SoulseekCandidate {
    #[serde(alias = "peer")]
    pub username: String,
    pub filename: String,
    pub size: u64,
    pub slots: bool,
    pub queue: u64,
    pub bitrate: Option<u64>,
    pub sample_rate: Option<u64>,
    pub bit_depth: Option<u64>,
    pub length: Option<u64>,
    pub lossy: Option<bool>,
}

impl SoulseekCandidate {
    pub fn normalized_path(&self) -> String {
        self.filename.replace('\\', "/")
    }

    pub fn folder_path(&self) -> String {
        let norm = self.normalized_path();
        match norm.rfind('/') {
            Some(idx) => norm[..idx].to_string(),
            None => String::new(),
        }
    }

    pub fn folder_name(&self) -> String {
        let folder = self.folder_path();
        let parts: Vec<&str> = folder
            .split('/')
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with("@@"))
            .collect();
        if parts.is_empty() {
            return "Shared folder".into();
        }
        let last = parts[parts.len() - 1];
        if parts.len() >= 2 && is_disc_segment(last) {
            format!("{} / {last}", parts[parts.len() - 2])
        } else if parts.len() >= 2 && !last.contains(" - ") {
            format!("{} — {last}", parts[parts.len() - 2])
        } else {
            last.to_string()
        }
    }

    pub fn file_name(&self) -> String {
        let norm = self.normalized_path();
        norm.rsplit('/').next().unwrap_or(&norm).to_string()
    }

    pub fn format_badge(&self) -> String {
        let ext = self
            .file_name()
            .rsplit('.')
            .next()
            .map(|e| e.to_ascii_uppercase())
            .unwrap_or_default();
        if let (Some(bd), Some(sr)) = (self.bit_depth, self.sample_rate) {
            let khz = sr as f64 / 1000.0;
            return format!("{ext} {bd}-bit/{khz:.1}kHz");
        }
        if let Some(br) = self.bitrate {
            return format!("{ext} {br}k");
        }
        if !ext.is_empty() {
            ext
        } else if self.lossy == Some(true) {
            "Lossy".into()
        } else {
            "Audio".into()
        }
    }
}

fn is_disc_segment(s: &str) -> bool {
    let lower = s.trim().to_ascii_lowercase();
    (lower.starts_with("cd") || lower.starts_with("disc") || lower.starts_with("disk"))
        && lower.len() <= 8
        && lower.chars().any(|c| c.is_ascii_digit())
}

#[derive(Clone, Debug, PartialEq)]
pub struct SoulseekAlbumGroup {
    pub peer: String,
    pub folder_path: String,
    pub title: String,
    pub files: Vec<SoulseekCandidate>,
    pub total_size: u64,
    pub slots: bool,
    pub queue: u64,
    pub format_label: String,
}

/// Groups Soulseek search hits by `(peer, folder_path)` while preserving the server's
/// relevance/readiness ranking.
pub fn group_soulseek_candidates(hits: &[SoulseekCandidate]) -> Vec<SoulseekAlbumGroup> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut buckets: HashMap<(String, String), Vec<SoulseekCandidate>> = HashMap::new();
    for hit in hits {
        let key = (hit.username.clone(), hit.folder_path());
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(hit.clone());
    }
    order
        .into_iter()
        .filter_map(|key| {
            let mut files = buckets.remove(&key)?;
            files.sort_by(|a, b| a.filename.cmp(&b.filename));
            let first = files.first()?;
            let total_size = files.iter().map(|f| f.size).sum();
            let slots = files.iter().any(|f| f.slots);
            let queue = files.iter().map(|f| f.queue).min().unwrap_or(0);
            let title = first.folder_name();
            let format_label = first.format_badge();
            Some(SoulseekAlbumGroup {
                peer: key.0,
                folder_path: key.1,
                title,
                files,
                total_size,
                slots,
                queue,
                format_label,
            })
        })
        .collect()
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct YoutubeCandidate {
    #[serde(alias = "id")]
    pub video_id: String,
    pub title: String,
    pub url: String,
    #[serde(alias = "author", alias = "uploader")]
    pub channel: Option<String>,
    #[serde(alias = "duration")]
    pub length: Option<u64>,
    pub bitrate: Option<u64>,
    pub lossy: Option<bool>,
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SoundcloudCandidate {
    #[serde(alias = "trackId")]
    pub id: Option<String>,
    pub title: String,
    pub url: String,
    #[serde(alias = "author", alias = "uploader", alias = "channel")]
    pub artist: Option<String>,
    #[serde(alias = "duration")]
    pub length: Option<u64>,
    pub bitrate: Option<u64>,
    pub lossy: Option<bool>,
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RumbleCandidate {
    #[serde(alias = "rumbleId")]
    pub id: Option<String>,
    pub title: String,
    pub url: String,
    #[serde(alias = "author", alias = "uploader", alias = "artist")]
    pub channel: Option<String>,
    #[serde(alias = "duration")]
    pub length: Option<u64>,
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceSearchResult {
    pub query: String,
    pub sources: Vec<String>,
    pub soulseek: Vec<SoulseekCandidate>,
    pub youtube: Vec<YoutubeCandidate>,
    pub soundcloud: Vec<SoundcloudCandidate>,
    pub rumble: Vec<RumbleCandidate>,
    pub errors: HashMap<String, String>,
    pub truncated: HashMap<String, bool>,
}

impl SourceSearchResult {
    #[cfg(test)]
    pub fn total_hits(&self) -> usize {
        self.soulseek.len() + self.youtube.len() + self.soundcloud.len() + self.rumble.len()
    }

    pub fn count_for(&self, source: &str) -> usize {
        match source {
            "soulseek" => self.soulseek.len(),
            "youtube" => self.youtube.len(),
            "soundcloud" => self.soundcloud.len(),
            "rumble" => self.rumble.len(),
            _ => 0,
        }
    }

    /// Parses both `src/mirror.js`'s `{ results: [...], bySource: { name: count }, errors: [...] }`
    /// shape AND `{ bySource: { name: [...] }, errors: { name: "..." } }`.
    pub fn from_value(val: Value) -> Result<Self, String> {
        let mut out = SourceSearchResult {
            query: val.get("query").and_then(Value::as_str).unwrap_or("").to_string(),
            sources: val
                .get("sources")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            ..Default::default()
        };

        if let Some(trunc) = val.get("truncated").and_then(Value::as_object) {
            for (k, v) in trunc {
                if let Some(b) = v.as_bool() {
                    out.truncated.insert(k.clone(), b);
                }
            }
        }

        // Case 1: flat `results` array tagged with `source`.
        if let Some(results) = val.get("results").and_then(Value::as_array) {
            for item in results {
                let src = item.get("source").and_then(Value::as_str).unwrap_or("");
                push_source_item(&mut out, src, item.clone());
            }
        }

        // Case 2: `bySource` object containing per-source arrays (or `{ results/candidates: [...] }`).
        if let Some(by_source) = val.get("bySource").and_then(Value::as_object) {
            for (src, entry) in by_source {
                let list = entry
                    .as_array()
                    .or_else(|| entry.get("results").and_then(Value::as_array))
                    .or_else(|| entry.get("candidates").and_then(Value::as_array));
                if let Some(items) = list {
                    if out.count_for(src) == 0 {
                        for item in items {
                            push_source_item(&mut out, src, item.clone());
                        }
                    }
                }
                if let Some(err_msg) = entry.get("error").and_then(Value::as_str) {
                    out.errors.insert(src.clone(), err_msg.to_string());
                }
            }
        }

        // Errors: either array of `{ source, message }` or map `{ source: "message" }`.
        if let Some(err_arr) = val.get("errors").and_then(Value::as_array) {
            for item in err_arr {
                if let Some(src) = item.get("source").and_then(Value::as_str) {
                    let msg = item
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("error").and_then(Value::as_str))
                        .unwrap_or("Search failed");
                    out.errors.insert(src.to_string(), msg.to_string());
                }
            }
        } else if let Some(err_map) = val.get("errors").and_then(Value::as_object) {
            for (src, v) in err_map {
                let msg = v
                    .as_str()
                    .or_else(|| v.get("message").and_then(Value::as_str))
                    .or_else(|| v.get("error").and_then(Value::as_str))
                    .unwrap_or("Search failed");
                out.errors.insert(src.clone(), msg.to_string());
            }
        }

        Ok(out)
    }
}

fn push_source_item(out: &mut SourceSearchResult, src: &str, item: Value) {
    match src {
        "soulseek" => {
            if let Ok(c) = serde_json::from_value::<SoulseekCandidate>(item) {
                if !c.filename.is_empty() {
                    out.soulseek.push(c);
                }
            }
        }
        "youtube" => {
            if let Ok(mut c) = serde_json::from_value::<YoutubeCandidate>(item) {
                if c.url.is_empty() && !c.video_id.is_empty() {
                    c.url = format!("https://www.youtube.com/watch?v={}", c.video_id);
                }
                if !c.title.is_empty() || !c.video_id.is_empty() {
                    out.youtube.push(c);
                }
            }
        }
        "soundcloud" => {
            if let Ok(c) = serde_json::from_value::<SoundcloudCandidate>(item) {
                if !c.title.is_empty() || !c.url.is_empty() {
                    out.soundcloud.push(c);
                }
            }
        }
        "rumble" => {
            if let Ok(c) = serde_json::from_value::<RumbleCandidate>(item) {
                if !c.title.is_empty() || !c.url.is_empty() {
                    out.rumble.push(c);
                }
            }
        }
        _ => {}
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SoulseekFolder {
    pub path: String,
    pub title: String,
    pub files: Vec<SoulseekCandidate>,
    pub total_size: u64,
    pub format_label: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SoulseekShelf {
    pub peer: String,
    pub files: Vec<SoulseekCandidate>,
    pub tracks: usize,
    pub size: u64,
    pub cached: bool,
}

impl SoulseekShelf {
    pub fn from_value(val: Value, fallback_peer: &str) -> Result<Self, String> {
        let peer = val
            .get("username")
            .or_else(|| val.get("peer"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_peer)
            .to_string();
        let mut files: Vec<SoulseekCandidate> = val
            .get("files")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        for f in &mut files {
            if f.username.is_empty() {
                f.username = peer.clone();
            }
        }
        let tracks = val
            .get("tracks")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(files.len());
        let size = val
            .get("size")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| files.iter().map(|f| f.size).sum());
        let cached = val.get("cached").and_then(Value::as_bool).unwrap_or(false);
        Ok(SoulseekShelf {
            peer,
            files,
            tracks,
            size,
            cached,
        })
    }

    pub fn folders(&self) -> Vec<SoulseekFolder> {
        let mut grouped: BTreeMap<String, Vec<SoulseekCandidate>> = BTreeMap::new();
        for f in &self.files {
            grouped.entry(f.folder_path()).or_default().push(f.clone());
        }
        grouped
            .into_iter()
            .map(|(path, mut files)| {
                files.sort_by(|a, b| a.filename.cmp(&b.filename));
                let title = files
                    .first()
                    .map(SoulseekCandidate::folder_name)
                    .unwrap_or_else(|| "Shared folder".into());
                let format_label = files
                    .first()
                    .map(SoulseekCandidate::format_badge)
                    .unwrap_or_default();
                let total_size = files.iter().map(|f| f.size).sum();
                SoulseekFolder {
                    path,
                    title,
                    files,
                    total_size,
                    format_label,
                }
            })
            .collect()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SoulseekSettings {
    pub user: String,
    pub password_set: bool,
    pub share: bool,
    /// True when the daemon uses `src/settings.js`'s `slskUser`/`slskPass`/`slskShare` keys.
    pub uses_slsk_keys: bool,
}

impl SoulseekSettings {
    pub fn from_value(val: &Value) -> Self {
        let settings_obj = val.get("settings").and_then(Value::as_object);
        let top_obj = val.as_object();

        // Check `slskUser` inside `settings` (src/settings.js view shape)
        if let Some(s) = settings_obj {
            if s.contains_key("slskUser") || s.contains_key("slskPass") || s.contains_key("slskShare") {
                let user = read_setting_str(s.get("slskUser")).unwrap_or_default();
                let password_set = s
                    .get("slskPass")
                    .and_then(|v| v.get("set").and_then(Value::as_bool))
                    .unwrap_or_else(|| !read_setting_str(s.get("slskPass")).unwrap_or_default().is_empty());
                let share = read_setting_bool(s.get("slskShare")).unwrap_or(false);
                return SoulseekSettings {
                    user,
                    password_set,
                    share,
                    uses_slsk_keys: true,
                };
            }
            if s.contains_key("soulseekUser") || s.contains_key("soulseekPassword") || s.contains_key("soulseekShare") {
                let user = read_setting_str(s.get("soulseekUser")).unwrap_or_default();
                let password_set = s
                    .get("soulseekPassword")
                    .and_then(|v| v.get("set").and_then(Value::as_bool))
                    .or_else(|| read_setting_bool(s.get("soulseekPasswordSet")))
                    .unwrap_or_else(|| !read_setting_str(s.get("soulseekPassword")).unwrap_or_default().is_empty());
                let share = read_setting_bool(s.get("soulseekShare")).unwrap_or(false);
                return SoulseekSettings {
                    user,
                    password_set,
                    share,
                    uses_slsk_keys: false,
                };
            }
        }

        // Check flat top-level fields (`{ soulseekUser, soulseekPasswordSet, soulseekShare }` or `slsk*`)
        if let Some(top) = top_obj {
            if top.contains_key("slskUser") || top.contains_key("slskPass") || top.contains_key("slskShare") {
                let user = read_setting_str(top.get("slskUser")).unwrap_or_default();
                let password_set = read_setting_bool(top.get("slskPassSet"))
                    .unwrap_or_else(|| !read_setting_str(top.get("slskPass")).unwrap_or_default().is_empty());
                let share = read_setting_bool(top.get("slskShare")).unwrap_or(false);
                return SoulseekSettings {
                    user,
                    password_set,
                    share,
                    uses_slsk_keys: true,
                };
            }
            let user = read_setting_str(top.get("soulseekUser")).unwrap_or_default();
            let password_set = read_setting_bool(top.get("soulseekPasswordSet"))
                .unwrap_or_else(|| !read_setting_str(top.get("soulseekPassword")).unwrap_or_default().is_empty());
            let share = read_setting_bool(top.get("soulseekShare")).unwrap_or(false);
            return SoulseekSettings {
                user,
                password_set,
                share,
                uses_slsk_keys: false,
            };
        }

        SoulseekSettings::default()
    }
}

fn read_setting_str(v: Option<&Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    v.get("value").and_then(Value::as_str).map(String::from)
}

fn read_setting_bool(v: Option<&Value>) -> Option<bool> {
    let v = v?;
    if let Some(b) = v.as_bool() {
        return Some(b);
    }
    v.get("value").and_then(Value::as_bool)
}

// ---- Discover v2 models ----

fn deserialize_opt_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val = Option::<Value>::deserialize(deserializer)?;
    let Some(v) = val else {
        return Ok(None);
    };
    if let Some(n) = v.as_u64() {
        return Ok(Some(n));
    }
    if let Some(f) = v.as_f64()
        && f.is_finite()
        && f >= 0.0
    {
        return Ok(Some(f.round() as u64));
    }
    Ok(None)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverFollowRequest {
    pub url: String,
    pub source: Option<String>,
    pub name: Option<String>,
    pub channel_id: Option<String>,
    pub handle: Option<String>,
}

impl DiscoverFollowRequest {
    pub fn from_url(url: impl Into<String>) -> Self {
        DiscoverFollowRequest {
            url: url.into(),
            ..Default::default()
        }
    }

    pub fn from_item(item: &DiscoverItem) -> Self {
        DiscoverFollowRequest {
            url: item.creator_url.clone(),
            source: Some(item.source.clone()),
            name: Some(item.creator_name.clone()),
            channel_id: None,
            handle: None,
        }
    }

    pub fn from_creator(creator: &DiscoverCreator) -> Self {
        let channel_id = (!creator.channel_id.is_empty()).then(|| creator.channel_id.clone());
        let handle = (!creator.handle.is_empty()).then(|| creator.handle.clone());
        DiscoverFollowRequest {
            url: creator.url.clone(),
            source: Some(creator.source.clone()),
            name: Some(creator.name.clone()),
            channel_id,
            handle,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverCreator {
    pub id: String,
    pub source: String,
    pub handle: String,
    pub name: String,
    pub url: String,
    pub channel_id: String,
    pub avatar: String,
    pub followed_at: u64,
    pub followed: Option<bool>,
}

impl DiscoverCreator {
    pub fn display_name(&self) -> &str {
        if !self.name.trim().is_empty() {
            self.name.trim()
        } else if !self.handle.trim().is_empty() {
            self.handle.trim()
        } else {
            self.id.as_str()
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverItem {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub item_id: String,
    pub title: String,
    pub creator_id: String,
    pub creator_name: String,
    pub creator_url: String,
    pub url: String,
    pub thumbnail: String,
    #[serde(default, deserialize_with = "deserialize_opt_u64")]
    pub duration: Option<u64>,
    pub published_at: u64,
    pub acquire_id: String,
    pub audio_only: bool,
    pub music: Option<MusicMeta>,
    pub in_library: bool,
}

impl DiscoverItem {
    pub fn source_label(&self) -> &'static str {
        match self.source.as_str() {
            "youtube" => "YouTube",
            "soundcloud" => "SoundCloud",
            "rumble" => "Rumble",
            _ => "Web",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverFeedError {
    pub creator_id: Option<String>,
    pub source: Option<String>,
    pub name: Option<String>,
    #[serde(alias = "error")]
    pub message: String,
}

impl DiscoverFeedError {
    pub fn display_label(&self) -> String {
        let prefix = self
            .name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| self.source.as_deref().filter(|s| !s.trim().is_empty()))
            .or_else(|| self.creator_id.as_deref().filter(|s| !s.trim().is_empty()));
        match prefix {
            Some(who) => format!("{who}: {}", self.message),
            None => self.message.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverFeed {
    pub creators: Vec<DiscoverCreator>,
    pub items: Vec<DiscoverItem>,
    pub errors: Vec<DiscoverFeedError>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverBrowseResult {
    pub query: String,
    pub sources: Vec<String>,
    pub creators: Vec<DiscoverCreator>,
    pub items: Vec<DiscoverItem>,
    pub errors: Vec<DiscoverFeedError>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverFollowResponse {
    pub creator: DiscoverCreator,
    pub creators: Vec<DiscoverCreator>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscoverUnfollowResponse {
    pub removed: bool,
    pub creators: Vec<DiscoverCreator>,
}

// ---- Visited Soulseek shelves persistence ----

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VisitedShelf {
    pub peer: String,
    pub tracks: usize,
    pub size: u64,
    pub visited_at: u64,
}

pub fn load_visited_shelves() -> Vec<VisitedShelf> {
    std::fs::read(DATA_DIR.join("visited-shelves.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<VisitedShelf>>(&bytes).ok())
        .unwrap_or_default()
}

pub fn save_visited_shelves(list: &[VisitedShelf]) {
    let file = DATA_DIR.join("visited-shelves.json");
    let tmp = file.with_extension("json.tmp");
    let _ = std::fs::create_dir_all(&*DATA_DIR);
    if let Ok(bytes) = serde_json::to_vec_pretty(list)
        && std::fs::write(&tmp, bytes).is_ok()
    {
        let _ = std::fs::rename(&tmp, &file);
    }
}

pub fn record_visited_shelf(list: &mut Vec<VisitedShelf>, peer: &str, tracks: usize, size: u64) {
    let clean = peer.trim();
    if clean.is_empty() {
        return;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    list.retain(|s| !s.peer.eq_ignore_ascii_case(clean));
    list.insert(
        0,
        VisitedShelf {
            peer: clean.to_string(),
            tracks,
            size,
            visited_at: now,
        },
    );
    list.truncate(24);
    save_visited_shelves(list);
}

// ---- Display helpers ----

pub fn format_duration(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

pub fn split_artist_title(raw: &str, fallback_artist: Option<&str>) -> (String, String) {
    let cleaned = raw.trim();
    for sep in [" - ", " — ", " – "] {
        if let Some((left, right)) = cleaned.split_once(sep) {
            let a = left.trim();
            let t = right.trim();
            if !a.is_empty() && !t.is_empty() {
                return (a.to_string(), t.to_string());
            }
        }
    }
    let artist = fallback_artist
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Unknown artist")
        .to_string();
    let title = if cleaned.is_empty() {
        "Untitled".to_string()
    } else {
        cleaned.to_string()
    };
    (artist, title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_shared_url_handles_all_supported_forms() {
        assert_eq!(
            extract_shared_url("peartube://add?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack%3Fsi%3D1"),
            Some("https://soundcloud.com/artist/track?si=1".to_string())
        );
        assert_eq!(
            extract_shared_url("PEARTUBE://add?foo=1&url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ"),
            Some("https://youtu.be/dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            extract_shared_url("peartube://channel/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
            Some("peartube://channel/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string())
        );
        let key = "a".repeat(64);
        assert_eq!(extract_shared_url(&key), Some(key.clone()));
        assert_eq!(
            extract_shared_url("https://rumble.com/v12345-example.html"),
            Some("https://rumble.com/v12345-example.html".to_string())
        );
        assert_eq!(
            extract_shared_url("Listen to this (https://soundcloud.com/demo/set)."),
            Some("https://soundcloud.com/demo/set".to_string())
        );
        assert_eq!(extract_shared_url("plain search words"), None);
        assert_eq!(extract_shared_url("   "), None);
    }

    #[test]
    fn parse_http_response_content_length_and_chunked() {
        let cl = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let parsed = parse_http_response(cl).expect("content-length response");
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body, b"{\"ok\":true}");

        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n";
        let parsed_chunked = parse_http_response(chunked).expect("chunked response");
        assert_eq!(parsed_chunked.status, 200);
        assert_eq!(parsed_chunked.body, b"{\"ok\":true}");

        let truncated = b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{\"ok\":true}";
        assert!(parse_http_response(truncated).is_err());

        let err_resp = HttpResponse {
            status: 400,
            body: br#"{"error":"Soulseek is not configured"}"#.to_vec(),
        };
        assert_eq!(
            parse_json_response(&err_resp).unwrap_err(),
            "Soulseek is not configured"
        );
    }

    #[test]
    fn parse_identify_result_flat_and_nested_shapes() {
        let flat = json!({
            "kind": "page",
            "site": "soundcloud",
            "title": "Blue Train",
            "author": "John Coltrane",
            "duration": 643,
            "audioOnly": true,
            "id": "clip:abcdef0123456789",
            "music": { "title": "Blue Train", "artist": "John Coltrane" },
            "match": null
        });
        let res = IdentifyResult::from_value(flat).expect("flat identify");
        assert!(res.is_page());
        assert_eq!(res.effective_site("https://soundcloud.com/x/y"), "SoundCloud");
        assert_eq!(res.effective_title("https://soundcloud.com/x/y"), "Blue Train");
        assert_eq!(res.effective_author().as_deref(), Some("John Coltrane"));
        assert_eq!(res.effective_duration_secs(), Some(643));
        assert!(res.default_audio_only("https://soundcloud.com/x/y"));
        assert_eq!(res.effective_id("https://soundcloud.com/x/y"), "clip:abcdef0123456789");

        let nested = json!({
            "link": {
                "kind": "page",
                "name": "Kind of Blue (Full Album)",
                "site": "youtube",
                "uploader": "Jazz Archive",
                "duration": 2740.4
            },
            "parsed": { "title": "Kind of Blue" },
            "candidates": [],
            "match": null,
            "plain": { "id": "clip:1122334455667788", "title": "Kind of Blue (Full Album)" }
        });
        let res2 = IdentifyResult::from_value(nested).expect("nested identify");
        assert_eq!(res2.effective_site("https://youtube.com/watch?v=abc"), "YouTube");
        assert_eq!(res2.effective_title("https://youtube.com/watch?v=abc"), "Kind of Blue (Full Album)");
        assert_eq!(res2.effective_author().as_deref(), Some("Jazz Archive"));
        assert_eq!(res2.effective_duration_secs(), Some(2740));
        assert!(!res2.default_audio_only("https://youtube.com/watch?v=abc"));
        assert_eq!(res2.effective_id("https://youtube.com/watch?v=abc"), "clip:1122334455667788");
    }

    #[test]
    fn parse_acquire_job_and_progress() {
        let raw = json!({
            "jobId": "11111111-2222-3333-4444-555555555555",
            "id": "album:0123456789abcdef0123",
            "title": "Miles Davis · Kind of Blue",
            "plugin": "soulseek",
            "status": "transferring",
            "phase": "transferring",
            "peer": "jazzfan99",
            "file": "01 - So What.flac",
            "fileIndex": 2,
            "fileCount": 5,
            "speed": 512000,
            "bytes": 50_000_000,
            "total": 200_000_000
        });
        let job: AcquireJob = serde_json::from_value(raw).expect("acquire job");
        assert!(job.is_active());
        assert_eq!(job.progress_fraction(), Some(0.25));
        assert_eq!(job.status_label(), "Downloading 2/5");
    }

    #[test]
    fn parse_source_search_result_both_shapes() {
        // Shape A: mirror.js flat results + bySource counts + errors array
        let shape_a = json!({
            "query": "coltrane",
            "sources": ["soulseek", "youtube", "soundcloud", "rumble"],
            "results": [
                {
                    "source": "soulseek",
                    "username": "vinylpeer",
                    "filename": "@@music\\John Coltrane - Blue Train (1958)\\01 Blue Train.flac",
                    "size": 42_000_000,
                    "slots": true,
                    "queue": 0,
                    "bit_depth": 24,
                    "sample_rate": 96000
                },
                {
                    "source": "youtube",
                    "videoId": "dQw4w9WgXcQ",
                    "title": "John Coltrane - Blue Train",
                    "length": 643,
                    "channel": "Blue Note",
                    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                },
                {
                    "source": "soundcloud",
                    "id": "sc-1",
                    "title": "Blue Train Live",
                    "artist": "Quartet",
                    "length": 412,
                    "url": "https://soundcloud.com/quartet/blue-train"
                },
                {
                    "source": "rumble",
                    "id": "rm-1",
                    "title": "Blue Train Documentary",
                    "channel": "Jazz Docs",
                    "length": 1800,
                    "url": "https://rumble.com/v1-blue-train.html"
                }
            ],
            "bySource": { "soulseek": 1, "youtube": 1, "soundcloud": 1, "rumble": 1 },
            "errors": []
        });
        let res_a = SourceSearchResult::from_value(shape_a).expect("shape A");
        assert_eq!(res_a.total_hits(), 4);
        assert_eq!(res_a.soulseek.len(), 1);
        assert_eq!(res_a.youtube.len(), 1);
        assert_eq!(res_a.soundcloud.len(), 1);
        assert_eq!(res_a.rumble.len(), 1);

        let groups = group_soulseek_candidates(&res_a.soulseek);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].peer, "vinylpeer");
        assert_eq!(groups[0].title, "John Coltrane - Blue Train (1958)");
        assert_eq!(groups[0].format_label, "FLAC 24-bit/96.0kHz");

        // Shape B: bySource object holding per-source arrays + errors map
        let shape_b = json!({
            "query": "ambient",
            "sources": ["soulseek", "youtube"],
            "bySource": {
                "youtube": [
                    { "videoId": "abcdefghijk", "title": "Ambient Study", "duration": 3600 }
                ]
            },
            "errors": {
                "soulseek": "Soulseek is not configured"
            }
        });
        let res_b = SourceSearchResult::from_value(shape_b).expect("shape B");
        assert_eq!(res_b.youtube.len(), 1);
        assert_eq!(res_b.youtube[0].url, "https://www.youtube.com/watch?v=abcdefghijk");
        assert_eq!(
            res_b.errors.get("soulseek").map(String::as_str),
            Some("Soulseek is not configured")
        );
    }

    #[test]
    fn parse_soulseek_shelf_and_group_folders() {
        let raw = json!({
            "username": "archivist",
            "tracks": 3,
            "size": 90_000_000,
            "cached": true,
            "files": [
                { "filename": "Music\\Miles Davis - Kind of Blue\\01 So What.flac", "size": 30_000_000, "bit_depth": 16, "sample_rate": 44100 },
                { "filename": "Music\\Miles Davis - Kind of Blue\\02 Freddie Freeloader.flac", "size": 30_000_000, "bit_depth": 16, "sample_rate": 44100 },
                { "filename": "Music\\Bill Evans - Waltz for Debby\\01 My Foolish Heart.flac", "size": 30_000_000, "bit_depth": 24, "sample_rate": 96000 }
            ]
        });
        let shelf = SoulseekShelf::from_value(raw, "archivist").expect("shelf");
        assert_eq!(shelf.peer, "archivist");
        assert_eq!(shelf.tracks, 3);
        let folders = shelf.folders();
        assert_eq!(folders.len(), 2);
        assert_eq!(folders[0].title, "Bill Evans - Waltz for Debby");
        assert_eq!(folders[1].title, "Miles Davis - Kind of Blue");
        assert_eq!(folders[1].files.len(), 2);
        assert_eq!(folders[1].total_size, 60_000_000);
    }

    #[test]
    fn parse_soulseek_settings_both_key_conventions() {
        let modern = json!({
            "soulseekUser": "listener",
            "soulseekPasswordSet": true,
            "soulseekShare": true
        });
        let s1 = SoulseekSettings::from_value(&modern);
        assert_eq!(s1.user, "listener");
        assert!(s1.password_set);
        assert!(s1.share);
        assert!(!s1.uses_slsk_keys);

        let relay_view = json!({
            "settings": {
                "slskUser": { "type": "text", "value": "relayuser" },
                "slskPass": { "type": "secret", "value": "", "set": true },
                "slskShare": { "type": "bool", "value": false }
            }
        });
        let s2 = SoulseekSettings::from_value(&relay_view);
        assert_eq!(s2.user, "relayuser");
        assert!(s2.password_set);
        assert!(!s2.share);
        assert!(s2.uses_slsk_keys);
    }

    #[test]
    fn parse_discover_feed_json() {
        let raw = json!({
            "creators": [
                {
                    "id": "youtube:UC1234567890abcdefghij",
                    "source": "youtube",
                    "handle": "@veritasium",
                    "name": "Veritasium",
                    "url": "https://www.youtube.com/channel/UC1234567890abcdefghij",
                    "channelId": "UC1234567890abcdefghij",
                    "avatar": "/v1/discover/thumb/0123456789abcdef0123",
                    "followedAt": 1730000000000u64
                },
                {
                    "id": "soundcloud:98765",
                    "source": "soundcloud",
                    "handle": "@quartet",
                    "name": "Quartet",
                    "url": "https://soundcloud.com/quartet",
                    "channelId": "98765",
                    "avatar": "",
                    "followedAt": 1730000001000u64
                }
            ],
            "items": [
                {
                    "id": "youtube:dQw4w9WgXcQ",
                    "source": "youtube",
                    "kind": "video",
                    "itemId": "dQw4w9WgXcQ",
                    "title": "Why Quantum Computers Break Cryptography",
                    "creatorId": "youtube:UC1234567890abcdefghij",
                    "creatorName": "Veritasium",
                    "creatorUrl": "https://www.youtube.com/channel/UC1234567890abcdefghij",
                    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "thumbnail": "/v1/discover/thumb/aaaaaaaaaaaaaaaaaaaa",
                    "duration": 1420,
                    "publishedAt": 1730000050000u64,
                    "acquireId": "clip:1122334455667788",
                    "audioOnly": false,
                    "music": null,
                    "inLibrary": false
                },
                {
                    "id": "soundcloud:555111",
                    "source": "soundcloud",
                    "kind": "audio",
                    "itemId": "555111",
                    "title": "Midnight Session",
                    "creatorId": "soundcloud:98765",
                    "creatorName": "Quartet",
                    "creatorUrl": "https://soundcloud.com/quartet",
                    "url": "https://soundcloud.com/quartet/midnight-session",
                    "thumbnail": "/v1/discover/thumb/bbbbbbbbbbbbbbbbbbbb",
                    "duration": 312.6,
                    "publishedAt": 1730000020000u64,
                    "acquireId": "sc:abcdef012345:s01e01",
                    "audioOnly": true,
                    "music": { "title": "Midnight Session", "artist": "Quartet" },
                    "inLibrary": true
                }
            ],
            "errors": [
                {
                    "creatorId": "rumble:c/example",
                    "source": "rumble",
                    "name": "Example Channel",
                    "message": "Rumble answered 403"
                }
            ],
            "updatedAt": 1730000100000u64
        });
        let feed: DiscoverFeed = serde_json::from_value(raw).expect("discover feed");
        assert_eq!(feed.creators.len(), 2);
        assert_eq!(feed.creators[0].display_name(), "Veritasium");
        assert_eq!(feed.creators[0].avatar, "/v1/discover/thumb/0123456789abcdef0123");
        assert_eq!(feed.items.len(), 2);
        assert_eq!(feed.items[0].source_label(), "YouTube");
        assert_eq!(feed.items[0].duration, Some(1420));
        assert!(!feed.items[0].audio_only);
        assert!(!feed.items[0].in_library);
        assert_eq!(feed.items[1].source_label(), "SoundCloud");
        assert_eq!(feed.items[1].duration, Some(313));
        assert!(feed.items[1].audio_only);
        assert!(feed.items[1].in_library);
        assert_eq!(
            feed.items[1].music,
            Some(MusicMeta {
                title: Some("Midnight Session".into()),
                artist: Some("Quartet".into()),
            })
        );
        assert_eq!(feed.errors.len(), 1);
        assert_eq!(feed.errors[0].display_label(), "Example Channel: Rumble answered 403");
        assert_eq!(feed.updated_at, 1730000100000);
    }

    #[test]
    fn parse_discover_browse_result_json() {
        let raw = json!({
            "query": "Science",
            "sources": ["youtube", "soundcloud", "rumble"],
            "creators": [
                {
                    "id": "youtube:aabbccddeeff",
                    "source": "youtube",
                    "handle": "",
                    "name": "PBS Space Time",
                    "url": "https://www.youtube.com/watch?v=xyz12345678",
                    "channelId": "",
                    "avatar": "/v1/discover/thumb/cccccccccccccccccccc",
                    "followedAt": 0,
                    "followed": true
                }
            ],
            "items": [
                {
                    "id": "rumble:v999",
                    "source": "rumble",
                    "kind": "video",
                    "itemId": "v999",
                    "title": "Deep Sea Expedition",
                    "creatorId": "rumble:112233445566",
                    "creatorName": "Ocean Lab",
                    "creatorUrl": "https://rumble.com/c/OceanLab",
                    "url": "https://rumble.com/v999-deep-sea.html",
                    "thumbnail": "",
                    "duration": 905,
                    "publishedAt": 0,
                    "acquireId": "clip:fedcba9876543210",
                    "audioOnly": false,
                    "music": null,
                    "inLibrary": false
                }
            ],
            "errors": [
                { "source": "soundcloud", "message": "Request timed out" }
            ]
        });
        let res: DiscoverBrowseResult = serde_json::from_value(raw).expect("discover browse");
        assert_eq!(res.query, "Science");
        assert_eq!(res.sources, vec!["youtube", "soundcloud", "rumble"]);
        assert_eq!(res.creators.len(), 1);
        assert_eq!(res.creators[0].followed, Some(true));
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].source_label(), "Rumble");
        assert_eq!(res.items[0].acquire_id, "clip:fedcba9876543210");
        assert_eq!(res.errors.len(), 1);
        assert_eq!(res.errors[0].display_label(), "soundcloud: Request timed out");
    }

    #[test]
    fn percent_encode_component_encodes_creator_ids() {
        assert_eq!(
            percent_encode_component("youtube:UC_123-abc"),
            "youtube%3AUC_123-abc"
        );
        assert_eq!(
            percent_encode_component("rumble:c/My Channel"),
            "rumble%3Ac%2FMy%20Channel"
        );
    }
}
