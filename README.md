# PearTube

PearTube is a pre-alpha decentralized video platform built on the Hypercore stack. It runs mobile, Electrobun desktop, and relay surfaces against one shared backend contract instead of maintaining separate platform backends.

## Current State

| Surface | Status | Primary command |
| --- | --- | --- |
| iOS | Active development, Expo + BareKit | `npm run ios` |
| Android | Active development, Expo + BareKit | `npm run android` |
| Electrobun desktop | Main desktop shell, Expo web export + embedded `pear-runtime` worker | `npm run desktop` |
| Relay | CLI/container for discovery, seeding, archive UI, and local mirror workflows | `docker compose -f docker-compose.relay.yml up -d` |

Pear OTA desktop release automation is not wired yet. Use the Electrobun build/release workflows in this repo; do not reintroduce `pear run` or claim OTA support without a dedicated release-flow change.

## Risks & Transparency

PearTube is pre-alpha, decentralized, and moves fast. Here's an honest picture of what running it means today. Not legal advice.

### Running a mobile or desktop peer

The apps are full P2P peers — viewers become seeders.

- **Watching re-serves content.** `autoSeedWatched` is on by default (`packages/backend/src/seeding.js`), so playing a video caches its blocks and serves them to other peers while you're connected — including content you haven't vetted. Capped by a 5&nbsp;GB quota; seeding subscribed channels is opt-in. Adjust or disable via seeding settings (`setSeedingConfig`) and clear the cache anytime.
- **Your IP is visible to peers.** Normal peers connect directly over Hyperswarm with no relay or proxy in front. Factor that into your threat model.
- **Mobile costs.** P2P upload/download uses cellular data and battery, and can continue in the background.

### Running a relay

A relay does the above at larger scale, plus:

- **It mirrors channels it doesn't own.** A relay runs as a Holepunch *blind peer* (`packages/backend/src/relay-blind-peer.js`), downloading and re-serving the channel cores it mirrors. "Blind" is a protocol-layer term (it replicates raw blocks) — it does **not** mean the content is hidden from you; public-feed videos stay viewable by any peer, operator included.
- **Blind peers can also mirror encrypted cores** — serving ciphertext the operator has no key to read. PearTube doesn't use this for the public feed today, but may later for private/encrypted channels, giving operators a genuine "can't see it" position. Future direction, not a current property.
- **You're responsible for what you host.** Redistributing third-party content can carry legal exposure depending on jurisdiction. For tighter control, use `docker-compose.local-relay.yml` to mirror a local directory you own instead of seeding the open network.

### No moderation yet

Discovery runs over a single public gossip topic with no allow-list. There are per-user comment actions, but **no network-level moderation**: no takedowns, blocklists, filtering, or way to purge content once replicated. A peer or relay can fetch and re-serve objectionable material before anyone reviews it.

Moderation is a known gap. Once the protocol stabilizes we intend to add blocklists, relay-operator controls over what a node mirrors, and reporting flows — planned, not implemented, and subject to change.

### Rapid development & LLM usage

- **Pre-alpha.** APIs, schema, and on-disk formats can change without migration. Treat published/stored data as disposable.
- **Heavily LLM-assisted.** Much of the code, tests, and docs were written with LLMs. Fast iteration, but expect subtle bugs and uneven review depth — read the code before relying on it.
- **Not audited.** No formal security or privacy review. Don't use it for sensitive content.

For current progress and constraints, see [DEV_STATUS.md](./DEV_STATUS.md).

## Architecture

Every client boots or connects to the same backend contract:

```text
Client shell
  -> platform runner
  -> @peartube/host
  -> @peartube/backend
  -> Corestore / Autobase / Hyperbee / Hyperblobs / Hyperswarm
```

