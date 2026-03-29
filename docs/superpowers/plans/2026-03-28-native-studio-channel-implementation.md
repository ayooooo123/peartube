# Native Studio and Channel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a proper native macOS Studio upload flow and a dedicated Channel page on top of the existing PearTube Native sidecar host.

**Architecture:** Keep the current top-level native shell and sidecar host boundary. Add targeted bridge/state surfaces for creator and channel-detail workflows, then layer dedicated `StudioView` and `ChannelDetailView` on top instead of overloading snapshot-driven feed views.

**Tech Stack:** SwiftUI, Foundation/AppKit, sidecar `bare` runtime, compact-encoding RPC, existing PearTube protocol client, Xcodebuild, Node test runner

---

## File Structure

### Swift files

- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`
  - Add explicit page/view state for channel pages and Studio state.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift`
  - Route the shell into `StudioView`, `ChannelDetailView`, watch page, diagnostics, or browse feed.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift`
  - Wire channel taps into the dedicated channel page instead of leaving channel identity as inert text.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/VideoDetailView.swift`
  - Wire channel attribution into the dedicated channel page and keep watch-page owner/viewer actions coherent.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/SectionEmptyStateView.swift`
  - Keep empty states aligned with the new Studio/channel surfaces instead of generic snapshot copy.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
  - Add targeted channel loads, owner edit operations, file picking helpers for avatar/thumbnail, and upload progress state updates.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
  - Add command/event IDs plus codecs for channel/video owner operations and upload progress.
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Models/NativeChannelProfile.swift`
  - Native-friendly channel metadata model for header/about/owner state.
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Models/NativeUploadJob.swift`
  - Upload progress and post-upload editing model.
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/StudioView.swift`
  - Dedicated native creator workspace.
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ChannelDetailView.swift`
  - Dedicated channel page for both owner and viewer states.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`
  - Register any new Swift files in the target.

### JS bridge files

- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.mjs`
  - Add bridge command IDs/codecs that mirror the new Swift RPC definitions.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
  - Route new commands into the existing protocol client and emit upload progress events back to Swift.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.mjs`
  - Reuse existing browse shaping where possible and keep targeted channel fetches off the bootstrap hot path.

### Tests

- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`
  - Add focused native state and view-model tests for Studio and Channel flows.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.test.mjs`
  - Add codec coverage for new commands/events.
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.test.mjs`
  - Add request routing and upload event coverage.

## Chunk 1: Bridge And State Foundation

### Task 1: Add bridge commands and codecs for channel management and upload progress

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.test.mjs`

- [ ] **Step 1: Write failing JS codec tests**

Add tests for:
- `getChannelMeta`
- `listChannelVideos`
- `updateChannel`
- `updateChannelAvatar`
- `updateVideoMetadata`
- `deleteVideo`
- `setVideoThumbnailFromFile`
- `uploadProgress` event payload

- [ ] **Step 2: Run the JS bridge tests and verify they fail**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-rpc.test.mjs
```

Expected: FAIL because the new command and event codecs do not exist yet.

- [ ] **Step 3: Implement the command/event additions**

In both Swift and JS bridge definitions:
- reserve new command IDs after the current comment/reaction set
- add request/response codecs for the targeted channel/video operations
- add an `uploadProgress` event command and payload codec

- [ ] **Step 4: Re-run the JS bridge tests**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-rpc.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Support/NativeBridgeRPC.swift packages/desktop-native/Bridge/native-rpc.mjs packages/desktop-native/Bridge/native-rpc.test.mjs
git commit -m "feat: add native studio and channel bridge commands"
```

### Task 2: Route the new bridge commands through the sidecar host

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.test.mjs`

- [ ] **Step 1: Write failing sidecar routing tests**

Add tests that assert the sidecar:
- forwards channel meta and channel video requests into the existing protocol client
- forwards owner actions (`updateChannel`, `updateChannelAvatar`, `updateVideoMetadata`, `deleteVideo`, `setVideoThumbnailFromFile`)
- emits `uploadProgress` back across the bridge when the client/backend reports upload state

- [ ] **Step 2: Run the focused sidecar tests and verify failure**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-host-sidecar.test.mjs
```

Expected: FAIL because the handlers and event forwarding do not exist yet.

- [ ] **Step 3: Implement minimal sidecar routing**

In `native-host-sidecar.mjs`:
- decode the new requests
- call the already-existing protocol methods where available
- normalize channel/video responses for Swift
- wire upload progress callbacks into the new bridge event

