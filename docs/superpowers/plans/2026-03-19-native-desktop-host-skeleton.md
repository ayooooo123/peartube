# Native Desktop Host Skeleton Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared host and protocol layer for PearTube, migrate mobile and legacy desktop bootstrap to that shared contract, and add a native macOS browse-to-detail-to-play shell that talks to the same host model.

**Architecture:** Extract backend startup into a new `@peartube/host` package wrapped around `createBackend()`, then layer a transport-neutral `@peartube/protocol` client on top of HRPC. Keep mobile and the current desktop path as thin runner adapters, and add a new SwiftUI/AppKit macOS app that launches a bundled Bare sidecar through `Process` plus `Pipe` and uses `AVPlayer` for the first playback slice.

**Tech Stack:** JavaScript ESM, TypeScript, HRPC, Bare/BareKit, brittle, React Native, SwiftUI, AppKit, AVPlayer, XCTest, xcodebuild

---

## File Structure

### Shared host package

- Create: `packages/host/package.json`
- Create: `packages/host/src/contracts.js`
- Create: `packages/host/src/sidecar-entry.js`
- Create: `packages/host/src/start-host.js`
- Create: `packages/host/src/index.js`
- Create: `packages/host/test/start-host.test.mjs`
- Create: `packages/host/test/mobile-entry.test.mjs`

Responsibilities:

- `contracts.js`: canonical `HostRunner`, `HostSession`, lifecycle event, and error-code shapes for JS consumers.
- `sidecar-entry.js`: desktop sidecar entrypoint that starts the shared host on a duplex process transport.
- `start-host.js`: host bootstrap wrapper that validates inputs, calls `createBackend()`, and normalizes lifecycle behavior.
- `index.js`: package exports only.
- `start-host.test.mjs`: startup validation, ready-event forwarding, and idempotent shutdown tests.
- `mobile-entry.test.mjs`: regression coverage for the mobile entrypoint after host extraction.

### Shared protocol package

- Create: `packages/protocol/package.json`
- Create: `packages/protocol/src/event-map.js`
- Create: `packages/protocol/src/create-client.js`
- Create: `packages/protocol/src/index.js`
- Create: `packages/protocol/test/create-client.test.mjs`
- Create: `packages/protocol/test/legacy-desktop-client.test.mjs`

Responsibilities:

- `event-map.js`: protocol event registration and shell-friendly event names.
- `create-client.js`: app-facing client wrapper over generated HRPC methods plus lifecycle/event helpers.
- `index.js`: package exports only.
- `create-client.test.mjs`: event forwarding, protocol version handshake, and typed error normalization tests.
- `legacy-desktop-client.test.mjs`: regression coverage for legacy desktop event remapping through the shared client.

### Backend and platform integration

