# PearTube Media Cockpit Slice 1 Autoresearch Iteration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the Slice 1 plan after review-driven mapper failures so the next implementation pass produces a Netflix/Spotify/Twitch/YouTube-style PearTube media cockpit without breaking existing playback, relay, protocol, or blob-serving behavior.

**Architecture:** Treat the original Slice 1 plan as the baseline experiment. This iteration replaces the active execution tasks with review-hardened steps: finish the pure mapper contract first, then build presentational media components, then integrate Home through explicit playback/source-item helpers. Keep product grouping in `packages/app/lib/media-hub.js`; keep UI in `packages/app/components/media/` and `packages/app/app/(tabs)/index.tsx`.

**Tech Stack:** Expo Router, React Native, TypeScript/TSX, existing PearTube primitives, Node `node:test` source/unit tests, OMP implementer/reviewer subagents.

---

## Autoresearch adaptation

Target artifact: `docs/superpowers/plans/2026-07-22-peartube-media-cockpit-slice-1.md`

Test inputs used:
- Mapper review failures from Task 1 after repeated green test runs.
- Current `packages/app/lib/media-hub.js` implementation.
- Current `packages/app/tests/media-hub.test.mjs` suite.
- PearTube media UI delivery skill invariants.

Binary eval suite:

EVAL 1: Mapper identity safety
Question: Does the plan require stable playback identity without title fallback and require normalized outputs to preserve playback/resume fields used by Home?
Pass: Tests cover title-only drops, `getMediaHubPlaybackKey()` on normalized output, direct `channelKey`/`videoId`/`driveKey`/`publicBeeKey` preservation, and continue-watching resume fields.
Fail: Plan lets normalized cards become `local:<id>`, relies on `item.item` only, or permits title-derived identity.

EVAL 2: Mapper rail consistency
Question: Does the plan require all rails and featured to use deduped/backfilled items consistently?
Pass: Tests cover metadata, timestamp, artwork, same-source feed/library dedupe, and featured selection after dedupe/backfill.
Fail: Only `allItems` is deduped/backfilled while `recentlySeeded`, `yourLibrary`, or `featured` use raw/partial arrays.

EVAL 3: Featured ordering contract
Question: Does the plan define one deterministic featured sort rule matching the product direction?
Pass: Featured selection is artwork first, then newest timestamp, then playback key; it does not silently boost movie/show metadata above recency.
Fail: Featured ranking prioritizes movie/show signal over newer playable media.

EVAL 4: UI playback preservation
Question: Do component and Home tasks preserve existing playback and channel routing while changing presentation?
Pass: Components are presentational, Home calls `playMediaHubItem()` / `resumeEntry()`, player still goes through `rpc.preparePlayback(playbackRequest)` and `loadAndPlayVideo(video, result.url)`, and public refresh remains visible.
Fail: UI cards call new backend APIs, route to unbuilt title pages, or pass shape-stripped normalized items into playback without a source-item fallback.

EVAL 5: Review and verification gates
Question: Does each task include exact tests, expected failures, commits, and spec/quality review gates?
Pass: Every task has a focused test command, expected result, commit boundary, and reviewer acceptance criteria.
Fail: Green tests alone are treated as sufficient, or Task 2/3 begin before Task 1 reviews approve.

Baseline score for original plan after Task 1 review feedback: 1/5.
- Passed: rough slice ordering existed.
- Failed: Task 1 template used title fallback, incomplete dedupe/backfill, featured content-type boost, weak normalized playback contract, and insufficient review gates.

Experiment 1 — KEEP: add mapper invariant list and stricter tests.
Score: 4/5. Improved identity, rail consistency, and featured rules, but still left UI tasks too loose.

Experiment 2 — KEEP: replace active task sequence with review-hardened execution tasks below.
Score: 5/5. Adds explicit Task 1 completion gate before UI, source-item playback helper, source-level guards, and reviewer prompts.

---

## Active execution rule

