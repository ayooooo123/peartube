# Interactive `peartube add` CLI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a dedicated Node `peartube` CLI with a smooth `peartube add` picker and an explicit scripted episode/movie mode, strict bulk verification for later workflows, crash-safe publication, and success only after verified secondary seeding and public announcement.

**Architecture:** Map `peartube` to a dedicated Node entry point that never imports the relay/peer/Bare command graph. Separate argument validation, stdout results, stderr diagnostics, terminal rendering, picker state, discovery adapters, normalized drafts, bulk verification, durable queue storage, and backend execution. Reuse the universal backend context, upload manager, publication primitives, and seed-pin durability service from plans 1–3; do not create a second backend or shell out for P2P behavior.

**Tech Stack:** Node.js ESM, built-in raw TTY/readline keypress support, TMDB HTTP API, existing `yt-dlp` integration, Hyperbee-backed job manifests, universal PearTube backend, Brittle

**Spec:** `docs/superpowers/specs/2026-07-17-peartube-add-cli-design.md`

**Depends on:** Plans 1–3 complete. This is implementation plan 4 of 4.

---

## Chunk 1: Command Boundary and Terminal Engine

### Task 1: Add the dedicated Node `peartube` entry point

**Files:**
- Modify: `packages/cli/package.json:6-17,41-55`
- Create: `packages/cli/peartube.js`
- Create: `packages/cli/src/add/argv.js`
- Create: `packages/cli/test/add-argv.test.mjs`
- Create: `packages/cli/test/peartube-entry.test.mjs`

- [ ] **Step 1: Write failing argument and entry-boundary tests**

Assert `parsePeartubeArgv` recognizes `add`, `config`, and `help`. Interactive text is preserved as the add query. Scripted v1 accepts:

```text
peartube add <url> --type episode --provider tmdb --show-id <id> --season <n> --episode <n> --yes
peartube add <url> --type movie --provider tmdb --movie-id <id> --yes
```

Validate `--storage`, `--config`, `--no-color`, `--json`, `--no-input`, `--yes`, and `--force`. Episode mode requires provider/show/season/episode and forbids movie ID. Movie mode requires provider/movie ID and forbids show/season/episode. V1 rejects providers other than TMDB with an explicit unavailable error. Missing/contradictory coordinates are usage errors; missing coordinates may open the picker only when stdin and stderr are TTYs and `--no-input` is absent.

The entry-boundary test imports `peartube.js` with injected dispatch and proves it lazily imports add/config/help code only. Importing existing `bin.js`/`bare-bin.js` remains unchanged and never acquires `node:readline`, TMDB, or add modules.

- [ ] **Step 2: Run focused tests and observe missing modules**

Run from `packages/cli`:

```bash
./node_modules/.bin/brittle test/add-argv.test.mjs
./node_modules/.bin/brittle test/peartube-entry.test.mjs
```

Expected: FAIL because the dedicated entry/parser do not exist.

- [ ] **Step 3: Add the isolated executable**

Map only the new alias:

```json
"peartube": "peartube.js"
```

Keep `peartube-relay`, `peartube-peer`, `bin.js`, `bare-bin.js`, and their existing parser graph unchanged.

- [ ] **Step 4: Implement strict parser results**

Return `{ command, query, fetchUrl, flags, mode }` where `fetchUrl` is runtime-only and mode is `interactive` or `scripted`. `--json` changes only final result formatting; diagnostics still use stderr. `--yes` never bypasses mapping, duplicate, claim, durability, or publication checks. `--force` may bypass a failed local source job but never an existing target-authority identity claim.

- [ ] **Step 5: Implement lazy command dispatch**

`peartube.js` uses a small `runPeartube({ argv, stdin, stdout, stderr, env })` seam. It imports `./src/add/index.js` only for `add`; `config` opens the content settings flow; `help` prints stable usage. Unknown commands exit with code 2 and no stack trace.

- [ ] **Step 6: Run entry tests and existing relay CLI regression**

```bash
./node_modules/.bin/brittle test/add-argv.test.mjs
./node_modules/.bin/brittle test/peartube-entry.test.mjs
./node_modules/.bin/brittle test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit the command boundary**

```bash
git add packages/cli/package.json packages/cli/peartube.js packages/cli/src/add/argv.js packages/cli/test/add-argv.test.mjs packages/cli/test/peartube-entry.test.mjs
git commit -m "feat(cli): add isolated peartube command entry"
```

### Task 2: Build a deterministic picker state machine

**Files:**
- Create: `packages/cli/src/add/picker-state.js`
- Create: `packages/cli/test/add-picker-state.test.mjs`

- [ ] **Step 1: Write failing state-transition tests**

Drive plain action objects, not terminal bytes:

```js
state = reducePicker(state, { type: 'query.insert', text: 'breaking' })
state = reducePicker(state, { type: 'selection.move', delta: 1 })
state = reducePicker(state, { type: 'selection.complete' })
state = reducePicker(state, { type: 'step.confirm' })
state = reducePicker(state, { type: 'step.back' })
```

Cover query editing, result replacement, selection clamp/wrap decision, multi-select toggles, loading/error/retry, stale response rejection by monotonically increasing request ID, `Tab`, arrows, `Enter`, `Esc`, and preserving prior selections when moving back. Add interrupt actions: before a durable job they cancel normally; during `replicationPending`, `projecting`, or `announcing` they enter `exitConfirm`, dismissal returns to unchanged progress, and confirmation exits while preserving the exact checkpoint/local bytes.

- [ ] **Step 2: Run and verify module is absent**

Run: `./node_modules/.bin/brittle test/add-picker-state.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement pure state and actions**