- [ ] **Step 4: Re-run the sidecar tests**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-host-sidecar.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Bridge/native-host-sidecar.mjs packages/desktop-native/Bridge/native-host-sidecar.test.mjs
git commit -m "feat: route native studio and channel operations through sidecar"
```

### Task 3: Expand native state and host service for dedicated Studio and Channel flows

**Files:**
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Models/NativeChannelProfile.swift`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Models/NativeUploadJob.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`

- [ ] **Step 1: Write failing native state tests**

Add tests for:
- entering/exiting channel page state
- owner vs viewer channel mode
- upload job progress/state transitions
- selecting the latest successful upload for post-upload editing

- [ ] **Step 2: Run the focused native tests and verify failure**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: FAIL in the new state tests because the models and state transitions do not exist yet.

- [ ] **Step 3: Implement the minimal state/service layer**

Add:
- `NativeChannelProfile`
- `NativeUploadJob`
- AppState helpers for:
  - open/close channel page
  - store channel metadata and channel video lists
  - keep Studio upload and editing state
- HostBridgeService helpers for:
  - load channel metadata/videos
  - update channel
  - update avatar
  - update video metadata
  - delete video
  - set thumbnail from file
  - handle upload progress events

- [ ] **Step 4: Re-run the focused native tests**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: PASS for the new state-focused assertions.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Models packages/desktop-native/Sources/App/AppState.swift packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "feat: add native studio and channel state models"
```

## Chunk 2: Build The Dedicated Studio Surface

### Task 4: Route the shell into a dedicated Studio view

**Files:**
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/StudioView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`

- [ ] **Step 1: Write a failing view-selection test**

Add a native test that asserts selecting `Studio` renders a dedicated Studio surface instead of the generic browse feed.

- [ ] **Step 2: Run the focused test and verify failure**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: FAIL because `Studio` still resolves through `FeedListView`.

- [ ] **Step 3: Implement `StudioView` and wire it into `ContentView`**

Initial `StudioView` sections:
- channel status card
- upload composer/drop target
- active upload card
- post-upload details editor
- recent uploads list

Keep the first implementation simple and local. Do not mix Studio-specific layout branches back into `FeedListView`.

- [ ] **Step 4: Run build verification**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'
```

Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Views/StudioView.swift packages/desktop-native/Sources/Views/ContentView.swift packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj
git commit -m "feat: add dedicated native studio surface"
```

### Task 5: Finish the Studio upload-and-edit flow

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/StudioView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`

- [ ] **Step 1: Write failing Studio behavior tests**

Cover:
- Studio without an identity shows `Create Channel`
- Studio with an identity shows upload and publish controls
- upload progress updates the active upload card
- metadata save failure preserves the draft

- [ ] **Step 2: Run the focused tests and verify failure**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: FAIL because the new Studio behavior is incomplete.

- [ ] **Step 3: Implement the full first-pass Studio flow**

Complete:
- drag/drop and picker upload entry
- live upload progress card
- post-upload metadata editing
- thumbnail picker
- recent upload selection/editing
- publish channel CTA in Studio

- [ ] **Step 4: Run verification**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'
open /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/build/Build/Products/Debug/PearTubeDesktop.app
```

Expected:
- tests pass for the new Studio assertions
- build succeeds
- app launches so the user can inspect the Studio surface

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Views/StudioView.swift packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "feat: add native studio upload workflow"
```

## Chunk 3: Build The Dedicated Channel Surface

### Task 6: Add a dedicated channel page and route channel taps into it

**Files:**
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ChannelDetailView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/VideoDetailView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`

- [ ] **Step 1: Write failing channel navigation tests**

Add tests for:
- tapping a channel from browse opens channel detail state
- tapping channel attribution from watch opens the same channel surface
- closing the channel page returns to the prior browse/watch context cleanly

- [ ] **Step 2: Run the focused tests and verify failure**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: FAIL because channel navigation does not exist yet.

- [ ] **Step 3: Implement the dedicated channel surface**

`ChannelDetailView` should include:
- header with avatar, name, description, stats
- role-aware actions
- `Videos` / `About` segmented body
- owner affordances only when the active identity owns the channel

- [ ] **Step 4: Run build verification**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'
```

Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Views/ChannelDetailView.swift packages/desktop-native/Sources/Views/ContentView.swift packages/desktop-native/Sources/Views/FeedListView.swift packages/desktop-native/Sources/Views/VideoDetailView.swift packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj
git commit -m "feat: add native channel detail page"
```

### Task 7: Complete owner and viewer actions on the channel page

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ChannelDetailView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`

- [ ] **Step 1: Write failing owner/viewer behavior tests**

Cover:
- viewer mode subscribe toggle
- owner mode edit/publish/upload controls
- owner delete confirmation flow
- channel page local retry state on load failure

- [ ] **Step 2: Run the focused tests and verify failure**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: FAIL because the role-aware action surface is incomplete.

- [ ] **Step 3: Implement the first-pass owner/viewer action set**

Complete:
- viewer subscribe/unsubscribe
- owner edit channel
- owner publish channel
- owner upload shortcut back into Studio
- owner edit metadata/set thumbnail/delete video actions
- local retry/error presentation on the page

- [ ] **Step 4: Run end-to-end verification**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS'
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'
open /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/build/Build/Products/Debug/PearTubeDesktop.app
```

Expected:
- the new channel/page tests pass
- the native desktop app builds
- the app launches so the user can inspect Studio and Channel end to end

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Views/ChannelDetailView.swift packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "feat: add native channel management actions"
```
