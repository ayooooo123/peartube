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

PearTube is pre-alpha, decentralized, and moves fast. Before you run it — especially a relay or a long-lived peer — here is an honest picture of what that means today. This is not legal advice, and it is not meant to scare you off; it is the context you need to make an informed decision.

### What running a peer or relay actually does

- **You re-host content you did not create.** The Hypercore stack is peer-to-peer. When your client or relay fetches, caches, or seeds a video, it stores those blobs locally and serves them to other peers. A relay run as a blind peer (`packages/backend/src/relay-blind-peer.js`) will mirror channel cores it is asked to mirror. In practice, running a peer means your machine can hold and redistribute media that other people published.
- **Discovery is a single shared public topic.** Channels are announced via gossip on one public feed topic. There is currently no per-topic opt-in, no allow-list of what your node discovers, and no built-in way to subscribe only to a vetted subset of the network.
- **There is no content-level moderation today.** The backend has *per-user comment actions* (hide/block at the UI level), but it has **no network-level moderation**: no takedown mechanism, no publisher blocklist, no content filtering, no scanning, and no way to purge something from the network once it has replicated. If objectionable or illegal material is published to the public feed, a peer or relay that discovers it may fetch and re-serve it before any human sees it.
- **You are responsible for what your node stores and serves.** Depending on your jurisdiction, hosting and redistributing third-party content can carry legal and reputational exposure. Run a public relay only if you understand and accept that. If you want tighter control, prefer `docker-compose.local-relay.yml` to mirror a local directory you own rather than seeding the open network.
- **Storage, bandwidth, and privacy.** A seeding node consumes disk and upload bandwidth, and P2P networking exposes your node's presence (e.g. IP address) to other peers as an inherent property of the protocol.

### Moderation plans

Moderation is a known gap, not an oversight. The current priority is stabilizing the protocol and backend contract. Once the protocol is stable, we intend to introduce moderation capabilities — for example publisher/content blocklists, relay-operator controls over what a node discovers and mirrors, and reporting flows. These are **planned, not implemented**, and the design is expected to change. Do not assume any moderation guarantees exist today.

### Rapid development & LLM usage

- **Pre-alpha, breaking changes expected.** APIs, schema (`packages/spec`), storage formats, and on-disk data can change without migration paths. Treat any data you publish or store as disposable.
- **Heavily LLM-assisted.** A large share of this codebase — including code, tests, and docs — was written with substantial help from large language models, and development continues that way. That enables fast iteration but also means code may carry subtle bugs, uneven review depth, and areas that have not been battle-tested. Review the code yourself before relying on it for anything that matters.
- **Not audited.** There has been no formal security or privacy audit. Do not use PearTube for sensitive content or in a threat model where compromise would be costly.

For current progress and known constraints, see [DEV_STATUS.md](./DEV_STATUS.md).

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
