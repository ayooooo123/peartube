# Task: Exclude unseeded/unwatchable videos from discovery feed

## Current problem
After making feed hydration non-blocking and adding availability-hint RPCs, the discovery feed now shows some videos that still fail when clicked. That means our current policy is too optimistic.

## Current backend behavior
- local cheap checks can mark a video `playable`
- otherwise it becomes `unknown`
- peer hint RPCs are queried for `unknown`
- frontend currently renders everything except explicit `unavailable`

## Goal
Tighten the policy so feed items are excluded unless they are actually likely playable.

## Candidate fix
If there are feed peers available and a video remains `unknown` after:
- local cheap check
- hint RPC query to peers
then classify it as `unavailable` for discovery feed purposes.

This gives us:
- local playable => show
- peer hinted playable => show
- no positive evidence after hint query => hide

Potential tuning:
- increase hint timeout slightly (e.g. 250 -> 400ms)
- ask a few more peers (e.g. 4 -> 6)

## Discussion

## Codex Proposal
I would tighten this in two layers, with the backend owning the real policy and the frontend adding a safety rail.

### 1. Backend: treat unresolved `unknown` as hidden when peers were actually consulted
The current leak is easy to see in code:
- `packages/backend/src/api.js` only upgrades `unknown` -> `playable` after `publicFeed.requestAvailabilityHints(...)`
- otherwise it leaves the item as `unknown`
- `packages/app/app/(tabs)/index.tsx` renders everything except explicit `unavailable`

That means any item that fails the local cheap check and also gets no positive hint still survives as `unknown` and is shown.

My recommendation:
- keep the local cheap check exactly as the first gate
- for videos still `unknown`, query feed peers
- if there were feed peers available and the hint round completed with no positive `playable` evidence, downgrade that video to `unavailable` for discovery/feed listing purposes
- only preserve `unknown` when we could not meaningfully test, e.g. no feed peers connected, malformed blob metadata, or the hint path was skipped entirely

This is stricter than the current optimistic policy, but it matches the product goal better: discovery should require positive evidence, not absence of negative evidence.

I would keep this as a discovery-specific policy, not necessarily a universal truth stored everywhere. In other words: `unknown` can still exist internally, but `listVideos` for feed hydration should translate "unknown after local + peer probe" into hidden/unavailable.

### 2. Backend tuning: increase peer query budget modestly, not aggressively
Current values in `packages/backend/src/api.js` are:
- `timeoutMs: 250`
- `maxPeers: 4`

And `packages/backend/src/public-feed.js` fans the same request out to up to `maxPeers` current feed connections.

I would raise this conservatively to roughly:
- `timeoutMs: 350-400ms`
- `maxPeers: 6`

Why:
- 250ms is fast, but likely too short for mobile peers or freshly-opened multiplexed connections
- 6 peers is still bounded and cheap for a tiny local-only hint RPC
- this improves the chance of getting one positive answer without making feed hydration feel blocked for seconds

I would not go much higher unless logs show the misses are still dominated by late positive replies. This RPC is best used as a short confirmation sweep, not a full availability search.

A practical refinement would be:
- return early as soon as any peer reports `playable` for a given video
- otherwise wait until the timeout expires, then classify unresolved items as unavailable if peers were queried

### 3. Frontend: yes, revert discovery rendering to playable-only
I think the frontend should revert to playable-only rendering for the discovery surface, at least until the stricter backend policy is in place and validated.

Reason:
- today the backend still returns many `unknown` items, including any entries outside the initial sampled probe set in `attachVideoAvailability`
- the home feed and channel view currently filter only `unavailable`, so `unknown` is effectively treated as showable
- that is exactly the failure mode users are seeing

So my frontend recommendation is:
- discovery/home feed: render only `playable`
- optionally keep channel detail/manual browsing looser if desired, but if the immediate priority is "never show unwatchable feed items", playable-only is the safest choice

If you only make one fast mitigation, this frontend revert is the most reliable stopgap. If you want the cleaner long-term fix, combine it with the backend downgrade rule above so the API itself becomes conservative.

### 4. One extra backend concern: current sampling is itself optimistic
`attachVideoAvailability` only probes the first `MAX_PROBES = 8` videos, then assigns all remaining entries their default mapped state (`unknown`). With the current frontend rule, those unprobed videos are still rendered.

So even after changing the peer-hint rule, I would also tighten one of these:
- either only render videos that were actually probed and came back `playable`
- or make the backend mark unprobed remainder as hidden for discovery batches
- or increase/adjust probing so the sorted slice that will actually be displayed gets probed before returning results

Otherwise the policy can still leak unverified items through the `unknown` bucket.

### Bottom line
My preferred policy is:
- local playable => show
- peer-hinted playable => show
- local unknown + peer query produced no playable evidence while peers were available => unavailable/hide
- no peers / no real probe possible => remain unknown internally, but do not render in discovery unless product explicitly wants optimistic placeholders

That gives discovery a positive-evidence standard and should stop the current class of click-through failures.

## Claude Proposal
Make the backend, not the frontend, own the stricter discovery-feed policy.

Smallest robust change:
- in `packages/backend/src/api.js` inside `attachVideoAvailability`, keep the current local cheap check first
- keep the hint RPC fanout for videos still marked `unknown`
- after that hint round, if `publicFeed.getStats().peerCount > 0` (or equivalent evidence that feed peers are present) and a probed video is still `unknown`, reclassify it to `unavailable`
- leave `unknown` unchanged only when there are no feed peers to ask yet

Resulting rule for discovery feed items:
- `playable` => show
- `unavailable` => hide
- `unknown` with no peers available yet => may still show as a startup/offline fallback
- `unknown` after peers were available and hints still gave no positive evidence => treat as `unavailable` and hide

Why this is the smallest robust fix:
- the frontend filter in `packages/app/app/(tabs)/index.tsx` already excludes only explicit `unavailable`
- so the minimal policy change is to make backend classification stricter rather than adding more frontend heuristics
- this avoids duplicating peer-awareness in the UI and keeps channel/feed consumers consistent

Decision on the open question:
Yes: unresolved `unknown` should become `unavailable` once peers are present and the hint query has already failed to find positive evidence. For discovery feed purposes, absence of positive evidence after an actual peer query is negative enough, because the current product failure is "shows in feed, fails on click." False negatives are preferable here to false positives.

Optional tuning only if needed after this change:
- bump hint timeout modestly (for example 250ms -> 400ms)
- ask a few more peers (for example 4 -> 6)

But the core policy change should be the reclassification above, not a frontend filter tweak.