Define explicit screens:

```text
search -> tvSeason -> episodeSelection -> sourceSelection -> review
search -> movieSource -> review
search -> creatorContent -> creatorAttachment -> sourceSelection -> review
bulkMapping -> review -> progress -> result
progress -> exitConfirm -> progress | result
```

State contains data only; no IO, timers, network calls, terminal width, or ANSI codes.

- [ ] **Step 4: Make completion deterministic**

`Tab` completes the highlighted suggestion into the active field. It must not depend on shell completion. For filesystem suggestions, the reducer accepts candidates supplied by the controller.

- [ ] **Step 5: Run state tests**

Expected: PASS.

- [ ] **Step 6: Commit state machine**

```bash
git add packages/cli/src/add/picker-state.js packages/cli/test/add-picker-state.test.mjs
git commit -m "feat(cli): add deterministic content picker state"
```

### Task 3: Implement raw-terminal input, rendering, and autocomplete

**Files:**
- Create: `packages/cli/src/add/terminal.js`
- Create: `packages/cli/src/add/render.js`
- Create: `packages/cli/src/add/controller.js`
- Create: `packages/cli/test/add-terminal.test.mjs`
- Create: `packages/cli/test/add-render.test.mjs`

- [ ] **Step 1: Write failing fake-TTY tests**

Use in-memory input/output streams and a fixed `{ columns: 100, rows: 30 }`. Assert key sequences map to reducer actions, one screen redraw does not append unbounded lines, cursor hide/show is balanced, cleanup restores raw mode on success/error/SIGINT, and non-TTY input returns an actionable error. SIGINT while publishing must dispatch the confirmation flow rather than immediately canceling or rolling back.

- [ ] **Step 2: Write renderer snapshots as arrays of lines**

Cover search, season/episode multi-select, bulk mapping table, progress, publishing-exit confirmation, narrow width, no-color, and errors. Strip ANSI before width assertions.

- [ ] **Step 3: Run and observe missing modules**

```bash
./node_modules/.bin/brittle test/add-terminal.test.mjs
./node_modules/.bin/brittle test/add-render.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Implement Node-only terminal adapter**

Use `node:readline.emitKeypressEvents`, raw mode, and ANSI cursor movement. Normalize keypresses to actions; never let terminal escape sequences enter picker state. Restore terminal state in `finally`.

- [ ] **Step 5: Implement compact rendering**

Render a stable header, query, bounded result window, contextual hints, and one footer. Use `↑/↓`, `Tab`, `Enter`, and `Esc` labels. Progress redraws one stable display rather than logging each tick.

- [ ] **Step 6: Add debounced controller effects**

The controller assigns a request ID, waits a configurable debounce, aborts the previous search with `AbortController`, and dispatches results only if request ID still matches. Inject clock/search/fs effects for deterministic tests.

- [ ] **Step 7: Implement path completion**

Expand `~`, preserve quoted spaces, complete directories on `Tab`, and normalize the final path only at confirmation. Do not stat every keystroke outside the current directory candidate.

- [ ] **Step 8: Run terminal/render tests**

Expected: PASS.

- [ ] **Step 9: Commit terminal engine**

```bash
git add packages/cli/src/add/terminal.js packages/cli/src/add/render.js packages/cli/src/add/controller.js packages/cli/test/add-terminal.test.mjs packages/cli/test/add-render.test.mjs
git commit -m "feat(cli): add in-process interactive picker"
```

## Chunk 2: Discovery and Normalized Drafts

### Task 4: Add secure add-command preferences and setup flow

**Files:**
- Create: `packages/cli/src/add/preferences.js`
- Create: `packages/cli/src/add/config-command.js`
- Create: `packages/cli/test/add-preferences.test.mjs`
- Create: `packages/cli/test/content-config-command.test.mjs`
- Modify: `packages/cli/config.example.yml`

- [ ] **Step 1: Write failing precedence/permission tests**

Resolve add preferences in this order:

1. command flags
2. environment (`TMDB_API_KEY`, `PEARTUBE_YTDLP_PATH`, `PEARTUBE_YTDLP_COOKIES`)
3. `content` section in the existing `PEARTUBE_CONFIG` YAML/default config
4. defaults

Assert a newly created or secret-bearing config is mode `0600`, unrelated config survives updates, logs/render/state never expose the TMDB key or cookie contents, absent keys keep creator URL/local flows available, and existing `network.trustedRelayKeys`/`network.blindPeerMirrors` values are normalized and forwarded without creating a second trust store. Config-command tests inspect/edit storage, locate and version-check the yt-dlp executable, validate an optional cookie file without reading it into output, redact the TMDB token, list backend publishing identities, and change the active identity only through the existing identity manager.

- [ ] **Step 2: Run and verify module is missing**

Run:

```bash
./node_modules/.bin/brittle test/add-preferences.test.mjs
./node_modules/.bin/brittle test/content-config-command.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement preference resolution**

