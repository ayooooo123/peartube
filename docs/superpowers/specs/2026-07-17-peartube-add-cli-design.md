# PearTube Add CLI and Structured Content Design

Date: 2026-07-17
Status: Approved in chat; written for review

## Summary

PearTube should add a Node-based `peartube` command whose primary creator workflow is:

```text
peartube add [search text]
```

The command provides an in-process interactive picker with live search, `Tab` completion, keyboard navigation, filesystem path completion, metadata review, verified bulk mapping, resumable imports, and publication to the existing universal backend.

TV and movie discovery comes from TMDB. Creator discovery and source inspection use an explicit capability matrix around the existing `yt-dlp` dependency. PearTube does not require SearXNG or a paid creator-data service. Platforms that `yt-dlp` cannot search or enumerate remain fully usable through creator URLs, content URLs, and local files.

Imported content is not stored as a loose archive. Each TV show, movie, or creator becomes a rich PearTube channel. Optional channel and video schema fields preserve profile artwork, source identity, episode coordinates, publication dates, provenance, and duplicate keys. A schema-first protocol contract exposes structured channel catalogs so Expo, Electrobun, and native macOS clients can render creator, season, movie, stream, and extras views consistently.

Bulk imports are mapping-first. PearTube verifies a complete one-to-one assignment between sources and target episodes or creator items before uploading any media bytes. Ambiguous assignments require explicit user action.

Publication is two-phase. New items remain private `replicationPending` drafts while a trusted relay, paired device, or the required number of independent peers acquires a complete copy. PearTube verifies the remote Hypercore ranges through the existing upload-offload durability logic before projecting the item into the public channel. The uploader may exit or offload local bytes only after that barrier passes.

## Goals

- Make adding one item as simple as `peartube add breaking bad`.
- Provide smooth in-process completion independent of the user's shell.
- Support TV shows, movies, and online creators.
- Support local files and public URLs through the same flow.
- Preserve rich metadata and artwork in the P2P channel instead of only in transient CLI state.
- Organize every imported item under the correct show, movie, or creator channel.
- Support selected episodes, whole seasons, all missing episodes, playlists, multiple URLs, and local directories.
- Prevent wrong episode assignments and duplicate imports before media transfer begins.
- Resume interrupted bulk imports safely.
- Require verified secondary durability before an imported item is publicly announced or reported complete.
- Preserve the existing universal backend and shared protocol architecture.
- Keep existing relay, peer, and Bare CLI entry points working.
- Keep legacy channels and videos readable.

## Non-Goals

- A universal, guaranteed name-search index for every social platform.
- A SearXNG service or dependency.
- A paid creator-discovery provider.
- Scraping bespoke search pages for every platform.
- Automatically merging two same-named creator profiles across platforms without evidence or explicit user confirmation.
- DRM bypass, credential theft, or importing content the user is not authorized to publish.
- Globally preventing two unrelated publishers from creating channels for the same external show or creator. Duplicate prevention is enforceable within a writable PearTube channel and its local import catalog, not across an authority-free P2P network.
- Replacing `yt-dlp` with a new downloader.
- Replacing the existing relay/archive runtime or introducing a second backend implementation.

## Product Principles

### Fast path first

The ordinary path should require a search, a selection, a source, and a final confirmation. Advanced fields remain available but do not dominate the flow.

### Structure is explicit

Season numbers, episode numbers, source identities, and content kinds are persisted fields. Clients never infer the catalog from titles or filenames after publication.

### Strict before expensive

Metadata resolution, source inspection, duplicate detection, and bulk assignment finish before media upload. Ambiguous content never consumes network or disk resources until the user resolves it.

### Graceful capability boundaries

`yt-dlp` supporting a URL does not imply it supports name search or profile enumeration for that platform. The CLI maintains tested, explicit capabilities and moves directly to URL or file input when a capability is absent.

### P2P-owned artwork

Remote images are useful during discovery, but successful imports copy thumbnails and channel artwork into PearTube blob storage. Published records prefer blob coordinates over remote hotlinks.

## Command Surface

The CLI package adds a new Node-only executable:

```json
{
  "bin": {
    "peartube": "peartube.js"
  }
}
```