- Modify: `packages/backend/src/backend-entry.js`
- Modify: `packages/backend/package.json`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Modify: `packages/platform/package.json`
- Modify: `packages/app/package.json`
- Create: `packages/platform/src/rpc.shared.ts`
- Create: `packages/platform/src/runner.native.ts`
- Create: `packages/platform/src/runner.web.ts`
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/app/backend/index.mjs`
- Modify: `packages/app/pear-src/worker-client.js`
- Modify: `packages/app/pear-src/index.js`
- Modify: `packages/app/app/_layout.tsx`
- Modify: `packages/app/app/_layout.web.tsx`

Responsibilities:

- `backend-entry.js`: expose the minimum hooks the host package needs without duplicating backend logic.
- `packages/backend/package.json`: add a stable export path for the backend entrypoint if the host package needs one.
- `hrpc-handlers.js`: keep shared handlers registered in one place while separating shell capability groups conceptually.
- `rpc.shared.ts`: common event subscription and client bootstrap used by both native and web adapters.
- `runner.native.ts`: BareKit-specific host runner implementation.
- `runner.web.ts`: legacy desktop runner implementation for the old desktop path.
- `rpc.native.ts` / `rpc.web.ts`: thin adapter exports over shared runner plus protocol client.
- `app/backend/index.mjs`: delegate host bootstrap to `@peartube/host`.
- `worker-client.js` / `pear-src/index.js`: delegate pipe setup to the shared runner/client contract.
- `_layout.tsx` / `_layout.web.tsx`: keep app startup behavior intact while consuming the thinner platform RPC layer.

### Native macOS shell

- Create: `packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`
- Create: `packages/desktop-native/PearTubeDesktop/App/PearTubeDesktopApp.swift`
- Create: `packages/desktop-native/PearTubeDesktop/App/AppModel.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Protocol/HostClientProtocol.swift`
- Create: `packages/desktop-native/PearTubeDesktop/App/HostSidecarController.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Protocol/HostClient.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Models/VideoSummary.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/SidebarView.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/HomeFeedView.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/VideoDetailView.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/PlayerView.swift`
- Create: `packages/desktop-native/scripts/stage-host-sidecar.sh`
- Create: `packages/desktop-native/PearTubeDesktopTests/HostClientTests.swift`
- Create: `packages/desktop-native/PearTubeDesktopTests/AppModelTests.swift`

Responsibilities:

- `PearTubeDesktopApp.swift`: app entry point and root scene wiring.
- `AppModel.swift`: native-shell presentation state only.
- `HostClientProtocol.swift`: minimal browse/detail/play API surface used by `AppModel` so tests can inject a fake client.
- `HostSidecarController.swift`: spawn and stop the Bare host sidecar via `Process` and `Pipe`.
- `HostClient.swift`: framed byte transport plus protocol-level request and event bridge for Swift.
- `VideoSummary.swift`: focused decoded models used by the native shell.
- `SidebarView.swift`, `HomeFeedView.swift`, `VideoDetailView.swift`, `PlayerView.swift`: browse/detail/play UI only.
- `stage-host-sidecar.sh`: build or stage the host sidecar into the native app’s resources during local development builds.
- test targets: verify host handshake, event decoding, and browse-to-play model updates.

## Chunk 1: Shared Host and Protocol Contracts

### Task 1: Scaffold the host and protocol packages

**Files:**
- Create: `packages/host/package.json`
- Create: `packages/host/src/index.js`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/src/index.js`
- Modify: `packages/app/package.json`
- Modify: `packages/platform/package.json`
- Modify: `packages/backend/package.json`

- [ ] **Step 1: Add the new package manifests**

Create minimal package manifests for `@peartube/host` and `@peartube/protocol` with `type: "module"`, `main`, `exports`, and a `test` script using `brittle test/*.test.mjs`.

Use these exact dependency sets:

- `packages/host/package.json`
  - `dependencies`: `@peartube/backend: "file:../backend"`
  - `devDependencies`: `brittle`
- `packages/protocol/package.json`
  - `dependencies`: `@peartube/spec: "file:../spec"`, `@peartube/host: "file:../host"`
  - `devDependencies`: `brittle`

- [ ] **Step 2: Wire package dependencies and exports**

Update:

- `packages/platform/package.json` to depend on `file:../host` and `file:../protocol`
- `packages/app/package.json` to depend on `file:../host` and `file:../protocol` because `packages/app/backend/index.mjs` and `packages/app/pear-src/worker-client.js` will import them directly
- `packages/backend/package.json` to expose the stable export `"./backend-entry": "./src/backend-entry.js"` so `packages/host/src/start-host.js` can import `createBackend` from `@peartube/backend/backend-entry`

- [ ] **Step 3: Add package entrypoints**

Create minimal `src/index.js` files that re-export the contract modules that will be added in the next tasks.

- [ ] **Step 4: Verify manifests are syntactically valid**

Run: `node -e "console.log(require('./packages/host/package.json').name, require('./packages/protocol/package.json').name, require('./packages/platform/package.json').dependencies['@peartube/host'])"`

Expected: prints the two new package names and the `file:../host` dependency without throwing.

- [ ] **Step 5: Commit**

```bash
git add packages/host/package.json packages/host/src/index.js packages/protocol/package.json packages/protocol/src/index.js packages/platform/package.json packages/app/package.json packages/backend/package.json
git commit -m "chore: scaffold host and protocol packages"
```

