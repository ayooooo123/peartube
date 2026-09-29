//! What the app joins: a tracker, optional blind relays, an optional DHT
//! bootstrap for a private network, and optional LAN discovery. Kept in
//! settings.json in the data dir.

use serde::{Deserialize, Serialize};

use crate::worker::DATA_DIR;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Tracker key, 64 hex characters. Empty until the user sets one.
    pub tracker: String,
    /// Blind relay keys, for peers behind two randomized NATs.
    pub relay_through: Vec<String>,
    /// DHT bootstrap nodes as host:port; empty means the public DHT.
    pub bootstrap: Vec<String>,
    /// This device's LAN address as IPv4:port, for finding relays on the local
    /// network over mDNS (relays run it with PEARTUBE_LAN_HOST). Empty is off.
    pub lan: String,
}

impl Settings {
    pub fn load() -> Settings {
        std::fs::read(DATA_DIR.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let file = DATA_DIR.join("settings.json");
        let tmp = file.with_extension("json.tmp");
        std::fs::create_dir_all(&*DATA_DIR).map_err(|err| err.to_string())?;
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|err| err.to_string())?).map_err(|err| err.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|err| err.to_string())
    }

    /// Settings from the form's text fields. Lists split on commas or whitespace.
    pub fn parse(tracker: &str, relay_through: &str, bootstrap: &str, lan: &str) -> Result<Settings, String> {
        let tracker = tracker.trim().to_lowercase();
        if !is_key(&tracker) {
            return Err("The tracker key is 64 hex characters.".into());
        }
        let relay_through: Vec<String> = split(relay_through).map(str::to_lowercase).collect();
        if let Some(bad) = relay_through.iter().find(|key| !is_key(key)) {
            return Err(format!("Relay key {bad} is not 64 hex characters."));
        }
        let bootstrap: Vec<String> = split(bootstrap).map(String::from).collect();
        if let Some(bad) = bootstrap.iter().find(|node| !is_host_port(node)) {
            return Err(format!("Bootstrap node {bad} is not host:port."));
        }
        let lan = lan.trim();
        // One below the relay default, so a relay and the app can share a machine.
        let lan = if lan.is_empty() || lan.contains(':') { lan.to_string() } else { format!("{lan}:49798") };
        let valid = lan.rsplit_once(':').is_some_and(|(host, port)| {
            host.parse::<std::net::Ipv4Addr>().is_ok() && port.parse::<u16>().is_ok_and(|p| p > 0)
        });
        if !lan.is_empty() && !valid {
            return Err(format!("LAN address {lan} is not an IPv4 address with an optional port."));
        }
        Ok(Settings { tracker, relay_through, bootstrap, lan })
    }
}

fn split(list: &str) -> impl Iterator<Item = &str> {
    list.split(|c: char| c == ',' || c.is_whitespace()).filter(|s| !s.is_empty())
}

fn is_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_host_port(node: &str) -> bool {
    node.rsplit_once(':').is_some_and(|(host, port)| !host.is_empty() && port.parse::<u16>().is_ok_and(|p| p > 0))
}
