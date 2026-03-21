# Native Consumer UI Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first real native macOS consumer slice: toolbar-driven global search, real center-pane results, and real right-pane detail/playback over the shared Bare host.

**Architecture:** Extend the native sidecar bridge with a single search command that returns native-shaped `NativeVideo` results, then teach the Swift shell to manage query-driven display state on top of the existing browse snapshot and playback flow. Keep all search semantics and content truth in Bare, and keep Swift limited to selection, focus, presentation, and player state.

**Tech Stack:** SwiftUI, AVKit, XCTest, Bare sidecar bridge, `bare-rpc-swift`, `compact-encoding-swift`, Node test runner

---

## File Map

- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/VideoDetailView.swift`
- Verify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/package.json`

## Chunk 1: Search State and Bridge Contract

### Task 1: Add failing native state tests

**Files:**
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`

- [ ] **Step 1: Write the failing test**

Add tests for:
- query-driven displayed videos replacing section videos
- clearing the query restoring section videos
- search result selection choosing the first result when the previous selection is absent

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --prefix packages/desktop-native`
Expected: XCTest failure because `AppState` does not yet expose search-aware display state.

- [ ] **Step 3: Write minimal implementation**

Add `searchQuery`, `searchResults`, `displayedVideos`, and small state helpers to `AppState`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --prefix packages/desktop-native`
Expected: new XCTest cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-native/Tests/PearTubeDesktopTests.swift packages/desktop-native/Sources/App/AppState.swift
git commit -m "feat: add native search state"
```

### Task 2: Add failing bridge codec and shaping tests

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/bridge-core.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/*.test.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.mjs`

- [ ] **Step 1: Write the failing test**

Add tests for:
- search request and response payload roundtrip
- search result shaping from backend global search metadata into native `NativeVideo` records

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bridge --prefix packages/desktop-native`
Expected: missing command/codec or missing `buildSearchResults`.

- [ ] **Step 3: Write minimal implementation**

Add:
- new bridge command for global search
- request and response codecs
- result shaping helper in `bridge-core.mjs`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:bridge --prefix packages/desktop-native`
Expected: all Node bridge tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-native/Bridge/bridge-core.mjs packages/desktop-native/Bridge/native-rpc.mjs packages/desktop-native/Bridge/*.test.mjs
git commit -m "feat: add native bridge search contract"
```

## Chunk 2: Sidecar Search and Swift Integration

### Task 3: Implement bridge-side global search

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`

- [ ] **Step 1: Write the failing test**

Extend a bridge test or add a small search-specific sidecar test that asserts the sidecar recognizes the search command and returns a native search payload.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bridge --prefix packages/desktop-native`
Expected: unsupported bridge command or payload mismatch.

- [ ] **Step 3: Write minimal implementation**

Wire `globalSearchVideos(query, topK)` through the protocol client and shape the results with the bridge helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:bridge --prefix packages/desktop-native`
Expected: search command path passes.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-native/Bridge/native-host-sidecar.mjs
git commit -m "feat: add sidecar global search"
```

### Task 4: Implement Swift bridge client search call

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`

- [ ] **Step 1: Write the failing test**

Add XCTest coverage for decoding the new native search payload and for `HostBridgeService`-driven app state updates if a pure test seam exists. If a service test seam is too expensive, keep the bridge payload test in place and move the state assertions into `AppState` tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --prefix packages/desktop-native`
Expected: missing Swift command/codec/state integration.

- [ ] **Step 3: Write minimal implementation**

Add the search command enum case, Swift request/response models, codecs, and a `searchVideos(query:into:)` method on `HostBridgeService`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --prefix packages/desktop-native`
Expected: XCTest and bridge tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-native/Sources/Support/NativeBridgeRPC.swift packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "feat: add swift native search bridge"
```

## Chunk 3: macOS-First Shell Behavior

### Task 5: Implement toolbar search and displayed result list

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/ContentView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/FeedListView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`

- [ ] **Step 1: Write the failing test**

If possible, keep this at the state level: assert that a query changes titles, subtitles, and displayed result counts. Avoid UI snapshot tests unless the project already has them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --prefix packages/desktop-native`
Expected: missing search-aware presentation state.

- [ ] **Step 3: Write minimal implementation**

Add:
- toolbar `.searchable`
- debounced query dispatch
- search-aware titles and empty states
- center-pane list rendering from `displayedVideos`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --prefix packages/desktop-native`
Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-native/Sources/Views/ContentView.swift packages/desktop-native/Sources/Views/FeedListView.swift packages/desktop-native/Sources/App/AppState.swift
git commit -m "feat: add macos search-first shell"
```

### Task 6: Refine the detail pane for real search results and playback continuity

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/VideoDetailView.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/App/AppState.swift`

- [ ] **Step 1: Write the failing test**

Add or extend state tests so that playback selection survives non-destructive selection changes and resets when the selected item leaves the displayed set.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --prefix packages/desktop-native`
Expected: playback/detail continuity behavior is not yet encoded.

- [ ] **Step 3: Write minimal implementation**

Use the current selected video from `displayedVideos`, preserve playback when valid, and improve inline detail state for loading and error cases.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --prefix packages/desktop-native`
Expected: all XCTest cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-native/Sources/Views/VideoDetailView.swift packages/desktop-native/Sources/App/AppState.swift packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "feat: refine native detail playback flow"
```

## Chunk 4: Verification

### Task 7: Full native verification

**Files:**
- Verify only

- [ ] **Step 1: Run bridge tests**

Run: `npm run test:bridge --prefix packages/desktop-native`
Expected: PASS

- [ ] **Step 2: Run Swift tests**

Run: `npm run test --prefix packages/desktop-native`
Expected: PASS

- [ ] **Step 3: Build the native app**

Run: `npm run build --prefix packages/desktop-native`
Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Launch the app**

Run: `npm run run --prefix packages/desktop-native`
Expected: app launches with real browse data, toolbar search, and inline playback.

- [ ] **Step 5: Commit final polish**

```bash
git add -A
git commit -m "feat: ship native consumer ui phase 1"
```
