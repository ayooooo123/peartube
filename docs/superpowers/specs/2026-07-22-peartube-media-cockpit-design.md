# PearTube Media Cockpit Design

Date: 2026-07-22
Status: Approved interactively for implementation planning

## Summary

PearTube should stop presenting itself as a simple YouTube-style video feed and become a generic network media cockpit: a private P2P media universe with beautiful browse, library, and title surfaces.

The product direction is a creative mix of Netflix, Spotify, Twitch, and YouTube:

- Netflix: cinematic browse, poster rails, movie/show destinations.
- Spotify: persistent library mental model, collection-first navigation, continue/resume surfaces.
- Twitch: visible liveness and network presence from peers, seeders, relays, and currently available content.
- YouTube: fast playback, creator/channel context, metadata clarity, comments/actions where they help.

The first pass is a client-side UI/product layer over the latest existing metadata on `main`. It should not introduce a new backend contract, playback path, relay behavior, or blob-serving mechanism.

## Goals

- Make PearTube feel like a general-purpose media CDN instead of a YouTube replacement.
- Give movies, shows, episodes, creators, music, downloads, and seeded content distinct presentation surfaces.
- Reuse current structured metadata: `contentKind`, `classification`, `seasonNumber`, `episodeNumber`, channel/profile metadata, public-feed videos, local videos, continue watching, and recommendations.
- Preserve all existing playback and channel navigation behavior.
- Keep P2P/network state visible as product atmosphere, not as intrusive diagnostics.
- Build the UI in reusable components so mobile and desktop can share semantics even if their layouts differ.

## Non-Goals

- No backend schema changes for this first pass.
- No new upload/import workflow changes.
- No change to relay seeding, public-feed gossip, playback URLs, PiP, mini-player, or blob server behavior.
- No automatic title/episode inference from filenames; use explicit metadata only.
- No full social/activity system until real backend signals exist.

## Product Model

PearTube has four primary surfaces.

### Home

Home is the living browse cockpit.

It should open with a cinematic, high-confidence feature from the available network/library, then continue with dense horizontal rails:

- Featured from the swarm
- Continue Watching
- Movies
- Shows
- New Episodes
- Music / Creators
- Recently from the swarm
- Your Library
- Downloads / Offline when available

The current Discover grid remains available, but it moves lower in the hierarchy as `Recently from the swarm` or equivalent. It should no longer define the entire app identity.

### Watch

Watch remains fast and focused.

The player keeps the existing playback path. Surrounding metadata becomes richer:

- content badge such as Movie, S01E03, trailer, extra, or stream
- movie/show/creator identity
- channel/source name
- swarm/availability context
- related episodes, trailers, extras, or creator videos
- comments and actions only where they do not crowd the player

### Library

Library becomes the Spotify-style ownership and navigation surface.

It should organize by collection rather than upload mechanics:

- Movies
- Shows
- Creators
- Music
- Downloads
- History
- Seeded by me
- My uploads / Studio handoff

The first pass can reuse existing library/download/history sources where available and leave deeper collection pages for later slices.

### Channel / Title Pages

A channel can represent a creator, TV show, movie, or legacy feed.

Presentation depends on explicit `profileKind` and content groups:

- TV show: backdrop/poster header, season selector, ordered episodes, extras.
- Movie: cinematic header, main feature, trailers, extras.
- Creator: avatar/banner header, latest uploads, videos, streams, extras.
- Standard/legacy: normal video feed with improved card styling.

Existing route behavior should remain intact: tapping a channel/title goes through the current channel route and carries `publicBeeKey` where available.

## Visual Direction

Dark, dense, premium, alive.

The UI should feel less like a generic SaaS/video clone and more like a private media system:

- near-black base
- cinematic hero art and large thumbnails
- restrained glass/elevated surfaces
- subtle indigo/blue accent rather than loud purple
- poster cards for movies/shows
- wide episode/video cards for playback items
- compact peer/seed badges as atmosphere
- fewer plain grids, more curated rails

The guiding phrase: PearTube is not videos. PearTube is media that lives on your network.

## Component Design

### Data shaping layer

Create a focused media-hub mapper rather than burying product grouping in `app/(tabs)/index.tsx`.

Inputs:

- `feedVideosWithThumbs`
- `myVideosWithMeta`
- `continueWatching`
- `recommendedVideos`
- channel/profile metadata where present
- content fields: `contentKind`, `classification`, `seasonNumber`, `episodeNumber`, category
- download/history state where available

Output rails:

- `featured`
- `continueWatching`
- `movies`
- `shows`
- `newEpisodes`
- `musicAndCreators`
- `recentlySeeded`
- `yourLibrary`

The mapper should dedupe by stable playback key, use explicit metadata only, and gracefully fall back when no rich media metadata exists.