Do not dispatch the original Task 1-5 bodies from `2026-07-22-peartube-media-cockpit-slice-1.md` directly. They are now baseline/reference material. Use the tasks in this file as the active handoff.

Implementation branch/worktree:

```bash
cd /home/user/projects/peartube/.worktrees/media-cockpit-slice-1
git status --short --branch
```

Expected branch: `feat/media-cockpit-slice-1`.

Focused suite used throughout:

```bash
node --test   packages/app/tests/content-catalog.test.mjs   packages/app/tests/media-hub.test.mjs   packages/app/tests/mobile-ui-redesign-regression.test.mjs   packages/app/tests/vertical-discovery-regression.test.mjs
```

---

### Task 1R: Finish and review-harden the media-hub mapper

**Files:**
- Modify: `packages/app/lib/media-hub.js`
- Modify: `packages/app/tests/media-hub.test.mjs`

- [ ] **Step 1: Add failing tests for the remaining review blockers**

Append these tests to `packages/app/tests/media-hub.test.mjs`:

```js
test('features artwork candidates by timestamp before content type weighting', () => {
  const olderMovie = video({
    id: 'older-movie',
    channelKey: 'featured-order',
    title: 'Older movie',
    contentKind: 'movie',
    classification: { type: 'movie' },
    thumbnailUrl: 'https://img.example/older-movie.jpg',
    createdAt: null,
    uploadedAt: 1_000,
  })
  const newerUpload = video({
    id: 'newer-upload',
    channelKey: 'featured-order',
    title: 'Newer upload',
    contentKind: null,
    classification: null,
    thumbnailUrl: 'https://img.example/newer-upload.jpg',
    createdAt: null,
    uploadedAt: 2_000,
  })

  const sections = buildMediaHubSections({ feedVideos: [olderMovie, newerUpload] })

  assert.equal(sections.featured.item.id, 'newer-upload')
})

test('normalized media items preserve Home playback identity fields', () => {
  const raw = video({
    id: 'raw-id',
    videoId: 'raw-video-id',
    channelKey: 'raw-channel',
    driveKey: 'raw-drive',
    publicBeeKey: 'raw-public-bee',
    path: '/videos/raw.mp4',
    title: 'Raw playable item',
    thumbnailUrl: 'https://img.example/raw.jpg',
  })

  const sections = buildMediaHubSections({ feedVideos: [raw] })
  const item = sections.allItems[0]

  assert.equal(item.channelKey, 'raw-channel')
  assert.equal(item.videoId, 'raw-video-id')
  assert.equal(item.driveKey, 'raw-drive')
  assert.equal(item.publicBeeKey, 'raw-public-bee')
  assert.equal(item.path, '/videos/raw.mp4')
  assert.equal(item.playbackKey, 'raw-channel:raw-id')
  assert.equal(getMediaHubPlaybackKey(item), 'raw-channel:raw-id')
})

test('normalized continue watching items preserve resume playback fields', () => {
  const sections = buildMediaHubSections({
    continueWatching: [{
      channelKey: 'resume-channel',
      videoId: 'resume-video',
      title: 'Resume video',
      durationSec: 100,
      positionSec: 25,
      thumbnail: 'https://img.example/resume.jpg',
    }],
  })
  const item = sections.continueWatching.items[0]

  assert.equal(item.channelKey, 'resume-channel')
  assert.equal(item.videoId, 'resume-video')
  assert.equal(item.durationSec, 100)
  assert.equal(item.positionSec, 25)
  assert.equal(item.thumbnailUrl, 'https://img.example/resume.jpg')
  assert.equal(getMediaHubPlaybackKey(item), 'resume-channel:resume-video')
})
```

- [ ] **Step 2: Run mapper tests and verify current failure**

```bash
node --test packages/app/tests/media-hub.test.mjs
```

