# Task: Speed up seeded/available video checks in discovery feed

## Problem
User reports that checking whether discovered videos are seeded/available in the discovery feed is too slow.

## Goal
Find where availability/seeded checks happen for the discovery feed and speed them up.

## Likely relevant areas
- `packages/backend/src/public-feed.js`
- `packages/backend/src/api.js`
- `packages/backend/src/storage.js`
- `packages/app/app/(tabs)/index.tsx`
- `packages/app/lib/feed-hydration.js`
- `packages/core/src/hooks/useP2PVideo.ts`

## Questions
1. Where is the seeded/available status computed today?
2. Is it doing per-video async checks serially?
3. Are we reopening storage/feeds repeatedly?
4. Can we batch, cache, or lazily hydrate availability?
5. Can we show feed items immediately and fill in availability later?

## Deliverable
- Diagnose bottleneck
- Propose smallest safe speedup first
- Then implement

## New architecture idea to evaluate
User proposed a protocol-level speedup:
- when a peer starts watching a video, it can advertise that it has some blocks for that video
- other peers browsing the discovery feed can query that state to determine likely watchability
- maybe use `protomux-rpc-pool` for scale

### Evaluation
This is a promising long-term direction, but the best version is likely:
- DO NOT join each video topic just to test watchability
- DO use the already-open public-feed peer connections and add a lightweight availability-hint RPC over them

Why this is better:
1. Joining every video topic during feed browsing would create huge network fan-out
2. Existing public-feed connections already give us a peer graph we can query cheaply
3. `protomux-rpc-pool` could help multiplex and reuse those peer RPC channels efficiently

### Important nuance
A peer saying "I watched some of this video" is not enough by itself.
We likely need a better signal such as:
- has head block
- contiguous prefix available up to X bytes or X blocks
- last-seen timestamp / TTL
- maybe whether peer is actively serving this blobs core now

That makes the feed status a soft hint like:
- `watchable_likely`
- `watchable_unknown`
- `watchable_unlikely`

rather than pretending we know exact playback success from one hint.

### Likely best staged plan
1. Immediate fix: remove networked availability probing from discovery hydration entirely; show videos fast
2. Medium-term: add per-peer availability hints over existing public-feed connections
3. Later: optionally back those hints with `protomux-rpc-pool` if the peer-count/query volume justifies it

## Discussion

## Codex Proposal

### Independent diagnosis
- The slow path is in `packages/backend/src/api.js` inside `listVideos()`, specifically `attachVideoAvailability()` and `probeVideoAvailability()`.
- Discovery hydration in `packages/app/app/(tabs)/index.tsx` calls `rpc.listVideos()` for up to 15 discovered channels at once via `Promise.all(...)`.
- Each `listVideos()` call then probes availability for up to 8 videos (`MAX_PROBES = 8`). In the worst common case that is 15 x 8 = 120 availability probes per feed refresh/reload.
- Each probe currently does relatively expensive work:
  - `ctx.store.get({ key })` + `core.ready()`
  - `retainSwarmDiscovery(...)`
  - `core.has(...)` for full range
  - another `core.has(...)` for head blocks
  - potentially `core.update({ wait: true })` with up to 1.2s timeout
  - then another `core.has(...)`
- `attachVideoAvailability()` waits for all selected probes before `listVideos()` returns, so the feed hydration path is blocked on seeded/available checks rather than returning metadata quickly.
- The frontend then filters to `availability === 'playable'`, so videos with `unknown` are hidden instead of being rendered and updated later. That makes the synchronous probe cost user-visible.

### What already looks good
- `loadChannel()` already has cache + in-flight dedupe.
- `loadPublicBee()` already has cache + in-flight dedupe.
- Swarm discovery joins are retained in `retainSwarmDiscovery()`, so repeated `join()` calls are somewhat amortized.

### Main inefficiencies
1. Per-video probing is repeated inside each channel load
   - The same `blobsCoreKey` can be reopened/probed multiple times across videos and refreshes.
   - There is no shared in-flight dedupe for availability probes.

2. Availability checks are on the critical path
   - `listVideos()` does not return until probing completes for the first batch of videos.
   - On a slow or cold network, many probes hit the 1.2s update timeout.

3. Cache TTLs are too short for discovery browsing
   - `VIDEO_AVAILABILITY_CACHE_TTL_MS = 5_000` is short enough that tab remounts / feed refresh / periodic polling can re-trigger the same work almost immediately.
   - Positive results especially should live longer than negative/unknown results.

4. No batching by blobs core
   - Multiple videos from one channel often share the same blobs core, but the code probes them independently instead of grouping by `blobsCoreKey` and reusing one prepared core handle.

5. Too much eager hydration from the app side
   - Home screen loads videos from up to 15 channels immediately.
   - That is reasonable for metadata listing, but too aggressive if every channel also does availability probing before returning.

### Optimization plan

#### 1) Smallest safe speedup first: remove blocking availability probes from initial discovery hydration
- Keep `listVideos()` fast for discovery by returning video metadata immediately.
- For discovery/feed usage, attach only cached availability if present; otherwise return `unknown`/`unchecked` without waiting on network probes.
- Trigger availability refresh in the background instead of awaiting it.
- UI should render discovery items immediately and not require `playable` before showing cards.
- This is the biggest user-perceived win with the smallest semantic change.