Add normalized example config:

```yaml
content:
  storagePath: ~/.peartube/content
  tmdbApiKey: ""
  ytDlpPath: yt-dlp
  ytDlpCookiesPath: ""
  searchLimit: 12
  claimRetentionDays: 30
```

Use existing `PEARTUBE_CONFIG` resolution. Interactive setup accepts a TMDB read token for the session and offers to persist it atomically under `content.tmdbApiKey`; it also manages `content.storagePath`, `content.ytDlpPath`, and optional `content.ytDlpCookiesPath`. Preserve every unrelated YAML key/comment supported by the current parser/writer. A newly created or secret-bearing config is mode `0600`; environment values always override the file and are displayed only as “configured”. If safe round-trip editing is unavailable, keep secrets session-only and print a redacted field template instead of rewriting destructively. Read trusted relay keys/blind-peer hints from the existing top-level `network` configuration. The active publishing identity remains backend identity state—inspect and change it through `identityManager`, never by copying keys/secrets into YAML.

- [ ] **Step 4: Implement setup result states**

Missing TMDB key on TV/movie search yields a short setup screen with “Paste key”, “Use creator URL”, “Choose local file”, and “Back”; it must not dump a stack trace. Missing `yt-dlp` offers the exact configured executable path and retry. `peartube config` shows storage, redacted TMDB status, yt-dlp executable/version, cookies configured/missing, and active publishing identity, then updates one field at a time.

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit preferences**

```bash
git add packages/cli/src/add/preferences.js packages/cli/src/add/config-command.js packages/cli/test/add-preferences.test.mjs packages/cli/test/content-config-command.test.mjs packages/cli/config.example.yml
git commit -m "feat(cli): configure add discovery securely"
```

### Task 5: Implement fixture-backed TMDB normalization

**Files:**
- Create: `packages/cli/src/add/providers/tmdb.js`
- Create: `packages/cli/test/fixtures/tmdb-search.json`
- Create: `packages/cli/test/fixtures/tmdb-tv.json`
- Create: `packages/cli/test/fixtures/tmdb-season.json`
- Create: `packages/cli/test/fixtures/tmdb-movie.json`
- Create: `packages/cli/test/tmdb-provider.test.mjs`

- [ ] **Step 1: Write failing provider tests**

Against injected `fetch`, assert normalized TV/movie search results, badges, stable IDs, release year, descriptions, season ordering, episode numbers/titles/air dates/stills, movie details, and image URLs. Assert non-2xx, invalid JSON, timeout/abort, rate limit, and missing key return typed provider errors.

- [ ] **Step 2: Run and verify provider is absent**

