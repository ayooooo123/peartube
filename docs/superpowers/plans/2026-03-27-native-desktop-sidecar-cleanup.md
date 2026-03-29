# Native Desktop Sidecar Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS native host sidecar the only supported production runtime path, reduce custom bridge complexity around it, and surface clear discovery/network state when the public feed is empty.

**Architecture:** Keep the separate `bare` child process boundary on desktop. Do not chase in-process BareKit embedding for production macOS. Narrow the Swift-to-Bare boundary to one stable, versioned bridge contract, remove embedded-only recovery branches from the app boot path, and improve diagnostics so "host broken" is clearly separated from "DHT bootstrapped but no reachable peers".

**Tech Stack:** SwiftUI, Foundation `Process`/`Pipe`, Bare runtime, compact-encoding RPC envelope, Hyperswarm/Corestore/Hyperbee, Xcodebuild, Node test runner

---

## Chunk 1: Lock Desktop To The Sidecar Architecture

### Task 1: Make sidecar the only production host path

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`

- [ ] **Step 1: Write failing tests for transport policy**

Add tests that assert:
- release/default environment always selects `.sidecar`
- embedded mode is only reachable under an explicit debug/test-only override
- relaunch-required embedded-host messaging is not shown on the sidecar path

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests/testPreferredNativeHostTransportDefaultsToSidecar
```

Expected: FAIL because the stricter sidecar-only assertions do not exist yet.

- [ ] **Step 3: Implement sidecar-only production selection**

In `HostBridgeService.swift`:
- keep `.embedded` only for explicit debug harness use
- remove embedded retry/relaunch logic from the normal production bootstrap path
- ensure error copy and logs say `native host sidecar` unless the embedded harness was explicitly requested

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS' -only-testing:PearTubeDesktopTests
```

Expected: PASS for the transport-policy tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "refactor: make desktop native host sidecar-only in production"
```

### Task 2: Split sidecar and embedded session code into separate files

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/BareKitWorkletSession.swift`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/BareRuntimeSidecarSession.swift`
- Create: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/EmbeddedBareKitSession.swift`

- [ ] **Step 1: Write a failing compilation-oriented test plan**

Add or update tests so they instantiate the sidecar session without referencing embedded types. The goal is to make sidecar ownership explicit.

- [ ] **Step 2: Move the sidecar `Process` implementation out of `BareKitWorkletSession.swift`**

Keep `NativeHostSession` as the shared protocol. Put:
- child-process launch code in `BareRuntimeSidecarSession.swift`
- BareKit-only code in `EmbeddedBareKitSession.swift`

- [ ] **Step 3: Update imports/usages**

Update `HostBridgeService.swift` to use the new concrete file paths and names with no behavior change.

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
git add packages/desktop-native/Sources/Support packages/desktop-native/Sources/Services/HostBridgeService.swift
git commit -m "refactor: split native host session implementations"
```

## Chunk 2: Narrow The Swift <-> Bare Bridge

### Task 3: Version the bridge envelope and handshake

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/BridgeRPCChannel.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- Test: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-rpc.test.mjs`

- [ ] **Step 1: Write failing tests for handshake/version mismatch**

Add a minimal handshake like:
```js
{ protocolVersion: 1, transport: 'stdio', hostMode: 'sidecar' }
```

Test that:
- matching versions open normally
- mismatched versions fail with a clear startup error

- [ ] **Step 2: Implement the minimal handshake**

Do not replace the transport with `bare-ipc` or `pear-ipc` directly. Swift is not a JS peer, so mirror the upstream IPC ideas instead:
- explicit protocol version
- capability handshake
- clear disconnect semantics
- bounded pending requests

- [ ] **Step 3: Remove dead protocol branches**

Delete or collapse:
- embedded-only transport assumptions in the Swift bridge
- duplicate launch-path logging in the JS sidecar entry
- stale `NativeSidecar*` naming if it no longer reflects reality

- [ ] **Step 4: Run JS bridge tests**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-rpc.test.mjs Bridge/native-host-sidecar.test.mjs Bridge/bridge-core.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Support packages/desktop-native/Bridge
git commit -m "refactor: version native desktop bridge protocol"
```

### Task 4: Collapse the JS host entrypoints around the sidecar

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-sidecar.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-worklet.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-worklet-push.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/package.json`

- [ ] **Step 1: Write a failing packaging/test assertion**

Add a test that ensures the generated app resources contain the sidecar bundle/runtime as first-class artifacts and that the worklet bundle is treated as debug-only.

- [ ] **Step 2: Centralize backend startup**

Share one bootstrap path for:
- storage path resolution
- debug logging setup
- native bridge command registration

Keep the worklet entrypoint only as a test harness wrapper around the same backend startup function.

- [ ] **Step 3: Update generate/build scripts**

Make `generate` and packaging explicitly about:
- sidecar bundle
- bare runtime
- addon staging

Keep worklet generation optional or clearly marked as debug/test infrastructure.

- [ ] **Step 4: Run packaging/build verification**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-host-sidecar.test.mjs
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'
```