Expected before implementation: FAIL because `selectFeatured()` still considers `hasFeaturedMediaSignal()`, normalized media items do not expose all direct playback fields, and `getMediaHubPlaybackKey()` does not honor normalized `playbackKey`.

- [ ] **Step 3: Patch `getMediaHubPlaybackKey()` to honor normalized mapper output**

In `packages/app/lib/media-hub.js`, replace `getMediaHubPlaybackKey()` with:

```js
export function getMediaHubPlaybackKey(item) {
  if (nonEmptyString(item?.playbackKey)) return item.playbackKey
  const source = nonArrayObject(item?.item) ? item.item : null
  const channelKey = firstNonEmptyString([
    item?.channelKey,
    item?.driveKey,
    item?.channel?.key,
    source?.channelKey,
    source?.driveKey,
    source?.channel?.key,
  ], 'local')
  const itemKey = firstNonEmptyString([
    item?.id,
    item?.videoId,
    item?.path,
    source?.id,
    source?.videoId,
    source?.path,
  ], 'unknown')
  return `${channelKey}:${itemKey}`
}
```

- [ ] **Step 4: Preserve direct playback/source fields during normalization**

In `normalizeVideoItem()`, include these fields in the `normalized` object immediately after `playbackKey`:

```js
    channelKey: nonEmptyString(item?.channelKey) ? item.channelKey : null,
    driveKey: nonEmptyString(item?.driveKey) ? item.driveKey : null,
    videoId: nonEmptyString(item?.videoId) ? item.videoId : null,
    path: nonEmptyString(item?.path) ? item.path : null,
    publicBeeKey: nonEmptyString(item?.publicBeeKey) ? item.publicBeeKey : null,
```

In `normalizeContinueWatchingItem()`, include these fields immediately after `playbackKey`:

```js
    channelKey: item.channelKey,
    videoId: item.videoId,
    durationSec: positiveDuration(item?.durationSec) ?? null,
    positionSec: finiteNumber(item?.positionSec) ? item.positionSec : null,
```

In `mergeMissingMediaFields()`, add these fields before timestamp merging:

```js
  mergeMissingField(existing, item, 'channelKey')
  mergeMissingField(existing, item, 'driveKey')
  mergeMissingField(existing, item, 'videoId')
  mergeMissingField(existing, item, 'path')
  mergeMissingField(existing, item, 'publicBeeKey')
```

- [ ] **Step 5: Make featured ordering match the reviewed contract**

Remove `hasFeaturedMediaSignal()` if no other code uses it. Replace `isBetterFeaturedItem()` with:

```js
function isBetterFeaturedItem(candidate, selected) {
  if (selected === null) return true

  const candidateHasThumbnail = hasFeaturedThumbnail(candidate)
  const selectedHasThumbnail = hasFeaturedThumbnail(selected)
  if (candidateHasThumbnail !== selectedHasThumbnail) return candidateHasThumbnail

  const candidateTimestamp = timestampMs(candidate)
  const selectedTimestamp = timestampMs(selected)
  if (candidateTimestamp !== selectedTimestamp) return candidateTimestamp > selectedTimestamp

  const candidatePlaybackKey = stablePlaybackSortKey(candidate)
  const selectedPlaybackKey = stablePlaybackSortKey(selected)
  if (candidatePlaybackKey !== selectedPlaybackKey) return candidatePlaybackKey < selectedPlaybackKey

  return false
}
```

- [ ] **Step 6: Run focused tests**