### Task 2: Add the host contract and startup wrapper

**Files:**
- Create: `packages/host/src/contracts.js`
- Create: `packages/host/src/sidecar-entry.js`
- Create: `packages/host/src/start-host.js`
- Create: `packages/host/test/start-host.test.mjs`
- Modify: `packages/host/src/index.js`
- Modify: `packages/backend/src/backend-entry.js`

- [ ] **Step 1: Write the failing host contract test**

Create `packages/host/test/start-host.test.mjs` with brittle tests covering:

```js
import test from 'brittle'
import { startHost, HOST_ERROR_CODES } from '../src/index.js'

test('startHost rejects empty storagePath', async (t) => {
  await t.exception(() => startHost({ platform: 'desktop', storagePath: '', entrypoint: 'sidecar-entry', args: [], stream: {} }))
})

test('startHost forwards ready payload with protocolVersion', async (t) => {
  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: { on() {}, once() {}, write() {}, destroy() {} },
    createBackendImpl: async ({ onReady }) => {
      onReady({ blobServerPort: 7777 })
      return { destroy: async () => {} }
    }
  })

  t.alike(await session.waitUntilReady(), { blobServerPort: 7777, protocolVersion: 1 })
})

test('startHost terminate is idempotent', async (t) => {
  let destroyCalls = 0
  const session = await startHost({
    platform: 'desktop',
    storagePath: '/tmp/peartube-host',
    entrypoint: 'sidecar-entry',
    args: [],
    stream: { on() {}, once() {}, write() {}, destroy() {} },
    createBackendImpl: async ({ onReady }) => {
      onReady({ blobServerPort: 7777 })
      return { destroy: async () => { destroyCalls++ } }
    }
  })

  await session.terminate()
  await session.terminate()
  t.is(destroyCalls, 1)
})
```

- [ ] **Step 2: Run the host test to verify it fails**

Run: `npm test --prefix packages/host`

Expected: FAIL because `startHost` and `HOST_ERROR_CODES` do not exist yet.

- [ ] **Step 3: Implement the host contracts**

Add `contracts.js` with:

```js
export const HOST_ERROR_CODES = Object.freeze({
  HOST_START_FAILED: 'HOST_START_FAILED',
  STORAGE_INIT_FAILED: 'STORAGE_INIT_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TRANSPORT_DISCONNECTED: 'TRANSPORT_DISCONNECTED',
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  OFFLINE_UNAVAILABLE: 'OFFLINE_UNAVAILABLE',
  REPLICATION_TIMEOUT: 'REPLICATION_TIMEOUT',
  PLAYBACK_URL_UNAVAILABLE: 'PLAYBACK_URL_UNAVAILABLE',
  PLAYER_LOAD_FAILED: 'PLAYER_LOAD_FAILED'
})
```

Implement `start-host.js` so it accepts the full start shape `{ platform, storagePath, entrypoint, args, stream }`, validates those fields, calls `createBackend()`, emits `{ type: 'host.ready', data: { blobServerPort, protocolVersion: 1 } }`, and normalizes shutdown through one `terminate()` path.

- [ ] **Step 4: Add the desktop sidecar entrypoint**

Create `packages/host/src/sidecar-entry.js` that:

- reads launch args for `storagePath`
- preserves the incoming `entrypoint` and optional `args` fields in the launch shape
- creates the duplex process transport
- calls `startHost()`
- keeps byte framing and process wiring out of the Swift shell

- [ ] **Step 5: Add the backend hook the host wrapper needs**

Update `packages/backend/src/backend-entry.js` so the host package can pass protocol version metadata through the ready callback without changing backend behavior for current callers.

- [ ] **Step 6: Re-export the host API**

Update `packages/host/src/index.js` to export `startHost`, `HOST_ERROR_CODES`, `PROTOCOL_VERSION`, and the sidecar entrypoint helper if it is consumed by build tooling.

- [ ] **Step 7: Run the host tests again**

Run: `npm test --prefix packages/host`

