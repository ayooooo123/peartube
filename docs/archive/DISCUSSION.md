# Task: Group current working tree into strategic local commits

## Goal
Analyze the current working tree and create a clean series of local commits grouped by relevant workstreams.

## User request
- App is in a good working state
- Analyze all changes
- Start strategic commits/tracking of all changes
- Notify user of oddities/confusing changes

## Current rough workstreams visible in git status/diff
1. Feed protocol extension / feed hydration / preparePlayback / spec/schema updates
2. Android PiP + media-session + PlayerActivity / host bridge changes
3. Desktop-native bridge / app / tests / extension-related changes
4. Misc app/frontend polish around tabs/search/video card/player integration
5. Potential generated/unwanted artifacts (fonts, .artifacts, DISCUSSION.md, maestro files, templates)

## Need from review
- propose logical commit buckets
- flag odd/unexpected files that may not belong
- identify generated files that should probably stay out of git
- suggest safe commit order

## Constraint
Do not use git checkout/restore destructively on valuable user work. Only exclude obviously generated artifacts where appropriate.

## Discussion

## Codex Proposal

### Recommended Commit Buckets
1. `contracts / schema / protocol`
   - `packages/spec/schema.cjs`
   - `packages/protocol/*`
   - `packages/platform/src/rpc.*` and `packages/platform/src/runner.*`
   - Keep this bucket focused on API shape and generated contract output.

2. `backend feed / public-channel / consumer shaping`
   - `packages/backend/src/*`
   - `packages/backend/test/*`
   - `packages/app/backend/*`
   - `packages/app/lib/feed-hydration.js`
   - `packages/core/src/hooks/useP2PVideo.ts`
   - `packages/core/src/types/index.ts`
   - `packages/core/src/utils/index.ts`
   - This is the main cross-package data model change.

3. `desktop bridge / host / extension`
   - `packages/host/*`
   - `packages/desktop-native/*`
   - `packages/app/pear-src/*`
   - `packages/app/pear-src/scripts/inject-pear-bar.js`
   - `packages/app/scripts/ensure-backend-bundles.js`
   - Treat the Xcode/project bridge outputs as one unit with their source config.

4. `Android PiP / media-session / player activity`
   - `packages/app/android/*`
   - `packages/app/modules/expo-media-session/*`
   - `packages/app/plugins/withAndroidPiP.js`
   - `packages/app/plugins/withMainActivityPiPCallback.js`
   - `packages/app/components/video-player/PearInlineVideoView.tsx`
   - `packages/app/tests/mobile-inline-player-integration.test.mjs`
   - `packages/app/scripts/maestro-android-pip-repro.sh`
   - `packages/app/maestro/*`

5. `app UI / playback polish`
   - `packages/app/app/*`
   - `packages/app/components/VideoPlayerOverlayImpl.tsx`
   - `packages/app/components/video/VideoCard.tsx`
   - `packages/app/lib/VideoPlayerContext.tsx`
   - `packages/app/lib/playerStateMachine.ts`
   - `packages/app/tests/feed-hydration.test.mjs`
   - `packages/app/tests/pear-desktop-bootstrap-regression.test.mjs`

6. `generated / validation artifacts`
   - `packages/spec/spec/*`
   - `packages/desktop-native/PearTubeDesktop.xcodeproj/*`
   - `packages/app/packages/app/pear/workers/core/index.ts`
   - `packages/app/android/app/src/main/assets/fonts/*`
   - `packages/app/.artifacts/*`
   - `docs/superpowers/plans/2026-04-02-android-pip-stability-reset.md`
   - Only keep these if they are intentionally versioned outputs.

### Oddities / Confusing Files
- `packages/app/packages/app/pear/workers/core/index.ts` is a nested duplicate path and looks like build output or a mirrored worker tree rather than a normal source file.
- `packages/app/android/app/src/main/assets/.gitignore` was deleted while `packages/app/android/app/src/main/assets/fonts/` appeared untracked; that strongly suggests vendored asset output rather than hand-authored product code.
- `packages/app/.artifacts/` contains captured logs/screenshots from PiP repro runs and should stay out of product commits.
- `packages/app/DISCUSSION.md` and `docs/superpowers/plans/2026-04-02-android-pip-stability-reset.md` are note/plan artifacts, not runtime changes.
- `packages/app/maestro/` and `packages/app/scripts/maestro-android-pip-repro.sh` are test harnesses; commit them only if you want the repro flow preserved.
- `packages/desktop-native/project.yml` and `packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj` should move together because one is the source of truth and the other is generated project state.