The existing `peartube-relay`, `peartube-peer`, `peartube-relay-bare`, and `peartube-peer-bare` executables remain intact. Interactive Node dependencies must not be imported at the top level of the shared relay entry point because `bare-bin.js` imports that path.

Initial commands:

```text
peartube add [query]
peartube config
peartube help
```

`peartube add` accepts positional search text, including multiple words. The parser must not treat positional words after `add` as unknown flags. A query can also be omitted and entered interactively.

`peartube config` interactively manages the existing PearTube configuration surface. It checks the TMDB API key, the `yt-dlp` executable, optional `yt-dlp` cookies, storage, and active publishing identity without exposing secrets in command history. Environment variables and explicit config continue to override interactive defaults according to existing CLI conventions.

## Interactive Terminal Model

The add flow is a state machine, not a sequence of unrelated prompts. Each state owns its input, selected row, pending request, validation, and back-navigation snapshot.

Global keys:

- typing updates the current query
- `Tab` completes the highlighted item
- `Up` and `Down` change the highlighted row
- `Enter` confirms
- `Esc` returns one state while preserving prior selections
- `Ctrl+C` cancels cleanly after confirming only when a job is already publishing

Search calls are debounced. Every request has a monotonically increasing token; late responses for stale tokens are discarded. Cached local entities render immediately, while remote results may fill in below them.

Filesystem input:

- expands `~`
- completes path segments on `Tab`
- appends a separator for directories
- handles spaces without requiring the user to understand shell quoting inside the TUI
- validates readability before leaving the source state
- accepts pasted absolute or relative paths

URL input recognizes a pasted HTTP(S) URL immediately and inspects it through `yt-dlp`. The UI does not require the user to choose a platform in advance.

## Search and Discovery

### TV and movies

TMDB supplies TV and movie search results, stable IDs, release years, descriptions, posters, backdrops, seasons, episodes, episode stills, air dates, and ordering. Results carry visible `TV` or `Movie` badges.

The TMDB API key is optional for non-media workflows but required for name-based TV/movie discovery. Missing configuration opens a short setup prompt. Direct URL, creator URL, and local-file workflows remain available without TMDB.

### Creators

Creator discovery uses only free/open tooling already compatible with the archive direction:

- tested `yt-dlp` search extractors for platforms that actually expose search through `yt-dlp`
- creator candidates derived and deduplicated from search results
- local creator profiles remembered from previous imports
- direct creator profile URLs for all supported URL extractors
- direct content URLs when profile enumeration is absent or broken

The capability matrix distinguishes at least:

- `search`: can find content or creator candidates from text
- `profile`: can inspect a creator profile URL
- `list`: can enumerate recent public items from that profile
- `download`: can resolve and download a selected content URL

A platform is only advertised for a capability after a fixture-backed probe proves that capability. Generic supported-site lists are not enough. Unsupported search or listing does not produce an empty result screen; the TUI focuses `Paste creator URL`, `Paste content URL`, or `Choose local file` and explains the limitation once.

`yt-dlp` extraction is best-effort per extractor. Platforms change. The direct content URL path is the reliable fallback contract.

### Creator identity across platforms

One PearTube creator channel can hold multiple source profiles. Each source profile includes provider, stable source ID when available, canonical URL, handle, display name, and source artwork URLs.

PearTube may automatically reuse a creator channel when a stable provider/source ID already belongs to it. It must not merge profiles solely because normalized names match. When the user adds a new platform profile for an existing human or organization, the review screen offers explicit attachment to an existing creator channel.

## Single-Item Flows

### TV episode

1. Search and select a show.
2. Select a season.
3. Select an episode.
4. Choose a local file or paste a content URL.
5. Inspect the source without uploading it.
6. Review the resolved title, synopsis, episode coordinates, dates, artwork, and target channel.
7. Publish, attach artwork, announce the channel, and print identifiers.

Previously imported episodes are visibly marked and blocked from accidental duplication.

### Movie

1. Search and select a movie.
2. Choose a local file or content URL.
3. Inspect the source.
4. Review movie metadata and target channel.
5. Publish.

A movie channel normally has one `movie` item but may also contain explicitly classified trailers and extras.

### Creator item

