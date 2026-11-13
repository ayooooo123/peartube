# PearTube

[![CI](https://github.com/ayooooo123/peartube/actions/workflows/ci.yml/badge.svg)](https://github.com/ayooooo123/peartube/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ayooooo123/peartube)](https://github.com/ayooooo123/peartube/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Your videos, on your hardware, streamed between peers.**
PearTube is a small, self-hosted media library and CDN on the
[Holepunch](https://holepunch.to) stack. A relay imports links, stores each video in its own
Hypercore, and shares the pieces with phones, desktops, TVs and other relays over the DHT — or
with the relay next door over LAN discovery. The core stays under 1,000 lines; the Holepunch
modules do the heavy lifting.

Each identity has one **Channel**. Its owner (and the devices and writers the owner grants)
publishes; followers have read-only copies and still help seed the catalog and the pieces.

> **Status:** 0.4.42 is a working release, not a polished product. Browser playback, the relay
> UI, LAN discovery and both apps have been exercised on real hardware; everything else is
> described honestly under [Known limitations](#known-limitations). Read that before trusting it
> with anything you cannot lose.

## Contents

- [What you can do](#what-you-can-do)
- [How it works](#how-it-works)
- [Install](#install)
- [Run from source](#run-from-source)
- [Settings and environment](#settings-and-environment)
- [Web UI and API](#web-ui-and-api)
- [Unified Channels, Devices & Subscriber Passes](#unified-channels-devices--subscriber-passes)
- [Cast and TV receivers](#cast-and-tv-receivers)
- [Privacy rule](#privacy-rule)
- [Client apps](#client-apps)
- [Known limitations](#known-limitations)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [History](#history)

## What you can do

- **Run a relay** on a server, NAS or VPS: import a link, a folder, a feed or another channel
  once, then serve it to everyone who asks.
- **Watch in the browser.** The Library is a poster grid (All / Movies / Shows / Videos) that
  lists each file once and plays MKV, AVI, MP4 and TS through `peartube-media` compiled to
  WebAssembly — DTS, AC-3 and TrueHD surround, PGS/ASS/SRT subtitles — or casts to a TV.
  Browser playback waits for a cold peer's first Range slice (up to 30 s); simultaneous viewers
  share downloaded blocks rather than requiring separate full-file copies.
- **Add without guessing.** Paste a direct file URL or a video page (YouTube, Vimeo and the
  sites `ubit` supports). The relay parses the name or reads the page, offers Cinemeta
  suggestions, and announces a Stremio-shaped id (`imdb:tt…` or `imdb:tt…:s01e02`) only when
  the title and year match exactly.
- **Share quietly.** Relays and viewers fetch the pieces they need from whichever peers hold
  them, cache what they watched, and keep serving the peers they are connected to. An app never
  tells the DHT which videos it holds. No port forwarding is needed on a LAN: `PEARTUBE_LAN_HOST`
  turns on mDNS discovery and direct dials.
- **Follow channels and directories.** Keep a personal channel, follow someone else's,
  copy a channel, or publish a directory of catalogs so followers can find them.
- **Cast to a TV.** Pair a phone or Mac with an Android TV, a Pi or a Mac receiver. Every receiver
  runs its own P2P node and PearTube's own player: a dedicated TV APK or a desktop receiver.
- **Use it elsewhere.** Stremio takes `/manifest.json`, VLC/MPV/IINA/Kodi take
  `/v1/playlist.m3u`, and every app exposes the same `/v1` API and SSE stream on loopback.

## How it works

1. **Unified Channels.** Every account or relay is a single [Autobee](https://github.com/holepunchto/autobee)
   Channel (`peartube://channel/<key>`) with a deterministic ACL `apply`, fast-forwarding only onto views the owner's own devices stamp:
   followers replicate and seed read-only without appending, linked devices authenticate via a
   fork-proof 12-word BIP-39 recovery phrase (`claim`) or explicit writer grants (`owner`/`mod`/`writer`),
   owners and moderators can delete any entry or revoke writers, and optional `peartube://access/…`
   epoch passes encrypt per-video Hypercores so blind relays seed ciphertext while canceled subscribers
   lose access to new epochs.
2. **Storage.** Every imported video becomes its own Hypercore with `512 KiB` blocks, opened
   lazily and closed at rest, so a viewer can start or seek before the whole file exists. Legacy
   shared-blob slots still read back, and `blob-rechunk` splits them in the background.
3. **Transport.** One connection per peer carries every channel and every video. A peer already
   connected through a channel's swarm or the LAN serves any video it stores, with no lookup. The
   title being played is also looked up on its core's own topic. Only a node that published a
   video announces that topic, and a relay announces its complete cached copies too; an app never
   announces what it watched on the DHT, though a lookup still joins the title's hashed topic in
   this node's LAN mDNS advertisement, so LAN neighbours can see it. The player reads HTTP
   Ranges from a local Range server on the same device (`src/blob-server.js`, which fetches only a
   bounded window ahead of the viewer) or the worklet's loopback copy. Backfill (replication,
   HiveRelay seeding) yields to viewers through `peartube/bulk-busy` instead of pausing
   connections; a relay honors that signal only from peers that serve it blocks.
4. **Acquisition.** Imports are a private job queue (`jobs.json`): fetch, store, announce, append durably.
   Page links download and mux natively on every attempt through `ubit get --json`, so adaptive DASH/HLS streams
   never depend on expiring media URLs. `ubit` is only needed for page links, and only on the relay — the apps never run an HTTP acquirer.
5. **Privacy.** The Corestore holds public data only. Source URLs, headers, feed tokens,
   HiveRelay keys and relay settings never leave private files in the data directory.

## Install

### Relay

The image is published for `linux/amd64` and `linux/arm64` from `main`:

```sh
mkdir -p /srv/peartube-data && chmod 700 /srv/peartube-data
docker run -d --name peartube-relay --restart unless-stopped \
  -p 8174:8174 \
  -e PEARTUBE_LAN_HOST=<lan-ipv4-if-on-lan> \
  -e PEARTUBE_API_TOKEN=$(openssl rand -hex 32) \
  -v /srv/peartube-data:/data \
  ghcr.io/ayooooo123/peartube-relay:latest
```

On a LAN host, prefer `--network host` so mDNS (`224.0.0.251:5353`) and ephemeral LAN ports
reach the network. `docker build -t peartube-relay .` works too. The image is
`gcr.io/distroless/cc-debian12` plus the `bare` binary and the relay: no shell, no package
manager, no Node. Node runs only in a build stage that installs the dependencies, which keeps
just this platform's native add-ons. Bare is the container's main process, so `docker stop`
shuts the relay down cleanly; keep `--restart unless-stopped` so it comes back after a crash.
Beyond Docker, the [agent quickstart](#install-on-a-system-agent-quickstart) covers `systemd`
and `launchd`.

A bare `npm start` founds a new channel and prints its `channel` key
(`{"msg":"relay ready", …}`). Open `http://<relay>:8174/` and finish under **Settings**.

Browsers hide `VideoDecoder` (WebCodecs) and `SharedArrayBuffer` on plain `http://` LAN addresses. To unlock hardware WebCodecs over a LAN IP without a reverse proxy, drop a local P-256 CA and 390-day SAN certificate into `/srv/peartube-data` (and remove `ca.key` after signing):

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -days 3650 -nodes -keyout /srv/peartube-data/ca.key -out /srv/peartube-data/ca.crt -subj "/CN=PearTube Local CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /srv/peartube-data/tls.key -subj "/CN=peartube" | openssl x509 -req -CA /srv/peartube-data/ca.crt -CAkey /srv/peartube-data/ca.key -CAcreateserial -days 390 -out /srv/peartube-data/tls.crt -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:<lan-ipv4>,DNS:localhost\n") && rm -f /srv/peartube-data/ca.key /srv/peartube-data/ca.srl
```

When `tls.crt` and `tls.key` exist in `PEARTUBE_STORAGE` (or `PEARTUBE_TLS_CERT` / `PEARTUBE_TLS_KEY`), the relay also listens over `bare-https` on `PEARTUBE_HTTPS_PORT` (default `8443`; add `-p 8443:8443` if not using `--network host`) and serves `ca.crt` at `http://<relay>:8174/ca.crt` so phones and desktops can trust it once and open `https://<relay>:8443/`.

### Apps

Download from the [latest release](https://github.com/ayooooo123/peartube/releases/latest):

| File | Use it on |
|---|---|
| `PearTube-<version>-arm64.apk` | Android phones and tablets (arm64), beside the dev build |
| `PearTubeReceiver-<version>-arm64.apk` | Android TV, Google TV, Fire TV and Pi receivers |
| `PearTube-<version>-macos-arm64.zip` | Apple Silicon Macs, macOS 13 or later |

Mac bundles are signed ad hoc, not notarized, so clear the quarantine once:

```sh
xattr -dr com.apple.quarantine /Applications/PearTube.app
```

### Install on a system (agent quickstart)

When an AI coding/ops agent (Codex CLI, Claude Code, OpenCode, etc.) installs `peartube-relay` on a host, follow these rules so peers and players can actually reach it and the daemon survives after the agent turn ends:

1. **Host and network capability check.**
   - **Real Linux/macOS host, NAS or VPS (including self-hosted remote `codex` CLI / SSH sessions):** supported. If the agent runs in a command sandbox (`workspace-write` + `codex-network-proxy`), escalate: `udx-native` needs raw UDP sockets (an HTTP proxy cannot carry HyperDHT), and the relay must be registered under Docker, `systemd` or `launchd` so the agent's process reaper does not kill it when the turn ends.
   - **OpenAI-hosted Codex Cloud VMs (`Work in > Cloud`):** cannot host a live public or LAN relay. Their HTTP/HTTPS-only egress proxy blocks HyperDHT/UDX UDP, no inbound ports exist, and the VM hibernates between turns. Use loopback-only tests against `createTestnet()` (`PEARTUBE_BOOTSTRAP=127.0.0.1:<port>`), call an external relay's HTTPS `/v1/acquire`, or deploy the container to a real VPS.
2. **Settings before starting.** An unattended install sets these as env vars; each one is the starting value of its setting in the UI.
   - On a LAN host set `PEARTUBE_LAN_HOST=$HOST_IP` (the reachable LAN IPv4). Players stream through `/v1/blob` on the API port, so no stream address or second port is needed.
   - Generate `PEARTUBE_API_TOKEN=$(openssl rand -hex 32)` on any non-loopback network (`GET` playback/Stremio/M3U routes stay open; `POST`/`PUT`/`DELETE` `/v1/*` and `/v1/settings` require `Authorization: Bearer <token>`). Keep `PEARTUBE_STORAGE` at mode `0700` and env files at `0600`.
   - Leave `PEARTUBE_CHANNEL` unset to found a new channel, or pass an existing `PEARTUBE_CHANNEL`/`PEARTUBE_SOURCES` (add `PEARTUBE_REPLICATE=1` to mirror and seed remote blobs). The key is saved in `settings.json` on first start, so later starts need no env var.
3. **Install and detach as a persistent service.**

   **Docker / Podman** (`linux/amd64` + `linux/arm64`). Use `--network host` on a Linux LAN host so mDNS and ephemeral LAN UDP reach the network; use the port form on a WAN VPS or macOS Docker Desktop:

   ```sh
   mkdir -p /srv/peartube-data && chmod 700 /srv/peartube-data
   API_TOKEN=$(openssl rand -hex 32)
   docker run -d --name peartube-relay --restart unless-stopped \
     --network host \
     -e PEARTUBE_LAN_HOST=<lan-ipv4-if-on-lan> \
     -e PEARTUBE_API_TOKEN="$API_TOKEN" \
     -v /srv/peartube-data:/data \
     ghcr.io/ayooooo123/peartube-relay:latest
   ```

   **Native Linux (`systemd`, no Docker)** needs Node >= 22 and `git`:

   ```sh
   sudo apt-get update && sudo apt-get install -y --no-install-recommends git curl ca-certificates
   sudo useradd --system --home-dir /var/lib/peartube --shell /usr/sbin/nologin peartube || true
   sudo install -d -m 0700 -o peartube -g peartube /var/lib/peartube
   sudo install -d -m 0755 /etc/peartube
   sudo git clone https://github.com/ayooooo123/peartube.git /opt/peartube
   sudo npm --prefix /opt/peartube ci --omit=dev
   API_TOKEN=$(openssl rand -hex 32)
   sudo tee /etc/peartube/relay.env >/dev/null <<EOF
   PEARTUBE_STORAGE=/var/lib/peartube
   PEARTUBE_LAN_HOST=<lan-ipv4-if-on-lan>
   PEARTUBE_API_TOKEN=$API_TOKEN
   UV_THREADPOOL_SIZE=16
   EOF
   sudo chmod 0600 /etc/peartube/relay.env
   sudo tee /etc/systemd/system/peartube-relay.service >/dev/null <<'EOF'
   [Unit]
   Description=PearTube P2P Relay
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=peartube
   Group=peartube
   WorkingDirectory=/opt/peartube
   EnvironmentFile=/etc/peartube/relay.env
   ExecStart=/opt/peartube/node_modules/.bin/bare /opt/peartube/bin/relay.js
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload && sudo systemctl enable --now peartube-relay
   ```

   **Native macOS (`launchd`)** needs Node >= 22 and `git`:

   ```sh
   mkdir -p ~/.local/share/peartube/data ~/Library/LaunchAgents && chmod 700 ~/.local/share/peartube/data
   git clone https://github.com/ayooooo123/peartube.git ~/.local/share/peartube/app
   npm --prefix ~/.local/share/peartube/app ci --omit=dev
   API_TOKEN=$(openssl rand -hex 32)
   cat > ~/Library/LaunchAgents/com.peartube.relay.plist <<EOF
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.peartube.relay</string>
     <key>WorkingDirectory</key><string>$HOME/.local/share/peartube/app</string>
     <key>ProgramArguments</key><array>
       <string>$HOME/.local/share/peartube/app/node_modules/.bin/bare</string>
       <string>$HOME/.local/share/peartube/app/bin/relay.js</string>
     </array>
     <key>EnvironmentVariables</key><dict>
       <key>PEARTUBE_STORAGE</key><string>$HOME/.local/share/peartube/data</string>
       <key>PEARTUBE_LAN_HOST</key><string><lan-ipv4></string>
       <key>PEARTUBE_API_TOKEN</key><string>$API_TOKEN</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>$HOME/.local/share/peartube/relay.log</string>
     <key>StandardErrorPath</key><string>$HOME/.local/share/peartube/relay.log</string>
   </dict></plist>
   EOF
   chmod 600 ~/Library/LaunchAgents/com.peartube.relay.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.peartube.relay.plist
   ```

4. **Verify and report.** Poll `curl -fsS http://127.0.0.1:8174/v1/status` until `channel` is a
   64-character hex key, and confirm `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8174/manifest.json`
   prints `200` (a GET: the relay answers `HEAD` only on blob routes). Return the Web UI (`http://<host>:8174/`), Stremio
   addon (`/manifest.json`), M3U playlist (`/v1/playlist.m3u`), public channel URI
   (`peartube://channel/<status.channel>`), and where `PEARTUBE_API_TOKEN` is stored.

Every variable except `PEARTUBE_STORAGE`, `PEARTUBE_API_HOST`, `PEARTUBE_API_PORT`,
`PEARTUBE_API_TOKEN`, `PEARTUBE_SOURCES`, `PEARTUBE_PLUGINS_DIR` and the `PEARTUBE_PRIVATE_RELAY*`
guard mode is also a setting in the web UI. An env var is that setting's starting value; a change
saved in the UI overrides it until you put the env value back.

## Run from source

Node 22 or newer (22.21+/24.9+ for `worklet/bare-kit.sh`), plus `git`.

```sh
npm install
npm start                     # founds a channel, serves http://127.0.0.1:8174/
npm test                      # core and network tests on a local HyperDHT testnet
npm run test:cast             # Cast & TV receiver E2E (writes desktop/target/e2e/cast-result.json)
node test/ui.e2e.js           # web UI E2E in headless Brave
```

The apps need Rust and more; the commands that build them are under
[Testing](#testing) and in `AGENTS.md`.

## Settings and environment

Settings are saved in `settings.json` (`0600`) in the data directory and are never part of the
Corestore. On the Settings tab nothing changes until you press a card's **Save changes**: text
fields, switches, list entries and the button that goes back to an env value all wait for it, and
saving one card keeps the unsaved edits in the others. A saved change applies in the running
relay: most in place (**Applies on save**), and those that shape the node (the peer port, the
channel, bootstrap, private routing, HiveRelays, channel publishing) by reopening the node, jobs,
plugins and cast stack in the same process, which drops peers for a few seconds (**Applies on save,
reconnects peers**). The one-click switches on the Sharing tab apply at once. Precedence is
`settings.json`, then the env var, then the default. A value that still comes from its env var shows
**From PEARTUBE_…**; one saved over an env var shows **Overrides PEARTUBE_…** with a button that puts
the env value back (`PUT /v1/settings` with `null`). **Restart relay** under Access reopens everything the same way,
and also restarts a guard whose process has stopped. A reopen that fails (an unreadable saved
source, say) leaves its changes listed as not applied; fix the cause and **Restart relay** opens the
same storage again. A LAN address this machine doesn't have no longer stops the node: it runs
without LAN discovery. A reopen waits for the file being imported from the watch folder, not the
whole import, which carries on afterwards. The peer port and the guard port can't be set to the
same fixed port. Settings are accepted only from the relay's own page, never cross-origin.

A relay without `PEARTUBE_API_TOKEN` already trusts its local network: devices on private
addresses may change settings, while public clients get `403`. Its founded channel key is
remembered as the **Primary channel key** setting on first start, so following a channel cannot
silently replace the relay's own library. A `settings.json` from before channels has its
`tracker` value moved to `channel`, and its `streamHost`/`streamPort` dropped, when the relay starts.

| Variable | Default | Meaning |
|---|---|---|
| `PEARTUBE_CHANNEL` | none (found new) | Channel key this relay serves |
| `PEARTUBE_STORAGE` | `./peartube-data` | Data directory |
| `PEARTUBE_API_HOST` | `0.0.0.0` | Interface bound by the UI and `/v1` API server |
| `PEARTUBE_API_PORT` | `8174` | UI, `/v1` API, `/v1/blob` streams, Stremio addon and M3U port |
| `PEARTUBE_DHT_PORT` | random | Fixed UDP port, only needed when forwarding a port behind a double-randomized NAT |
| `PEARTUBE_BOOTSTRAP` | mainnet | Peer-discovery network; comma-separated `host:port` servers |
| `PEARTUBE_PRIVATE_ROUTING` | off | `1`: two-hop encrypted guard circuits on stock HyperDHT; endpoint addresses and channel keys are never announced publicly |
| `PEARTUBE_PRIVATE_RELAY` | off | `1`: standalone Corestore-free guard forwarder (`bin/private-relay.js`); cannot combine with channel or content flags |
| `PEARTUBE_PRIVATE_RELAY_PORT` | `PEARTUBE_DHT_PORT` | UDP port for the standalone guard forwarder |
| `PEARTUBE_PRIVATE_GUARD` | off | `1`: also run a guard forwarder beside this relay so others can route privately; the relay's own connections stay direct |
| `PEARTUBE_PRIVATE_GUARD_PORT` | random | UDP port for that guard; must differ from `PEARTUBE_DHT_PORT` |
| `PEARTUBE_RELAY_THROUGH` | none | Comma-separated blind relay keys |
| `PEARTUBE_LAN_HOST` | off | This machine's LAN IPv4; turns on mDNS discovery |
| `PEARTUBE_SOURCES` | none | Extra channel keys or `peartube://` URIs to follow |
| `PEARTUBE_PUBLISH_CHANNEL` | `1` on relays | List this relay's saved videos in its own channel without duplicating media (`0` disables) |
| `PEARTUBE_DIRECTORY` | off | `1`: publish a list of subscribed channels so peers can discover them. Turning it off unlists the ones it listed (kept in private `directory.json`); sources added with **Add to directory** stay |
| `PEARTUBE_WATCH_DIR` | none | Folder (e.g. `/data/import`) imported once per file |
| `PEARTUBE_MIRROR_FEEDS` | none | Comma-separated JSON feed or peer `/v1/entries` URLs to import |
| `PEARTUBE_REPLICATE` | off | `1` (or keys) to P2P-replicate remote blobs without duplicating catalog entries |
| `PEARTUBE_REPLICATE_FREE_GB` | `20` | Free disk GiB kept in reserve while replicating |
| `PEARTUBE_REPLICATE_MBPS` | `80` | Shared backfill download cap; backfill also pauses while a relay reports viewers (`peartube/bulk-busy`) and resumes after. `0` removes the cap |
| `PEARTUBE_HIVERELAYS` | none | Comma-separated [HiveRelay](https://github.com/bigdestiny2/P2P-Hiverelay) URLs (`http://host:9100=TOKEN` or bare) recruited as supplemental seeders |
| `PEARTUBE_HIVERELAY_API_KEY` | none | Shared Bearer key for HiveRelay entries without an inline `=TOKEN` |
| `PEARTUBE_HIVERELAY_DISCOVER` | off | `1`: discover HiveRelays on the `hiverelay-discovery-v1` DHT topic and send signed seed requests |
| `PEARTUBE_HIVERELAY_REPLICAS` | `3` | Target P2P HiveRelay replica count when discovering or using unauthenticated relays |
| `PEARTUBE_HIVERELAY_UPLOAD_MBPS` | `50` | Shared upload cap for bulk peers that do not pace themselves; over it their connections are paused. Viewer apps are never capped. `0` removes it |
| `PEARTUBE_PLUGINS_DIR` | `<PEARTUBE_STORAGE>/plugins` | Directory scanned on startup for `*.mjs`/`*.js` import plugins |
| `PEARTUBE_ACQUIRE_CONCURRENCY` | `4` | Maximum concurrent HTTP acquisition downloads |
| `PEARTUBE_CINEMETA_URL` | `https://v3-cinemeta.strem.io` | Cinemeta-compatible title service; empty turns lookups off |
| `PEARTUBE_ALLOWED_PEERS` | none | Comma-separated 64-hex Noise public keys allowed through the swarm firewall |
| `PEARTUBE_API_TOKEN` | none | Bearer token required on mutating `/v1/*` routes and `/v1/settings` |

### Reachability

HyperDHT cannot holepunch between two randomized NATs. Relays on one network can still find
each other: set `PEARTUBE_LAN_HOST` on each and they discover one another over mDNS and connect
direct over ephemeral UDP ports. Across networks, forward a UDP port and set
`PEARTUBE_DHT_PORT`, or use a blind relay via `PEARTUBE_RELAY_THROUGH`.

Private routing connects peers over two-hop encrypted UDX-spliced guard circuits on unmodified
`hyperdht`. It needs at least two reachable, `/24`-diverse guards (run `node bin/private-relay.js`,
`PEARTUBE_PRIVATE_RELAY=1` with no channel/content flags, or turn on **Help others route privately**
on any relay), which open zero disk state and are auto-discovered on each boot. Endpoints never
announce IPs or channel keys, disable LAN mDNS, and fail closed with fewer than two diverse guards.

A relay's guard is `bin/private-relay.js` started as a child process, so it never shares the
relay's Corestore process. It uses its own HyperDHT node, port and fresh key on every start, and
exits with the relay. The relay keeps its direct and LAN connections; turning on **Private
routing** instead moves the relay's own traffic onto guards and drops them.

## Web UI and API

One port serves the UI at `/`, the `/v1` API, video at `/v1/blob`, the Stremio addon and the M3U
playlist. The node's blob server stays on loopback behind `/v1/blob`.
Without `PEARTUBE_API_TOKEN` there is no auth, so run an open relay only on a network you trust:
anyone who can reach it can queue a download of any URL.

The UI has five tabs: **Library** (add and play), **Channels** (your channel and the ones you
follow), **Sharing** (peers, kept copies, HiveRelays, Stremio and M3U addresses), **TV** (pair
and control) and **Settings**. Plugins appear only as user intents.

| Route | Does |
|---|---|
| `GET /` | Web UI |
| `GET/PUT /v1/settings` | Settings with each one's `value`, `source` (`file`, `env` or `default`), `env`, `envSet`, `live` flag and `restartNeeded`. `PUT` applies before it answers; `null` puts a value back to its env var or default; secrets inside URLs never return |
| `GET /v1/identity`, `POST /v1/identity/{writers,epoch,recover}`, `DELETE /v1/identity/writers/:key` | Channel writer ACL, 12-word recovery phrase (`?reveal=1` / `recover`), and paid subscriber epoch pass rotation; same token and origin gate as `/v1/settings` |
| `POST /v1/restart` | Reopens the node, jobs, plugins and cast stack in the running process; same auth and origin rules as settings |
| `POST /v1/identify` `{url}` | Link contents: parsed name, Cinemeta `candidates` and `match`, or a plain `clip:` fallback |
| `GET /v1/search?id=imdb:tt…`, `GET /v1/entries`, `POST /v1/entries/remove` | Channel entries with `streamUrl` (on this port's `/v1/blob`); one result per file (`id` + `sha256`), or owner/mod entry removal + unreferenced core purge |
| `POST /v1/acquire` `{id, title, private, source}` | Fetch, store (optionally epoch-encrypted) and announce; `page: true` downloads and muxes a page through `ubit` on every attempt |
| `GET/DELETE /v1/jobs[/:id]` | Acquire jobs; sources are never returned. `DELETE` cancels or removes |
| `GET /v1/status` | Keys, stored bytes, peers and per-transport traffic, `lan`, `privateRouting`, `privateGuard` (`publicKey`, `port`, circuit counts, or `null`), `tokenRequired`, `settingsOpen` |
| `GET/POST /v1/sources`, `DELETE /v1/sources/:key` | Follow or remove a channel |
| `POST /v1/open`, `GET /v1/resolve` | Open a `peartube://channel/…`, `peartube://access/…` subscriber pass, receiver pairing or `peartube://watch/…` link |
| `POST /v1/cache/clear`, `GET /v1/events` | Clear cached pieces; live SSE updates |
| `GET /manifest.json`, `/catalog/…`, `/stream/…` | Stremio v3 addon |
| `GET /v1/playlist.m3u` | M3U8 playlist |
| `GET /v1/plugins`, `POST /v1/plugins/:name/run`, `POST /v1/mirror` | Import and seeder plugins (`http-acquire`, `channel-backfill`, `blob-rechunk`, `watch-dir`, `feed-mirror`, `p2p-replicate`, `hiverelay-seed`, plus `/data/plugins/*.mjs`) |
| `/v1/cast/*` | Pair, play, attach, control and stop TVs; start or manage a local receiver |

Job states: `queued` → `running` (`bytes` of `total`) → `announcing` → `done`, or `failed`/`cancelled`.
A job is `done` only once its announce is on disk.

## Unified Channels, Devices & Subscriber Passes

| Capability | How it works |
|---|---|
| **Public followers** (`peartube://channel/<key>`) | Strictly read-only (`optimistic: false`); followers replicate and seed catalog + `512 KiB` video blocks without write access |
| **Multi-device accounts** (12-word phrase or `grantWriter`) | Every device keeps its own random `Corestore` writer core (zero fork risk) and proves ownership via a detached Ed25519 `claim` signed from the 12-word BIP-39 vault (`identity.json`, `0600`) |
| **Moderation & deletion** | `owner` and `mod` writers can delete any entry in the Channel and revoke secondary writers (`purgeEntries` optional) |
| **Paid / private epochs** (`peartube://access/<ch>:<epoch>:<key>`) | Private uploads encrypt each per-video `Hypercore` with a random key wrapped under `EpochKey_N`; blind relays seed ciphertext, and rotating to `EpochKey_N+1` locks canceled subscribers out of new uploads without re-encrypting archives |
## Cast and TV receivers

Senders stay libraries and players; only the dedicated TV clients receive a cast. A receiver is a
P2P node with a player. Smart TV browsers are not supported: a receiver needs native UDP.

1. **Android TV receiver APK** (`android/tv/`, `com.peartube.receiver`): Leanback launcher, a
   10-foot QR idle screen and native playback through `libpeartube.so` (MKV, AVI, MP4, HEVC,
   XviD, FLAC, TrueHD, ASS, PGS) with full D-pad and media-remote controls synced to the sender.
2. **Desktop receiver** (`PearTubeReceiver`): the same idea on a Mac or HTPC, with seek,
   play/pause, ±10 s, audio/subtitle menus, fullscreen and stop.

A cast uses one connection. The sender's node connects to the receiver's node as to any peer: on
the LAN when mDNS (`_peartube-cast._tcp`) shows the receiver, else by its key over the swarm.
Pairing and remote control run on a Protomux channel of that connection (`src/cast-control.js`),
and the film reaches the TV over the same connection and the swarm. The receiver has no control
port and no LAN HTTP: its only HTTP port is on loopback, for its own player.

- **Pairing** is the 6-character code on the TV's screen, or a
  `peartube://receiver/<pubkey>?token=…` link, which needs no code. The receiver's node keeps one
  key across restarts, so pairings last. A key that pairing saved wins over what mDNS says.
- **Who may cast.** Any peer that connects to a receiver can open the channel, so every request is
  checked: a command needs the token. A receiver started open (`--open`) takes casts without
  pairing from LAN links only. Wrong codes are counted apart for LAN links and all others.
- **Routing.** A cast uses the routing the receiver's node is set to. With private routing off
  (the default) the film comes over the public swarm. A TV with private routing on plays over
  2-hop circuits, and only a sender on private routing reaches it.
- **Older builds.** A sender and a receiver from before and after this change cannot cast to each
  other: update both.

Once a cast starts, the receiver keeps playing and serving after the sender disconnects.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data:
the channel and the blobs. `jobs.json` keeps source URLs and headers; `settings.json` keeps
feed URLs, HiveRelay keys and tokens. Neither is replicated. A page thumbnail is shown only
while you confirm the add and is never announced; an identified entry carries only its
`imdb:…` id and title.

## Client apps

The released clients are a Kotlin app for Android (`android/`) and a GPUI app for macOS
(`desktop/`); an iOS development target lives in `ios/` and is not a published release. Each
runs `src/index.js` in a Bare worklet through `bare-kit` and plays through the Rust player in
[peartube-media](https://github.com/ayooooo123/peartube-media): hardware decoders (MediaCodec,
VideoToolbox) where supported, software otherwise, drawn into a native view under overlay
controls. Android builds default to that JS engine; `-Ppeartube.engine=rust` builds one against
the prebuilt, pinned peartube-native engine in `native.lock` instead.

Apps connect to peers directly rather than routing everything through a relay: they follow
catalogs, open `peartube://` links, cast, fetch the pieces playback needs, and seed cached
pieces while online. They never run the HTTP acquirer, and cached data can be cleared in the
app without removing subscriptions. On first launch, enter a relay's channel key (`/v1/status`
shows it); LAN discovery is on by default on fresh installs and follows the device's address.

The relay's browser player uses the same full-screen cinema layout and 10-second seek
controls as the Mac app; its Mini player button keeps the stream playing in a corner
while you browse, with its own pause, seek, and Expand controls. Close ends playback.
After a seek or a return from another window, AVI playback keeps each picture
at its source time and resumes it alongside the audio.
WebCodecs playback can trim persistent black rows baked into a movie's encoded frame;
it never trims picture columns, and restores the full frame when the picture expands.
Codec and browser support still determine whether playback uses WebCodecs, MSE, or
software decoding. The browser's picture and soundtrack are not HDMI bitstream
passthrough or the native apps' HDR output path.

On the Mac, Space plays and pauses, ← and → skip 10 s, F toggles fullscreen and Esc leaves it.
A click on the picture plays or pauses; a double click toggles fullscreen.

The Mac player info drawer offers Auto, Bit-Perfect PCM, Passthrough and Stereo audio
routing, seamless/Exact 24p/off display matching, an opt-in Dolby Vision Profile 7
12-bit FEL software path, chapter jumps, and live decoder/output details. Changing
a quality option reopens the current stream at its saved position. The Android
phone defaults to Auto audio and seamless frame-rate matching; the Android TV and
Mac receiver default to Auto audio (attempting supported passthrough) and exact
matching. Their info
overlays show the active dynamic range and audio output, not a promise that the
connected display or AVR accepted every advertised mode. TV receivers expose
chapter jumps alongside audio/subtitle selection.

For local development without pushing a media commit, run
`python3 sync-player.py --local` in this checkout, then build both Mac bundles with
`sh desktop/bundle.sh` and `sh desktop/bundle.sh --receiver`, or the Android
debug clients with `cd android && ./gradlew :app:assembleDebug :tv:assembleDebug`.
The script rewrites the four app Cargo manifests to sibling `peartube-media`
paths; run `python3 sync-player.py` only after that media HEAD has been pushed
to restore pinned git revisions.

MIDI playback needs your own SoundFont 2 (`.sf2`, up to 256 MiB), copied into private storage;
no bank is bundled. Subtitles use platform fonts and fonts attached to the media.

## Known limitations

- **Moderation is per channel.** Only the owner and the writers it grants publish; `owner` and
  `mod` writers can remove entries. There is no shared, open catalog.
- **Private routing is early alpha and not anonymity.** It needs testing across real
  connections, at least two diverse guards, adds delay, and still exposes bootstrap traffic.
- **Format coverage is narrower than VLC's.** `peartube-media` plays common video, audio and
  subtitle formats, but compatibility remains in development.
- **Platform limits.** `ios/` is a sideload target; the Mac app is arm64 and not notarized;
  there is no Windows or Linux desktop app; `/v1` auth is one optional Bearer token on writes.
- **Real-world mileage is uneven.** Playback and P2P streaming get the most use; Casting,
  Stremio, M3U, import plugins and multi-catalog directories pass E2E tests but have had little
  outside use.

## Repository layout

| Path | What it is |
|---|---|
| `src/index.js` | `createNode`: Corestore, Autobee channel, per-video Hypercores, Hyperswarm, `search`/`put`/`append`/`publish`/`remove`, `setLan`, LAN discovery |
| `src/http.js`, `src/ui.js` | The one-port server and the relay web UI |
| `src/acquire.js`, `src/settings.js`, `src/identify.js` | Private job queue, settings store, link identification and Cinemeta matching |
| `src/lan.js`, `src/cast.js`, `src/cast-control.js` | LAN discovery, Cast & TV receiver stack, its control channel |
| `src/mirror.js`, `src/hiverelay.js` | Plugin host and HiveRelay recruitment/seeding |
| `src/private-overlay.js`, `bin/private-relay.js` | Stateless 2-hop guard overlay and guard forwarders |
| `bin/relay.js` | Relay daemon |
| `worklet/` | The worklet the apps run (`worker.js`), its crypto and the QuickJS bare-kit build |
| `desktop/`, `android/`, `android/tv/`, `ios/` | The Mac app, the phone app, the TV receiver, the iOS development target |
| `web/` | The WebAssembly player (`sh web/build.sh` → `web/assets/`, not part of the core line budget) |
| `test/` | Network, LAN, Cast, HiveRelay, per-video blob, UI and desktop E2E suites |

## Testing

The suite prefers E2E and writes repeatable artifacts under `desktop/target/e2e/`.

```sh
npm test                         # core + network + cast tests on a local testnet
npm run test:desktop             # Mac worklet E2E: exact bytes, live publish/remove, LAN-only run
npm run test:cast                # test receiver in its own process, LAN and DHT casts, initiator loss, private-routing TV
node test/ui.e2e.js              # web UI in headless Brave at 1440×900 and 390×844, light/dark
node android/e2e.mjs --serial <adb serial> --relay http://<relay>:8174 [--lan]
```

Builds:

```sh
sh worklet/bare-kit.sh           # once: bare-kit on QuickJS, plus V8 for the TV receiver (Android if the NDK exists, macOS on a Mac)
sh android/release.sh            # signed arm64 phone APK
sh android/release-tv.sh         # signed arm64 TV receiver APK
cd android && ./gradlew :tv:assembleDebug -Ppeartube.engine=rust   # TV receiver on the pinned peartube-native engine
python3 sync-native.py check     # contract files changed since native.lock's jsRef (fails for a rust-default platform)
npm run app                      # macOS: builds and opens PearTube.app
sh desktop/bundle.sh --zip       # macOS: release zip
sh desktop/bundle.sh --receiver --zip
```

CI runs the core and Cast suites on every push and pull request, publishes the multi-arch
`ghcr.io/ayooooo123/peartube-relay:latest` image on `main`, and builds the Android debug APKs
when `android/`, `worklet/` or `src/` changes.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged
`archive/v0.3.0-platform`. Restore anything with
`git checkout archive/v0.3.0-platform -- <path>`.
