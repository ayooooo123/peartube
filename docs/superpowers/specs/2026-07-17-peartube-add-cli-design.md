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

A fixture-backed adapter test proves normalization and safe command construction for a capability; it does not guarantee that a live platform extractor still works. At runtime, every advertised operation may degrade to direct input with a specific error. Generic supported-site lists are not enough. Unsupported or newly broken search/listing does not produce an empty result screen; the TUI focuses `Paste creator URL`, `Paste content URL`, or `Choose local file` and explains the limitation once.

All `yt-dlp` operations, including direct content URLs, are best-effort per extractor. Platforms change. Direct URLs are the broadest fallback path, not a guarantee; inspection or download failure returns to source selection without losing the draft.

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
- `publicationState`: `replicationPending`, `durabilityVerified`, or `published` for newly staged imports

Interactive imports use a two-phase channel write. The backend stores the item in the private writable channel with `publicationState: replicationPending` and suppresses public-channel synchronization. This keeps the record visible to `getVideoData` and durability assessment without advertising it. Public projection must filter pending records defensively.

Channel profile changes are staged with the durable job rather than applied immediately. The staged patch contains channel metadata, channel-source records, and artwork refs. For a new channel, no public profile is created before the first item is durable. For an existing channel, its previous public profile remains unchanged. Newly referenced item and profile artwork is part of the same required durability set as the media. Once durability passes, one idempotent projection operation applies the staged profile/source patch, projects the content, and records its checkpoint. A crash between its internal writes is repaired by replaying that operation before announcement; all referenced blobs are already durable at that point.

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
- replicated import claims for the target channel

An `importClaims` collection records contenders under deterministic identity keys before media transfer. A claim row is keyed by identity key plus claimant ID, where claimant ID is derived from writer key and durable job ID. An index groups contenders by identity key; the lexicographically lowest non-released claimant ID is the deterministic winner. Claims move through `reserved`, `published`, and `released`. A claim cannot expire after media transfer begins until the job explicitly publishes or cleans it up. Released rows are excluded from winner selection and may be compacted only after their retention window, when no active job refers to them and a published winner exists or the identity has no remaining contender.

The pre-transfer guarantee covers one importer and claims already observed in synchronized channel state. Replication is refreshed before the claim check, but two writers racing concurrently—or operating across a partition—may both begin upload before observing the other claim; no coordinator-free check can prevent that. After replication, the deterministic resolver suppresses the losing pending draft before projection. If both were already projected, catalog/public reconciliation marks the loser as a duplicate, removes it from canonical listings, and schedules safe cleanup. Network-wide duplicates may also exist under independently owned channels.

## Structured Catalog Protocol

Backend-facing capability starts in `packages/spec/schema.cjs`, then flows through generated JS/HRPC, `@peartube/protocol`, `@peartube/platform`, and generated Swift support.

The catalog contract should be paginated rather than returning an unbounded channel history in one response.

Conceptual operations:

- `getContentCatalog(channelKey)` returns the normalized channel profile and group summaries
- `getContentItems(channelKey, groupId, cursor, limit)` returns a page of fully structured content items

Pagination semantics are part of the protocol:

- default limit is 50 and maximum limit is 200; zero, negative, or oversized limits are rejected
- TV season groups sort by episode number ascending, effective publication time ascending, then content ID ascending
- `latest`, creator video/stream, movie, trailer, and extras groups sort by effective publication time descending, then content ID ascending
- effective publication time is `sourcePublishedAt` when present, otherwise `uploadedAt`; all timestamps are UTC Unix milliseconds
- group IDs are stable (`season:<number>`, `latest`, `videos`, `streams`, `movie`, `trailers`, `extras`)
- cursors are opaque base64url-encoded versioned values containing protocol cursor version, channel key, group ID, and the last complete sort tuple
- a malformed cursor or one used with another channel/group returns `INVALID_CURSOR`
- keyset pagination returns items strictly after the cursor tuple

Grouping identity and sort fields are immutable after publication. Newer inserts sort before an existing descending cursor and appear on refresh rather than later pages; deletions are skipped. These rules avoid duplicates within a traversal without requiring an unbounded snapshot. Metadata fields that do not affect grouping/order may be edited normally.

Group summaries are derived from persisted fields:

- creator: `latest`, `videos`, `streams`, `extras`
- TV show: one group per season plus `extras`, and a conditional `latest` group when ungrouped items exist
- movie: `movie`, `trailers`, `extras`, and a conditional `latest` group when ungrouped items exist
- standard channel: `latest`

Clients do not parse filenames or titles. All legacy or otherwise ungrouped content uses the stable `latest` group and its descending effective-publication-time ordering.

Group-summary order is stable. Creator groups use `latest`, `videos`, `streams`, `extras`; TV uses numeric seasons ascending, then `extras`, then conditional `latest`; movie uses `movie`, `trailers`, `extras`, then conditional `latest`; standard channels use `latest`. Empty optional groups are omitted without changing the relative order of groups that remain.

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
- `sourceUnassigned`: an included source has no safe target
- `targetMissing`: a selected, non-duplicate target has no source
- `excluded`: a source or target deliberately omitted by the user
- `alreadyAdded`: duplicate target/source; satisfied and skipped

Invariants:

- each included source maps to exactly one target item
- each selected, non-duplicate target maps to exactly one included source or has an explicit target exclusion
- each duplicate target is explicitly represented as `alreadyAdded`
- no duplicate source identity exists in the manifest or synchronized target channel
- no duplicate season/episode coordinate exists in the manifest or synchronized target channel
- every `review`, `conflict`, `sourceUnassigned`, and `targetMissing` row is resolved or explicitly excluded

Filename ordering alone can never produce `exact`. Manual assignments are recorded in the manifest and survive backward navigation.

Extras are explicitly classified as `trailer` or `extra`; they are not silently attached to the nearest episode.

### Durable execution

The verified manifest extends the existing archive job storage and manager rather than introducing a second queue. Each row has a deterministic job identity and resumable states: `pending`, `resolving`, `downloading`, `uploading`, `uploaded`, `replicationPending`, `durabilityVerified`, `projecting`, `projected`, `announcing`, `announced`, `finalizing`, `published`, `failed`, and `skipped`.

Execution is sequential by default to bound disk usage, bandwidth, backend contention, and terminal complexity. Metadata and lightweight artwork fetches may be concurrent before the upload phase when bounded.

Checkpoint after every state transition that changes external effects. `published` is terminal only after public projection, feed announcement, and final private/public item-state synchronization succeed. Projection, announcement, and finalization are idempotent by channel/content identity. On restart:

Before calling `uploadFromPath`, the queue checkpoints `uploading` with a deterministic video ID derived from the writable channel and durable job identity, the verified artifact hash/path, and the intended structured metadata. `uploadFromPath` accepts that video ID as an idempotency key and atomically commits the resulting private video record as the `replicationPending` draft; there is no second draft record or later draft-creation step. After it returns, the queue checkpoints `uploaded` with the stable media/artwork blob refs already referenced by that draft. On restart from `uploading`, the queue first looks up that deterministic private video ID: if the `replicationPending` record exists, it reconstructs and checkpoints `uploaded` without invoking the downloader or `uploadFromPath`; otherwise it resumes the idempotent upload from the verified artifact. A crash inside the upload may leave unreachable blob blocks, but cannot create a second video record; normal orphan cleanup may reclaim those blocks.

- `published` rows are not repeated
- `uploaded` rows reconcile the existing private `replicationPending` draft and begin pinning without repeating download or upload
- `uploading` rows reconcile the deterministic private video ID before deciding whether the idempotent upload must resume
- `projecting` or `projected` rows replay/continue projection safely
- `announcing` rows retry idempotent announcement
- `announced` or `finalizing` rows retry only final item-state synchronization
- downloaded artifacts may be reused when present and verified
- failed rows can be retried independently
- pending assignments remain frozen
- duplicate claims and checks run again before writing media

A partial failure never reassigns subsequent rows. The final report lists published, skipped, failed, and pending items.

## Verified Secondary Seeding

An upload is not complete merely because its bytes reached the uploader's local Hypercore. The import pipeline treats remote durability as a publication barrier.

### Durability threshold

The backend reuses the policy and evidence in `packages/backend/src/upload-offload.js`:

- one configured trusted relay holding every required range is sufficient
- one paired own device holding every required range is sufficient
- otherwise the configured number of independent ordinary peers must each hold every required range; the current default is two