Expected: PASS and BUILD SUCCEEDED.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Bridge packages/desktop-native/package.json packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj
git commit -m "build: center native desktop host on sidecar runtime"
```

## Chunk 3: Make Feed/Network State Legible

### Task 5: Surface real network state instead of “empty home”

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/storage.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/public-feed.js`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Support/NativeBridgeRPC.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Views/SectionEmptyStateView.swift`

- [ ] **Step 1: Write failing tests for network-empty state**

Cover:
- DHT bootstrapped with zero peers
- DHT not yet bootstrapped
- peers connected but feed still empty

The UI should distinguish these cases instead of always rendering a generic empty home.

- [ ] **Step 2: Add one structured network status event**

Emit a compact event containing:
```json
{
  "bootstrapped": true,
  "firewalled": true,
  "peerCount": 0,
  "connectionCount": 0,
  "feedPeerCount": 0
}
```

Send it through the existing native bridge as telemetry, not as log scraping.

- [ ] **Step 3: Render useful empty-state copy**

Examples:
- `Connecting to the DHT…`
- `Connected to the DHT, but no PearTube peers are reachable right now.`
- `Peers connected, waiting for public feed entries…`

- [ ] **Step 4: Verify against the app and backend**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'

cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --input-type=module -e "import Hyperswarm from 'hyperswarm'; import crypto from 'hypercore-crypto'; import b4a from 'b4a'; const swarm = new Hyperswarm(); const topics = ['peartube-network','peartube-public-feed-v1'].map(s => crypto.data(b4a.from(s,'utf8'))); for (const t of topics) swarm.join(t,{server:true,client:true}); await swarm.listen(); setTimeout(async () => { console.log({ bootstrapped: swarm.dht?.bootstrapped, firewalled: swarm.dht?.firewalled, peers: swarm.peers.size, connections: swarm.connections.size }); await swarm.destroy(); }, 8000)"
```

Expected: the app can now tell the difference between transport success and network emptiness.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/backend/src/storage.js packages/backend/src/public-feed.js packages/desktop-native/Sources/Support/NativeBridgeRPC.swift packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Sources/Views/SectionEmptyStateView.swift
git commit -m "feat: surface native desktop network discovery state"
```

### Task 6: Remove the last production-facing embedded-host leftovers

**Files:**
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Sources/Services/HostBridgeService.swift`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-worklet.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Bridge/native-host-worklet-push.mjs`
- Modify: `/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/Tests/PearTubeDesktopTests.swift`

- [ ] **Step 1: Delete production-only references to embedded recovery**

Remove:
- production relaunch copy about embedded host reopen failures
- embedded bootstrap retry/reset paths from normal desktop startup

- [ ] **Step 2: Keep only a clearly labeled debug harness**

If the embedded path must remain, gate it behind a debug-only environment switch and make tests assert that it is unsupported in normal app usage.

- [ ] **Step 3: Run the final verification set**

Run:
```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native
/Users/jd/.nvm/versions/node/v22.19.0/bin/node --test Bridge/native-host-sidecar.test.mjs Bridge/native-rpc.test.mjs
xcodebuild test -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -destination 'platform=macOS'
xcodebuild build -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build -destination 'platform=macOS'
```

Expected: PASS and BUILD SUCCEEDED.

- [ ] **Step 4: Smoke-test the shipped bundle**

Run:
```bash
pkill -f 'PearTubeDesktop.app/Contents/MacOS/PearTubeDesktop' || true
open /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/desktop-native/build/Build/Products/Debug/PearTubeDesktop.app
```

Expected:
- sidecar startup log appears
- addon path resolves from `Contents/Resources/BareAddons`
- bootstrap succeeds
- network diagnostics are legible even when the feed is empty

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton
git add packages/desktop-native/Sources/Services/HostBridgeService.swift packages/desktop-native/Bridge packages/desktop-native/Tests/PearTubeDesktopTests.swift
git commit -m "refactor: remove production embedded host fallback"
```

## Notes

- Keep the separate `bare` sidecar process. That part aligns with upstream Holepunch desktop/runtime patterns.
- Do not try to drop `bare-ipc` or `pear-ipc` directly into the Swift boundary. Those repos are the right design reference, but Swift is not a JS peer, so the practical move is to mirror their structure with a thinner custom transport.
- Treat the embedded BareKit path as a test harness at most. It should not remain part of the user-facing production recovery story on macOS.