Run: `./node_modules/.bin/brittle test/tmdb-provider.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement minimal TMDB endpoints**

Use `/search/multi`, `/tv/{id}`, `/tv/{id}/season/{number}`, and `/movie/{id}`. Ignore unsupported person results in v1. Limit response sizes and normalize only explicit fields into internal drafts.

- [ ] **Step 4: Normalize artwork provenance**

Return poster/backdrop/still candidates as remote provenance records; do not hotlink them in persisted channel data. The executor later downloads and stores selected artwork in channel blobs.

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit TMDB adapter**

```bash
git add packages/cli/src/add/providers/tmdb.js packages/cli/test/fixtures/tmdb-*.json packages/cli/test/tmdb-provider.test.mjs
git commit -m "feat(cli): add TMDB content discovery"
```

### Task 6: Extract and extend the existing `yt-dlp` adapter

**Files:**
- Create: `packages/cli/src/media/yt-dlp.js`
- Modify: `packages/cli/src/archive-manager.js:201-329`
- Create: `packages/cli/src/add/providers/yt-dlp.js`
- Create: `packages/cli/test/fixtures/yt-dlp-search.json`
- Create: `packages/cli/test/fixtures/yt-dlp-channel.json`
- Create: `packages/cli/test/add-yt-dlp-provider.test.mjs`
- Modify: `packages/cli/test/archive.test.mjs`

- [ ] **Step 1: Write failing shared-adapter tests**

Assert exact safe argv arrays—never shell strings—for:

- direct URL inspect
- `ytsearchN:<query>` text search
- flat creator/channel listing
- selected download with existing archive format/cookies/ffmpeg flags

Cover executable missing, unsupported extractor operation, invalid output, and nonzero exit with stderr truncation.

- [ ] **Step 2: Run focused tests before extraction**

```bash
./node_modules/.bin/brittle test/add-yt-dlp-provider.test.mjs
./node_modules/.bin/brittle test/archive.test.mjs
```

Expected: new test FAIL; existing archive tests PASS.

- [ ] **Step 3: Extract without changing archive behavior**

Move reusable process execution/info/download logic from `archive-manager.js` into `src/media/yt-dlp.js`. Keep `createYtDlpDownloader` export compatibility and make archive-manager import it. Do not duplicate download command construction.

- [ ] **Step 4: Implement explicit capability matrix**

Represent `search`, `profile`, `list`, `metadata`, and `download` separately. Enable v1 fixture-backed YouTube text search plus generic direct URL inspection/download. Runtime failure degrades to direct URL/local source selection with the draft intact.

- [ ] **Step 5: Normalize creators and content**

Map creator name, platform, source ID, canonical URL, handle, avatar/banner URLs, biography, and recent videos/streams. Map content source ID, canonical URL, title, description, published timestamp, thumbnail, duration, and creator identity.

- [ ] **Step 6: Run provider and archive tests**

Expected: PASS.

- [ ] **Step 7: Commit shared downloader/provider**

```bash
git add packages/cli/src/media/yt-dlp.js packages/cli/src/archive-manager.js packages/cli/src/add/providers/yt-dlp.js packages/cli/test/fixtures/yt-dlp-*.json packages/cli/test/add-yt-dlp-provider.test.mjs packages/cli/test/archive.test.mjs
git commit -m "feat(cli): reuse yt-dlp for creator discovery"
```

### Task 7: Merge discovery, remembered creators, and normalized drafts

**Files:**
- Create: `packages/cli/src/add/content-model.js`
- Create: `packages/cli/src/add/discovery.js`
- Create: `packages/cli/src/add/creator-memory.js`
- Create: `packages/cli/test/add-discovery.test.mjs`

- [ ] **Step 1: Write failing merge/deduplication tests**

Combine TMDB, yt-dlp, remembered creators, existing local creator channels, direct URLs, and fallback actions. Assert stable provider/source identities dedupe candidates; remembered creators sort first for relevant queries; stale provider responses cannot replace newer results; direct URL/local choices are always present; provider failure leaves successful providers visible. A newly selected creator source offers “Create creator channel” and explicit “Attach to <existing creator>” targets; equal/similar names never auto-attach. Test one central URL normalizer: `identityUrl` lowercases scheme/host, removes fragments/default ports and known secret/tracking parameters, preserves provider-declared identity parameters, and yields after stable provider/source ID for identity precedence; `displayUrl` removes user info and all query values.

- [ ] **Step 2: Write draft normalization tests**

Assert TV selection produces one show channel profile + episode target drafts; movie produces one movie channel + movie/trailer drafts; creator produces one creator channel + source-linked video/stream drafts. For cross-platform creators, assert explicit review selection produces `{ mode: 'existing', channelKey }` and adds the new normalized source identity to that channel; choosing new produces `{ mode: 'new' }`; cancel changes nothing; name similarity alone never merges. Remote response objects must not leak arbitrary keys. The runtime-only original `fetchUrl` reaches yt-dlp but never appears in normalized persisted drafts, job serialization, errors, or logs; only `identityUrl` persists as provenance and only `displayUrl` reaches diagnostics.

- [ ] **Step 3: Run and verify modules are absent**

Run: `./node_modules/.bin/brittle test/add-discovery.test.mjs`

Expected: FAIL.

- [ ] **Step 4: Implement provider-independent internal types**

Use plain validated objects:

```js
{ kind: 'channel', profileKind, name, description, mediaProvider, mediaId, sources, artwork, channelTarget: { mode: 'new' } /* or { mode: 'existing', channelKey } */ }
{ kind: 'item', contentKind, title, sourceProvider, sourceVideoId, identityUrl, displayUrl, sourcePublishedAt, seasonNumber, episodeNumber, artwork }
```

Keep `fetchUrl` in an ephemeral controller/executor input object until a verified download artifact exists. Resume after that point uses the verified artifact path and does not need the original URL.

- [ ] **Step 5: Persist remembered creators in backend metadata**

Use a versioned `content-add/v1/creator/<provider>/<encoded-identityKey>` prefix in the active backend metadata Hyperbee. The `identityKey` follows Plan 1 (`id:<sourceId>` first, otherwise hashed normalized URL); persist optional normalized `sourceId`/`identityUrl` public fields. Store no API tokens, cookies, `fetchUrl`, or `displayUrl`.

- [ ] **Step 6: Run tests**

Expected: PASS.

- [ ] **Step 7: Commit discovery coordinator**

```bash
git add packages/cli/src/add/content-model.js packages/cli/src/add/discovery.js packages/cli/src/add/creator-memory.js packages/cli/test/add-discovery.test.mjs
git commit -m "feat(cli): normalize content discovery drafts"
```

## Chunk 3: Strict Bulk Verification and Durable Queue

### Task 8: Build mapping-first bulk import verification

**Files:**
- Create: `packages/cli/src/add/bulk/source-scanner.js`
- Create: `packages/cli/src/add/bulk/matcher.js`
- Create: `packages/cli/src/add/bulk/manifest.js`
- Create: `packages/cli/test/add-bulk-matcher.test.mjs`
- Create: `packages/cli/test/add-bulk-property.test.mjs`

- [ ] **Step 1: Write failing scanner tests**

Cover local directory, selected files, playlist URL, multiple URLs, and creator/channel URL listing. A source record includes path/URL, provider/source ID when known, size, media metadata, and optional extracted title/date. Stream a full-file SHA-256 fingerprint for local files; never load a large file into memory.

- [ ] **Step 2: Write failing strict matcher tests**

Fixture cases:

- exact stable external episode/content ID
- exact embedded metadata or filename `S01E01` / `1x01`
- provider-declared show/season/episode coordinates
- normalized exact episode title
- air/release date
- filename order only
- stable-ID conflict against misleading title/date/filename evidence
- duplicate target assignments
- one source matching two targets
- already-added provider/source IDs
- already-added local fingerprints
- unassigned source and missing selected target
- manual assignment/exclusion persistence
- trailer/extra/behind-the-scenes classification

- [ ] **Step 3: Add property-oriented one-to-one tests**

Generate shuffled sources/targets and assert every accepted mapping is injective both directions, deterministic under input reordering, and never automatically accepts ambiguous equal-confidence candidates.

- [ ] **Step 4: Run and verify modules are absent**

```bash
./node_modules/.bin/brittle test/add-bulk-matcher.test.mjs
./node_modules/.bin/brittle test/add-bulk-property.test.mjs
```

Expected: FAIL.

- [ ] **Step 5: Implement evidence-ranked matching**

Use this strict precedence:

1. exact stable external episode/content ID
2. provider-declared show/season/episode coordinates
3. exact embedded season/episode metadata or explicit filename token
4. unique normalized episode title
5. unique air/release date
6. filename order as weak suggestion only

A stable external ID always wins conflicts against provider coordinates, title, date, or filename evidence; provider coordinates outrank filename-only tokens. Only unique high-confidence evidence auto-assigns. Title/date and every weak/ambiguous result remains review-required.

- [ ] **Step 6: Implement serializable manifests**

A frozen manifest contains schema version, channel draft, selected targets, sources, fingerprints/source IDs, assignments, exclusions, manual classifications, confidence/evidence, unresolved rows, and created/updated timestamps. Serialization is deterministic; invalid/unresolved manifests cannot enter upload state.

- [ ] **Step 7: Run bulk tests**

Expected: PASS.

- [ ] **Step 8: Commit bulk verifier**

```bash
git add packages/cli/src/add/bulk packages/cli/test/add-bulk-matcher.test.mjs packages/cli/test/add-bulk-property.test.mjs
git commit -m "feat(cli): verify bulk episode mappings before upload"
```

### Task 9: Add a crash-safe content job store

**Files:**
- Create: `packages/cli/src/add/job-store.js`
- Create: `packages/cli/test/add-job-store.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Use a temporary Hyperbee and assert atomic/checkpointed transitions:

```text
pending -> resolving -> downloading -> uploading -> uploaded
-> replicationPending -> durabilityVerified -> projecting -> projected
-> announcing -> announced -> finalizing -> published
terminal alternatives: failed | skipped
```

Each row has independent state/progress/error/attempt counts and deterministic channel/video/blob intent IDs. Test process recreation, idempotent retry, completed-row skipping, failure/skipping of one row without corrupting later rows, frozen-manifest checksum validation, and resumption at the first incomplete row. The transition into `uploading` atomically persists deterministic upload intent before upload starts; there is no separate intent state. Reopen after that transition, post-upload/pre-checkpoint, `uploaded`, projection, announcement, and finalization boundaries; assert repair from the private video record, stable identifiers, no repeated completed upload, and one terminal publication. Serialization rejects/strips `fetchUrl`, credentials, and unredacted downloader errors.

- [ ] **Step 2: Run and verify store is absent**

Run: `./node_modules/.bin/brittle test/add-job-store.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement versioned Hyperbee keys**

```text
content-add/v1/job/<jobId>
content-add/v1/job/<jobId>/row/<rowId>
content-add/v1/active/<createdAt>/<jobId>
```

Use single-batch updates for row transition plus job summary. Enforce allowed transitions and compare expected prior state/version to prevent double workers.

- [ ] **Step 4: Preserve private pending jobs indefinitely**

Never drop `replicationPending` jobs because the CLI exits. Store staged descriptor/profile/source/artwork patches in the durable job/manifest until `contentPublication.project()` applies Plan 1’s APIs, plus the verified artifact path/checksum after download, upload intent, manifest durability refs, pin request IDs, channel/video/blob IDs, public announcement identity, and exact checkpoints needed to resume without re-download/re-upload. Cached artwork blob bytes may exist early, but their profile/source/artwork references are not attached to channel metadata before project. Before a verified artifact exists, a URL failure resumes by asking the user to supply the URL again rather than persisting `fetchUrl`.

- [ ] **Step 5: Run lifecycle tests**

Expected: PASS.

- [ ] **Step 6: Commit durable queue**

```bash
git add packages/cli/src/add/job-store.js packages/cli/test/add-job-store.test.mjs
git commit -m "feat(cli): persist resumable content add jobs"
```

## Chunk 4: Backend Execution and End-to-End UX

### Task 10: Open the universal backend and publish verified jobs

**Files:**
- Create: `packages/cli/src/add/runtime.js`
- Create: `packages/cli/src/add/artwork-cache.js`
- Create: `packages/cli/src/add/diagnostic-scope.js`
- Create: `packages/cli/src/add/executor.js`
- Create: `packages/cli/src/add/duplicate-check.js`
- Create: `packages/cli/test/add-executor.test.mjs`
- Modify: `packages/backend/src/orchestrator.js`
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/upload.js`
- Modify: `packages/backend/src/public-feed.js`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Write failing executor tests**