Eligibility is item-level, not per-range. For each required blob ref, the backend collects stable full-copy holder identities, intersects those identity sets across all refs, and applies the trust/count policy once to the intersection. Anonymous peers that cannot be correlated across refs do not count toward aggregate durability. This prevents media on peers A/B and artwork on peers C/D from falsely qualifying an item that no acceptable holder set possesses completely.

Required refs are the media blob, an item thumbnail when the published record references one, and any newly staged channel artwork referenced by the same profile commit. Artwork that failed to fetch and was explicitly omitted is not required; a remote URL alone never counts as durable artwork.

A single untrusted peer cannot satisfy durability. `ctx.trustedRelayKeys` is empty by default, so a deployment that promises immediate one-peer handoff must configure and operate a trusted relay/blind seeder with a stable swarm key and enough admitted storage. Without that infrastructure, the CLI honestly remains at `replicationPending`.

### Two-phase flow

For each verified manifest row:

1. Checkpoint the deterministic upload intent, then idempotently upload media and selected artwork; `uploadFromPath` atomically commits the deterministic private video as `replicationPending`.
2. Checkpoint `uploaded` with the stable channel, video, and blob identifiers already held by that draft; keep channel profile/source changes staged in the job.
3. Send an idempotent full-copy pin request to connected seed-capable peers.
4. Prioritize every complete required range.
5. Observe remote bitfield/contiguous-range progress.
6. Intersect full-copy holder identities across all required refs and apply the durability policy.
7. Set the private draft to `durabilityVerified` and checkpoint the job.
8. Enter `projecting`; idempotently apply staged channel changes and project a public item whose state is `durabilityVerified`.
9. Checkpoint `projected`, enter `announcing`, and announce idempotently.
10. After successful announcement, checkpoint `announced` before entering `finalizing`.
11. Idempotently update both private and public item records to `published`, then checkpoint terminal job state `published`.
12. Optionally invoke the existing `offloadUpload` path for media bytes, or allow the uploader to exit.

Peer acknowledgements are progress hints only. They never replace bitfield-based aggregate verification.

A low-level `assessBlobSetDurability(refs, policy)` accepts direct normalized blob refs and returns the intersected holder set plus policy result. Existing `assessUploadOffload` delegates to the single-ref form, preserving its API, while the import queue uses the set form for media and artwork. The private draft remains readable by `getVideoData`, so existing video offload continues to work after publication.

### Peer seeding request

The control transport is a versioned Protomux protocol named `peartube/seed-pin/1` on existing authenticated backend swarm connections; it does not depend on PublicBee or feed discovery. A configured trusted relay must already be connected through deployment peer configuration/known-peer reconnect before it can receive a pending draft request.

Logical units are:

- `packages/backend/src/seed-pin/client.js`: sends requests, correlates responses, and resumes status after reconnect
- `packages/backend/src/seed-pin/server.js`: registers the shared Node/Bare-compatible Protomux receiver
- `packages/backend/src/seed-pin/worker.js`: opens requested blob cores, downloads accepted ranges linearly, and keeps them pinned
- `packages/cli/src/seed-pin-admission.js`: supplies relay admission, capacity, retention, and trusted-key policy
- relay metadata storage: persists request state and accepted pins across restart

`registerSeedPinProtocol(ctx, { admission })` is a shared universal-backend registration function with two required startup call sites. `packages/backend/src/orchestrator.js` calls it after storage creates Corestore/swarm and before public discovery, using the paired-own-device admission policy. `packages/cli/src/runtime.js:createRelayRuntime` calls it after `initializeStorage` and before `publicFeed.start()`, passing the policy created by `packages/cli/src/seed-pin-admission.js` from relay mode, allowlists, capacity, retention, and trusted-client configuration. This second call site serves both Node and Bare relay executables because they share `createRelayRuntime`. Registration attaches the receiver to existing connections and subscribes to future swarm connections, while Corestore replication continues on the same authenticated streams.

`PIN_REQUEST` carries a deterministic request ID, requester swarm key, channel key, signed channel-root descriptor, sorted normalized blob refs with roles, retention request, expiry, and a device attestation over the canonical request payload. The request ID is the SHA-256 digest of channel key, durable manifest row ID, and sorted refs, making replay idempotent. The requester creates the attestation with `IdentityKey.attestData(payload, ctx.swarm.keyPair, descriptorProof)`, reusing the identity proof already present in the signed descriptor; no persisted identity secret key is required. Verification uses `IdentityKey.verify` with the descriptor identity as `expectedIdentity`, requires the returned device public key to equal both the verified descriptor device key and the signed requester swarm key, and requires that swarm key to equal the Noise connection's remote public key. The relay then applies channel/owner admission and storage capacity before accepting.

