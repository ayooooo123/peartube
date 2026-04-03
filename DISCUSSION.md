# Task: Rebalance discovery feed speed vs correctness

## Problem
User reports discovery feed videos are loading impossibly slow.

## Current situation
We tightened correctness so only `availability === 'playable'` items render.
That stopped false positives, but now the feed can look empty/slow until we get positive evidence.

## Likely combined bottleneck
- public feed entries arrive quickly
- channel/video hydration is slower
- positive availability evidence is even slower
- strict playable-only filtering means nothing renders until all three line up

## Better UX direction
Two-stage rendering:
1. Render discovered videos as soon as listVideos() returns
2. Mark them as `checking` / `unknown` in UI
3. Upgrade to playable or hide later when hints resolve

This gives:
- fast first paint
- fewer false negatives
- avoids the previous bug where completely unseeded videos looked fully watchable

## Discussion

## Codex Proposal

Implement discovery rendering as a two-stage pipeline on the frontend:

1. Stage 1: render every `listVideos()` result immediately unless we have explicit negative evidence.
2. Stage 2: let availability hints upgrade cards to `playable` or remove them later if they resolve to `unavailable`.

Why this fits the current code:
- `packages/backend/src/api.js` already returns per-video `availability` and only flips unknown items to `unavailable` when hint requests come back negative while peers exist.
- The strict frontend gate is in `packages/app/app/(tabs)/index.tsx` today, not the web screen. Both the discovery loader and channel view do:
  - `.filter((v: any) => (v?.availability || 'unknown') === 'playable')`
- That means first paint waits for positive proof, which is exactly the slow path we are trying to avoid.

Exact frontend change I would make now:
- In `packages/app/app/(tabs)/index.tsx`, change both filters from:
  - `(v?.availability || 'unknown') === 'playable'`
- to:
  - `(v?.availability || 'unknown') !== 'unavailable'`

That gives the intended behavior:
- `playable` renders
- `unknown` renders immediately
- `unavailable` stays hidden

Important follow-up found while inspecting the same path:
- `packages/app/pear-src/workers/core/index.ts` currently strips `availability` when it remaps `api.listVideos(...)` results into RPC payloads.
- So if we want the frontend to distinguish `unknown` from `unavailable`, the worker should also forward `availability` (for example `availability: v.availability || 'unknown'`).
- If we do not forward it, the proposed relaxed filter still improves first paint, but it cannot later hide explicit negatives because everything arrives as implicit `unknown`.

Recommendation:
- Do the filter relaxation and worker forwarding together as the minimum viable fix.
- Keep the existing sort/merge behavior; only change the inclusion rule.
- Do not block discovery cards on thumbnails or positive availability.

On a lightweight `checking` badge/state:
- I do not think a badge is required for the first fix.
- The main UX regression is empty/slow discovery, and the filter change solves that with minimal surface area.
- A badge becomes worthwhile only after availability is forwarded end-to-end and we confirm users are confused by cards that appear before playback is confirmed.

Why I would defer the badge for now:
- The current web `VideoGrid` / `VideoCard` props do not carry availability, so adding a badge is a broader UI plumbing change than the filter fix.
- A badge introduces product decisions we do not yet have settled: wording (`Checking`, `Verifying`, `Availability unknown`), when it clears, and whether a card should stay clickable while checking.
- We already have a safe backend state model where explicit negatives can hide later; that gives most of the value without extra visual noise.

If we do want a very small follow-up later:
- Add `availability?: 'playable' | 'unknown' | 'unavailable'` to the card data shape.
- Show a subtle top-left `Checking` pill only for `unknown` items in discovery, not on channel pages or owned videos.
- Remove the pill automatically when the card becomes `playable`; drop the card if it becomes `unavailable`.

Bottom line:
- Ship the two-stage behavior now by changing the frontend inclusion rule to hide only `unavailable`.
- Forward `availability` through the worker in the same patch so later negative evidence can actually remove cards.
- Treat the checking badge as a later polish item unless user testing shows the temporary ambiguity is a real problem.

## Claude Proposal

Minimal change: keep the existing progressive `loadFeedVideos()` shape, but stop requiring `availability === 'playable'` for first render.

Implementation sketch:

1. In `packages/app/app/(tabs)/index.tsx`, change the discover-feed path in `loadEntry()` so `rpc.listVideos()` results are mapped into `feedVideos` immediately.
   - Keep `availability` on each mapped video.
   - First pass should include `unknown` / `checking` / `playable` items.
   - Only exclude clearly dead states if we already have them (`unavailable`, `missing`, etc.).

2. Add a tiny second-stage refinement pass after first merge.
   - Re-run `listVideos({ channelKey, publicBeeKey })` for already-rendered channels with a slightly longer timeout.
   - Merge by `channelKey + id` so later metadata overwrites earlier `availability`.
   - If an item resolves to a hard negative state, remove it then.
   - This preserves fast first paint while still converging toward correctness.

3. Keep playback strict.
   - Do not auto-assume unknown items are safe to play.
   - If a user taps an `unknown` / `checking` card, let the normal `preparePlayback()` path be the source of truth.
   - Optional tiny guard: disable tap only for explicit negative states, not for `unknown`.

4. Small UI affordance in feed card.
   - `VideoCard` currently shows title/channel/time only; there is no availability status.
   - Add a minimal muted label or pill for non-playable-positive states:
     - `checking` -> “Checking…”
     - `unknown` -> “Syncing…”
   - Hide the badge once state becomes `playable`.

Why this is small-scope:
- no new backend API
- no feed architecture rewrite
- uses the existing progressive merge behavior already present in `loadFeedVideos()`
- only changes filtering and adds a lightweight refinement/update path

Concretely, the biggest current blocker is here:
- discover feed filters `listVideos()` results to playable-only before rendering
- `feedVideosWithThumbs` also only shows videos from seeded/discovered channels

That means the app already has a decent fast path, but it throws away early `unknown` results. Rendering those early and refining them later should materially improve perceived discovery speed with minimal risk.