Inject backend/upload/downloader/replication fakes. Assert:

- new TV/movie/creator selections create/reuse one canonical channel
- a new creator platform source attaches to an existing creator channel only with explicit reviewed `channelTarget`; similar names alone create no merge
- channel profile/source/artwork updates are staged, not public early
- brand-new channels use deferred public projection: a local public key/descriptor may exist for pin authorization, but no public profile/discovery/feed entry exists before durability
- selected artwork is downloaded, MIME-validated, blob-stored, and referenced locally
- rows execute sequentially with durable checkpoints
- exact source IDs/fingerprints and import claims block duplicates before transfer
- target-authority exact episode/movie identities and active local jobs return `already-exists` with stable IDs and no transfer
- structured public/feed matches are advisory (exact first, fuzzy title/year warnings) and never block another authority
- `--force` bypasses only a failed local source job, never a winning/pending target-authority identity
- claims are flushed/resolved before downloader/upload manager media transfer begins
- `importClaimantId` equals Plan 1’s `deriveImportClaimantId(writerKey, durableJobId)` and is unchanged across every restart/checkpoint
- a later replicated lower claimant suppresses the losing private draft from projection without deleting its bytes
- released-claim compaction receives active job IDs and honors configured retention
- upload creates `replicationPending`
- upload receives persisted `identityUrl` provenance explicitly and never receives/persists runtime `fetchUrl` or diagnostic `displayUrl`
- executor does not report success on pin acceptance
- executor waits for verified durability, then project/announce/finalize
- retry after every checkpoint does not duplicate video/feed records

- [ ] **Step 2: Run and verify executor is absent**

