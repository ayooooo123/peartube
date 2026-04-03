# Task: Improve discovery feed breadth / initial sync so more channels/videos show up

## Current log evidence
- Public feed currently returns only 1 entry despite 2 peers:
  `[API] Returning 1 feed entries (2 peers, keyed=1, fallback=0, raw=1)`
- For that one channel, `LIST_VIDEOS` returns 0 via both PublicBee and channel fallback.

## Conclusion
The current empty feed is not primarily availability filtering. The bigger issue is discovery breadth / initial feed sync / hydration.

## Likely areas
- `packages/backend/src/public-feed.js`
  - initial HAVE_FEED exchange
  - requestFeedsFromPeers / sync behavior
  - peer entry pruning
- `packages/backend/src/orchestrator.js`
  - startup timing around publicFeed.start()
- `packages/app/app/(tabs)/index.tsx`
  - refresh cadence after feed sync

## Goal
Get more real feed entries quickly and avoid deciding the feed is empty too early.

## Candidate fixes
1. Aggressively re-request HAVE_FEED from peers for a short warm window after startup
2. Delay/prune peer entry removal less aggressively on transient connection churn
3. Trigger UI refresh/feed reload after each feed sync burst, not just initial load
4. Keep polling public feed briefly after app start while peer count > 0 and feed is still tiny

## Discussion

## Codex Proposal

### Independent diagnosis
- The narrow discovery result is mainly a sync-timing problem, not a final "no content exists" result.
- `packages/backend/src/public-feed.js` does send `HAVE_FEED` on channel open, but after that the only explicit re-request path is `requestFeedsFromPeers()`, which just re-sends once to currently wired peers and is only reached by manual/UI refresh or the 30s poll in `index.tsx`.
- That means startup can easily miss breadth if peers are connected but have not finished opening their own feed channel, loading published/discovered entries, or are briefly churning during the first few seconds.
- `public-feed.js` also prunes peer-discovered entries immediately in `_clearPeerFeedKeys()` when a connection closes/errors. Since `getFeed()` only returns peer entries with `peerCount > 0`, transient disconnects can collapse the feed back to 0/1 entries and make the app believe discovery is exhausted.
- In `packages/backend/src/orchestrator.js`, deferred warm-up currently focuses on identities/subscriptions/pins/seeds, but there is no short startup discovery burst that keeps asking peers for feed state during the initial network warm window.
- In `packages/app/app/(tabs)/index.tsx`, the home feed loads immediately and then refreshes every 30s. If the first `getPublicFeed()` lands before peer sync settles, the UI can show an effectively empty discovery state much too early.

### Practical fix plan
1. Add a backend startup warm-window sync burst
   - In `public-feed.js`, add a short-lived startup scheduler, for example 8-15 seconds total.
   - During that window, re-run `requestFeedsFromPeers()` on a fast cadence with backoff, e.g. immediately, 1s, 2s, 4s, 8s.
   - Also trigger a refresh when each new feed channel opens, but guard with a small debounce so multiple peers do not spam.
   - Goal: if a peer was connected before its feed protocol was ready, or if its entries arrive slightly later, we still solicit a broader `HAVE_FEED` set quickly.

2. Make `requestFeedsFromPeers()` a true sync nudge, not a one-shot manual action
   - Keep the existing resend of `HAVE_FEED`, since peers already treat that as the exchange trigger.
   - Extend it to optionally target only peers with no announced keys yet, plus a mode that targets all peers during startup warm-up.
   - Record `lastFeedRequestAt` / `lastFeedSyncAt` per connection so we can re-request peers that stay silent for the first few seconds.

3. Stop treating transient peer churn as authoritative feed disappearance
   - In `_clearPeerFeedKeys()`, do not immediately delete peer entries from `this.entries` when peer count falls to zero.
   - Instead, mark them stale with `lastSeen`, keep them in memory for a grace TTL (for example 2-10 minutes), and only hard-prune later.
   - Update `getFeed()` so recently seen peer entries remain eligible during the grace period, possibly surfaced as `peerCount: 0` but still discoverable.
   - This avoids the current pattern where a brief disconnect wipes out discovery breadth and causes premature empty-feed conclusions.