| Client | UI shell | Backend runner | RPC |
| --- | --- | --- | --- |
| iOS / Android | Expo + React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun desktop | Expo web export | embedded `pear-runtime` worker | HRPC over worker pipe |
| Relay | CLI / container | direct backend runtime | local process API |

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/app` | Expo app, mobile routes, Electrobun export, mobile BareKit backend bundle, desktop worker bundle |
| `packages/core` | Shared app components, hooks, stores, and types |
| `packages/platform` | App-side runner selection and RPC facade |
| `packages/host` | Backend lifecycle wrapper, host errors, shared `PROTOCOL_VERSION`, and the universal protocol client (readiness normalization, event map, grouped namespaces) |
| `packages/backend` | P2P storage, discovery, feed, upload, playback, comments, reactions, search, recommendations, livestream, cast, and diagnostics |
| `packages/spec` | HRPC schema source and JS code generation |
| `packages/cli` | Relay CLI, standalone build, Docker image, archive UI, and local mirror support |
| `packages/bare-*` | Vendored/native Bare runtime support, including `bare-ffmpeg` |

## Prerequisites

- Node.js from `.nvmrc` (`20.18.0`) or another supported version from `package.json` (`>=18 <23`).
- Git submodules, currently `packages/bare-ffmpeg`.
- iOS: Xcode, CocoaPods, and the iOS simulator/toolchain.
- Android: Android Studio, Android SDK, and JDK 17.
- Electrobun desktop: Bun and the Electrobun toolchain.
- Relay/container workflows: Docker with Compose.

## Fresh Clone

```bash
git clone <repo-url>
cd peartube
nvm use
git submodule update --init --recursive
npm run install:all
npm run schema:full
npm run bundle:backend
```

`npm run install:all` is the repository install contract and is what CI uses. The repo currently uses plain npm installs across packages; the root `package-lock.json` is local/ignored, while `packages/app/package-lock.json` is tracked. Treat fully locked dependency installs as a separate policy decision.

## Run Locally

```bash
npm start                  # Expo dev server
npm run ios                # iOS simulator
npm run android            # Android emulator/device
npm run desktop            # Build and launch Electrobun desktop
npm run desktop:build      # Build Electrobun web/worker assets only
npm run desktop:start      # Launch the built Electrobun app
```

## Relay

Run the packaged relay container:

```bash
docker compose -f docker-compose.relay.yml up -d
docker compose -f docker-compose.relay.yml exec relay /peartube-relay status --json
```

The default compose file exposes the archive UI at `http://127.0.0.1:8174` and persists relay storage in the `peartube-relay-data` volume.

Archive a video from the container:

```bash
docker compose -f docker-compose.relay.yml exec relay \
  /peartube-relay archive --url https://youtu.be/... --channel-name "Anonymous Archive" --run-now
```

Use `docker-compose.local-relay.yml` when you want the relay to mirror a local host directory into PearTube.

## Generated Code

`packages/spec/schema.cjs` is the HRPC schema source of truth. After changing the schema, run:

```bash
npm run schema:full
npm test --prefix packages/spec
```

`schema:full` regenerates JS schema/HRPC output. Generated app-facing metadata lives at `packages/spec/spec/hrpc/app-rpc-adapter.mjs`.

## Verification

Use the narrowest command that covers the change:

```bash
npm run typecheck
npm test
npm run lint:changed
npm test --prefix packages/backend
npm test --prefix packages/host
npm test --prefix packages/spec
npm run desktop:build
npm run desktop:smoke --prefix packages/app
```

CI has separate workflows for fast tests, Android/mobile builds, Electrobun desktop, relay builds, and release artifacts.

## Development Docs

- [QUICKSTART.md](./QUICKSTART.md) - shortest fresh-clone runbook.
- [SETUP.md](./SETUP.md) - platform-specific setup and troubleshooting.
- [DEVELOPMENT.md](./DEVELOPMENT.md) - daily commands and generated-artifact workflow.
- [DEV_STATUS.md](./DEV_STATUS.md) - current progress, CI coverage, and known constraints.
- [ARCHITECTURE.md](./ARCHITECTURE.md) - live architecture overview.
- [docs/pear-runtime-evolution-readiness.md](./docs/pear-runtime-evolution-readiness.md) - desktop runtime/OTA boundary.

## Storage

Clients resolve storage paths through `@peartube/platform` and the active runner.

## License

Apache-2.0
