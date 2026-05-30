# Development Status

## Current Status: Stable (Feb 2026)

| Platform | Status | Primary Command |
|----------|--------|-----------------|
| iOS | Working | `npm run ios` |
| Android | Working | `npm run android` |
| Android APK Build | Working | `npm run build:android:apk` |
| Electrobun Desktop | Working | `npm run desktop` |

## Recent Stabilization Work

- Migrated main desktop shell away from `pear run` to Electrobun/Bun with embedded `pear-runtime`.
- Fixed desktop backend RPC initialization regressions by re-wiring shared HRPC handler registration in backend entry.
- Added capability-based shared handler registration to avoid crashes when optional HRPC methods are absent.
- Fixed mobile startup resilience: backend can start even when downloader worker bundle is unavailable.
- Hardened Android release pipeline with reliable prebuild + SDK path restoration before Gradle release builds.

## What Changed in Build/Run Flow

- Desktop: `npm run desktop` builds and launches the Electrobun app; `pear run` is deprecated upstream and should not be restored.
- Android releases: `build:android:apk` and `build:android:aab` run Android prebuild before Gradle.
- Backend bundles: `npm run bundle:backend` now generates both backend and downloader-worker bundles.

## Known Constraints

- Some `packages/platform` typecheck issues remain environment/type-definition related and predate the runtime fixes.
- Pear OTA desktop release flow is not wired yet; see `docs/pear-runtime-evolution-readiness.md` before adding `pear build`/provision/multisig release automation.
- P2P peer visibility still depends on NAT/firewall and available peers on the public feed topic.

---

**Last Updated**: 2026-02-27