### Safe Commit Order
1. Land the contract layer first: `spec`, `protocol`, and `platform` shims.
2. Land backend/feed plumbing next: `packages/backend`, `packages/app/backend`, and the shared `core` consumers.
3. Land desktop bridge/host changes after the backend contract is stable.
4. Land Android PiP/media-session changes after the host and backend shapes are stable.
5. Land app UI/player polish last, once the data and playback plumbing is settled.
6. Commit generated artifacts only in a separate cleanup pass, or leave them untracked if they are just repro output.

## Hermes Review

### Recommended Commit Buckets
1. `protocol contract / preparePlayback surface`
   - `packages/spec/schema.cjs`
   - `packages/spec/spec/*`
   - `packages/protocol/src/*`
   - `packages/protocol/test/create-client.test.mjs`
   - `packages/platform/src/rpc.*`
   - `packages/platform/src/runner.*`
   - `packages/host/src/contracts.js`
   - `packages/host/src/index.d.ts`
   - Keep this commit about the new RPC shape only: `preparePlayback`, richer `getVideoUrl` args, protocol versioning, and shared bridge init behavior.

2. `backend feed snapshots / playback preparation`
   - `packages/backend/src/api.js`
   - `packages/backend/src/backend-entry.js`
   - `packages/backend/src/channel/public-channel-bee.js`
   - `packages/backend/src/hrpc-handlers.js`
   - `packages/backend/src/mobile-handlers.js`
   - `packages/backend/src/orchestrator.js`
   - `packages/backend/src/public-feed.js`
   - `packages/backend/src/types.js`
   - `packages/backend/test/*`
   - `packages/app/backend/index.mjs`
   - `packages/app/backend/mobile-handlers.mjs`
   - `packages/app/backend/mobile-handlers.test.mjs`
   - This looks like the server-side behavior change: public feed entries now carry preview metadata, playback can be prepared instead of only URL-resolved, and shared app handlers got more explicit boot control.

3. `app feed hydration / discover rendering / playback consumer updates`
   - `packages/app/lib/feed-hydration.js`
   - `packages/app/tests/feed-hydration.test.mjs`
   - `packages/core/src/hooks/useP2PVideo.ts`
   - `packages/core/src/types/index.ts`
   - `packages/core/src/utils/index.ts`
   - `packages/app/app/(tabs)/index.tsx`
   - `packages/app/app/(tabs)/index.web.tsx`
   - `packages/app/app/(tabs)/search.tsx`
   - `packages/app/app/search.tsx`
   - `packages/app/app/video/[id].tsx`
   - `packages/app/app/_layout.tsx`
   - `packages/app/components/video/VideoCard.tsx`
   - This commit can stand on top of the backend contract work: feed ordering, preview video selection, availability-based rendering, and discover/search/video-detail consumption changes.

4. `Android PiP / native playback host / media-session wiring`
   - `packages/app/android/app/build.gradle`
   - `packages/app/android/app/src/main/AndroidManifest.xml`
   - `packages/app/android/app/src/main/java/com/peartube/app/MainActivity.kt`
   - `packages/app/android/app/src/main/java/com/peartube/app/PlayerActivity.kt`
   - `packages/app/android/app/src/main/res/values/styles.xml`
   - `packages/app/modules/expo-media-session/**/*`
   - `packages/app/components/video-player/PearInlineVideoView.tsx`
   - `packages/app/components/VideoPlayerOverlayImpl.tsx`
   - `packages/app/lib/VideoPlayerContext.tsx`
   - `packages/app/lib/playerStateMachine.ts`
   - `packages/app/plugins/withAndroidPiP.js`
   - `packages/app/plugins/withMainActivityPiPCallback.js`
   - `packages/app/plugins/templates/PlayerActivity.kt.template`
   - `packages/app/tests/mobile-inline-player-integration.test.mjs`
   - This is the large native/mobile feature commit: new ExoPlayer-backed `PlayerActivity`, PiP action events, payload priming, config-plugin source generation, and JS state coordination.

5. `Android PiP repro harness / non-product notes`
   - `packages/app/package.json`
   - `packages/app/maestro/*`
   - `packages/app/scripts/maestro-android-pip-repro.sh`
   - `packages/app/DISCUSSION.md`
   - `docs/superpowers/plans/2026-04-02-android-pip-stability-reset.md`
   - Only include this if you want the reproducibility tooling and plan docs preserved in git. It should stay separate from the runtime PiP commit.