Expected: PASS with the new tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/contracts.js packages/host/src/sidecar-entry.js packages/host/src/start-host.js packages/host/src/index.js packages/host/test/start-host.test.mjs packages/backend/src/backend-entry.js
git commit -m "feat: add shared host bootstrap contract"
```

### Task 3: Add the protocol client wrapper and event map

**Files:**
- Create: `packages/protocol/src/event-map.js`
- Create: `packages/protocol/src/create-client.js`
- Create: `packages/protocol/test/create-client.test.mjs`
- Modify: `packages/protocol/src/index.js`
- Modify: `packages/backend/src/hrpc-handlers.js`

- [ ] **Step 1: Write the failing protocol client tests**

Create `packages/protocol/test/create-client.test.mjs` with tests for:

```js
import test from 'brittle'
import { createProtocolClient, PROTOCOL_EVENTS } from '../src/index.js'

test('createProtocolClient remaps feed update events', async (t) => {
  const events = []
  const client = createProtocolClient({
    stream: {},
    HRPCImpl: class FakeHRPC {
      getStatus() { return Promise.resolve({ status: { blobServerPort: 9999, protocolVersion: 1 } }) }
      onEventFeedUpdate(handler) { handler({ action: 'update', channelKey: 'abc' }) }
    }
  })

  client.events.on(PROTOCOL_EVENTS.FEED_UPDATED, (payload) => events.push(payload))
  await client.ready()
  t.alike(events[0], { action: 'update', channelKey: 'abc' })
})

test('createProtocolClient fails fast on protocol version mismatch', async (t) => {
  const client = createProtocolClient({
    stream: {},
    HRPCImpl: class FakeHRPC {
      getStatus() { return Promise.resolve({ status: { blobServerPort: 9999, protocolVersion: 2 } }) }
    }
  })

  await t.exception(() => client.ready(), /PROTOCOL_VERSION_MISMATCH/)
})
```

- [ ] **Step 2: Run the protocol tests to verify they fail**

Run: `npm test --prefix packages/protocol`

Expected: FAIL because the client and event map do not exist yet.

- [ ] **Step 3: Implement shared event names and import canonical error codes**

Add `event-map.js` so JS consumers can depend on one list of protocol event names, and import `HOST_ERROR_CODES` from `@peartube/host` instead of redefining them in the protocol package:

```js
export const PROTOCOL_EVENTS = Object.freeze({
  HOST_READY: 'host.ready',
  HOST_ERROR: 'host.error',
  UPLOAD_PROGRESS: 'upload.progress',
  DOWNLOAD_PROGRESS: 'download.progress',
  FEED_UPDATED: 'feed.updated',
  VIDEO_STATS: 'video.stats',
  CAST_DEVICE_FOUND: 'cast.deviceFound',
  CAST_DEVICE_LOST: 'cast.deviceLost',
  CAST_PLAYBACK_STATE: 'cast.playbackState',
  CAST_TIME_UPDATE: 'cast.timeUpdate',
  TRANSPORT_CLOSED: 'transport.closed'
})
```

- [ ] **Step 4: Implement the protocol client wrapper**

Add `create-client.js` so it:

- accepts a duplex stream
- constructs HRPC from `@peartube/spec`
- performs a `getStatus({})` handshake
- checks `protocolVersion === 1`
- exposes grouped namespaces (`system`, `identity`, `feed`, `channel`, `video`, `watch`, `transfer`, `search`, `shell`)
- re-emits shell-friendly events using `PROTOCOL_EVENTS`

- [ ] **Step 5: Keep handler registration centralized**

Adjust `packages/backend/src/hrpc-handlers.js` only as needed to make the capability groups explicit in comments or helper groupings without changing the actual registered handler set for current consumers.

- [ ] **Step 6: Re-export the protocol client**

Update `packages/protocol/src/index.js` to export `createProtocolClient`, `PROTOCOL_EVENTS`, and the shared error-code constants re-exported from `@peartube/host`.

- [ ] **Step 7: Run the protocol tests**

Run: `npm test --prefix packages/protocol`

Expected: PASS with event remapping and version checks verified.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/event-map.js packages/protocol/src/create-client.js packages/protocol/src/index.js packages/protocol/test/create-client.test.mjs packages/backend/src/hrpc-handlers.js
git commit -m "feat: add shared protocol client contract"
```

