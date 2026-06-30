# Development Status

Status as of 2026-06-26: pre-alpha, active development.

## Platform Status

| Platform / surface | Status | Primary command | CI coverage |
| --- | --- | --- | --- |
| iOS | Active development | `npm run ios` | iOS simulator build in `build-mobile.yml` |
| Android | Active development | `npm run android` | debug/release APK/AAB builds in `build-mobile.yml` |
| Electrobun desktop | Main desktop shell | `npm run desktop` | build, bundle smoke, and artifact upload in `build-desktop.yml` |
| Relay CLI/container | Active relay/archive surface | `docker compose -f docker-compose.relay.yml up -d` | relay build/release workflows |

## Current Architecture Progress

- Universal backend boundary is in place through `@peartube/host`, `@peartube/protocol`, `@peartube/platform`, and `@peartube/backend`.
- Protocol version is centralized in `packages/host/src/contracts.js` and currently validated by the protocol client.
- Shared HRPC handlers are centralized in `packages/backend/src/hrpc-handlers.js` and registered by `packages/backend/src/backend-entry.js`.
- Schema generation produces JS HRPC/schema output via `npm run schema:full`.
- Electrobun desktop is off the old `pear run` path and uses embedded `pear-runtime`.
- Relay support includes CLI tests, standalone builds, Docker artifacts, archive UI, YouTube archive support, and local mirror support.

## Backend Capability Progress

The shared backend includes current work for:

- identities, channel metadata, and multi-device pairing;
- public feed discovery with structured swarm diagnostics;
- PublicBee fast-path reads for discovered channels;
- uploads, download intents, seeding, pinning, storage quotas, and cache clearing;
- playback URL preparation, blob playback, transcode settings, cast compatibility, and Chromecast sender support;
- comments, moderation actions, reactions, playlists, watch history, resume positions, and personal settings;
- search, semantic/vector indexing, recommendations, and livestream start/stop/playback status;
- relay/offload assessment and relay seeding workflows.

## Reproducibility Status

- Fresh-clone setup is documented in [QUICKSTART.md](./QUICKSTART.md) and [SETUP.md](./SETUP.md).
- CI uses `npm run install:all` and validates the expected `packages/bare-ffmpeg` submodule.
- The root lockfile remains ignored/local; `packages/app/package-lock.json` is tracked. Fully locked monorepo installs are still a policy decision, not a current guarantee.
- Generated JS schema output under `packages/spec/spec/` is tracked.

## Known Constraints

- Pear OTA desktop release flow is not wired. Use the Electrobun desktop release artifact workflows, and see `docs/pear-runtime-evolution-readiness.md` before adding OTA automation.
- P2P peer visibility depends on DHT/bootstrap reachability, NAT/firewall behavior, active feed peers, and whether feed entries include enough PublicBee/blob references for fast viewer reads.
- Some historical roadmap and handoff docs still contain old path examples. Prefer README, QUICKSTART, SETUP, DEVELOPMENT, DEV_STATUS, and ARCHITECTURE for current commands.

## Before Handoff

Use the smallest relevant verification set, then broaden for cross-package changes:

```bash
npm run lint:changed
npm run typecheck
npm test
npm run desktop:smoke --prefix packages/app
```

Last updated: 2026-06-26.
