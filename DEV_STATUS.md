# Development Status

Status as of 2026-08-26: pre-alpha, active development.

## Platform Status

| Platform / surface | Status | Primary command | CI coverage |
| --- | --- | --- | --- |
| iOS | Active development | `npm run ios` | iOS simulator build in `build-mobile.yml` |
| Android | Active development | `npm run android` | debug/release APK/AAB builds in `build-mobile.yml` |
| Electrobun desktop | Main desktop shell | `npm run desktop` | build, bundle smoke, and artifact upload in `build-desktop.yml` |
| Relay CLI/container | Active relay/archive surface | `docker compose -f docker-compose.relay.yml up -d` | relay build/release workflows |

## Current Architecture Progress

- Universal backend boundary is in place through `@peartube/host`, `@peartube/platform`, and `@peartube/backend`.
- Protocol version is centralized in `packages/host/src/contracts.js` and currently validated by the protocol client.
- Shared HRPC handlers are centralized in `packages/backend/src/hrpc-handlers.js` and registered by `packages/backend/src/backend-entry.js`.
- Schema generation produces JS HRPC/schema output via `npm run schema:full`.
- Electrobun desktop is off the old `pear run` path and uses embedded `pear-runtime`.
- Relay support includes the authenticated machine API, bounded ingest jobs, archive UI, local mirror workflows, local catalog indexing, and S3-compatible block offload.

## Current Product Direction

- Consumer-first Home, Search/Discover, Library, and playback surfaces; publishing and network controls stay behind Developer Settings or the relay CLI.
- Permissionless signed catalogs with local moderation, bounded index federation, and provenance-preserving source selection.
- Strict P2P immutable-rendition playback with structured availability errors and no HTTP origin fallback.
- Client applications perform their own ranking and private acquisition. PearTube verifies, publishes, transfers, retains, and archives selected media.
- Relays are voluntary peers, not trusted infrastructure. S3 is an operator-selected block tier, not a media authority or public origin.

## Backend Capability Progress

The shared backend includes:

- publisher roots, admitted device writers, namespace rotation, signed catalogs, and immutable publication manifests;
- local and federated index services, exact TMDB movie/episode selectors, candidate verification, and source provenance;
- purpose-scoped bootstrap, publisher, index, asset, archive, and archive-discovery networking;
- static rendition cores, exact-range transfer, multi-peer playback, availability evidence, seeding, and retention;
- watch-only, balanced, and archive-enabled participation policy with device/network/storage budgets;
- archive pledges, possession challenges, S3 block offload, restore-on-read, and relay reseeding;
- authenticated machine search, deferred open, ingest jobs, and route-scoped streams;
- local encrypted personal state, optional device pairing, moderation, library, watch history, and recommendations without viewer analytics.

## Reproducibility Status

- Fresh-clone setup is documented in [QUICKSTART.md](./QUICKSTART.md) and [SETUP.md](./SETUP.md).
- CI uses `npm run install:all` and validates the expected `packages/bare-ffmpeg` submodule.
- The root lockfile remains ignored/local; `packages/app/package-lock.json` is tracked. Fully locked monorepo installs are still a policy decision, not a current guarantee.
- Generated JS schema output under `packages/spec/spec/` is tracked.

## Known Constraints

- Pear OTA desktop release flow is not wired. Use the Electrobun desktop release artifact workflows, and see `docs/pear-runtime-evolution-readiness.md` before adding OTA automation.
- Network catalog visibility does not prove current media reachability. Availability requires fresh verified range evidence; archival durability is reported separately.
- Historical plans and handoffs describe the path to the current design and can contain superseded file names or incomplete checklists. README, QUICKSTART, SETUP, DEVELOPMENT, DEV_STATUS, and ARCHITECTURE are the current contract.

## Before Handoff

Use the smallest relevant verification set, then broaden for cross-package changes:

```bash
npm run lint:changed
npm run typecheck
npm test
npm run desktop:smoke --prefix packages/app
```

Last updated: 2026-08-26.
