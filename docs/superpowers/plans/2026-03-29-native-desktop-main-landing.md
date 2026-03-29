# Native Desktop Main Landing Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Swift native macOS desktop app into `main` without merging the current dirty worktree as one unreviewable blob.

**Architecture:** Treat the current state as two layers: a committed baseline branch already ahead of `main`, and a large set of still-local follow-up changes. Land the committed baseline first from a clean worktree, then cut the remaining local changes into focused PRs for backend/bridge hardening, desktop runtime/playback work, and native UI/creator functionality.

**Tech Stack:** Git worktrees, SwiftUI, Foundation/AppKit, `bare` sidecar runtime, compact-encoding RPC, Xcodebuild, Node test runner

---

## Current Inventory

### Already committed ahead of `main`

`main..HEAD` currently includes committed work for:

- host/protocol package scaffolding and shared bridge contracts
- native macOS shell scaffold
- sidecar runtime stabilization
- search-first browse shell
- native browse/detail/watch playback polish
- first-run actions and host mutations
- sidecar/app handler wiring
- playback/blob field parity
- native bridge RPC serialization fix
- design/spec docs for the native host skeleton and Studio/Channel work

Representative commits:

- `77f88c1 feat: add native macos shell scaffold`
- `69484a9 feat: stabilize native desktop bare sidecar`
- `96e2068 feat: add native search-first shell`
- `4a41216 feat: polish native browse and detail panes`
- `5ee3a2c feat: add native first-run actions and host mutations`
- `81d8f93 fix: wire native sidecar to app handlers`
- `4cbebd1 fix: improve native playback and thumbnail parity`
- `194dd7a fix: serialize native bridge rpc access`

### Still local in the worktree

Current dirty state is split across these buckets:

- `packages/backend` and `packages/app/backend`: Corestore/identity/bootstrap cleanup, public-feed behavior, mobile handler alignment
- `packages/host`, `packages/protocol`, `packages/spec`: request/timeout/schema updates
- `packages/desktop-native`: sidecar/runtime packaging, playback, PiP, portrait rendering, comments, Studio/Channel/upload flows
- `packages/bare-mpv` and `packages/bare-ffmpeg`: native playback module changes
- docs and local artifacts

Do **not** stage or commit these local artifact paths:

- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/.superpowers/`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/.tmp-native-playback-check/`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/default.profraw`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/default.profraw`

## Shared Files That Must Be Split By Hunk

These files span multiple logical PRs and should be staged with `git add -p`, not wholesale:

- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.mjs`

## Chunk 1: Land The Clean Committed Baseline

### Task 1: Create a clean worktree from the committed native-desktop branch head

**Files:**
- Review only: committed history already on `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton`

- [ ] **Step 1: Create a clean landing worktree**

Run:
```bash
git -C /Users/jd/projects/peartube worktree add /Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base -b codex/native-desktop-mainline-base /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
```

Expected: new clean worktree at `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base` with no dirty files.

- [ ] **Step 2: Verify the clean worktree really has no local changes**

Run:
```bash
git -C /Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base status --short
```

Expected: no output.

- [ ] **Step 3: Commit**

No new commit. This task establishes the clean landing workspace.

### Task 2: Verify the already-committed baseline before opening the first PR

**Files:**
- Test: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/backend/test/identity-key-file.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/backend/test/storage-layout.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/host/test/start-host.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/desktop-native/Bridge/native-rpc.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/desktop-native/Bridge/native-host-sidecar.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/desktop-native/Bridge/bridge-core.test.mjs`
- Build: `/Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`

- [ ] **Step 1: Run the JS/backend baseline checks**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test \
  packages/backend/test/identity-key-file.test.mjs \
  packages/backend/test/storage-layout.test.mjs \
  packages/host/test/start-host.test.mjs \
  packages/desktop-native/Bridge/native-rpc.test.mjs \
  packages/desktop-native/Bridge/native-host-sidecar.test.mjs \
  packages/desktop-native/Bridge/bridge-core.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the native desktop build**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base/packages/desktop-native
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS'
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 3: Push and open PR 1**

Run:
```bash
git -C /Users/jd/.config/superpowers/worktrees/peartube-native-mainline-base push -u origin codex/native-desktop-mainline-base
```

