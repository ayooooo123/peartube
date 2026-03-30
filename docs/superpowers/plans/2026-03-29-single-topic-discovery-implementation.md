# Single-Topic Discovery and Feed Hydration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate PearTube from dual app-level discovery topics to a single `peartube-network` topic, make public-feed sync connection-driven over Protomux, and then reduce cached-feed hydration churn so the first discovered peer pays off immediately.

**Architecture:** Keep Hyperswarm topic-based discovery, but use `peartube-network` as the only app-level discovery surface. Refactor `PublicFeedManager` so it restores cache and attaches a Protomux feed channel to shared swarm connections instead of joining `peartube-public-feed-v1`. Gate background warm-up behind first useful network state, then tighten cached feed hydration by deduping `PublicBee` loads and reducing duplicate feed-screen fetches.

**Tech Stack:** Hyperswarm, Protomux, Protomux-wakeup, Hyperbee, Corestore, React Native, Expo Router, brittle, Node `node:test`

---

## File Structure

### Shared discovery protocol and constants

- Modify: `packages/backend/src/types.js`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/core/src/utils/index.ts`
- Modify: `packages/backend/src/public-feed.js`
- Create: `packages/backend/test/public-feed-manager.test.mjs`
- Modify: `packages/backend/test/public-feed-api.test.mjs`

Responsibilities:

- `types.js`: keep the public-feed protocol name, remove the old feed discovery topic constant.
- `index.js`: export only the remaining protocol-facing constants.
- `core/src/utils/index.ts`: remove the stale public-feed topic export so app code stops depending on it.
- `public-feed.js`: restore feed cache, pair/open the feed protocol on shared swarm connections, emit lifecycle hooks for first useful connection state, and stop joining `peartube-public-feed-v1`.
- `public-feed-manager.test.mjs`: cover single-topic startup behavior, connection pairing, and first-open sync semantics.
- `public-feed-api.test.mjs`: keep API shaping stable while the manager implementation changes underneath it.

### Relay and runtime alignment

- Modify: `packages/cli/src/runtime.js`
- Modify: `packages/cli/src/service.js`
- Modify: `packages/cli/test/service.test.mjs`

Responsibilities:

- `runtime.js`: rely on shared `peartube-network` discovery plus Protomux feed channels opened on swarm connections.
- `service.js`: stop doing a startup-time feed request that often hits zero open channels.
- `service.test.mjs`: verify the relay still starts, mirrors candidates, and reports network stats after the connection-driven flow change.

### Startup gating and network milestones

- Create: `packages/backend/src/startup-gates.js`
- Create: `packages/backend/test/startup-gates.test.mjs`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/storage.js`
- Modify: `packages/app/tests/native-backend-startup-regression.test.mjs`

Responsibilities:

- `startup-gates.js`: hold the small, pure policy for when background warm-up is allowed to start.
- `startup-gates.test.mjs`: prove the warm-up gate stays closed before the first useful peer and opens once the backend sees useful network state.
- `orchestrator.js`: remove the eager startup feed request and gate `loadChannelDrives()` / warm-up behind the new milestone flow.
- `storage.js`: keep joining `peartube-network`, surface first-peer state, and keep replication/wakeup wiring on shared connections.
- `native-backend-startup-regression.test.mjs`: pin the startup policy so future changes do not reintroduce eager second-topic work or feed requests at boot.

### Cached feed hydration and duplicate-work reduction

- Create: `packages/backend/src/public-bee-loader.js`
- Create: `packages/backend/test/public-bee-loader.test.mjs`
- Modify: `packages/backend/src/storage.js`
- Create: `packages/app/lib/feed-hydration.js`
- Create: `packages/app/tests/feed-hydration.test.mjs`
- Modify: `packages/app/app/(tabs)/index.tsx`

Responsibilities:

- `public-bee-loader.js`: dedupe concurrent `loadPublicBee` requests so repeated metadata/video fetches share the same in-flight work.
- `public-bee-loader.test.mjs`: cover in-flight dedupe and cache population behavior.
- `storage.js`: route `loadPublicBee()` through the deduping loader.
- `feed-hydration.js`: compute missing-meta fetch sets and decide when automatic feed-video loading is allowed.
- `feed-hydration.test.mjs`: prove visible-first and milestone-gated hydration decisions.
- `index.tsx`: stop fanning out duplicate `getChannelMeta` / `joinChannel` / `listVideos` work before the first peer is useful.