```bash
node --test   packages/app/tests/content-catalog.test.mjs   packages/app/tests/media-hub.test.mjs   packages/app/tests/mobile-ui-redesign-regression.test.mjs   packages/app/tests/vertical-discovery-regression.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Amend the mapper commit**

```bash
git add packages/app/lib/media-hub.js packages/app/tests/media-hub.test.mjs
git commit --amend --no-edit
```

Expected: Task 1 remains one mapper commit on top of Task 0.

- [ ] **Step 8: Run both Task 1 reviews before moving on**

Spec review prompt must reject if:
- featured ordering is not artwork -> timestamp -> playback key
- normalized media/continue items cannot be passed to Home helper/key extractors safely
- any backend/protocol/playback/relay/blob code changed
- tests do not cover the new review blockers

Quality review prompt must reject if:
- malformed/title-only inputs become invented cards
- dedupe/backfill is inconsistent across `allItems`, `recentlySeeded`, `yourLibrary`, or `featured`
- normalized items drop direct playback/resume fields
- `getMediaHubPlaybackKey()` differs for raw vs normalized mapper outputs

Only mark Task 1 complete after both reviewers return APPROVED and the focused suite passes.

---

### Task 2R: Add presentational media cockpit mobile components

**Files:**
- Create: `packages/app/components/media/NetworkStatusPill.tsx`
- Create: `packages/app/components/media/HeroFeatureCard.tsx`
- Create: `packages/app/components/media/MediaRail.tsx`
- Create: `packages/app/components/media/MediaPosterCard.tsx`
- Create: `packages/app/components/media/EpisodeCard.tsx`
- Create: `packages/app/components/media/index.ts`
- Modify: `packages/app/tests/mobile-ui-redesign-regression.test.mjs`

- [ ] **Step 1: Keep components presentational**

Component contracts:
- `HeroFeatureCard({ item, peers, onPress, onChannelPress })`
- `MediaPosterCard({ item, onPress })`
- `EpisodeCard({ item, onPress, progress })`
- `MediaRail({ title, subtitle, data, itemWidth, renderItem, keyExtractor, actionLabel, onActionPress, topSpacing })`
- `NetworkStatusPill({ peers, label, tone })`

Do not import RPC, router, backend clients, relay code, blob-server code, or playback prep inside these components. They render only and call callbacks supplied by Home.

- [ ] **Step 2: Use PearTube media language in visible copy**

Required user-facing copy patterns:
- hero: `Featured from the swarm` or `Featured media`
- network pill: `live from swarm`, `<n> peers`, `ready to play`, or `offline ready`
- rails: `Continue watching`, `Movies`, `Shows`, `New episodes`, `Music & creators`

Avoid raw diagnostics copy as primary UI.

- [ ] **Step 3: Add source-level guard for component boundaries**

Append to `packages/app/tests/mobile-ui-redesign-regression.test.mjs`:

```js
test('media cockpit components stay presentational', () => {
  const componentSources = [
    readApp('components/media/HeroFeatureCard.tsx'),
    readApp('components/media/MediaPosterCard.tsx'),
    readApp('components/media/EpisodeCard.tsx'),
    readApp('components/media/MediaRail.tsx'),
    readApp('components/media/NetworkStatusPill.tsx'),
  ].join('
')

  assert.doesNotMatch(componentSources, /preparePlayback|getContentCatalog|rpc\./, 'media components must not call backend or playback APIs directly')
  assert.doesNotMatch(componentSources, /router\.push|useRouter/, 'media components must not own navigation')
  assert.match(componentSources, /ThumbnailImage/, 'media cards should reuse existing thumbnail rendering')
})
```

If `readApp()` does not accept component paths yet, extend it once in the test helper so it reads from `packages/app/` consistently.

- [ ] **Step 4: Run focused component/source checks**

```bash
node --test packages/app/tests/mobile-ui-redesign-regression.test.mjs packages/app/tests/media-hub.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit component slice**

```bash
git add packages/app/components/media packages/app/tests/mobile-ui-redesign-regression.test.mjs
git commit -m "feat(app): add media cockpit mobile components"
```

---

### Task 3R: Integrate mobile Home with source-item playback helpers

**Files:**
- Modify: `packages/app/app/(tabs)/index.tsx`
- Modify: `packages/app/tests/mobile-ui-redesign-regression.test.mjs`

- [ ] **Step 1: Import mapper and components**

```ts
import { buildMediaHubSections, getMediaHubPlaybackKey } from '@/lib/media-hub'
import {
  EpisodeCard,
  EPISODE_CARD_WIDTH,
  HeroFeatureCard,
  MediaPosterCard,
  MEDIA_POSTER_CARD_WIDTH,
  MediaRail,
} from '@/components/media'
```

- [ ] **Step 2: Add explicit source-item helpers near Home callbacks**

```ts
  const getMediaHubSourceItem = useCallback((item: any) => {
    if (item?.item && typeof item.item === 'object' && !Array.isArray(item.item)) return item.item
    return item
  }, [])

  const playMediaHubItem = useCallback((item: any) => {
    playVideo(getMediaHubSourceItem(item))
  }, [getMediaHubSourceItem, playVideo])

  const openMediaHubChannel = useCallback((item: any) => {
    const source = getMediaHubSourceItem(item)
    const channelKey = source?.channelKey || source?.driveKey || item?.channelKey || item?.driveKey
    if (!channelKey) return
    router.push({ pathname: '/channel/[key]', params: { key: channelKey, publicBeeKey: source?.publicBeeKey || item?.publicBeeKey || undefined } })
  }, [getMediaHubSourceItem, router])
```

Rationale: cards render normalized/backfilled items, but playback should retain existing raw Home playback shape unless the mapper output is explicitly proven compatible.

- [ ] **Step 3: Build `mediaHub` from existing Home arrays only**

```ts
  const mediaHub = useMemo(() => buildMediaHubSections({
    feedVideos: feedVideosWithThumbs,
    myVideos: myVideosWithMeta,
    continueWatching,
    recommendedVideos,
  }), [feedVideosWithThumbs, myVideosWithMeta, continueWatching, recommendedVideos])
```

No new backend calls. No content catalog fetch in Home.

- [ ] **Step 4: Put hero and semantic rails above Discover, preserving Discover fallback**

`homeFeedItems` order:
1. hero when `mediaHub.featured.item` exists
2. continue watching
3. movies
4. shows
5. new episodes
6. music & creators
7. existing Discover header/grid, renamed `Recently from the swarm`
8. existing Your videos/library section

- [ ] **Step 5: Render media rails using playback helpers**

Required callbacks:

```tsx
<HeroFeatureCard
  item={hero}
  peers={displayPeers}
  onPress={() => playMediaHubItem(hero)}
  onChannelPress={(hero.channelKey || hero.driveKey || hero.item?.channelKey || hero.item?.driveKey) ? () => openMediaHubChannel(hero) : undefined}
/>
```

```tsx
<MediaPosterCard item={item} onPress={() => playMediaHubItem(item)} />
<EpisodeCard item={item} progress={item.progress} onPress={() => playMediaHubItem(item)} />
```

Continue Watching keeps the existing resume path:

```tsx
<EpisodeCard item={entry} progress={entry.progress} onPress={() => resumeEntry(entry)} />
```

- [ ] **Step 6: Add Home source-level guard**

Append/extend a test in `packages/app/tests/mobile-ui-redesign-regression.test.mjs`:

```js
test('mobile home media cockpit preserves playback, channel, and refresh paths', () => {
  const source = readApp('app/(tabs)/index.tsx')

  assert.match(source, /buildMediaHubSections/, 'Home should use the shared media-hub mapper')
  assert.match(source, /HeroFeatureCard/, 'Home should render a cinematic hero feature')
  assert.match(source, /MediaRail/, 'Home should render semantic media rails')
  assert.match(source, /MediaPosterCard/, 'Home should render poster cards')
  assert.match(source, /EpisodeCard/, 'Home should render episode cards')
  assert.match(source, /getMediaHubSourceItem/, 'Home should preserve raw playback source items')
  assert.match(source, /playMediaHubItem/, 'Home should use an explicit media playback adapter')
  assert.match(source, /rpc\.preparePlayback\(playbackRequest\)/, 'Home playback should still resolve URLs through preparePlayback')
  assert.match(source, /loadAndPlayVideo\(video, result\.url\)/, 'Home playback should still use the shared player path')
  assert.match(source, /onPress=\{refreshFeed\}/, 'Public feed refresh should remain available')
  assert.match(source, /Recently from the swarm/, 'Discover should remain as lower-page swarm content')
  assert.doesNotMatch(source, /getContentCatalog\(/, 'Slice 1 Home should not fetch a new backend catalog')
})
```

- [ ] **Step 7: Run focused tests**

```bash
node --test packages/app/tests/media-hub.test.mjs packages/app/tests/mobile-ui-redesign-regression.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Home integration**

```bash
git add packages/app/app/\(tabs\)/index.tsx packages/app/tests/mobile-ui-redesign-regression.test.mjs
git commit -m "feat(app): reshape mobile home as media cockpit"
```

---

### Task 4R: Review source-level cockpit invariants as their own gate

**Files:**
- Modify only if Task 2/3 missed assertions: `packages/app/tests/mobile-ui-redesign-regression.test.mjs`

- [ ] **Step 1: Confirm regression coverage includes these invariants**

Required assertions:
- mapper imported and used in mobile Home
- hero, media rail, poster, episode components imported and used
- Discover refresh remains available
- `rpc.preparePlayback(playbackRequest)` and `loadAndPlayVideo(video, result.url)` remain in Home
- no `getContentCatalog()` or new backend catalog dependency in Home
- component files contain no direct RPC/router/playback calls
- media-hub tests cover normalized playback fields and featured ordering

- [ ] **Step 2: Run source regression tests**

```bash
node --test packages/app/tests/mobile-ui-redesign-regression.test.mjs packages/app/tests/media-hub.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit guard-only changes if any were needed**

```bash
git add packages/app/tests/mobile-ui-redesign-regression.test.mjs packages/app/tests/media-hub.test.mjs
git commit -m "test(app): guard media cockpit home invariants"
```

If no changes are needed, do not create an empty commit. Record that Task 4 was satisfied by earlier task commits.

---

### Task 5R: Final verification and handoff

**Files:**
- No new files expected unless verification notes are requested.

- [ ] **Step 1: Run focused UI/data suite**

```bash
node --test   packages/app/tests/content-catalog.test.mjs   packages/app/tests/media-hub.test.mjs   packages/app/tests/mobile-ui-redesign-regression.test.mjs   packages/app/tests/vertical-discovery-regression.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript/static smoke**

```bash
npm exec --prefix packages/app -- tsc --noEmit --pretty false
```

Expected: PASS, or only pre-existing unrelated noise. If it fails, isolate whether errors are in changed files: `packages/app/lib/media-hub.js`, `packages/app/components/media/*`, `packages/app/app/(tabs)/index.tsx`, or edited tests.

- [ ] **Step 3: Inspect git state**

```bash
git status --short --branch
git log --oneline -n 8
```

Expected: clean branch with Task 0, Task 1, Task 2, Task 3, and optional Task 4 commits.

- [ ] **Step 4: Final report**

Report:
- changed files
- commit list
- exact tests run and pass/fail output
- TypeScript/static smoke result
- confirmation that playback, relay, protocol, blob-server, and backend contracts were intentionally untouched
- remaining risk: visual/physical-device QA is still required before claiming the mobile UX is release-ready

---

## Reviewer prompt upgrade

For every remaining task, include this block in both reviewer prompts:

```text
Hard constraints:
- Do not modify backend, relay, protocol, blob-server, upload, or playback preparation contracts.
- Do not classify movies/shows from titles or filenames.
- Do not let normalized media-hub items lose playback/resume identity fields.
- Do not route movie/show cards to unbuilt title pages in Slice 1.
- Keep public feed refresh and existing Discover fallback visible.
- Reject green tests if the code would break the next UI slice.
```

This is the key autoresearch lesson from Task 1: tests can pass while the plan still underspecifies the integration contract.