Suggested shape:
- Add a mode flag to backend listing, e.g. `listVideos({ availabilityMode: 'cached' | 'probe' | 'none' })`
- Discovery feed uses `cached` (or `none`)
- Channel detail / playback prep can use `probe`

#### 2) Batch probes by `blobsCoreKey`
- Replace per-video `probeVideoAvailability(video)` calls with a batch planner:
  - group candidate videos by `blobsCoreKey`
  - open each core once
  - call `retainSwarmDiscovery()` once per core
  - run `core.has(...)` checks for all candidate ranges on that core
  - if needed, do at most one `core.update({ wait: true })` per core, not per video
  - re-check the relevant head ranges after the update
- This should collapse repeated readiness/update work dramatically for channels whose videos live in the same blobs core.

#### 3) Add in-flight dedupe for availability work
- Introduce an in-memory `videoAvailabilityInflight` map keyed by a stable tuple such as `${blobsCoreKey}:${blockOffset}:${blockLength}`.
- Concurrent discovery refreshes, remounts, and overlapping `listVideos()` calls should await the same promise instead of launching duplicate probes.
- Consider a second-level `coreAvailabilityInflight` keyed only by `blobsCoreKey` for batch/core prep operations.

#### 4) Use asymmetric caching
- Positive/playable cache TTL: longer (30-120s)
- Negative/unavailable cache TTL: medium (10-30s)
- Unknown/probe-timeout cache TTL: short (2-5s) or stale-while-revalidate
- Discovery browsing benefits much more from reusing the last known answer than from aggressively re-probing every few seconds.

#### 5) Lazy hydration on the frontend
- Do not hydrate all 15 channels equally on first paint.
- Prioritize:
  - channels currently visible on screen
  - top 1-2 newest videos per channel
  - channels the user opens explicitly
- A simple first step is to reduce eager discovery video loads from 15 channels to a smaller visible window, then load more as the user scrolls.
- Even without virtualization changes, the UI can request metadata immediately and defer deeper availability checks until interaction/visibility.

#### 6) Stop filtering the feed entirely on synchronous `playable`
- Current feed hydration keeps only `availability === 'playable'` in `index.tsx`.
- That couples rendering to backend availability probes.
- Better approach:
  - render items with cached/unknown availability
  - visually indicate pending availability if needed
  - sort playable items higher once known
  - do the strict availability check when playback begins or when a card enters the visible window

### Recommended implementation order
1. Discovery `listVideos()` path returns immediately with cached-or-unknown availability only.
2. Frontend stops hiding all `unknown` items in the discovery feed.
3. Add batched backend availability probing grouped by `blobsCoreKey`.
4. Add in-flight dedupe maps for availability probes.
5. Extend TTLs and use asymmetric cache policy.
6. Later, narrow feed hydration to visible channels/videos only.

### Expected outcome
- Much faster initial discovery feed render.
- Far fewer duplicate `core.ready()` / `core.update()` calls.
- Reduced swarm thrash from repeated availability probing.
- Better cache reuse across remounts and periodic refreshes.
- Availability becomes progressive metadata rather than a hard blocker for showing discovery content.

## Claude Proposal
Most likely bottleneck: discovery feed hydration is doing per-video availability probes inside `packages/backend/src/api.js:listVideos()`, and the home screen calls that across many channels at once.

Why this is probably the slow path:
- `packages/app/app/(tabs)/index.tsx` calls `rpc.listVideos({ channelKey, publicBeeKey })` for up to 15 feed entries in parallel during `loadFeedVideos()`.
- Each backend `listVideos()` call then runs `attachVideoAvailability()` on up to 8 videos.
- Each `probeVideoAvailability()` is internally serial for that video: `core.ready()` -> optional swarm join via `retainSwarmDiscovery()` -> `core.has(full)` -> `core.has(head)` -> `core.update({ wait: true })` with timeout -> `core.has(head)` again.
- So the feed can trigger roughly 15 channels × 8 probes = 120 blob availability checks during one hydration pass, and each check may wake networking and wait on replication.

What is repeated/uncached today:
- The checks are parallel across videos/channels, but each individual video check is serial and potentially network-blocking.
- The same checks are repeated whenever the index screen reloads feed videos, on feed updates, refresh, foregrounding, and channel view opens.
- There is a cache, but `videoAvailabilityCache` TTL is only 5 seconds, so it is effectively too short for discovery feed browsing and does not suppress much repeated work.
- `listVideosCache` helps only per channel for 15 seconds, but once it expires the expensive availability probing runs again for that whole channel.

Smallest robust performance fix:
- Stop doing networked availability probing in discovery-feed `listVideos()` hydration.
- For the discovery/public-feed path (especially when `publicBeeKey` is present), return videos immediately after `listVideos()`/metadata enrichment and leave `availability` as `unknown` unless the blob is already locally cached from a cheap `core.has(...)` check.
- Move the stronger availability check to lazy/on-demand paths such as `preparePlayback()` / actual play intent, where paying the network wait cost is justified for one selected video instead of every discovered video.

Why this is the safest minimal fix:
- It avoids the current repeated mass fan-out of uncached blob probes without changing feed discovery itself.
- It preserves correctness because actual playback already has a dedicated preparation path.
- It lets the feed render immediately and only spends network time on videos the user actually opens.
- If we still want a tiny bit of precomputed signal, keep only a local cached/head-available check in `listVideos()` and never call `core.update({ wait: true })` from feed hydration.