## Chunk 1: Single-Topic Public Feed Protocol

### Task 1: Add failing backend tests for single-topic feed behavior

**Files:**
- Create: `packages/backend/test/public-feed-manager.test.mjs`
- Modify: `packages/backend/test/public-feed-api.test.mjs`

- [ ] **Step 1: Write the failing test**

Add tests for:

```js
test('PublicFeedManager.start restores cache without joining a feed topic', async (t) => {
  // fake swarm.join should not be called from start()
})

test('handleConnection pairs and opens one feed channel per connection', async (t) => {
  // duplicate handleConnection calls should be idempotent
})

test('feed channel open sends HAVE_FEED immediately', async (t) => {
  // opening the feed channel should push one HAVE_FEED payload
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx brittle packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-api.test.mjs
```

Expected: FAIL because `PublicFeedManager.start()` still calls `swarm.join(this.feedTopic, ...)` and the current connection flow does not use the pairing-based single-topic contract.

- [ ] **Step 3: Write minimal implementation**

Update the protocol surface:

```js
// packages/backend/src/types.js
export const PROTOCOL_NAME = 'peartube-feed'
```

Refactor `PublicFeedManager` so:

```js
start() {
  this.started = true
  this._restorePublishedAndCachedEntries()
  for (const conn of this.swarm.connections) this.handleConnection(conn, {})
}

handleConnection(conn) {
  const mux = Protomux.from(conn)
  mux.pair({ protocol: PROTOCOL_NAME }, () => this._createFeedChannel(mux, conn))
  this._createFeedChannel(mux, conn)
}
```

And delete feed-topic discovery ownership from `public-feed.js`:

- remove `feedTopic`
- remove `_feedDiscovery`
- remove the `swarm.join(this.feedTopic, ...)` block from `start()`
- keep cache restore and listener notification behavior

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx brittle packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-api.test.mjs
```

Expected: PASS with the manager using only shared swarm connections.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/types.js packages/backend/src/index.js packages/core/src/utils/index.ts packages/backend/src/public-feed.js packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-api.test.mjs
git commit -m "refactor: move public feed to single-topic discovery"
```

### Task 2: Align the CLI relay with connection-driven feed sync

**Files:**
- Modify: `packages/cli/src/runtime.js`
- Modify: `packages/cli/src/service.js`
- Modify: `packages/cli/test/service.test.mjs`

- [ ] **Step 1: Write the failing test**

Update `packages/cli/test/service.test.mjs` so startup no longer expects a proactive feed-sync request:

```js
test('createRelayService starts without forcing an eager feed sync', async (t) => {
  // requestFeedSync should not be called during start()
})
```

Also keep one positive test that discovered candidates still flow through `setCandidateHandler(...)`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx brittle packages/cli/test/service.test.mjs
```

Expected: FAIL because `createRelayService.start()` still calls `runtime.requestFeedSync()` and logs a startup feed-sync message.

- [ ] **Step 3: Write minimal implementation**

Remove the eager startup feed sync path:

```js
// packages/cli/src/service.js
await runtime.start?.()
// no requestFeedSync call here
```

Keep `requestFeedSync()` as a manual hook if the runtime still exposes it, but do not invoke it during relay boot. Ensure the relay startup summary still reports `peers`, `connections`, and `feedConnections` from `runtime.getNetworkStats()`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx brittle packages/cli/test/service.test.mjs
```

Expected: PASS with relay startup depending on connection-opened feed channels instead of an early zero-peer request.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime.js packages/cli/src/service.js packages/cli/test/service.test.mjs
git commit -m "refactor: remove eager relay feed sync"
```

## Chunk 2: Startup Gating Around First Useful Peer

### Task 3: Add failing tests for the background warm-up gate

**Files:**
- Create: `packages/backend/src/startup-gates.js`
- Create: `packages/backend/test/startup-gates.test.mjs`

- [ ] **Step 1: Write the failing test**

Add tests for a tiny pure policy module:

```js
test('warm-up stays blocked before the first useful peer state', (t) => {
  // expect shouldStartDeferredWarmup(...) === false
})

