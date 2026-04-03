# Task: Fix discovery feed staying empty

## Symptom
Discovery feed stays empty / videos never appear.

## Relevant recent work
There was recent work on:
- feed hydration
- public feed availability
- public bee loader
- startup gates
- public-feed manager / storage / orchestrator integration

Potentially relevant files:
- `packages/app/app/(tabs)/index.tsx`
- `packages/app/lib/feed-hydration.js`
- `packages/app/app/_layout.tsx`
- `packages/backend/src/public-feed.js`
- `packages/backend/src/public-bee-loader.js`
- `packages/backend/src/startup-gates.js`
- `packages/backend/src/storage.js`
- `packages/backend/src/orchestrator.js`
- related tests in app/backend packages

## Goal
Find the smallest coherent fix for the current failure mode where the discovery feed remains empty.

## Questions
1. Is the frontend not requesting hydration / refresh correctly?
2. Is backend gating withholding public-feed readiness forever?
3. Is the public bee loader returning no entries due to a race or filter?
4. Did recent startup/lazy init changes break feed availability?

## Deliverable
- diagnosis of why feed stays empty now
- smallest code fix
- preserve recent hydration/startup work if possible

## Discussion

## Hermes Review
Most likely root cause: the backend now restores cached discovered channels at startup, but immediately filters them back out before the app can ever see them.

Why this is the best fit:
- `packages/backend/src/public-feed.js:start()` explicitly restores `discovered-channels-v2` / legacy cache and even says this is so "UIs don't come up empty on restart."
- But `packages/backend/src/public-feed.js:getFeed()` drops every peer entry whose live `peerCount` is `0`:
  - it only keeps `entry.source === 'local' || (entry.peerCount || 0) > 0`
- Restored cached entries are added as `source: 'peer'`, and on startup they have no live announcing peer yet, so their computed `peerCount` is `0`.
- The frontend only hydrates videos if `getPublicFeed()` returns entries (`getFeedVideoHydrationMode()` returns `'off'` when `feedEntries.length === 0`). So once backend filtering removes the restored entries, the discovery pipeline never even tries `listVideos` / `loadPublicBee` for them.

Why this likely showed up after the recent changes:
- Recent work added persistence/restore of discovered channels and moved more of discovery to the PublicBee fast path.
- That means the intended startup path is now: restore keyed entries -> surface them to UI immediately -> let viewers hydrate via `publicBeeKey` even before a fresh gossip round.
- The current `getFeed()` filter still reflects the older "only show currently announced peers" rule, which now contradicts the restore-and-hydrate design.

Smallest robust fix:
- In `packages/backend/src/public-feed.js`, change `getFeed()` so peer entries with a valid `publicBeeKey` are still returned even when current `peerCount === 0`.
- Keep hiding truly unusable entries (for example, unkeyed peer entries), but do not require a live announcer for cached/restored PublicBee-backed entries.

Concretely, the keep/show rule should become effectively:
- keep local entries, and
- keep peer entries if they either have `peerCount > 0` or have a valid `publicBeeKey`

Why this is the smallest safe fix:
- No frontend changes are required.
- No startup-gate/orchestrator behavior needs to change.
- It preserves the newer PublicBee-only discovery model.
- It makes the existing cache-restore code actually do what its comments say.
- It allows discovery to work in the common case where no peer is actively re-announcing at the exact moment the app opens, but the viewer can still join the stored PublicBee discovery key and fetch videos.

Secondary issue worth noting, but probably not the primary empty-feed bug:
- `sendHaveFeed()` and peer `addEntry(..., 'peer', ...)` now require valid `publicBeeKey`s. If some publishers still have legacy published entries without a persisted `publicBeeKey`, they will also be effectively invisible to peers. That is real, but the more direct contradiction in the current startup pipeline is the cached entries being restored and then filtered out.