1. Search a supported creator source or paste a creator URL.
2. Reuse or create the creator channel.
3. List recent videos or streams when supported.
4. Select an item, paste a content URL, or choose a local file.
5. Review source metadata, thumbnail, creator profile changes, and target channel.
6. Publish.

## Rich Channel Model

Each selected external entity maps to a PearTube channel profile kind:

- `tvShow`
- `movie`
- `creator`
- absent/`standard` for legacy and ordinary channels

### Channel profile

The channel profile preserves:

- profile kind
- canonical name and description
- original language and release/year data where relevant
- primary media provider and stable external ID where relevant
- avatar/poster artwork
- banner/backdrop artwork
- artwork MIME types and blob coordinates
- remote artwork URLs as temporary provenance/fallback
- multiple external source profiles for creators
- created/updated clocks already required by the channel model

A new channel-source collection is preferable to a delimited string or opaque JSON field. It is keyed by provider plus source ID or a deterministic canonical-URL key and holds source profile identity independently from the main channel profile.

### Video/content item

The fixed channel and public video schemas gain optional fields for:

- `contentKind`: `episode`, `movie`, `video`, `stream`, `trailer`, or `extra`
- source provider/extractor
- source video ID
- canonical source URL
- source creator ID and URL
- source publication timestamp
- media provider and external media/episode ID
- season number
- episode number
- original air date
- local content fingerprint
- imported thumbnail URL plus existing thumbnail blob coordinates
- provenance version sufficient to explain which resolver supplied the metadata
- `publicationState`: `replicationPending` or `published` for newly staged imports

Interactive imports use a two-phase channel write. The backend stores the item in the private writable channel with `publicationState: replicationPending` and suppresses public-channel synchronization. This keeps the record visible to `getVideoData` and the existing offload assessment without advertising it. After durability verification, one explicit publish transition changes the state and synchronizes the public projection. Public projection must also filter pending records defensively.

The upload manager must accept and persist these fields. Passing them through the CLI publisher without extending `uploadFromPath` is insufficient because the current upload path destructures a fixed option set and would silently drop them.

### Indexes and duplicate rules

Indexes support:

- videos by upload time, preserving the existing index
- videos by season and episode
- videos by source provider and source video ID
- videos by content kind and publication date
- channel sources by provider and source ID

Before upload, duplicate detection checks:

- TMDB episode ID or channel + season + episode
- provider + source video ID
- local file fingerprint
- an already completed or active durable job row

These checks are scoped to the target writable channel and local import state. Network-wide duplicates may still exist under independently owned channels.

## Structured Catalog Protocol

Backend-facing capability starts in `packages/spec/schema.cjs`, then flows through generated JS/HRPC, `@peartube/protocol`, `@peartube/platform`, and generated Swift support.

The catalog contract should be paginated rather than returning an unbounded channel history in one response.

Conceptual operations:

- `getContentCatalog(channelKey)` returns the normalized channel profile and group summaries
- `getContentItems(channelKey, groupId, cursor, limit)` returns a page of fully structured content items

Group summaries are derived from persisted fields:

- creator: `latest`, `videos`, `streams`, `extras`
- TV show: one group per season plus `extras`
- movie: `movie`, `trailers`, `extras`
- standard channel: `latest`

Clients do not parse filenames or titles. Legacy content without rich fields falls into `latest` or an ungrouped section.

Native clients continue to validate the universal protocol version before applying returned data. Introducing the catalog contract requires the appropriate shared protocol version update and regenerated Swift outputs.

## Client Presentation

The content must appear organized after publication, not only in CLI output.

### Creator channel

- profile header with avatar, banner, description, and source links
- sections or tabs for latest items, videos, streams, and extras
- stable thumbnail cards ordered by original publication date by default

### TV show channel

- poster/backdrop profile header
- season selector
- episode list ordered by episode number
- clear missing/available state where the contract exposes it
- extras separated from canonical episodes

### Movie channel

- movie profile header
- primary movie item
- trailers and extras separated

Expo/Electrobun and native macOS consume the same protocol shape. Platform-specific rendering may differ, but grouping semantics must not.

## Verified Bulk Uploads

Bulk entry points from a show, season, or creator include:

- one episode/item
- selected episodes/items
- an entire season
- all missing episodes
- a local directory or multiple selected files
- a playlist or creator/channel URL when listing is supported
- multiple pasted content URLs

