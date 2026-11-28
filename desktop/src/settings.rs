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
    /// Subscribed P2P metadata channels (`peartube://meta/<64hex>` URIs or 64-hex keys).
    #[serde(default)]
    pub meta_sources: Vec<String>,
    /// Block all clearnet metadata/artwork lookups (Cinemeta, Metahub, iTunes, YouTube typeahead).
    #[serde(default)]
    pub p2p_only_metadata: bool,
    /// Opt-in to seeding full metadata and artwork shards for subscribed metadata channels.
    #[serde(default)]
    pub seed_full_metadata: bool,
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
            meta_sources: Vec::new(),
            p2p_only_metadata: false,
            seed_full_metadata: false,
        }
    }
}

impl Settings {
    pub fn has_sources(&self) -> bool {
        !self.tracker.is_empty() || !self.mnemonic.is_empty() || !self.sources.is_empty()
    }

    pub fn load() -> Settings {
        std::fs::read(DATA_DIR.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
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

    /// Add a P2P metadata source key (lowercased, deduplicated against both raw keys and
    /// `peartube://meta/<key>` URIs). Returns `true` if a new entry was added.
    pub fn add_meta_source(&mut self, raw: &str) -> bool {
        let lower = raw.trim().to_ascii_lowercase();
        let key = lower
            .strip_prefix("peartube://meta/")
            .and_then(|rest| rest.split(['?', '#', '/']).next())
            .unwrap_or(lower.as_str())
            .to_string();
        if key.is_empty() {
            return false;
        }
        let exists = self.meta_sources.iter().any(|existing| {
            let e = existing.trim().to_ascii_lowercase();
            let existing_key = e
                .strip_prefix("peartube://meta/")
                .and_then(|rest| rest.split(['?', '#', '/']).next())
                .unwrap_or(e.as_str());
            existing_key == key
        });
        if exists {
            return false;
        }
        self.meta_sources.push(key);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_v050_settings_json_deserializes_with_meta_defaults() {
        let legacy = r#"{
            "tracker": "",
            "sources": [{ "key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "kind": "channel" }],
            "relayThrough": [],
            "bootstrap": [],
            "lanDiscovery": true,
            "privateRouting": false,
            "cacheMaxGb": 25
        }"#;
        let parsed: Settings = serde_json::from_str(legacy).expect("legacy settings.json");
        assert_eq!(parsed.cache_max_gb, 25);
        assert!(parsed.lan_discovery);
        assert!(!parsed.private_routing);
        assert!(parsed.meta_sources.is_empty());
        assert!(!parsed.p2p_only_metadata);
        assert!(!parsed.seed_full_metadata);
    }

    #[test]
    fn p2p_metadata_settings_round_trip_camel_case() {
        let s = Settings {
            meta_sources: vec![
                "peartube://meta/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            ],
            p2p_only_metadata: true,
            seed_full_metadata: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"metaSources\""));
        assert!(json.contains("\"p2pOnlyMetadata\":true"));
        assert!(json.contains("\"seedFullMetadata\":true"));
        let decoded: Settings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(decoded, s);
    }

    #[test]
    fn add_meta_source_lowercases_and_deduplicates_without_touching_sources() {
        let key_upper = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
        let key_lower = key_upper.to_ascii_lowercase();
        let mut s = Settings::default();
        assert!(!s.add_meta_source("   "));
        assert!(s.add_meta_source(key_upper));
        assert_eq!(s.meta_sources, vec![key_lower.clone()]);
        assert!(s.sources.is_empty());
        // Duplicate bare key or URI form is ignored.
        assert!(!s.add_meta_source(&key_lower));
        assert!(!s.add_meta_source(&format!("peartube://meta/{key_upper}?name=Lumen")));
        assert_eq!(s.meta_sources.len(), 1);
    }
}