Responses are correlated by request ID and have `accepted`, `rejected`, `progress`, or `complete` state with reason codes. The receiver persists acceptance before starting the worker. Repeated requests return the existing state. A `complete` response is still only a hint: the uploader independently verifies remote bitfields. All codecs and handlers live in the universal backend path and avoid Node-only APIs so relay and Bare runtimes share one protocol.

Pending drafts are absent from the public feed by design; therefore no part of pin dispatch relies on feed mirroring. Rejection, expiry, capacity exhaustion, or disconnect is visible to the queue and never counts as durability.

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
- Announcement failure after durable public projection: preserve the public `durabilityVerified` record, keep the job in `announcing`, and retry announcement without re-uploading media.
- No trusted relay or sufficient peers: retain a private `replicationPending` draft and local bytes; resume when eligible peers reconnect.
- Pin request rejected or peer disconnects: continue seeking another eligible peer and never count a soft acknowledgement as durability.
- Durability passes but public projection fails: retain the durable draft and retry only the publish transition.
- Final private/public state synchronization fails after announcement: keep the `announced` checkpoint and retry only idempotent finalization.
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
- fixture-backed `yt-dlp` adapter normalization and argument construction for search, profile, list, and download
- runtime extractor failure degrades to source selection with the draft intact
- unsupported capability routes to direct input rather than an empty picker
- creator candidate deduplication
- stable provider/source IDs
- explicit cross-platform creator attachment

### Bulk verifier

- exact `SxxExx` and `NxNN` matches
- title/date suggestions remain review-required when not strongly unique
- duplicate file, source ID, episode coordinate, active-job, and replicated-claim detection
- `sourceUnassigned` and `targetMissing` are distinct
- every selected target is mapped, already added, or explicitly excluded
- manual assignments and source/target exclusions
- deterministic replicated claim winner and losing-draft suppression
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
- channel profile/source changes remain staged and publicly invisible before durability
- draft, durability, projection, announcement, and terminal publication transitions resume idempotently after a crash at every checkpoint
- aggregate durability intersects the same stable peer identities across media and artwork refs
- anonymous or disjoint per-range holders cannot satisfy item durability
- `peartube/seed-pin/1` authentication, admission, idempotent replay, restart persistence, rejection, and disconnect behavior

### Protocol and clients

- rich and legacy catalog responses
- catalog pagination and stable ordering
- cursor limit bounds and `INVALID_CURSOR` behavior
- keyset pagination mutation behavior and no duplicate items across a traversal
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
11. Crash after setting `durabilityVerified`, after public projection, and after feed announcement; verify each restart reaches one terminal publication without duplicate side effects.
12. Stage new channel artwork on an existing public channel and verify the old profile remains public until the media and artwork share a qualifying durable holder set.
13. Put media and artwork on disjoint peers and verify aggregate durability fails.
14. Create concurrent claims from paired writers, merge them, and verify the deterministic loser is suppressed from canonical catalogs.

## First Deliverable: Single-Item URL Import

The first implementation slice exposes a complete, testable URL workflow without discarding the richer catalog design:

```text
peartube add <url>
peartube add <url> --type episode --provider tmdb --show-id <id> --season <n> --episode <n> --yes
peartube add <url> --type movie --provider tmdb --movie-id <id> --yes
peartube config
peartube help
```

Interactive mode searches TMDB, selects a show or movie and, for TV, a season and episode, then reviews normalized metadata before import. Scripted mode resolves the same normalized record from explicit provider coordinates. V1 accepts `episode` and `movie`. An episode requires `--provider`, `--show-id`, `--season`, and `--episode` and forbids `--movie-id`. A movie requires `--provider` and `--movie-id` and forbids show, season, and episode flags. `--provider tmdb` is the only implemented V1 provider. Missing or contradictory coordinates are usage errors. Missing coordinates may open the picker only when stdin and stderr are TTYs and `--no-input` is absent; otherwise the command fails without prompting.