4. Persist and surface a "warm startup" state to the UI
   - In `orchestrator.js`, after `publicFeed.start()`, kick off the warm-window sync burst immediately rather than waiting for the deferred background phase.
   - Wire `onFeedSync` / `onFeedConnectionOpen` to refresh frontend-visible state more often during startup.
   - Expose enough status for the app to know: peers exist, feed sync is still warming, and empty feed is not yet final.

5. Make the app poll aggressively only while the result set is still tiny
   - In `index.tsx`, add a short warm polling loop for the first 10-20 seconds after mount/foreground/resume when `peerCount > 0` and `feedEntries.length` is still very small (for example `< 5`).
   - Example cadence: every 1-2 seconds during warm-up, then fall back to the current 30s interval.
   - Keep the existing backend event subscription, but do not rely on it alone because the backend may have connected peers before the broader feed exchange completes.

6. Avoid premature empty-feed UX
   - Gate the "No seeded videos discovered yet" empty state behind a stronger condition: only show it once the warm window has expired or peer count is actually zero.
   - Before then, show a softer status such as "Syncing discovery from peers…".
   - This matches the real backend state: connected peers plus tiny feed should be treated as incomplete sync, not final emptiness.

### Suggested implementation order
- First: backend warm-window re-request loop in `public-feed.js`.
- Second: entry-retention grace period instead of immediate prune on disconnect.
- Third: orchestrator startup hook so warm sync begins as soon as public feed starts.
- Fourth: frontend warm polling + delayed empty-state messaging.

### Expected impact
- More peers will contribute `HAVE_FEED` entries during the first startup seconds.
- Discovery breadth should grow from the current 1-entry/2-peer behavior without waiting for the 30s refresh interval.
- Temporary network churn will stop collapsing discovery back to empty, so initial sync will feel much more stable.

## Claude Proposal
Smallest robust fix: add a short backend warm-sync burst that re-requests peer feeds for the first few seconds after startup / first feed connection, instead of relying on the one-shot HAVE_FEED exchange plus the UI's 30s refresh interval.

Why this is the best small fix from the inspected files:
- `packages/backend/src/public-feed.js` already has `requestFeedsFromPeers()`, but it is only used when the UI explicitly calls `refreshFeed()`.
- `createFeedChannel(... onopen)` sends exactly one `HAVE_FEED` immediately. If that happens before the remote peer has finished loading/restoring its own published/discovered entries, we lock in a very narrow initial snapshot.
- `packages/app/app/(tabs)/index.tsx` already reloads on backend `onFeedUpdate`, so the UI is not the primary bottleneck. It also only does periodic refresh every 30s, which is too slow for initial discovery.
- `packages/backend/src/orchestrator.js` is the right place to schedule a temporary startup-only retry burst without changing feed semantics.

Proposed change:
- In `orchestrator.js`, after `publicFeed.start()` and/or on the first `onFeedConnectionOpen`, schedule a tiny bounded retry loop such as at ~0s / 2s / 5s / 10s:
  - call `publicFeed.requestFeedsFromPeers()`
  - stop early if there are no feed peers
  - optionally stop once the feed reaches a modest threshold (for example `getFeed().length >= 10`)
- Keep this startup-only; do not turn it into permanent aggressive polling.

Why this should help:
- It covers the race where peers connect before their local published/discovered feed has been fully restored or hydrated.
- It improves breadth quickly without touching availability filtering, video hydration, or peer pruning.
- It uses existing protocol behavior (`HAVE_FEED`) and requires the least code/risk.

What I would not choose as the first fix:
- UI-only polling in `index.tsx`: helpful, but it papers over a backend discovery timing issue and depends on the screen being open.
- Relaxing pruning in `public-feed.js`: logs point more toward under-sync at startup than churn-driven removal.
- Changing availability filtering: not the reported problem; the known discovered channel already had 0 videos.