### Preflight phases

1. Resolve the target catalog from TMDB or the selected creator source.
2. Enumerate source files/URLs.
3. Inspect source metadata without downloading full media when possible.
4. Compute local file fingerprints.
5. Produce candidate assignments.
6. Detect target and source duplicates.
7. Present a verification table.
8. Require resolution of every conflict or explicit exclusion.
9. Freeze the verified manifest.
10. Begin the durable upload queue.

No media upload begins before the manifest is valid.

### Matching evidence

Evidence is evaluated in descending strength:

1. stable external episode/content ID
2. explicit filename or metadata coordinate such as `S01E03` or `1x03`
3. unique normalized episode title
4. unique air/release date
5. source metadata returned by `yt-dlp`
6. file ordering, used only as a weak suggestion

Assignment states:

- `exact`: strong unique evidence; ready
- `review`: plausible but not safe; user confirmation required
- `conflict`: multiple sources or targets claim the same identity
- `unassigned`: no safe candidate
- `excluded`: deliberately omitted by the user
- `alreadyAdded`: duplicate target/source; skipped

Invariants:

- each included source maps to exactly one target item
- each target item maps to at most one source
- no duplicate source identity exists in the manifest or target channel
- no duplicate season/episode coordinate exists in the manifest or target channel
- every `review`, `conflict`, and `unassigned` row is resolved or excluded

Filename ordering alone can never produce `exact`. Manual assignments are recorded in the manifest and survive backward navigation.

Extras are explicitly classified as `trailer` or `extra`; they are not silently attached to the nearest episode.

### Durable execution

The verified manifest extends the existing archive job storage and manager rather than introducing a second queue. Each row has a deterministic job identity and states such as `pending`, `resolving`, `downloading`, `uploading`, `replicationPending`, `verifyingDurability`, `published`, `failed`, and `skipped`.

Execution is sequential by default to bound disk usage, bandwidth, backend contention, and terminal complexity. Metadata and lightweight artwork fetches may be concurrent before the upload phase when bounded.

Checkpoint after every state transition that changes external effects. On restart:

- published rows are not repeated
- downloaded artifacts may be reused when present and verified
- failed rows can be retried independently
- pending rows preserve their frozen assignment
- duplicate checks run again before writing media

A partial failure never reassigns subsequent rows. The final report lists published, skipped, failed, and pending items.

## Verified Secondary Seeding

An upload is not complete merely because its bytes reached the uploader's local Hypercore. The import pipeline treats remote durability as a publication barrier.

### Durability threshold

The backend reuses the policy and evidence in `packages/backend/src/upload-offload.js`:

- one configured trusted relay holding the complete required ranges is sufficient
- one paired own device holding the complete ranges is sufficient
- otherwise at least the configured number of independent ordinary full-copy peers is required; the current default is two

A single untrusted peer cannot satisfy durability. `ctx.trustedRelayKeys` is empty by default, so a deployment that promises immediate one-peer handoff must configure and operate a trusted relay/blind seeder with a stable swarm key and enough admitted storage. Without that infrastructure, the CLI honestly remains at `replicationPending`.

### Two-phase flow

For each verified manifest row:

1. Upload media and artwork to local blobs.
2. Write a private channel draft with `publicationState: replicationPending`.
3. Send a full-copy pin request to connected seed-capable peers.
4. Prioritize complete media, thumbnail, and required channel-artwork ranges.
5. Observe remote bitfield/contiguous-range progress.
6. Verify every required range against the durability policy.
7. Transition the draft to `published`.
8. Synchronize the public channel and announce it to the feed.
9. Optionally invoke the existing `offloadUpload` path for media bytes, or simply allow the uploader to exit.

Peer acknowledgements are progress hints only. They never replace bitfield-based full-range verification.

The low-level durability calculation should accept a direct blob reference (`blobsCoreKey` plus normalized blob range) and be reused by `assessUploadOffload`. This permits the queue to verify media and artwork refs explicitly while preserving the current video-oriented API. The private draft also remains readable by `getVideoData`, so existing upload-offload behavior continues to work after publication.

### Peer seeding request