## Chunk 2: Migrate Mobile and Legacy Desktop Adapters

### Task 4: Add shared platform runner and client helpers

**Files:**
- Create: `packages/platform/src/rpc.shared.ts`
- Create: `packages/platform/src/runner.native.ts`
- Create: `packages/platform/src/runner.web.ts`

- [ ] **Step 1: Write a shared helper contract comment block**

At the top of `rpc.shared.ts`, document the only shapes it accepts:

```ts
type PlatformRunner = {
  start(options: {
    platform: 'mobile' | 'desktop'
    storagePath: string
    entrypoint: string
    args?: string[]
  }): Promise<{
    stream: any
    waitUntilReady(): Promise<{ blobServerPort: number | null; protocolVersion: 1 }>
    terminate(): Promise<void>
    onLifecycle(cb: (event:
      | { type: 'host.ready', data: { blobServerPort: number | null; protocolVersion: 1 } }
      | { type: 'host.error', code: string, message: string, retryable: boolean }
      | { type: 'transport.closed', reason?: string }
    ) => void): () => void
  }>
}
```

- [ ] **Step 2: Implement `rpc.shared.ts`**

Move common event subscription, callback bookkeeping, and protocol-client creation into `rpc.shared.ts` so the native and web modules stop duplicating callback storage and initialization flow.

- [ ] **Step 3: Implement `runner.native.ts`**

Wrap BareKit worklet startup there. The file should own:

- worklet creation
- shutdown signaling
- IPC lifecycle handling
- calling `startHost()` through the mobile backend entrypoint

- [ ] **Step 4: Implement `runner.web.ts`**

Wrap the current legacy desktop transport there. The file should own:

- pear pipe creation
- legacy worker lifecycle
- termination on pipe close

- [ ] **Step 5: Verify TypeScript still understands the platform package**

Run: `npm run typecheck --prefix packages/platform`

Expected: PASS with the new shared helper and runner files included.

- [ ] **Step 6: Commit**

```bash
git add packages/platform/src/rpc.shared.ts packages/platform/src/runner.native.ts packages/platform/src/runner.web.ts
git commit -m "refactor: add shared platform runner helpers"
```

### Task 5: Refactor the mobile path onto the shared host contract

**Files:**
- Modify: `packages/platform/src/rpc.native.ts`
- Modify: `packages/app/backend/index.mjs`
- Modify: `packages/app/app/_layout.tsx`
- Create: `packages/host/test/mobile-entry.test.mjs`

- [ ] **Step 1: Write a focused regression test for the mobile host bootstrap**

Create `packages/host/test/mobile-entry.test.mjs` that exercises `packages/app/backend/index.mjs` through a mocked duplex stream and asserts:

- startup resolves `{ blobServerPort: <number>, protocolVersion: 1 }`
- shutdown flows through the shared host terminate path
- mobile-only handlers are still attached after the refactor

- [ ] **Step 2: Run the focused regression test and capture the current failure**

Run: `npm test --prefix packages/host`

Expected: FAIL because the mobile entrypoint still owns backend bootstrap directly.

- [ ] **Step 3: Replace direct backend bootstrap in `packages/app/backend/index.mjs`**

Refactor `packages/app/backend/index.mjs` so it delegates startup and shutdown to `@peartube/host`, keeping only:

- BareKit globals
- mobile-only handler attachment
- mobile runner wiring

- [ ] **Step 4: Thin `rpc.native.ts` down to adapter code**

Refactor `packages/platform/src/rpc.native.ts` to use `runner.native.ts` plus `rpc.shared.ts` for:

- initialization
- callback registration
- `rpc` exposure
- blob-server-port access

- [ ] **Step 5: Keep app startup behavior stable**

Update `packages/app/app/_layout.tsx` only enough to consume the thinner platform RPC module without changing loading flow, startup status UI, or the existing app context behavior.

