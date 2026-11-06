//! What the app joins: an optional primary tracker, subscribed channels/trackers,
//! optional blind relays, DHT bootstrap, LAN discovery (on by default on fresh installs),
//! and private routing. Kept in private settings.json, never inside Corestore.

use serde::{Deserialize, Serialize};

use crate::worker::DATA_DIR;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceSpec {
    pub key: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub alias: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Primary channel key, 64 hex characters. May be empty when `sources` or `mnemonic` is set.
    pub tracker: String,
    /// Optional 12/24-word recovery phrase linking this Mac as an authorized multi-device writer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mnemonic: String,
    /// Followed channels (`kind: "channel"`).
    pub sources: Vec<SourceSpec>,
    /// Blind relay keys, for peers behind two randomized NATs.
    pub relay_through: Vec<String>,
    /// DHT bootstrap nodes as host:port; empty means the public DHT.
    pub bootstrap: Vec<String>,
    /// Find relays and peers on the local network over mDNS.
    pub lan_discovery: bool,
    /// Route peer connections over 2-hop encrypted guard circuits.
    pub private_routing: bool,
    /// Playback cache ceiling in GB, kept to help the network. `0` = unlimited.
    pub cache_max_gb: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            tracker: String::new(),
            mnemonic: String::new(),
            sources: Vec::new(),
            relay_through: Vec::new(),
            bootstrap: Vec::new(),
            lan_discovery: true,
            private_routing: false,
            cache_max_gb: 10,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSettings {
    #[serde(default)]
    tracker: String,
    #[serde(default)]
    mnemonic: String,
    #[serde(default)]
    sources: Vec<SourceSpec>,
    #[serde(default)]
    relay_through: Vec<String>,
    #[serde(default)]
    bootstrap: Vec<String>,
    #[serde(default)]
    lan_discovery: bool,
    #[serde(default)]
    private_routing: bool,
    #[serde(default = "default_cache_max_gb")]
    cache_max_gb: u32,
}

fn default_cache_max_gb() -> u32 {
    10
}

impl Settings {
    pub fn has_sources(&self) -> bool {
        !self.tracker.is_empty() || !self.mnemonic.is_empty() || !self.sources.is_empty()
    }

    pub fn load() -> Settings {
        std::fs::read(DATA_DIR.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RawSettings>(&bytes).ok())
            .map(|r| Settings {
                tracker: r.tracker,
                mnemonic: r.mnemonic,
                sources: r.sources,
                relay_through: r.relay_through,
                bootstrap: r.bootstrap,
                lan_discovery: r.lan_discovery,
                private_routing: r.private_routing,
                cache_max_gb: r.cache_max_gb,
            })
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let file = DATA_DIR.join("settings.json");
        let tmp = file.with_extension("json.tmp");
        std::fs::create_dir_all(&*DATA_DIR).map_err(|err| err.to_string())?;
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|err| err.to_string())?).map_err(|err| err.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|err| err.to_string())
    }

    pub fn format_sources(&self) -> String {
        self.sources.iter().map(|s| s.key.as_str()).collect::<Vec<_>>().join("\n")
    }

    pub fn add_or_update_source(&mut self, mut spec: SourceSpec) {
        spec.kind = "channel".to_string();
        if self.tracker == spec.key {
            return;
        }
        if let Some(existing) = self.sources.iter_mut().find(|s| s.key == spec.key) {
            existing.kind = "channel".to_string();
            if !spec.alias.is_empty() {
                existing.alias = spec.alias;
            }
        } else {
            self.sources.push(spec);
        }
    }
}
