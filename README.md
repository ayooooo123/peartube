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

Two kinds of catalog: a **shared Tracker**, where anyone with the key can add listings, and a
**personal Channel**, where only the owner publishes while subscribers still help seed the catalog
and the pieces.

> **Status:** 0.4.38 is a working release, not a polished product. Browser playback, the relay
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
- [Trackers and Channels](#trackers-and-channels)
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
- **Add without guessing.** Paste a direct file URL or a video page (YouTube, Vimeo and the
  sites `yt-dlp` supports). The relay parses the name or reads the page, offers Cinemeta
  suggestions, and announces a Stremio-shaped id (`imdb:tt…` or `imdb:tt…:s01e02`) only when
  the title and year match exactly.
- **Share quietly.** Relays and viewers fetch the pieces they need from whichever peers hold
  them, cache what they watched, and keep seeding while online. No port forwarding is needed on
  a LAN: `PEARTUBE_LAN_HOST` turns on mDNS discovery and direct dials.
- **Follow channels and directories.** Keep a personal channel, follow someone else's,
  copy a channel, or publish a directory of catalogs so followers can find them.
- **Cast to a TV.** Pair a phone, Mac, Android TV, Pi, LG webOS or Samsung Tizen receiver; a
  dedicated TV APK and a zero-install `/tv` page both run a headless P2P receiver.
- **Use it elsewhere.** Stremio takes `/manifest.json`, VLC/MPV/IINA/Kodi take
  `/v1/playlist.m3u`, and every app exposes the same `/v1` API and SSE stream on loopback.

## How it works

1. **Catalogs.** A tracker is multi-writer [Autobee](https://github.com/holepunchto/autobee)
   with `fastForward: false`: every writer may add or remove only its own entries, and `apply`
   decides what counts — no clock, no randomness, no I/O. A channel is a single-writer
   `Hyperbee`. Both are public, shareable catalogs.
2. **Storage.** Every imported video becomes its own Hypercore with `512 KiB` blocks, opened
   lazily and closed at rest, so a viewer can start or seek before the whole file exists. Legacy
   shared-blob slots still read back, and `blob-rechunk` splits them in the background.
3. **Transport.** Peers join the swarm for the video's core, stream HTTP Ranges from a local
   [`hypercore-blob-server`](https://github.com/holepunchto/hypercore-blob-server) or the
   worklet's loopback copy, and exchange blocks with anyone who has them. Backfill (replication,
   HiveRelay seeding) yields to viewers through `peartube/bulk-busy` instead of pausing
   connections.
4. **Acquisition.** Imports are a private job queue (`jobs.json`): fetch, store, announce, append durably.
   A page is resolved again on every attempt because its media URLs expire. `yt-dlp` is only
   needed for page links, and only on the relay — the apps never run an HTTP acquirer.
5. **Privacy.** The Corestore holds public data only. Source URLs, headers, feed tokens,
   HiveRelay keys and relay settings never leave private files in the data directory.

## Install

### Relay

The image is published for `linux/amd64` and `linux/arm64` from `main`:

```sh
mkdir -p /srv/peartube-data && chmod 700 /srv/peartube-data
docker run -d --name peartube-relay --restart unless-stopped \
  -p 8174:8174 -p 8175:8175 \
  -e PEARTUBE_STREAM_HOST=<lan-or-public-ip> \
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

A bare `npm start` founds a new tracker and prints its `tracker` and `channel` keys
(`{"msg":"relay ready", …}`). Open `http://<relay>:8174/` and finish under **Settings**.

### Apps

Download from the [latest release](https://github.com/ayooooo123/peartube/releases/latest):

| File | Use it on |
|---|---|
| `PearTube-<version>-arm64.apk` | Android phones and tablets (arm64), beside the dev build |
| `PearTubeReceiver-<version>-arm64.apk` | Android TV, Google TV, Fire TV and Pi receivers |
| `PearTube-<version>-macos-arm64.zip` | Apple Silicon Macs, macOS 13 or later |
| `PearTubeReceiver-<version>-macos-arm64.zip` | A dedicated Mac/HTPC TV display |

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
   - Detect the reachable LAN, Tailscale or public IPv4 (`HOST_IP`) and set `PEARTUBE_STREAM_HOST=$HOST_IP`. The `127.0.0.1` default breaks playback on every other device. On a LAN host also set `PEARTUBE_LAN_HOST=$HOST_IP`.
   - Generate `PEARTUBE_API_TOKEN=$(openssl rand -hex 32)` on any non-loopback network (`GET` playback/Stremio/M3U routes stay open; `POST`/`PUT`/`DELETE` `/v1/*` and `/v1/settings` require `Authorization: Bearer <token>`). Keep `PEARTUBE_STORAGE` at mode `0700` and env files at `0600`.
   - Leave `PEARTUBE_TRACKER` unset to found a new catalog, or pass an existing `PEARTUBE_TRACKER`/`PEARTUBE_SOURCES` (add `PEARTUBE_REPLICATE=1` to mirror and seed remote blobs).
3. **Install and detach as a persistent service.**

   **Docker / Podman** (`linux/amd64` + `linux/arm64`). Use `--network host` on a Linux LAN host so mDNS and ephemeral LAN UDP reach the network; use the port form on a WAN VPS or macOS Docker Desktop:

   ```sh
   mkdir -p /srv/peartube-data && chmod 700 /srv/peartube-data
   API_TOKEN=$(openssl rand -hex 32)
   docker run -d --name peartube-relay --restart unless-stopped \
     --network host \
     -e PEARTUBE_STREAM_HOST=<lan-or-public-ip> \
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
   PEARTUBE_STREAM_HOST=<lan-or-public-ip>
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
       <key>PEARTUBE_STREAM_HOST</key><string><lan-ipv4></string>
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

4. **Verify and report.** Poll `curl -fsS http://127.0.0.1:8174/v1/status` until `tracker` and
   `channel` are 64-character hex keys, and confirm `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8174/manifest.json`
   prints `200` (a GET: the relay answers `HEAD` only on blob routes). Return the Web UI (`http://<host>:8174/`), Smart TV page (`/tv`), Stremio
   addon (`/manifest.json`), M3U playlist (`/v1/playlist.m3u`), public channel URI
   (`peartube://channel/<status.channel>`), tracker key, and where `PEARTUBE_API_TOKEN` is stored.

Every variable except `PEARTUBE_STORAGE`, `PEARTUBE_API_HOST`, `PEARTUBE_API_PORT`,
`PEARTUBE_API_TOKEN`, `PEARTUBE_SOURCES`, `PEARTUBE_PLUGINS_DIR` and the `PEARTUBE_PRIVATE_RELAY*`
guard mode is also a setting in the web UI. An env var is that setting's starting value; a change
saved in the UI overrides it until you put the env value back.

## Run from source

Node 22 or newer (22.21+/24.9+ for `worklet/bare-kit.sh`), plus `git`.

```sh
npm install
npm start                     # founds a tracker, serves http://127.0.0.1:8174/
npm test                      # core and network tests on a local HyperDHT testnet
npm run test:cast             # Cast & TV receiver E2E (writes desktop/target/e2e/cast-result.json)
node test/ui.e2e.js           # web UI E2E in headless Brave
npm run receiver              # portable TV receiver daemon (--thin, --player web|mpv|vlc|headless)
```

The apps need Rust and more; the commands that build them are under
[Testing](#testing) and in `AGENTS.md`.

## Settings and environment

Settings are saved in `settings.json` (`0600`) in the data directory and are never part of the
Corestore. On the Settings tab nothing changes until you press a card's **Save changes**: text
fields, switches, list entries and the button that goes back to an env value all wait for it, and
saving one card keeps the unsaved edits in the others. A saved change applies in the running
relay: most in place (**Applies on save**), and those that shape the node (addresses, ports,
tracker, bootstrap, private routing, HiveRelays, channel publishing) by reopening the node, jobs,
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
addresses may change settings, while public clients get `403`. Its founded tracker key is
remembered as the **Join a tracker** setting on first start, so following a channel cannot
silently replace the relay's own library.

| Variable | Default | Meaning |
|---|---|---|
| `PEARTUBE_TRACKER` | none (found new) | Tracker key to join |
| `PEARTUBE_STORAGE` | `./peartube-data` | Data directory |
| `PEARTUBE_API_HOST` | `0.0.0.0` | Interface bound by the UI and `/v1` API server |
| `PEARTUBE_API_PORT` | `8174` | UI, `/v1` API, Stremio addon, M3U and `/tv` port |
| `PEARTUBE_STREAM_HOST` | `127.0.0.1` | Host put in stream URLs; set a LAN or reachable address to serve other machines |
| `PEARTUBE_STREAM_PORT` | `8175` | Port players stream video from |
| `PEARTUBE_DHT_PORT` | random | Fixed UDP port, only needed when forwarding a port behind a double-randomized NAT |
| `PEARTUBE_BOOTSTRAP` | mainnet | Peer-discovery network; comma-separated `host:port` servers |
| `PEARTUBE_PRIVATE_ROUTING` | off | `1`: two-hop encrypted guard circuits on stock HyperDHT; endpoint addresses and tracker keys are never announced publicly |
| `PEARTUBE_PRIVATE_RELAY` | off | `1`: standalone Corestore-free guard forwarder (`bin/private-relay.js`); cannot combine with tracker or content flags |
| `PEARTUBE_PRIVATE_RELAY_PORT` | `PEARTUBE_DHT_PORT` | UDP port for the standalone guard forwarder |
| `PEARTUBE_PRIVATE_GUARD` | off | `1`: also run a guard forwarder beside this relay so others can route privately; the relay's own connections stay direct |
| `PEARTUBE_PRIVATE_GUARD_PORT` | random | UDP port for that guard; must differ from `PEARTUBE_DHT_PORT` |
| `PEARTUBE_RELAY_THROUGH` | none | Comma-separated blind relay keys |
| `PEARTUBE_LAN_HOST` | off | This machine's LAN IPv4; turns on mDNS discovery |
| `PEARTUBE_SOURCES` | none | Extra channel/tracker keys or `peartube://` URIs to follow |
| `PEARTUBE_PUBLISH_CHANNEL` | `1` on relays | List this relay's saved videos in its own channel without duplicating media (`0` disables) |
| `PEARTUBE_DIRECTORY` | off | `1`: publish a list of subscribed channels and trackers so peers can discover them. Turning it off unlists the ones it listed (kept in private `directory.json`); sources added with **Add to directory** stay |
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
`PEARTUBE_PRIVATE_RELAY=1` with no tracker/content flags, or turn on **Help others route privately**
on any relay), which open zero disk state and are auto-discovered on each boot. Endpoints never
announce IPs or tracker keys, disable LAN mDNS, and fail closed with fewer than two diverse guards.

A relay's guard is `bin/private-relay.js` started as a child process, so it never shares the
relay's Corestore process. It uses its own HyperDHT node, port and fresh key on every start, and
exits with the relay. The relay keeps its direct and LAN connections; turning on **Private
routing** instead moves the relay's own traffic onto guards and drops them.

## Web UI and API

One port serves the UI at `/`, the `/v1` API, the Stremio addon, the M3U playlist and `/tv`.
Without `PEARTUBE_API_TOKEN` there is no auth, so run an open relay only on a network you trust:
anyone who can reach it can queue a download of any URL.

The UI has five tabs: **Library** (add and play), **Channels** (your tracker and the ones you
follow), **Sharing** (peers, kept copies, HiveRelays, Stremio and M3U addresses), **TV** (pair
and control) and **Settings**. Plugins appear only as user intents.

| Route | Does |
|---|---|
| `GET /` | Web UI |
| `GET/PUT /v1/settings` | Settings with each one's `value`, `source` (`file`, `env` or `default`), `env`, `envSet`, `live` flag and `restartNeeded`. `PUT` applies before it answers; `null` puts a value back to its env var or default; secrets inside URLs never return |
| `POST /v1/restart` | Reopens the node, jobs, plugins and cast stack in the running process; same auth and origin rules as settings |
| `POST /v1/identify` `{url}` | Link contents: parsed name, Cinemeta `candidates` and `match`, or a plain `clip:` fallback |
| `GET /v1/search?id=imdb:tt…`, `GET /v1/entries` | Tracker entries with `streamUrl`; one result per file (`id` + `sha256`), picking a copy that plays |
| `POST /v1/acquire` `{id, title, source}` | Fetch, store and announce; `page: true` resolves a page through `yt-dlp` on every attempt |
| `GET/DELETE /v1/jobs[/:id]` | Acquire jobs; sources are never returned. `DELETE` cancels or removes |
| `GET /v1/status` | Keys, stored bytes, peers and per-transport traffic, `lan`, `privateRouting`, `privateGuard` (`publicKey`, `port`, circuit counts, or `null`), `tokenRequired`, `settingsOpen` |
| `GET/POST /v1/sources`, `DELETE /v1/sources/:key` | Follow or remove a tracker or channel |
| `POST /v1/open`, `GET /v1/resolve` | Open a `peartube://` channel, tracker, receiver pairing or `peartube://watch/…` link |
| `POST /v1/cache/clear`, `GET /v1/events` | Clear cached pieces; live SSE updates |
| `GET /manifest.json`, `/catalog/…`, `/stream/…` | Stremio v3 addon |
| `GET /v1/playlist.m3u`, `GET /tv` | M3U8 playlist; fullscreen TV page for a browser |
| `GET /v1/plugins`, `POST /v1/plugins/:name/run`, `POST /v1/mirror` | Import and seeder plugins (`http-acquire`, `channel-backfill`, `blob-rechunk`, `watch-dir`, `feed-mirror`, `p2p-replicate`, `hiverelay-seed`, plus `/data/plugins/*.mjs`) |
| `/v1/cast/*` | Pair, play, attach, control and stop TVs; start or manage a local receiver |

Job states: `queued` → `running` (`bytes` of `total`) → `announcing` → `done`, or `failed`/`cancelled`.
A job is `done` only once its announce is on disk.

## Trackers and Channels

| | Shared Tracker (`peartube://tracker/<key>`) | Personal Channel (`peartube://channel/<key>`) |
|---|---|---|
| Who publishes | Anyone with the key | Only the owner; share `status.channel`, not the publishing secret |
| Unwanted listings | Contributors can add their own, not edit others'; no moderation yet | Subscribers follow read-only |
| Publisher offline | Other peers keep serving the catalog and their pieces | Subscribers keep serving the catalog and their pieces |
| Typical use | A catalog shared across trusted relays | Your library, or a directory linking other catalogs (`PEARTUBE_DIRECTORY=1`) |

Your node always creates its own channel (`sources.json` / `PEARTUBE_SOURCES`); relays with
`PEARTUBE_PUBLISH_CHANNEL=1` also list their imports there without duplicating stored media.
Viewers opening the same video through different catalogs join the same peer pool
(`peartube/blob/v1/<key>`) and exchange pieces directly.

## Cast and TV receivers

Senders stay libraries and players; only the dedicated TV clients receive a cast.

1. **Android TV receiver APK** (`android/tv/`, `com.peartube.receiver`): Leanback launcher, a
   10-foot QR idle screen and native playback through `libpeartube.so` (MKV, AVI, MP4, HEVC,
   XviD, FLAC, TrueHD, ASS, PGS) with full D-pad and media-remote controls synced to the sender.
2. **Desktop receiver** (`PearTubeReceiver`): the same idea on a Mac or HTPC, with seek,
   play/pause, ±10 s, audio/subtitle menus, fullscreen and stop.
3. **Smart TV page** (`/tv`): zero install for LG webOS, Samsung Tizen, consoles and TV
   browsers, with D-pad and pointer controls.
4. **Portable receiver daemon** (`bin/receiver.js`, `npm run receiver`): Hybrid P2P+HTTP or
   `--thin`, with `--player web|mpv|vlc|headless|cmd:…`.

Pairing is a 6-character code on mDNS (`_peartube-cast._tcp`) or a
`peartube://receiver/<pubkey>?token=…` link over HyperDHT Noise. Once a cast starts, a P2P
receiver keeps playing and seeding after the initiator disconnects. Private senders get a
strict fail-closed 2-hop `privateRouting` receiver instead.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data:
the tracker and the blobs. `jobs.json` keeps source URLs and headers; `settings.json` keeps
feed URLs, HiveRelay keys and tokens. Neither is replicated. A page thumbnail is shown only
while you confirm the add and is never announced; an identified entry carries only its
`imdb:…` id and title.

## Client apps

The released clients are a Kotlin app for Android (`android/`) and a GPUI app for macOS
(`desktop/`); an iOS development target lives in `ios/` and is not a published release. Each
runs `src/index.js` in a Bare worklet through `bare-kit` and plays through the Rust player in
[peartube-media](https://github.com/ayooooo123/peartube-media): hardware decoders (MediaCodec,
VideoToolbox) where supported, software otherwise, drawn into a native view under overlay
controls.

Apps connect to peers directly rather than routing everything through a relay: they follow
catalogs, open `peartube://` links, cast, fetch the pieces playback needs, and seed cached
pieces while online. They never run the HTTP acquirer, and cached data can be cleared in the
app without removing subscriptions. On first launch, enter a relay's tracker key (`/v1/status`
shows it); LAN discovery is on by default on fresh installs and follows the device's address.

On the Mac, Space plays and pauses, ← and → skip 10 s, F toggles fullscreen and Esc leaves it.
A click on the picture plays or pauses; a double click toggles fullscreen.

MIDI playback needs your own SoundFont 2 (`.sf2`, up to 256 MiB), copied into private storage;
no bank is bundled. Subtitles use platform fonts and fonts attached to the media.

## Known limitations

- **Trackers have no moderation.** Anyone with a tracker key can add duplicate or unwanted
  listings. Share `peartube://channel/…` links publicly and keep tracker keys to trusted relays.
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
| `src/index.js` | `createNode`: Corestore, Autobee tracker, per-video Hypercores, Hyperswarm, `search`/`put`/`append`/`publish`/`remove`, `setLan`, LAN discovery |
| `src/http.js`, `src/ui.js` | The one-port server and the relay web UI |
| `src/acquire.js`, `src/settings.js`, `src/identify.js` | Private job queue, settings store, link identification and Cinemeta matching |
| `src/lan.js`, `src/cast.js`, `src/cast-ui.js` | LAN discovery, Cast & TV receiver stack, TV web page |
| `src/mirror.js`, `src/hiverelay.js` | Plugin host and HiveRelay recruitment/seeding |
| `src/private-overlay.js`, `bin/private-relay.js` | Stateless 2-hop guard overlay and guard forwarders |
| `bin/relay.js`, `bin/receiver.js` | Relay daemon and portable TV receiver daemon |
| `worklet/` | The worklet the apps run (`worker.js`), its crypto and the QuickJS bare-kit build |
| `desktop/`, `android/`, `android/tv/`, `ios/` | The Mac app, the phone app, the TV receiver, the iOS development target |
| `web/` | The WebAssembly player (`sh web/build.sh` → `web/assets/`, not part of the core line budget) |
| `test/` | Network, LAN, Cast, HiveRelay, per-video blob, UI and desktop E2E suites |

## Testing

The suite prefers E2E and writes repeatable artifacts under `desktop/target/e2e/`.

```sh
npm test                         # core + network + cast tests on a local testnet
npm run test:desktop             # Mac worklet E2E: exact bytes, live publish/remove, LAN-only run
npm run test:cast                # thin receiver, HTTP→P2P failover, cross-subnet Noise casting
node test/ui.e2e.js              # web UI in headless Brave at 1440×900 and 390×844, light/dark
node android/e2e.mjs --serial <adb serial> --relay http://<relay>:8174 [--lan]
```

Builds:

```sh
sh worklet/bare-kit.sh           # once: bare-kit on QuickJS (Android if the NDK exists, macOS on a Mac)
sh android/release.sh            # signed arm64 phone APK
sh android/release-tv.sh         # signed arm64 TV receiver APK
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