- [ ] **Step 6: Re-run the host and platform checks**

Run: `npm test --prefix packages/host`

Expected: PASS.

Run: `npm run typecheck --prefix packages/platform`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/platform/src/rpc.native.ts packages/app/backend/index.mjs packages/app/app/_layout.tsx
git commit -m "refactor: route mobile backend startup through shared host"
```

### Task 6: Refactor the legacy desktop path onto the shared host contract

**Files:**
- Modify: `packages/platform/src/rpc.web.ts`
- Modify: `packages/app/pear-src/worker-client.js`
- Modify: `packages/app/pear-src/index.js`
- Modify: `packages/app/app/_layout.web.tsx`
- Create: `packages/protocol/test/legacy-desktop-client.test.mjs`

- [ ] **Step 1: Add a narrow regression test for desktop event remapping**

Create `packages/protocol/test/legacy-desktop-client.test.mjs` and exercise `createProtocolClient()` with a `FakeLegacyDesktopTransport` fixture that:

- resolves `getStatus()` with `{ status: { blobServerPort: 7777, protocolVersion: 1 } }`
- emits one feed-update payload
- emits one video-stats payload
- emits one transport-close notification

Assert that the shared protocol client re-emits exactly:

- `feed.updated`
- `video.stats`
- `transport.closed`

from that fixture without relying on DOM custom events.

- [ ] **Step 2: Run the desktop regression test and verify it fails**

Run: `npm test --prefix packages/protocol`

Expected: FAIL because the old web client path still dispatches DOM-specific event names directly.

- [ ] **Step 3: Thin `worker-client.js` down to transport only**

Refactor `packages/app/pear-src/worker-client.js` so it owns only:

- transport connection
- lifecycle
- passing the stream to `@peartube/protocol`

Remove DOM-event-specific translation logic from this file.

- [ ] **Step 4: Refactor `rpc.web.ts` to use shared helpers**

Move all duplicated callback storage and event setup out of `packages/platform/src/rpc.web.ts` into `rpc.shared.ts`, keeping `rpc.web.ts` as a web-specific adapter only.

- [ ] **Step 5: Keep the old Pear desktop shell booting**

Update `packages/app/pear-src/index.js` and `packages/app/app/_layout.web.tsx` only enough to preserve current startup semantics while the transport moves behind the new shared contract.

- [ ] **Step 6: Re-run the protocol and platform checks**

Run: `npm test --prefix packages/protocol`

Expected: PASS.

Run: `npm run typecheck --prefix packages/platform`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/platform/src/rpc.web.ts packages/app/pear-src/worker-client.js packages/app/pear-src/index.js packages/app/app/_layout.web.tsx
git commit -m "refactor: route legacy desktop through shared protocol client"
```

## Chunk 3: Native macOS Browse to Detail to Play Shell

### Task 7: Scaffold the native macOS app target

**Files:**
- Create: `packages/desktop-native/PearTubeDesktop.xcodeproj/project.pbxproj`
- Create: `packages/desktop-native/PearTubeDesktop/App/PearTubeDesktopApp.swift`
- Create: `packages/desktop-native/PearTubeDesktop/App/AppModel.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Protocol/HostClientProtocol.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Models/VideoSummary.swift`
- Create: `packages/desktop-native/scripts/stage-host-sidecar.sh`
- Create: `packages/desktop-native/PearTubeDesktopTests/AppModelTests.swift`

- [ ] **Step 1: Create the macOS project structure**

Add a minimal macOS app target named `PearTubeDesktop` and a test target named `PearTubeDesktopTests`.

- [ ] **Step 2: Write the first failing app-model test**

Create `packages/desktop-native/PearTubeDesktopTests/AppModelTests.swift` with:

```swift
import XCTest
@testable import PearTubeDesktop

final class AppModelTests: XCTestCase {
    func testSelectingVideoMarksCurrentVideo() async throws {
        let model = AppModel()
        model.selectVideo(.init(id: "abc", title: "Hello", channelKey: "chan"))
        XCTAssertEqual(model.currentVideo?.id, "abc")
    }
}
```