Automatic replication alone does not guarantee that another peer will request an entire newly uploaded blob. Seed-capable relay/peer code therefore needs an explicit bounded pin request carrying the channel identity and required blob refs. The receiving peer applies its admission and capacity policy, downloads each accepted range linearly, keeps the ranges pinned, and exposes normal Hypercore availability. Rejection or capacity exhaustion is visible to the queue and never counts as durability.

### Bulk behavior

Every bulk row has an independent durability state. The queue may prepare the next row while one row replicates, but a small configured bound prevents a large local backlog of under-replicated uploads. Published rows are never re-uploaded; pending rows resume seeding and verification from their existing blobs after restart.

### No eligible peer

When the threshold is not met:

- the draft and local bytes remain intact
- public projection and feed announcement remain suppressed
- the CLI states which durability condition is missing
- reconnecting later resumes pin requests and verification
- ordinary interactive flow offers no casual `publish anyway` action

This state is incomplete but safe. The system must not claim that the uploader can leave until verification passes.

## Progress and Output

The TUI keeps one stable progress region instead of appending noisy logs:

```text
✓ Metadata     Breaking Bad · S01E01
✓ Source       /Videos/Breaking.Bad.S01E01.mkv
✓ Importing    1.4 GB
⠸ Replicating trusted relay 8f21… · 61% · 854 MB / 1.4 GB
○ Verifying
○ Publishing
○ Announcing
```

Success displays:

- channel name and key
- video/content ID
- content coordinates when relevant
- copyable PearTube link
- bulk totals when relevant

Debug logs remain available behind existing debug conventions but do not corrupt the interactive renderer.

## Error Handling

- Missing `yt-dlp`: setup state with the exact missing executable and retry after installation.
- Missing TMDB key: interactive configuration for media discovery; creator URL and local workflows stay available.
- Search failure: cached entities and direct input actions remain visible.
- Unsupported creator search: focus creator/content URL actions.
- Unsupported profile listing: keep the selected creator and request a content URL or file.
- Metadata unavailable: require a title and explicit content kind; never invent season coordinates.
- Artwork failure: allow publication after a visible warning.
- Source inspection failure: remain on source selection with retry/change/cancel.
- Disk or upload failure: checkpoint and retain the frozen manifest.
- Announcement failure after media publication: preserve the published record and retry announcement; do not re-upload media.
- No trusted relay or sufficient peers: retain a private `replicationPending` draft and local bytes; resume when eligible peers reconnect.
- Pin request rejected or peer disconnects: continue seeking another eligible peer and never count a soft acknowledgement as durability.
- Durability passes but public projection fails: retain the durable draft and retry only the publish transition.
- Schema/protocol mismatch: reject rich catalog operations before applying or publishing incompatible data.

Errors are attached to their current state. Navigating back does not discard metadata drafts or manual bulk assignments.

## Security and Trust

- Do not print or persist API secrets in logs.
- Interactive secret entry disables terminal echo.
- Use argument arrays for `yt-dlp`; never interpolate user input into a shell command.
- Treat extractor JSON and remote metadata as untrusted input.
- Bound text lengths, result counts, artwork sizes, redirects, and timeouts.
- Sanitize filenames and temporary paths.
- Validate downloaded artifacts before upload.
- Preserve canonical source URLs and provenance for moderation and audit.
- State that publishers are responsible for rights to imported content; do not add DRM-bypass behavior.

## Compatibility and Migration

All new record fields are optional. Existing records remain decodable:

- missing profile kind means a standard channel
- missing content kind means a standard video
- missing season metadata means ungrouped content
- missing blob artwork permits existing thumbnail/avatar behavior

Channel and public HyperDB builders and generated outputs must evolve together. The public projection must copy the new fields explicitly; otherwise content may look correct locally and lose its structure after publication.

The new protocol operations require a clean protocol-version cutover across host, protocol, platform, and native generated code. No compatibility aliases or duplicate backend implementations are introduced.

## Testing and Verification

### Terminal and parser

- positional multi-word `add` query
- omitted query
- `Tab`, arrows, `Enter`, and `Esc`
- stale async result rejection
- path completion with spaces, `~`, files, and directories
- pasted URL recognition
- renderer behavior on narrow terminals and non-interactive input
- existing relay and Bare entry points still load without Node-only TUI imports

