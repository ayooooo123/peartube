# Plan index

Audited 2026-08-21 by extracting every `packages/**` source path each plan claims to create or
modify, then testing whether those paths exist. The ratio is a proxy, not proof — a plan can score
low because paths were later renamed — but it separates design records from wishes well enough to
act on.

**Twelve plans scoring under 25% were deleted.** They described code that does not exist and never
did; two were spot-checked by hand first (`packages/backend/src/indexer/` and the pear-electron
shell are both absent entirely). They remain in git history if a design decision needs recovering.

## Kept

| Plan | Paths present | Status |
|---|---|---|
| `2026-06-11-desktop-mse-audio-transcode-fallback.md` | 0/0 | no-paths |
| `2026-03-19-native-desktop-host-skeleton.md` | 14/40 | partial |
| `2026-03-29-native-desktop-main-landing.md` | 25/73 | partial |
| `2026-03-29-single-topic-discovery-implementation.md` | 12/18 | partial |
| `2026-04-02-android-pip-stability-reset.md` | 5/14 | partial |
| `2026-04-06-electrobun-migration.md` | 4/9 | partial |
| `2026-07-22-peartube-media-cockpit-slice-1.md` | 6/11 | partial |
| `2026-07-23-peartube-media-cockpit-slice-1-autoresearch-iteration.md` | 6/11 | partial |
| `2026-07-24-stremio-consumer-vertical-slice.md` | 58/125 | partial |
| `2026-08-04-app-visual-testing-cheap-eyes.md` | 11/14 | partial |
| `2026-08-09-01-static-asset-core.md` | 3/5 | partial |
| `2026-08-09-07-index-union-verification.md` | 6/10 | partial |
| `2026-08-09-10-route-scoped-streaming.md` | 2/8 | partial |
| `2026-08-09-13-catalog-epoch-schemas.md` | 3/7 | partial |
| `2026-08-09-16-locator-anti-entropy.md` | 6/9 | partial |
| `2026-08-09-17-registration-discovery.md` | 5/12 | partial |
| `2026-08-09-18-operational-proof.md` | 4/13 | partial |
| `2026-04-23-ci-workflows-cleanup.md` | 3/3 | shipped |
| `2026-06-11-retire-libmpv-cross-platform.md` | 1/1 | shipped |
| `2026-07-17-content-persistence-publication.md` | 18/22 | shipped |
| `2026-07-17-interactive-add-cli.md` | 47/58 | shipped |
| `2026-07-17-seed-pin-durability.md` | 26/30 | shipped |
| `2026-07-17-structured-catalog-clients.md` | 25/28 | shipped |
| `2026-07-23-permissionless-media-cdn.md` | 223/273 | shipped |
| `2026-08-09-02-asset-manifest-ingestion.md` | 16/20 | shipped |
| `2026-08-09-03-multi-peer-range-playback.md` | 16/16 | shipped |
| `2026-08-09-12-consent-retention-status.md` | 7/7 | shipped |
| `2026-08-09-14-publisher-rollover.md` | 11/13 | shipped |
| `2026-08-09-distributed-archive-phase-1-roadmap.md` | 1/1 | shipped |

## Deleted

| Plan | Paths present |
|---|---|
| `2026-03-20-native-consumer-ui-phase-1.md` | 0/11 |
| `2026-03-27-native-desktop-sidecar-cleanup.md` | 1/16 |
| `2026-03-28-native-studio-channel-implementation.md` | 0/17 |
| `2026-04-05-pear-electron-migration.md` | 0/7 |
| `2026-04-05-replace-mpv-with-html5-video.md` | 1/9 |
| `2026-08-09-04-index-schema.md` | 1/10 |
| `2026-08-09-05-catalog-ingestion.md` | 0/7 |
| `2026-08-09-06-index-service-protocol.md` | 2/9 |
| `2026-08-09-08-companion-v2-api.md` | 3/13 |
| `2026-08-09-09-client-candidate-resolver.md` | 0/1 |
| `2026-08-09-11-ingest-jobs.md` | 1/6 |
| `2026-08-09-15-indexer-recovery.md` | 1/7 |

## Reading a `partial`

Partial means the plan was started and not finished, so treat it as a description of intent, not of
the code. Check the paths before trusting any claim in one.
