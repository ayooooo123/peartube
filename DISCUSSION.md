# Task: Relay should behave like a serving peer + mobile Discover should not clear on refresh

## New user requirements
1. Relay should serve feed/videos like a normal peer when original peers go offline.
2. On mobile, once Discover/feed videos are loaded, the entire feed should not disappear every ~15s/30s during refresh cycles.

## Relay findings already established
Current relay:
- runs PublicFeedManager
- discovers channels
- mirrors blobs for accepted candidates
But likely missing:
- CacheManager-backed persistence/restoration of mirrored channels
- submitChannel(publicBee) into relay publicFeed after successful mirror
- startup restore/reannounce of mirrored channels so relay advertises itself as a source even after publisher goes offline

## Mobile Discover refresh issue
Likely root cause in `packages/app/app/(tabs)/index.tsx`:
- `loadFeedVideos()` currently calls `setFeedVideos([])` at the start of every load run
- periodic refreshes / feed updates retrigger loadFeedVideos
- that wipes the feed UI before the new hydration run completes

The feed should behave like:
- initial load: can start empty/spinner
- subsequent refreshes: retain existing feedVideos while refreshing in background
- merge new results in, don't blank the UI

## Deliverables
1. Relay patch: add CacheManager persistence + reannounce mirrored channels as serving sources
2. Mobile Discover patch: keep existing feedVideos during refresh/hydration reruns

## Discussion