Then open a PR from `codex/native-desktop-mainline-base` into `main`.

- [ ] **Step 4: Commit**

No new commit. PR 1 is the already-committed baseline.

## Chunk 2: Cut Shared Backend/Bridge Hardening Into PR 2

### Task 3: Stage only the backend, host, protocol, and schema hardening changes

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/app/backend/mobile-handlers.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/app/backend/mobile-handlers.test.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/api.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/backend-entry.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/channel/multi-writer-channel.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/channel/public-channel-bee.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/identity-key-file.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/identity.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/orchestrator.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/storage.js`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/corestore-cleanup.js`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/corestore-error-utils.js`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/runtime-modules.js`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/test/channel-bootstrap-replication.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/test/corestore-cleanup.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/test/orchestrator-seed-mismatch.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/test/public-feed-api.test.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/test/storage-meta-core-keypair.test.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/host/src/start-host.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/host/src/start-host.d.ts`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/host/test/start-host.test.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/protocol/src/create-client.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/spec/schema.cjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/spec/spec/hrpc/index.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/spec/spec/hrpc/messages.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/spec/spec/schema/index.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/spec/spec/schema/schema.json`

- [ ] **Step 1: Stage only the backend/host/spec bucket**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add \
  packages/app/backend/mobile-handlers.mjs \
  packages/app/backend/mobile-handlers.test.mjs \
  packages/backend/src/api.js \
  packages/backend/src/backend-entry.js \
  packages/backend/src/channel/multi-writer-channel.js \
  packages/backend/src/channel/public-channel-bee.js \
  packages/backend/src/identity-key-file.js \
  packages/backend/src/identity.js \
  packages/backend/src/orchestrator.js \
  packages/backend/src/storage.js \
  packages/backend/src/corestore-cleanup.js \
  packages/backend/src/corestore-error-utils.js \
  packages/backend/src/runtime-modules.js \
  packages/backend/test/channel-bootstrap-replication.test.mjs \
  packages/backend/test/corestore-cleanup.test.mjs \
  packages/backend/test/orchestrator-seed-mismatch.test.mjs \
  packages/backend/test/public-feed-api.test.mjs \
  packages/backend/test/storage-meta-core-keypair.test.mjs \
  packages/host/src/start-host.js \
  packages/host/src/start-host.d.ts \
  packages/host/test/start-host.test.mjs \
  packages/protocol/src/create-client.js \
  packages/spec/schema.cjs \
  packages/spec/spec/hrpc/index.js \
  packages/spec/spec/hrpc/messages.js \
  packages/spec/spec/schema/index.js \
  packages/spec/spec/schema/schema.json
```

Expected: only backend/host/protocol/spec files are staged.

- [ ] **Step 2: Verify PR 2 test coverage**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test \
  packages/app/backend/mobile-handlers.test.mjs \
  packages/backend/test/channel-bootstrap-replication.test.mjs \
  packages/backend/test/corestore-cleanup.test.mjs \
  packages/backend/test/orchestrator-seed-mismatch.test.mjs \
  packages/backend/test/public-feed-api.test.mjs \
  packages/backend/test/storage-meta-core-keypair.test.mjs \
  packages/host/test/start-host.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit PR 2**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git commit -m "fix: harden native host bootstrap and shared bridge contracts"
```

## Chunk 3: Cut Desktop Runtime And Playback Work Into PR 3

### Task 4: Stage sidecar/runtime, addon-path, and playback changes

**Files:**
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.mjs`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.test.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/sidecar-addon-roots.test.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-worklet.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-worklet-push.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/barekit-bare-fs-worklet.cjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/barekit-corestore-worklet.cjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/barekit-echo-worklet.cjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/barekit-echo-worklet.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/playback-resolution.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/playback-resolution.test.mjs`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/BridgeRPCChannel.swift`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/BareKit-Bridging-Header.h`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/BareRuntimeSidecarSession.swift`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/EmbeddedBareKitSession.swift`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/MpvPlayerView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Resources/PearTubeDesktop.entitlements`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/package.json`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/project.yml`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/ensure-host-sidecar-frameworks.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/sidecar-addon-roots.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/ensure-bare-mpv-prebuilds.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/ensure-barekit-bare-fs-bundle.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/ensure-barekit-corestore-bundle.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/ensure-barekit-echo-bundle.mjs`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/scripts/ensure-host-worklet-bundle.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/bare-ffmpeg`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/bare-mpv/binding.cc`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/bare-mpv/binding.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/bare-mpv/index.js`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/bare-mpv/index.test.cjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/BareKitIntegrationTests.swift`