### UI components

Add or extend reusable components:

- `HeroFeatureCard`: large cinematic lead item with title, subtitle, content badge, duration, swarm status, and primary Play action.
- `MediaRail`: horizontal rail with title, optional subtitle/action, and snap-friendly cards.
- `MediaPosterCard`: vertical poster-like card for movies and shows.
- `EpisodeCard`: wide 16:9 card for episodes/videos with SxxExx, resume progress, and creator/channel context.
- `CreatorChannelCard`: avatar/banner-oriented card for creators, channels, and music-ish sources.
- `NetworkStatusPill`: small Twitch-like presence/availability marker.

Existing `VideoCard`, `RailCard`, `Rail`, `ThumbnailImage`, `formatContentBadge`, and `matchesHomeFeedCategory` should be reused or extended where practical.

## Data Rules

- Movies: `contentKind === 'movie'` or `classification.type === 'movie'`.
- Shows/episodes: `contentKind === 'episode'` or `classification.type === 'tv'`.
- New Episodes: episode/show items ordered by publish/upload time, then stable key.
- Music/Creators: explicit category `Music`, creator-like profile/channel metadata, or creator recommendations where present.
- Recently Seeded: public-feed videos ordered by feed recency/upload time.
- Featured: choose the highest-quality available playable item, preferring movies/shows/recommended/continue candidates with thumbnails.
- Legacy videos: still visible through Recently from the swarm and fallback rails.

Do not parse titles to infer movie/show/season data.

## Screen Changes

### Mobile Home: `packages/app/app/(tabs)/index.tsx`

Replace the current top-level sequence with the media cockpit:

1. mobile header remains compact
2. hero feature if a candidate exists
3. Continue Watching rail
4. Movies rail
5. Shows / New Episodes rails
6. Music / Creators rail
7. Recently from the swarm section with refresh and compact network status
8. Your Library / Your videos lower section
9. existing empty and backend-start states preserved

The current direct playback function remains the only play path for normal home cards.

### Desktop Home: `packages/app/app/(tabs)/index.web.tsx`

Use the same semantic rails with desktop sizing:

- wider hero
- multi-column poster/episode rails
- existing hash watch/channel routes preserved
- current `VideoGrid` can remain for lower fallback sections if needed

Desktop can be visually stronger later; first pass should align semantics without destabilizing watch routing.

### Channel / Title pages

Do not rewrite title pages in the first implementation slice unless needed for shared card components. The follow-up slice should apply the same media cards and profile treatment to `app/channel/[key].tsx` and `.web.tsx` using the existing structured catalog helpers.

## Testing and Verification

Add source-level tests for the mapper and guarded UI invariants.

Suggested tests:

- `packages/app/tests/media-hub.test.mjs`
  - groups movies and shows from explicit metadata
  - does not infer from title strings
  - dedupes feed/local/recommendation duplicates by stable key
  - chooses a featured item with a thumbnail when available
  - keeps legacy videos in fallback/recently-seeded rails

- update mobile UI regression tests or add a new source-reading test asserting:
  - Home imports/uses media hub mapper
  - Hero/media rail components exist
  - normal playback still calls existing `playVideo`/`loadAndPlayVideo` path
  - Discover/public feed refresh remains present

Run focused checks:

```bash
node --test packages/app/tests/content-catalog.test.mjs packages/app/tests/media-hub.test.mjs
node --test packages/app/tests/mobile-ui-redesign-regression.test.mjs packages/app/tests/vertical-discovery-regression.test.mjs
```

If global TypeScript is noisy from pre-existing dependency/type issues, report it separately and keep focused edited-file/source tests passing.

## Implementation Slices

### Slice 1: Shared data model and mobile home

- create media-hub mapper
- add focused tests
- add/extend reusable mobile components
- reshape mobile Home around hero + rails
- preserve existing playback, refresh, empty, and channel navigation behavior

### Slice 2: Desktop semantic parity

- apply the same media-hub sections to `index.web.tsx`
- keep hash watch/channel behavior unchanged
- use existing `VideoGrid` only as fallback/lower-section layout

### Slice 3: Title/channel destination polish

- upgrade show/movie/creator pages using structured catalog helpers
- add poster/backdrop headers
- add season/movie/trailer/extras presentation
- preserve `publicBeeKey` route propagation

## Open Risks

- Current feed metadata may not expose enough source/profile richness for great creator/music cards yet; design should degrade to video rails.
- Artwork blob resolution for poster/backdrop cards may need a follow-up utility if profile artwork is not already resolved on Home.
- Desktop Home is large and route-sensitive; make smaller semantic changes first and avoid player/hash refactors.
- Physical Android verification is required before claiming release-ready mobile UI, especially if card press behavior or playback surfaces change.