test('warm-up opens after first swarm peer or feed channel open', (t) => {
  // expect shouldStartDeferredWarmup(...) === true
})

test('visible feed hydration waits for stronger sync state than cache restore', (t) => {
  // expect shouldStartVisibleFeedHydration(...) to stay false until the right milestone
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx brittle packages/backend/test/startup-gates.test.mjs
```

Expected: FAIL because `startup-gates.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create the helper with explicit, boring predicates:

```js
export function shouldStartDeferredWarmup(state) {
  return Boolean(state.firstSwarmPeerAt || state.firstFeedChannelOpenAt || state.firstFeedSyncAt)
}

export function shouldStartVisibleFeedHydration(state) {
  return Boolean(state.firstFeedChannelOpenAt || state.firstFeedSyncAt || state.manualRefreshRequested)
}
```

Keep the helper pure so later orchestrator and app code can share the same milestone semantics.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx brittle packages/backend/test/startup-gates.test.mjs
```

Expected: PASS with a pure policy module in place.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/startup-gates.js packages/backend/test/startup-gates.test.mjs
git commit -m "test: define startup warm-up gate policy"
```

### Task 4: Wire orchestrator and storage to the new network milestones

**Files:**
- Modify: `packages/backend/src/public-feed.js`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/storage.js`
- Modify: `packages/app/tests/native-backend-startup-regression.test.mjs`

- [ ] **Step 1: Write the failing regression assertions**

Extend `packages/app/tests/native-backend-startup-regression.test.mjs` and add one focused backend assertion set so the code must show the new startup flow:

```js
assert.doesNotMatch(orchestratorSource, /publicFeed\.requestFeedsFromPeers\(\)/)
assert.match(publicFeedSource, /mux\.pair\(\{ protocol: PROTOCOL_NAME \}/)
assert.match(orchestratorSource, /shouldStartDeferredWarmup/)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx brittle packages/backend/test/public-feed-manager.test.mjs packages/backend/test/startup-gates.test.mjs
node --test packages/app/tests/native-backend-startup-regression.test.mjs
```

Expected: FAIL because the orchestrator still does eager startup refresh and deferred warm-up does not consult the new gate.

- [ ] **Step 3: Write minimal implementation**

In `public-feed.js`:

- add one-shot lifecycle hooks for:
  - first feed channel open
  - first feed sync received

In `storage.js`:

- keep `peartube-network` join as the only app-level discovery join
- add a one-shot callback or marker for first swarm connection

In `orchestrator.js`:

```js
await publicFeed.start()

defer(async () => {
  await waitForFirstUsefulNetworkState()
  await identityManager.loadChannelDrives()
  await warmChannels(...)
})
```

Specifically:

- delete the startup `publicFeed.requestFeedsFromPeers()` call
- gate `loadChannelDrives()` and `warmChannels(...)` behind first useful network state
- keep shutdown checks and background error handling intact

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npx brittle packages/backend/test/public-feed-manager.test.mjs packages/backend/test/startup-gates.test.mjs
node --test packages/app/tests/native-backend-startup-regression.test.mjs
```

Expected: PASS with no eager startup feed request and warm-up deferred until useful peer state exists.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/public-feed.js packages/backend/src/orchestrator.js packages/backend/src/storage.js packages/app/tests/native-backend-startup-regression.test.mjs
git commit -m "refactor: gate startup warm-up on useful peer state"
```

## Chunk 3: Cached Feed Hydration and Duplicate-Work Reduction

### Task 5: Add failing tests for in-flight `PublicBee` dedupe

**Files:**
- Create: `packages/backend/src/public-bee-loader.js`
- Create: `packages/backend/test/public-bee-loader.test.mjs`
- Modify: `packages/backend/src/storage.js`

- [ ] **Step 1: Write the failing test**

Add tests for a small loader abstraction:

```js
test('concurrent loads for the same public bee share one in-flight promise', async (t) => {
  // createBee should run once
})

test('resolved bees populate the long-lived cache after the shared load completes', async (t) => {
  // second call after resolve should hit cache
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx brittle packages/backend/test/public-bee-loader.test.mjs
```

Expected: FAIL because the loader abstraction does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create a loader that mirrors the existing `loadingChannels` behavior:

```js
export function createPublicBeeLoader({ createBee }) {
  const cache = new Map()
  const inflight = new Map()
  // return { load(key), clear(key) }
}
```

Then update `storage.js` so `loadPublicBee()` delegates to the loader instead of constructing a fresh `PublicChannelBee` for every concurrent request.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx brittle packages/backend/test/public-bee-loader.test.mjs
```

Expected: PASS with duplicate `loadPublicBee: loading ...` fan-out removed for concurrent callers.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/public-bee-loader.js packages/backend/test/public-bee-loader.test.mjs packages/backend/src/storage.js
git commit -m "perf: dedupe concurrent public bee loads"
```

### Task 6: Add failing feed-screen hydration tests and wire the Home tab to them

**Files:**
- Create: `packages/app/lib/feed-hydration.js`
- Create: `packages/app/tests/feed-hydration.test.mjs`
- Modify: `packages/app/app/(tabs)/index.tsx`

- [ ] **Step 1: Write the failing test**

Add pure-function tests that cover:

```js
test('missing channel-meta fetches are deduped per load cycle', () => {})
test('automatic feed-video loading stays off before the first useful peer milestone', () => {})
test('visible feed entries are prioritized before broader hydration', () => {})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test packages/app/tests/feed-hydration.test.mjs
```

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `feed-hydration.js` with small helpers such as:

```js
export function getMissingMetaKeys(entries, channelMeta) { /* unique keys only */ }
export function shouldAutoLoadFeedVideos({ peerCount, firstUsefulFeedState, feedEntries }) { /* boolean */ }
export function getVisibleFeedSlice(entries, limit = 15) { /* deterministic subset */ }
```

Then update `packages/app/app/(tabs)/index.tsx` so it:

- batches missing `getChannelMeta` requests once per feed load
- does not auto-run `loadFeedVideos()` while the screen is still in cache-only mode
- only fans out `joinChannel` / `listVideos` after the first useful peer/feed milestone or manual refresh
- keeps manual `refreshFeed()` behavior intact

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test packages/app/tests/feed-hydration.test.mjs
```

Expected: PASS with the feed screen using explicit hydration rules instead of repeated mount-time fan-out.

- [ ] **Step 5: Run focused startup regressions**

Run:

```bash
node --test packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/feed-hydration.test.mjs
```

Expected: PASS with both the backend startup guardrails and feed-screen hydration policy intact.

- [ ] **Step 6: Commit**

```bash
git add packages/app/lib/feed-hydration.js packages/app/tests/feed-hydration.test.mjs packages/app/app/'(tabs)'/index.tsx packages/app/tests/native-backend-startup-regression.test.mjs
git commit -m "perf: stage cached feed hydration after first peer"
```

## Out-Of-Repo Coordination

The Swift native desktop app is not in this workspace. Before shipping this repo-wide protocol change:

- update the Swift runtime to join `peartube-network` only
- remove `peartube-public-feed-v1` assumptions there as well
- keep the same public-feed Protomux protocol name and `HAVE_FEED` payload semantics

Do not deploy a mixed fleet expecting both discovery topologies to interoperate.

## Verification Sweep

After all chunks land, run:

```bash
npx brittle packages/backend/test/public-feed-manager.test.mjs packages/backend/test/public-feed-api.test.mjs packages/backend/test/startup-gates.test.mjs packages/backend/test/public-bee-loader.test.mjs
npx brittle packages/cli/test/service.test.mjs
node --test packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/feed-hydration.test.mjs
npm run typecheck --prefix packages/platform
```

If an Android device is available, also do one manual cold-start trace and confirm:

- only `peartube-network` is joined as an app-level topic
- no startup log shows `Sent HAVE_FEED to 0 peers`
- first `swarm.connection` is followed by a feed channel opening on the same connection
- the Home tab stays cache-backed before first peer, then hydrates progressively instead of fanning out duplicate requests immediately