- [ ] **Step 1: Stage runtime/playback files, not UI feature files**

Use `git add` for whole files and `git add -p` for:
- `packages/desktop-native/Sources/Services/HostBridgeService.swift`
- `packages/desktop-native/Sources/Support/BridgeRPCChannel.swift`
- `packages/desktop-native/Bridge/bridge-core.mjs`
- `packages/desktop-native/Bridge/native-host-sidecar.mjs`

Exclude UI-only hunks related to comments, Studio, channel page, portrait layouts, and thumbnail container styling.

- [ ] **Step 2: Verify PR 3 tests and build**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test \
  packages/desktop-native/Bridge/bridge-core.test.mjs \
  packages/desktop-native/Bridge/native-host-sidecar.test.mjs \
  packages/desktop-native/Bridge/playback-resolution.test.mjs \
  packages/desktop-native/Bridge/sidecar-addon-roots.test.mjs \
  packages/bare-mpv/index.test.cjs

cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS'
```

Expected: PASS and `BUILD SUCCEEDED`.

- [ ] **Step 3: Commit PR 3**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git commit -m "feat: harden native desktop runtime and playback pipeline"
```

## Chunk 4: Cut Native UI, Creator, And Channel Features Into PR 4

### Task 5: Stage the remaining Swift UI, comments, and Studio/Channel work

**Files:**
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppCommands.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/PearTubeDesktopApp.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Models/AppSection.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Models/NativeVideo.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/SectionEmptyStateView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/VideoDetailView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/BridgeRPCChannelTests.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.test.mjs`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.mjs`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.test.mjs`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- Modify by hunk: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.test.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/docs/superpowers/plans/2026-03-27-native-desktop-sidecar-cleanup.md`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/docs/superpowers/plans/2026-03-28-native-studio-channel-implementation.md`

- [ ] **Step 1: Stage the remaining desktop-native hunks**

Use `git add -p` to stage the UI, upload, comments, miniplayer, portrait playback layout, channel page, and Studio/channel owner-action hunks that were intentionally excluded from PR 3.

- [ ] **Step 2: Verify PR 4 with focused native tests**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: `PearTubeDesktopTests` PASS. Document any still-failing unrelated `BareKitIntegrationTests` separately instead of mixing them into this PR.

- [ ] **Step 3: Launch the app for smoke verification**

Run:
```bash
open /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/build/Build/Products/Debug/PearTubeDesktop.app
```

Verify manually:
- feed renders with fixed neutral thumbnail shells
- watch page shows details and comments
- portrait videos render sanely
- Studio upload retry path appears for failed uploads
- Channel page owner actions update locally

- [ ] **Step 4: Commit PR 4**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git commit -m "feat: finish native desktop ui and creator workflows"
```

## Chunk 5: Final Landing Hygiene

### Task 6: Push follow-up branches and open sequenced PRs

**Files:**
- Review only: git history and PR descriptions

- [ ] **Step 1: Push PR 2, PR 3, and PR 4 branches**

Use separate branches off the committed baseline for each slice. Do **not** stack new PRs directly on the dirty worktree branch without recording which base they target.

- [ ] **Step 2: Write PR descriptions that reference dependency order**

State clearly:
- PR 1 lands the committed native-desktop baseline
- PR 2 depends on PR 1
- PR 3 depends on PR 1 and may be reviewed independently from PR 2 unless shared host/spec changes require otherwise
- PR 4 depends on PR 1 and whichever runtime/bridge changes its staged hunks actually use

- [ ] **Step 3: Clean local artifacts after commits are secured**

Only after all intended work is committed or safely branched:
```bash
rm -rf /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/.tmp-native-playback-check
rm -f /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/default.profraw
rm -f /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/default.profraw
```

Expected: worktree is free of obvious local test artifacts.