The provider interface supports search plus show, season, episode, and movie lookup. TMDB is the first implementation. TVDB remains a future adapter and must report that it is unavailable rather than silently substituting another provider.

The package maps the `peartube` bin to a dedicated Node entry point, `peartube.js`. That entry point lazily imports terminal and metadata-provider dependencies. It does not import or dispatch through `bin.js`; `bare-bin.js` may continue to import the existing relay/peer graph without acquiring Node-only dependencies. The new path reuses the existing archive downloader, publisher, backend runtime, identity manager, upload manager, feed publication, thumbnail attachment, and seeding components rather than introducing a second backend.

TV episodes reuse or create one channel keyed by media provider plus stable show ID. Movies use provider plus stable movie ID. Name equality alone never reuses a channel. The upload path and private/public channel builders must explicitly preserve the normalized content kind, provider IDs, show/movie identity, season and episode coordinates, air/release date, source identity, canonical identity URL, provenance, and artwork blob coordinates; passing extra options to the current fixed `uploadFromPath` option set is insufficient.

Before source inspection or media download, the CLI refreshes claims for the target writable channel, reserves a deterministic `importClaims` contender, and checks the target channel plus local durable jobs. An exact movie identity (`provider + movie ID`) or episode identity (`provider + show ID + season + episode`) already won, published, or pending in that authority is a successful no-op. Concurrent single-item writers use claim creation, synchronization, deterministic winner resolution, and losing-draft suppression from this specification. Human output identifies the existing channel, item, and availability source. JSON output returns `status: "already-exists"` with stable identifiers. `--force` may bypass a failed local source job but cannot override the winning claim or duplicate an exact identity already published or pending in the writable target channel.

The CLI also searches locally cached/replicated catalogs and the public PearTube feed for possible existing content. Network results are advisory because unrelated publishers are separate authorities and the current feed preview does not carry a complete identity index. Exact structured network matches are reported first when observable; fuzzy title/year matches follow as warnings. Neither blocks publication. A future bounded identity-index protocol with defined freshness is required before network-wide exact matches can become authoritative blockers.

Source URL handling has three explicit forms produced by one central normalizer. `fetchUrl` is the original runtime value passed only to `yt-dlp` and retained in memory. `identityUrl` lowercases scheme/host, removes fragments/default ports and known secret or tracking parameters, preserves provider-declared identity-bearing parameters, and is the only source URL persisted as provenance. `displayUrl` additionally removes user info and all query values and is safe for diagnostics. Job state never persists `fetchUrl`; a failure before a verified download artifact exists requires the user to supply the URL again. After download, resume uses the verified artifact path and no longer needs the fetch URL. Errors from the downloader, archive manager, and backend pass through the same central redactor before logging or persistence.

CLI flags override environment, which overrides user configuration. `TMDB_API_KEY` supplies the first metadata provider credential. Diagnostics and progress use stderr. The final human or `--json` result uses stdout. The backend path used by this command must route diagnostics through an injected logger rather than direct `console.log`; a process-level test requires `--json` stdout to contain exactly one parseable JSON value. Ctrl-C cancels download without creating a published record.

Publication failure after a successful local import retains the same channel, video, blob identifiers, verified local artifact, and resumable job checkpoint. Restart from `uploaded`, projection, announcement, or finalization checkpoints must not invoke the downloader or `uploadFromPath` again. A crash after `uploadFromPath` commits the deterministic private video but before the `uploaded` checkpoint is repaired from that record while reopening `uploading`. Focused crash tests reopen storage at the pre-upload intent, post-upload/pre-checkpoint, `uploaded`, projection, announcement, and finalization boundaries and assert stable identifiers, no duplicate video record, no repeated completed upload, and one terminal publication.

The first-deliverable smoke fixture starts isolated uploader storage plus a configured trusted relay, imports an openly licensed small video, waits for the relay to hold every required media/artwork range, and then observes the structured published result. A separate no-peer smoke check must remain at `replicationPending` and must not announce the item.

The first deliverable is one vertical implementation plan: rich optional schema fields and upload/public projection round trips; deterministic upload intent plus single-item draft and resumable publication checkpoints; single-item `importClaims` creation, synchronization, winner resolution, and losing-draft suppression; required blob-set durability and the trusted-relay pin path; target-authority duplicate lookup plus advisory network search; the dedicated Node CLI, TMDB normalization, review, and URL download; and the two smoke gates above. It excludes bulk mapping, creator discovery, network-wide authoritative identity indexing, and client catalog rendering. Those remain later plans and cannot block delivery of the single-item command.

