# PearTube Development Guide

PearTube is a decentralized CDN and debrid provider on the Holepunch stack. The core is deliberately small: the Holepunch modules do the heavy work, and PearTube glues them together. Keep it under 1,000 lines.

## Agent Instructions

Builds, installs, and deploy commands may be run when explicitly requested.

## Layout

|File|Purpose|
|---|---|
|`src/index.js`|`createNode`: Corestore, Autobee tracker + `apply`, Hyperblobs, blob server, Hyperswarm, `search` / `put` / `append` / `publish` / `remove`|
|`src/acquire.js`|Private job queue: fetch a source, `put` it, save the announce, `append` it durably. Stored in `jobs.json`, never in the Corestore|
|`src/http.js`|One port: the UI at `/` and the `/v1` API (no auth for now)|
|`src/ui.js`|The acquisitions page, one HTML string|
|`src/lan.js`|Optional LAN discovery: `@p2plabs/hyperdht-mdns` with an adapter that dials each peer's advertised address, not the mDNS reflector|
|`bin/relay.js`|Relay process, configured by env|
|`test/network.test.js`|Relays on a local HyperDHT testnet, including adversarial peers|
|`test/lan.test.js`|LAN adapter and error handling in isolation; no E2E test runs LAN discovery|

## Rules

- The Corestore holds only public data (tracker + blobs). Replication serves any stored core a peer can name. Secrets, source URLs and headers stay in private files.
- `apply` is the only gate on the tracker. It must stay deterministic: no clock, no randomness, no I/O. A writer may only add or remove entries under its own writer key.
- Keep Autobee `fastForward: false`. Fast-forward adopts a peer's built view without running `apply`, which lets a forging peer plant entries under other writers' keys (covered by a test).
- A tracker write counts only once it is in the local oplog; an unsynced joiner's optimistic write lives in memory until first sync.
- Connect peers with `tracker.replicate(conn)`, not `store.replicate(conn)`; only the former attaches Autobee's wakeup protocol.
- Give Autobee a namespaced store, and have a new tracker's founder append once before relying on others' optimistic writes.
- Pin `autobee` exactly; it is experimental.
- Don't add a machine API field without updating every client in the same change. MediaStorm is the proof client.
- Prefer deleting code to adding it. Old platform code is at tag `archive/v0.3.0-platform`.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.

## Commands

```bash
npm install
npm test
npm start
```

## Troubleshooting

No peers: check both NATs. HyperDHT aborts with `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` when both sides are randomized; forward a UDP port (`PEARTUBE_DHT_PORT`) or use `PEARTUBE_RELAY_THROUGH`.