- [ ] **Step 3: Run the native test to verify it fails**

Run: `xcodebuild test -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS'`

Expected: FAIL because the target files and `AppModel` are not implemented yet.

- [ ] **Step 4: Add the sidecar staging script**

Create `packages/desktop-native/scripts/stage-host-sidecar.sh` and wire it into the Xcode project build phases with this exact contract:

- source entrypoint: `packages/host/src/sidecar-entry.js`
- staged JS path: `${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/host-sidecar/peartube-host-sidecar.js`
- staged launcher path: `${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/host-sidecar/run-host-sidecar.sh`
- launcher contents:

```bash
#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env bare "$SCRIPT_DIR/peartube-host-sidecar.js" "$@"
```

`HostSidecarController.swift` should later spawn `run-host-sidecar.sh` directly.

- [ ] **Step 5: Implement the minimal native app skeleton**

Add:

- `PearTubeDesktopApp.swift` with a root `WindowGroup`
- `AppModel.swift` with observable presentation state and `init(hostClient: HostClientProtocol)`
- `HostClientProtocol.swift` with the browse/detail/play methods the app model needs
- `VideoSummary.swift` with only the fields needed for browse/detail/play

- [ ] **Step 6: Re-run the native test**

Run: `xcodebuild test -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS'`

Expected: PASS for `AppModelTests`.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop-native/PearTubeDesktop.xcodeproj packages/desktop-native/PearTubeDesktop packages/desktop-native/scripts/stage-host-sidecar.sh packages/desktop-native/PearTubeDesktopTests/AppModelTests.swift
git commit -m "feat: scaffold native macOS shell"
```

### Task 8: Add the host sidecar controller and Swift protocol bridge

**Files:**
- Create: `packages/desktop-native/PearTubeDesktop/App/HostSidecarController.swift`
- Modify: `packages/desktop-native/PearTubeDesktop/Protocol/HostClientProtocol.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Protocol/HostClient.swift`
- Create: `packages/desktop-native/PearTubeDesktopTests/HostClientTests.swift`

- [ ] **Step 1: Write the failing host-client tests**

Create tests for:

```swift
final class HostClientTests: XCTestCase {
    func testHandshakeRequiresProtocolVersionOne() async throws {
        let transport = FakeHostTransport(handshakeJSON: #"{"status":{"blobServerPort":7777,"protocolVersion":2}}"#)
        let client = HostClient(transport: transport)

        do {
            _ = try await client.connect()
            XCTFail("Expected protocol version mismatch")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .protocolVersionMismatch(expected: 1, actual: 2))
        }
    }