### Discovery and normalization

- fixture-backed TMDB TV/movie/show/season/episode normalization
- fixture-backed `yt-dlp` search, profile, list, and download capabilities
- unsupported capability routes to direct input rather than an empty picker
- creator candidate deduplication
- stable provider/source IDs
- explicit cross-platform creator attachment

### Bulk verifier

- exact `SxxExx` and `NxNN` matches
- title/date suggestions remain review-required when not strongly unique
- duplicate file, source ID, episode coordinate, and active-job detection
- unmatched sources
- missing selected episodes
- manual assignments and exclusions
- extras classification
- manifest serialization and restoration
- no valid manifest when any unresolved state remains

Property-oriented tests should enforce one-to-one mapping invariants across generated source/target sets.

### Backend persistence

- channel profile and source records round-trip through HyperDB
- every new video field survives `uploadFromPath`
- artwork persists to blobs and resolves without the original remote URL
- public projection preserves rich fields
- source and season indexes return correct records
- duplicate checks remain correct after restart and replication

### Protocol and clients

- rich and legacy catalog responses
- catalog pagination and stable ordering
- protocol-version mismatch rejection
- Expo/Electrobun creator and TV grouping smoke checks
- native macOS creator and TV grouping smoke checks

### End-to-end smoke scenarios

1. Add one local TV episode and observe it under the correct season.
2. Add one movie by URL and observe its artwork and primary movie section.
3. Add a creator URL, select a recent item, and observe the creator profile and thumbnail.
4. Import a complete season containing one ambiguous filename; verify no bytes upload until it is manually assigned.
5. Interrupt a bulk import, restart it, and verify completed rows are not duplicated.
6. Import a second platform profile into an existing creator only after explicit attachment.
7. Upload with a configured trusted relay and verify the item remains private until the relay's full-range bitfield is complete.
8. Upload without a trusted relay or enough ordinary peers and verify the draft remains local, pending, and unannounced.
9. Disconnect a seeding peer mid-transfer and verify no soft receipt promotes the draft.
10. Restart during `replicationPending`, reconnect the relay, and verify publication resumes without media re-upload.

## Rollout Order

1. Rich backend/channel/public schemas, draft publication state, and upload persistence.
2. Direct blob-range durability assessment and trusted relay configuration.
3. Seed-capable peer pin requests and verified two-phase publication.
4. Schema-first protocol catalog and platform exposure.
5. Client rendering for structured and legacy catalogs.
6. Node-only `peartube` executable and TUI state machine.
7. TMDB and `yt-dlp` discovery/normalization.
8. Single-item verified import.
9. Bulk verifier and durable manifest execution.
10. End-to-end smoke verification across CLI, backend, relay, and clients.

The CLI depends on the structured persistence contract. Shipping the interactive shell before the backend can retain and expose its metadata would create polished data loss, so schema and persistence come first.

## Alternatives Rejected

### Commercial creator API

Phyllo and similar services provide broad normalized discovery but add cost, account requirements, and a centralized dependency. The user explicitly chose a free/open approach.

### SearXNG dependency

SearXNG is open source and useful for broad search, but requiring or bundling a service is too heavy for this CLI. Public instances also do not reliably enable JSON output. It is not part of the design.

### Bespoke platform scrapers

Dedicated platform adapters can improve discovery but create continuous maintenance and breakage. The first version uses tested `yt-dlp` capabilities and direct URLs. The provider boundary permits future focused adapters without changing the TUI or backend model.

### P2P creator directory first

A native creator directory is a strong long-term direction, but it cold-starts empty and requires a new discovery protocol. Remembered local creators and rich channel source records create useful seed data without blocking the CLI.

## Open Implementation Decisions

The implementation plan should settle these details against current package conventions:

- exact generated HyperDB field ordering and compatible schema evolution mechanics
- whether channel artwork uses fixed profile fields or a dedicated artwork collection
- exact HRPC pagination request/response names
- where interactive non-relay config values live within the existing `PEARTUBE_CONFIG` conventions
- the initial tested `yt-dlp` capability allowlist
- the local file fingerprint algorithm balancing duplicate detection with large-file cost

These decisions may change internal representation but must preserve the product invariants in this specification.