Run: `./node_modules/.bin/brittle test/add-executor.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement Node headless backend lifecycle**
Use `createBackendContext({ storagePath, network, logger })` from the universal backend orchestrator and `shutdownBackend(ctx)` in `finally`, forwarding normalized existing `network.trustedRelayKeys`/blind-peer discovery configuration. Reuse its `identityManager`, channel loaders, upload manager, public feed, seed-pin clients, and metadata Hyperbee. Thread the injected logger through orchestrator/API/upload/feed code changed here. For legacy backend dependencies on this execution path that still call `console.*`, `diagnostic-scope.js` temporarily routes those methods to the same injected stderr logger for the single command and restores them in `finally`; it never captures the final explicit stdout writer. The process test covers success, error, and restoration. Do not instantiate a CLI-specific Corestore/swarm stack.

- [ ] **Step 4: Implement identity, channel, and duplicate resolution**

Honor an explicit reviewed `channelTarget: { mode: 'existing', channelKey }` for cross-platform creator attachment after validating the target is an owned creator channel; stage the new provider/source identity in the durable job and apply it only at project. Otherwise match existing channels only by the same media provider + stable show/movie ID or creator provider/source identity; name equality never reuses a channel. Before claims or transfer, query target-channel structured videos and active durable jobs for exact movie identity or show+season+episode identity. An existing target item is a successful no-op with channel/video/availability identifiers. Query locally cached/replicated catalogs and the public feed for advisory exact/fuzzy matches, ordered exact first, but never use them as cross-authority blockers. If no explicit/exact target exists, create through the identity API with `deferPublicProjection: true`. Keep descriptor/profile/source/artwork patches only in the durable job until `contentPublication.project()` applies Plan 1’s private/public APIs; do not pre-write channel rows that an unrelated legacy sync could leak.

- [ ] **Step 5: Implement safe artwork caching**

Fetch with abort/time/size limits, require `image/*`, stream to channel blobs, retain remote provenance URL, and mark optional artwork failure as a visible warning. Required selected artwork refs join the durable manifest.

- [ ] **Step 6: Implement row execution**

Before media transfer, refresh replicated channel state, reject existing published/pending source IDs/fingerprints, derive `importClaimantId = deriveImportClaimantId(writerKey, durableJobId)`, write and flush that deterministic claim, then resolve it; a losing claimant is marked `released` and skipped without downloading/uploading. Retries reuse the stored durable job ID and cannot create another contender. Only a winning row may invoke the shared yt-dlp downloader or local `uploadFromPath`; pass `identityUrl` as explicit persisted provenance, keep `fetchUrl` only in the downloader call, and keep `displayUrl` only in diagnostics. Atomically enter `uploading` with deterministic upload intent plus `importIdentityKey`/`importClaimantId` before upload; if a crash occurs after the private video commit but before the `uploaded` checkpoint, reopen `uploading`, find that deterministic video, and repair without repeating upload. Build durable refs, invoke `createContentReplication`, and checkpoint every transition. Cancellation before upload releases its claim; Ctrl-C during download cancels the downloader and creates no public record. On startup/cleanup, compact released claims with `content.claimRetentionDays` and the job store’s active-job predicate.

- [ ] **Step 7: Bound replication backlog**

Default sequential execution: do not upload the next item until the prior item passes durability or is explicitly paused/failed. Metadata/artwork pre-resolution may happen before transfer. No publish-anyway option.

- [ ] **Step 8: Run executor tests**

Expected: PASS.

- [ ] **Step 9: Commit backend executor**

```bash
git add packages/cli/src/add/runtime.js packages/cli/src/add/diagnostic-scope.js packages/cli/src/add/artwork-cache.js packages/cli/src/add/duplicate-check.js packages/cli/src/add/executor.js packages/cli/test/add-executor.test.mjs packages/cli/package.json packages/backend/src/orchestrator.js packages/backend/src/api.js packages/backend/src/upload.js packages/backend/src/public-feed.js
git commit -m "feat(cli): execute verified content imports"
```

### Task 11: Wire the complete interactive workflow and progress display

**Files:**
- Create: `packages/cli/src/add/index.js`
- Modify: `packages/cli/src/index.js`
- Create: `packages/cli/test/add-command.test.mjs`
- Create: `packages/cli/test/add-process-output.test.mjs`
- Modify: `packages/cli/scripts/run-tests.mjs`

- [ ] **Step 1: Write failing command scenarios**

Drive fake providers/TTY/runtime through:

1. one standalone local video file
2. one local TV episode
3. one URL movie
4. scripted non-TTY episode with exact TMDB coordinates
5. scripted non-TTY movie with exact TMDB coordinates
6. creator selection then recent video
7. explicit attachment of a second-platform creator source to an existing creator channel
8. selected episodes from a season
9. entire season with one ambiguous filename corrected manually
10. all selected episodes missing until sources are supplied or explicitly excluded
11. local directory/multiple-file scan through frozen mapping
12. playlist or creator-listing URL through frozen mapping
13. multiple pasted URLs through frozen mapping
14. resume from every persisted checkpoint without repeated download/upload
15. target-authority `already-exists` in human and JSON modes
16. missing TMDB key and missing yt-dlp setup/retry
17. non-TTY missing coordinates and `--no-input` fail without prompting
18. Ctrl-C during download cancels with no published record
19. Ctrl-C during `replicationPending`, `projecting`, and `announcing`: dismiss continues unchanged; confirm exits with checkpoint/local bytes intact; restart resumes once
20. entry-level `peartube config` inspection/update for redacted TMDB status, yt-dlp executable/cookies, storage, and active publishing identity

In `add-process-output.test.mjs`, spawn the dedicated entry with fakes and require `--json` stdout to contain exactly one parseable JSON value; all progress/diagnostics go to stderr, secrets and `fetchUrl` never appear, and `status: "already-exists"` includes stable channel/video/availability identifiers. For confirmed SIGINT during publishing, assert no rollback/delete/public duplication and exact checkpoint recovery in a restarted process. Assert exact outcomes, not source text.

- [ ] **Step 2: Run and verify command module is absent**

Run:

```bash
./node_modules/.bin/brittle test/add-command.test.mjs
./node_modules/.bin/brittle test/add-process-output.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Compose search and selection flows**

`runAddCommand` resolves preferences, opens backend/job store, surfaces resumable jobs before new search, and either wires discovery effects into the picker or resolves scripted TMDB coordinates without a TTY. URL/path input bypasses irrelevant search while retaining review unless valid scripted flags plus `--yes` are present. The dedicated entry dispatches `config` to `config-command.js` and `help` without loading the add executor unnecessarily.

- [ ] **Step 4: Compose mapping-first bulk review**

Never enqueue until every selected target and source has a unique assignment or explicit exclusion/classification. Show source, assignment, confidence/evidence, already-added state, and errors in the verification table.

- [ ] **Step 5: Render stable publication progress**

Use stderr for progress:

```text
Uploading 1.4 GB
Metadata
Replicating peer 8f21… · 61% · 854 MB / 1.4 GB
Verifying copy
Announcing
```

Write exactly one final human line or JSON object to stdout, such as `Published peartube://channel/<key>/video/<id>`. An already-existing item is also successful and identifies the stable existing record.

If no eligible peer exists, leave the job pending, retain local bytes, state that the uploader is still the only source, and offer retry/exit—not publish.

- [ ] **Step 6: Preserve state on recoverable errors**

Provider, download, upload, pin, and announcement errors remain on the current step with Retry/Change source/Cancel. Cancel never deletes already published rows; pending-row deletion requires explicit confirmation. SIGINT before durable publication cancels safely; SIGINT after a durable publishing checkpoint requires confirmation, and confirmed exit preserves the checkpoint/local bytes for resume rather than rolling back.

- [ ] **Step 7: Register and run all add-command tests**

Add every new CLI test from Tasks 1–11 to `TEST_FILES` in `scripts/run-tests.mjs`. Keep one Brittle process per file, then run `npm test` from `packages/cli`. Expected: PASS.

- [ ] **Step 8: Commit workflow composition**

```bash
git add packages/cli/src/add/index.js packages/cli/src/index.js packages/cli/test/add-command.test.mjs packages/cli/test/add-process-output.test.mjs packages/cli/scripts/run-tests.mjs
git commit -m "feat(cli): complete interactive peartube add workflow"
```

### Task 12: Smoke-test the real command and verify regressions

**Files:**
- Create: `packages/cli/test/fixtures/media/S01E01.mp4`
- Create: `packages/cli/test/fixtures/add-smoke-preload.mjs`
- Create: `packages/cli/test/fixtures/fake-yt-dlp.mjs`
- Modify: `packages/cli/package.json`
- Create: `packages/cli/scripts/add-smoke.mjs`

- [ ] **Step 1: Build a deterministic local smoke environment**

Start an uploader backend and trusted relay using temporary storage and real seed-pin registration. Add `node-pty` as a Node-only dev dependency and dynamically import it only from `add-smoke.mjs`, preserving relay/peer/Bare graphs. The runner creates platform-specific temporary `yt-dlp` launchers (POSIX executable and Windows `.cmd`) that invoke `fake-yt-dlp.mjs`; `add-smoke-preload.mjs` intercepts only fixture TMDB/artwork `fetch` URLs via Node `--import`. Use a tiny valid media fixture. No live key, internet, or system PTY command dependency.

- [ ] **Step 2: Drive the actual command through a pseudo-terminal**

Use `node-pty.spawn(process.execPath, ['--import', preloadPath, 'packages/cli/peartube.js', ...args], { env })` so the actual executable main, argv parser, dispatch, controller, and runtime run in a real cross-platform PTY. Drive fixture-backed scenarios for: local TV episode; URL movie with artwork; creator URL + recent item; complete season with one ambiguous filename that blocks transfer until manual assignment; interrupted bulk resume without duplicate completed rows; and explicit second-platform attachment to an existing creator. Send `Tab`, arrows, `Enter`, `Esc`, and Ctrl-C bytes through the PTY; wait on semantic screen text with bounded timeouts and assert one stable progress display per run.

- [ ] **Step 3: Verify network/storage outcomes directly**

Assert across the smoke matrix:

- private drafts precede every public record
- trusted relay acquires the complete same-holder media/artwork ref set before publication
- backend assessment names that authenticated configured relay as the complete-item holder
- TV/movie/creator structured catalogs and public feed each expose exactly the expected canonical item/channel snapshot
- uploader may offload only after verification
- no trusted relay and fewer than two ordinary full-copy peers remains local `replicationPending` and unannounced
- mid-transfer disconnect/soft receipt cannot promote
- disjoint media/artwork holders fail aggregate durability
- staged artwork on an existing channel leaves the old public profile visible until the combined manifest is durable
- converged paired-writer claims suppress the deterministic loser in both catalog and refreshed feed

- [ ] **Step 4: Verify interruption, crash repair, and terminal races**

Disconnect the relay mid-transfer. Exit the CLI; confirm no public item, retained local bytes, and persisted `replicationPending`. Restart, choose Resume, reconnect, and confirm publication without re-upload/remapping. Inject crashes after entering `uploading` with intent, private upload commit before `uploaded`, `replicationPending`, `durabilityVerified`, public projection, feed announcement, and claim-suppression-before-feed-refresh; each restart must reach one terminal publication/canonical feed snapshot with stable IDs and no repeated completed transfer/effect.

- [ ] **Step 5: Run the smoke script**

From repo root:

```bash
node packages/cli/scripts/add-smoke.mjs
```

Expected: prints fourteen verified scenario summaries matching the approved end-to-end matrix and exits 0.

- [ ] **Step 6: Run focused permanent suites**

```bash
npm test --prefix packages/cli
npm --prefix packages/backend exec -- brittle test/content-replication.test.mjs test/seed-pin-integration.test.mjs test/channel-catalog-api.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
```

Expected: PASS.

- [ ] **Step 7: Exercise help/error paths manually**

Run:

```bash
node packages/cli/peartube.js add --help
TMDB_API_KEY= node packages/cli/peartube.js add "Breaking Bad"
PATH=/usr/bin:/bin node packages/cli/peartube.js add "https://example.invalid/video"
```

Expected: concise help/setup/actionable errors; no secret or stack dump.

- [ ] **Step 8: Commit smoke coverage**

```bash
git add packages/cli/package.json packages/cli/test/fixtures/media/S01E01.mp4 packages/cli/test/fixtures/add-smoke-preload.mjs packages/cli/test/fixtures/fake-yt-dlp.mjs packages/cli/scripts/add-smoke.mjs
git commit -m "test(cli): smoke verified peartube add publication"
```

## Plan 4 Completion Gate

The feature is complete only when the actual `peartube add` binary provides in-process completion, strict pre-transfer mapping, canonical rich channels, locally retained artwork, crash-safe resume, and verified remote full-range durability before one public catalog/feed entry appears. Relay/peer/Bare commands and legacy channel clients must still pass their focused regressions.