    func testVideoStatsEventDecodesIntoAppEvent() async throws {
        let transport = FakeHostTransport(handshakeJSON: #"{"status":{"blobServerPort":7777,"protocolVersion":1}}"#)
        let client = HostClient(transport: transport)
        let event = try client.decodeEvent(Data(#"{"type":"video.stats","channelKey":"chan","videoId":"vid","stats":{"progress":0.5}}"#.utf8))

        XCTAssertEqual(event, .videoStats(channelKey: "chan", videoId: "vid", progress: 0.5))
    }
}
```

- [ ] **Step 2: Run the host-client tests and verify they fail**

Run: `xcodebuild test -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS' -only-testing:PearTubeDesktopTests/HostClientTests`

Expected: FAIL because the sidecar controller and host client do not exist yet.

- [ ] **Step 3: Implement `HostSidecarController.swift`**

Use `Process` plus paired `Pipe` streams to:

- launch the bundled Bare host sidecar
- stream bytes to and from the host
- terminate the child process cleanly

- [ ] **Step 4: Implement `HostClientProtocol.swift` and `HostClient.swift`**

Keep responsibilities narrow:

- `HostClientProtocol.swift`: define only the browse/detail/play methods `AppModel` needs
- framed byte transport
- initial handshake using `getStatus`
- protocol-version validation
- typed event decoding for the native shell

- [ ] **Step 5: Re-run the host-client tests**

Run: `xcodebuild test -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS' -only-testing:PearTubeDesktopTests/HostClientTests`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop-native/PearTubeDesktop/App/HostSidecarController.swift packages/desktop-native/PearTubeDesktop/Protocol/HostClientProtocol.swift packages/desktop-native/PearTubeDesktop/Protocol/HostClient.swift packages/desktop-native/PearTubeDesktopTests/HostClientTests.swift
git commit -m "feat: add native host sidecar bridge"
```

### Task 9: Build the browse, detail, and play flow

**Files:**
- Create: `packages/desktop-native/PearTubeDesktop/Views/SidebarView.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/HomeFeedView.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/VideoDetailView.swift`
- Create: `packages/desktop-native/PearTubeDesktop/Views/PlayerView.swift`
- Modify: `packages/desktop-native/PearTubeDesktop/App/AppModel.swift`
- Modify: `packages/desktop-native/PearTubeDesktop/App/PearTubeDesktopApp.swift`

- [ ] **Step 1: Write the failing browse-to-play model test**

Add this explicit injection seam to the plan:

```swift
protocol HostClientProtocol {
    func loadHomeFeed() async throws -> [VideoSummary]
    func loadVideoDetail(channelKey: String, videoId: String) async throws -> VideoSummary
    func resolvePlaybackURL(channelKey: String, videoId: String) async throws -> URL
}
```

Then add an `AppModelTests` case that:

- injects a `FakeHostClient: HostClientProtocol`
- loads a feed response
- selects a video
- resolves a playback URL
- asserts `currentPlaybackURL` becomes non-nil

- [ ] **Step 2: Run the model tests and verify they fail**

Run: `xcodebuild test -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS' -only-testing:PearTubeDesktopTests/AppModelTests`

Expected: FAIL because browse/detail/play state transitions are not wired yet.

- [ ] **Step 3: Implement browse and detail presentation**

Build the smallest useful UI:

- `SidebarView.swift`: primary navigation
- `HomeFeedView.swift`: feed list
- `VideoDetailView.swift`: selected video metadata

Keep view models inside `AppModel.swift`; do not put transport logic in SwiftUI views.

- [ ] **Step 4: Implement playback with `AVPlayer`**

Add `PlayerView.swift` that accepts a resolved URL and builds the first native player path with `AVPlayer`.

- [ ] **Step 5: Wire the app entry point**

Update `PearTubeDesktopApp.swift` so app launch starts the sidecar, loads initial data, and renders the browse-to-detail-to-play flow.

- [ ] **Step 6: Re-run tests**

Run: `xcodebuild test -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS'`

Expected: PASS for `AppModelTests` and `HostClientTests`.

- [ ] **Step 7: Build the app**

Run: `xcodebuild build -project packages/desktop-native/PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -destination 'platform=macOS'`

Expected: BUILD SUCCEEDED.

- [ ] **Step 8: Commit**

```bash
git add packages/desktop-native/PearTubeDesktop/App/AppModel.swift packages/desktop-native/PearTubeDesktop/App/PearTubeDesktopApp.swift packages/desktop-native/PearTubeDesktop/Views/SidebarView.swift packages/desktop-native/PearTubeDesktop/Views/HomeFeedView.swift packages/desktop-native/PearTubeDesktop/Views/VideoDetailView.swift packages/desktop-native/PearTubeDesktop/Views/PlayerView.swift packages/desktop-native/PearTubeDesktopTests/AppModelTests.swift
git commit -m "feat: add native browse to play flow"
```

## Done Criteria

- `@peartube/host` owns shared backend bootstrap.
- `@peartube/protocol` owns lifecycle, event names, and client grouping over HRPC.
- Mobile and legacy desktop adapters compile against the same host-launch shape.
- The current app still boots on mobile and the old desktop path after the adapter refactor.
- The new macOS app launches, loads feed data, shows a selected video, and plays it through `AVPlayer`.

## Deferred After This Plan

- settings parity
- upload or studio UI in the native shell
- download management UI
- cast UI in the native shell
- full removal of the old desktop path