6. `desktop bridge / worker bootstrap / host-runtime integration`
   - `packages/app/pear-src/package.json`
   - `packages/app/pear-src/scripts/inject-pear-bar.js`
   - `packages/app/pear-src/workers/core/index.ts`
   - `packages/app/scripts/ensure-backend-bundles.js`
   - `packages/host/src/start-host.js`
   - `packages/host/test/mobile-entry.test.mjs`
   - `packages/host/test/start-host.test.mjs`
   - `packages/desktop-native/Bridge/*`
   - `packages/desktop-native/Sources/Support/BridgeRPCChannel.swift`
   - `packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
   - `packages/desktop-native/scripts/bare-pack-host-flags.test.mjs`
   - `packages/desktop-native/scripts/barekit-build-contract.test.mjs`
   - `packages/desktop-native/scripts/ensure-host-sidecar-bundle.mjs`
   - `packages/desktop-native/scripts/ensure-host-worklet-bundle.mjs`
   - `packages/app/tests/pear-desktop-bootstrap-regression.test.mjs`
   - This group is the desktop/bootstrap plumbing counterpart to the protocol work.

7. `desktop native app behavior + media extension lab`
   - `packages/desktop-native/project.yml`
   - `packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`
   - `packages/desktop-native/PearTubeDesktop.xcodeproj/xcshareddata/xcschemes/PearTubeMediaExtensionLab.xcscheme`
   - `packages/desktop-native/Extensions/*`
   - `packages/desktop-native/Resources/MediaExtensionLab-Info.plist`
   - `packages/desktop-native/Sources/App/AppState.swift`
   - `packages/desktop-native/Sources/Services/HostBridgeService.swift`
   - `packages/desktop-native/Sources/Support/ProfessionalVideoWorkflowExtensions.swift`
   - `packages/desktop-native/Sources/Views/ContentView.swift`
   - `packages/desktop-native/Sources/Views/VideoDetailView.swift`
   - `packages/desktop-native/Tests/BridgeRPCChannelTests.swift`
   - `packages/desktop-native/Tests/PearTubeDesktopTests.swift`
   - This is probably worth its own commit because it mixes experimental MediaExtension targets, FFmpeg decode diagnostics, native playback routing rules, and some desktop app-state regressions.

8. `exclude or quarantine generated artifacts`
   - `packages/app/.artifacts/*`
   - `packages/app/android/app/src/main/assets/fonts/*`
   - `packages/app/android/app/src/main/assets/.gitignore` deletion
   - `packages/app/packages/app/pear/workers/core/index.ts`
   - I would not mix these into feature commits until you confirm they are intentionally versioned.

### Oddities / Needs Confirmation
- The Android PiP branch currently appears to invert the earlier architecture notes: `withAndroidPiP.js` now sets `MainActivity` PiP-capable and strips PiP flags from `PlayerActivity`, while the planning doc says the opposite. That mismatch should be resolved before making the commit history look cleaner than the architecture really is.
- `packages/app/packages/app/pear/workers/core/index.ts` still looks like a duplicated/generated mirror of `packages/app/pear-src/workers/core/index.ts`, not a hand-maintained source tree.
- The deleted `packages/app/android/app/src/main/assets/.gitignore` plus newly untracked `assets/fonts/*.ttf` strongly smells like generated Expo/React Native asset output.
- `packages/app/.artifacts/maestro-pip/...` is clearly captured repro output and should stay out of normal feature commits.
- `packages/desktop-native/project.yml` and `packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj` must move together; the pbxproj is generated state, not the best review surface.
- `packages/desktop-native/Tests/PearTubeDesktopTests.swift` bundles several concerns together: media-extension diagnostics, playback routing, snapshot persistence, AVPlayer control behavior, and studio workspace regressions. If possible, split pure app-state regressions from the experimental media-extension work.
- `docs/superpowers/plans/2026-04-02-android-pip-stability-reset.md` currently documents a reset direction that does not fully match the present worktree. Good note to keep, but not as proof of current implementation.

### Safe Commit Order
1. `protocol contract / preparePlayback surface`
2. `backend feed snapshots / playback preparation`
3. `app feed hydration / discover rendering / playback consumer updates`
4. `desktop bridge / worker bootstrap / host-runtime integration`
5. `Android PiP / native playback host / media-session wiring`
6. `desktop native app behavior + media extension lab`
7. `Android PiP repro harness / non-product notes`
8. generated artifacts only if intentionally versioned; otherwise leave them out