The slice is complete only when focused tests prove interactive and scripted parsing, the complete coordinate matrix, centralized URL redaction, TMDB normalization and failures, authoritative local duplicate no-ops before download, advisory network results, structured field round trips through upload and public projection, provider-identity channel reuse, one-value JSON stdout, restart without re-download/re-upload at every publication checkpoint, successful trusted-relay publication, safe no-peer pending behavior, and unchanged relay/Bare entry-point loading.

## Planning and Rollout

After the first vertical deliverable, the remaining product program proceeds through dependent plans:

1. **Catalog protocol and clients**
   - add schema-first paginated catalog RPCs and a bounded identity-search contract if network-wide authoritative lookup is desired
   - regenerate and atomically cut over host, protocol, platform, and Swift consumers
   - render structured and legacy channels in Expo/Electrobun and native macOS
2. **Bulk and creator import**
   - add creator discovery and cross-platform source attachment
   - add verified bulk mapping, extend import claims to bulk rows, and extend durable queue execution
   - extend end-to-end smoke scenarios across seasons, playlists, and creator catalogs

Each later plan starts only after the preceding plan's focused smoke gate passes. Rich persistence, verified seeding, and resumable single-item publication are part of the first vertical slice rather than hidden prerequisites or deferred cleanup.

## Alternatives Rejected

### Commercial creator API

Phyllo and similar services provide broad normalized discovery but add cost, account requirements, and a centralized dependency. The user explicitly chose a free/open approach.

### SearXNG dependency

SearXNG is open source and useful for broad search, but requiring or bundling a service is too heavy for this CLI. Public instances also do not reliably enable JSON output. It is not part of the design.

### Bespoke platform scrapers

Dedicated platform adapters can improve discovery but create continuous maintenance and breakage. The first version uses tested `yt-dlp` capabilities and direct URLs. The provider boundary permits future focused adapters without changing the TUI or backend model.

### P2P creator directory first

A native creator directory is a strong long-term direction, but it cold-starts empty and requires a new discovery protocol. Remembered local creators and rich channel source records create useful seed data without blocking the CLI.

## Locked Implementation Contracts

- HyperDB evolution appends optional fields where an existing record evolves, introduces explicit `channelSources`, `channelArtwork`, and `importClaims` collections where records have independent identity, regenerates channel/public outputs together, and keeps a legacy decode fixture.
- Channel artwork uses a dedicated collection keyed by role (`avatar`, `poster`, `banner`, `backdrop`) with MIME type, remote provenance URL, and blob coordinates. Published profile responses normalize that collection.
- HRPC operations are `get-content-catalog` and `get-content-items`, with the pagination semantics in this specification. Their host/protocol/platform/generated-JS/generated-Swift release and shared protocol-version bump are one atomic cutover.
- Interactive settings use the existing `PEARTUBE_CONFIG` file under a `content` section, with `TMDB_API_KEY` as the environment override. Secret entry disables echo, logging redacts it, and a newly created secret-bearing config is mode `0600`.
- Released import claims use a configurable retention window with a 30-day default. Compaction still requires no active job reference and either a published winner or no remaining contender.
- The source capability matrix is an allowlist in code. V1 must support fixture-backed YouTube text search and generic direct-URL inspection; any additional search/profile/list capability is enabled only with a committed adapter fixture. Live failures still degrade at runtime.
- Local file identity is file size plus a streaming SHA-256 of the complete file, computed during preflight before the claim is finalized. Partial sampling cannot block a duplicate as exact.
- Canonical URLs lowercase scheme/host, remove fragments and default ports, strip known tracking parameters, preserve semantically meaningful query parameters, and defer provider-specific identity normalization to the adapter. Stable provider/source IDs take precedence over URL identity.
- Every persisted timestamp in the new contracts is UTC Unix milliseconds in `uint64` fields.
- Required durability refs include media and every local blob referenced by the same item/profile commit. Explicitly omitted optional artwork is absent from both the commit and required set.
- Trusted relay swarm keys and connection hints use existing relay configuration and populate `ctx.trustedRelayKeys`; one-peer immediate handoff is unavailable until that trust configuration is active.
