# PearTube Media Cockpit Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first client-side media cockpit slice by adding a tested media-hub data mapper, reusable mobile media cards/rails, and a redesigned mobile Home surface without changing playback, relay, protocol, or blob-serving behavior.

**Architecture:** Keep product grouping in `packages/app/lib/media-hub.js` so `app/(tabs)/index.tsx` does not become more tangled. Add focused reusable components under `packages/app/components/media/` and use them only on mobile Home first. Preserve existing `playVideo`, channel routing, public-feed refresh, empty states, thumbnail resolution, and diagnostics paths.

**Tech Stack:** Expo Router, React Native, TypeScript/TSX, existing PearTube primitives (`GlassCard`, `Rail`, `ThumbnailImage`, `SwarmIndicator`), Node `node:test` source/unit tests.

---

## Active Autoresearch Iteration — 2026-07-23

The active task handoff has been iterated with the absorbed `autoresearch` workflow after Task 1 review failures. Use `docs/superpowers/plans/2026-07-23-peartube-media-cockpit-slice-1-autoresearch-iteration.md` for remaining execution. The original task bodies below are retained as baseline/reference material and should not be dispatched directly.


## File Structure

- Create: `packages/app/lib/media-hub.js`
  - Pure data mapper. Accepts existing Home data arrays and returns semantic rails: `featured`, `continueWatching`, `movies`, `shows`, `newEpisodes`, `musicAndCreators`, `recentlySeeded`, `yourLibrary`.
  - No React imports. No backend calls. No title parsing.

- Create: `packages/app/tests/media-hub.test.mjs`
  - Unit tests for explicit metadata grouping, dedupe, featured selection, and legacy fallback.

- Create: `packages/app/components/media/NetworkStatusPill.tsx`
  - Small peer/seed availability pill used by hero/cards.

- Create: `packages/app/components/media/HeroFeatureCard.tsx`
  - Cinematic top card for one playable item. Calls the existing Home `playVideo` callback.

- Create: `packages/app/components/media/MediaRail.tsx`
  - Section wrapper around existing `Rail`, with title/subtitle/action and empty suppression.

- Create: `packages/app/components/media/MediaPosterCard.tsx`
  - Vertical poster-style card for movies/shows.

- Create: `packages/app/components/media/EpisodeCard.tsx`
  - Wide 16:9 card for episodes/videos/continue watching.

- Create: `packages/app/components/media/index.ts`
  - Exports the media components.

- Modify: `packages/app/app/(tabs)/index.tsx`
  - Import `buildMediaHubSections` and new media components.
  - Add media-hub memo derived from already computed `feedVideosWithThumbs`, `myVideosWithMeta`, `continueWatching`, and `recommendedVideos`.
  - Replace top Home order with hero + semantic rails before the existing Discover fallback grid.
  - Keep existing playback/channel/refresh/empty behavior.

- Modify: `packages/app/tests/mobile-ui-redesign-regression.test.mjs`
  - Add source-level guard that Home uses media-hub mapper/components and still keeps public-feed refresh/playback path.

---

### Task 1: Build the pure media-hub mapper

**Files:**
- Create: `packages/app/lib/media-hub.js`
- Create: `packages/app/tests/media-hub.test.mjs`

- [ ] **Step 1: Write failing mapper tests**

Create `packages/app/tests/media-hub.test.mjs` with:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMediaHubSections,
  getMediaHubPlaybackKey,
  isMovieItem,
  isShowItem,
} from '../lib/media-hub.js'

const movie = {
  id: 'movie-1',
  title: 'Moon Archive',
  channelKey: 'movies',
  thumbnailUrl: 'http://thumb/movie.jpg',
  contentKind: 'movie',
  duration: 7200,
  uploadedAt: 3000,
  channel: { name: 'Cinema Relay' },
}

const episode = {
  id: 'episode-1',
  title: 'Pilot',
  channelKey: 'show-a',
  thumbnailUrl: 'http://thumb/episode.jpg',
  contentKind: 'episode',
  seasonNumber: 1,
  episodeNumber: 1,
  uploadedAt: 4000,
  channel: { name: 'Show A' },
}

const classifiedEpisode = {
  id: 'episode-2',
  title: 'Second',
  channelKey: 'show-a',
  classification: { type: 'tv', season: 1, episode: 2 },
  uploadedAt: 5000,
}

const legacy = {
  id: 'legacy-1',
  title: 'S99E99 title should not classify this',
  channelKey: 'legacy',
  uploadedAt: 6000,
  category: 'Entertainment',
}

test('classifies movies and shows only from explicit metadata', () => {
  assert.equal(isMovieItem(movie), true)
  assert.equal(isShowItem(episode), true)
  assert.equal(isShowItem(classifiedEpisode), true)
  assert.equal(isShowItem(legacy), false)
  assert.equal(isMovieItem({ ...legacy, title: 'Movie Night' }), false)
})

test('builds semantic rails and keeps legacy videos in recently seeded fallback', () => {
  const hub = buildMediaHubSections({
    feedVideos: [legacy, episode, movie],
    myVideos: [],
    continueWatching: [],
    recommendedVideos: [],
  })

  assert.equal(hub.movies.items.length, 1)
  assert.equal(hub.movies.items[0].id, 'movie-1')
  assert.equal(hub.shows.items.length, 2)
  assert.deepEqual(hub.newEpisodes.items.map((item) => item.id), ['episode-2', 'episode-1'])
  assert.equal(hub.recentlySeeded.items.some((item) => item.id === 'legacy-1'), true)
  assert.equal(hub.featured.item.id, 'episode-1')
})

test('dedupes by channel/video key across feed, local, and recommendations', () => {
  const duplicateRecommendation = {
    ...movie,
    title: 'Moon Archive recommended copy',
    thumbnailUrl: null,
  }
  const localCopy = {
    ...movie,
    title: 'Moon Archive local copy',
    channel: { name: 'You' },
  }

  const hub = buildMediaHubSections({
    feedVideos: [movie],
    myVideos: [localCopy],
    continueWatching: [],
    recommendedVideos: [duplicateRecommendation],
  })

  assert.equal(hub.allItems.length, 1)
  assert.equal(hub.movies.items.length, 1)
  assert.equal(hub.movies.items[0].title, 'Moon Archive')
})

test('normalizes continue-watching entries without polluting movie/show rails', () => {
  const hub = buildMediaHubSections({
    feedVideos: [],
    myVideos: [],
    continueWatching: [{
      channelKey: 'show-a',
      videoId: 'episode-1',
      title: 'Pilot',
      channelName: 'Show A',
      thumbnailUrl: 'http://thumb/resume.jpg',
      durationSec: 1800,
      positionSec: 450,
    }],
    recommendedVideos: [],
  })

  assert.equal(getMediaHubPlaybackKey(hub.continueWatching.items[0]), 'show-a:episode-1')
  assert.equal(hub.continueWatching.items[0].progress, 0.25)
  assert.equal(hub.movies.items.length, 0)
  assert.equal(hub.shows.items.length, 0)
})
```

- [ ] **Step 2: Run tests and verify failure**

Run from repo root:

```bash
node --test packages/app/tests/media-hub.test.mjs
```

Expected: FAIL with a module-not-found error for `../lib/media-hub.js`.

- [ ] **Step 3: Implement `media-hub.js`**

Create `packages/app/lib/media-hub.js`:

```js
const DEFAULT_LIMIT = 12

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function numberOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function hasThumbnail(item) {
  return Boolean(item?.thumbnailUrl || item?.thumbnail)
}

function uploadedAt(item) {
  return numberOrZero(item?.uploadedAt || item?.createdAt || item?.addedAt)
}

function sortNewestFirst(a, b) {
  const byTime = uploadedAt(b) - uploadedAt(a)
  if (byTime !== 0) return byTime
  return getMediaHubPlaybackKey(a).localeCompare(getMediaHubPlaybackKey(b))
}

export function getMediaHubPlaybackKey(item) {
  const channelKey = item?.channelKey || item?.driveKey || item?.channel?.key || 'local'
  const videoId = item?.id || item?.videoId || item?.path || item?.title || 'unknown'
  return `${channelKey}:${videoId}`
}

export function isMovieItem(item) {
  return item?.contentKind === 'movie' || item?.classification?.type === 'movie'
}

export function isShowItem(item) {
  return item?.contentKind === 'episode' || item?.classification?.type === 'tv'
}

function isMusicOrCreatorItem(item) {
  return item?.category === 'Music' || item?.profileKind === 'creator' || item?.contentKind === 'stream'
}

function normalizeVideoItem(item, source) {
  if (!item || typeof item !== 'object') return null
  const id = item.id || item.videoId || item.path
  if (!id || !item.title) return null
  return {
    ...item,
    id,
    source,
    playbackKey: getMediaHubPlaybackKey(item),
    title: item.title,
    subtitle: item.creatorName || item.channelName || item.channel?.name || item.sourceLabel || null,
    thumbnailUrl: item.thumbnailUrl || item.thumbnail || null,
    duration: item.duration || item.durationSec || 0,
    progress: numberOrZero(item.progress),
  }
}

function normalizeContinueEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (!entry.videoId || !entry.channelKey || !entry.title) return null
  const duration = numberOrZero(entry.durationSec)
  const position = numberOrZero(entry.positionSec)
  return {
    id: entry.videoId,
    videoId: entry.videoId,
    channelKey: entry.channelKey,
    title: entry.title,
    subtitle: entry.channelName || null,
    channelName: entry.channelName || null,
    thumbnailUrl: entry.thumbnailUrl || entry.thumbnail || null,
    duration,
    durationSec: duration,
    positionSec: position,
    progress: duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0,
    source: 'continueWatching',
    playbackKey: `${entry.channelKey}:${entry.videoId}`,
  }
}

function dedupeItems(groups) {
  const byKey = new Map()
  for (const group of groups) {
    for (const item of asArray(group)) {
      if (!item) continue
      const key = getMediaHubPlaybackKey(item)
      if (!byKey.has(key)) {
        byKey.set(key, item)
        continue
      }
      const previous = byKey.get(key)
      if (!hasThumbnail(previous) && hasThumbnail(item)) {
        byKey.set(key, { ...previous, ...item })
      }
    }
  }
  return Array.from(byKey.values())
}

function makeRail(id, title, items, subtitle = null, limit = DEFAULT_LIMIT) {
  return {
    id,
    title,
    subtitle,
    items: asArray(items).slice(0, limit),
  }
}

function chooseFeatured(items) {
  const candidates = asArray(items)
    .filter((item) => item?.title)
    .slice()
    .sort((a, b) => {
      const aScore = (hasThumbnail(a) ? 4 : 0) + (isMovieItem(a) ? 3 : 0) + (isShowItem(a) ? 2 : 0)
      const bScore = (hasThumbnail(b) ? 4 : 0) + (isMovieItem(b) ? 3 : 0) + (isShowItem(b) ? 2 : 0)
      if (bScore !== aScore) return bScore - aScore
      return sortNewestFirst(a, b)
    })
  return candidates[0] || null
}

export function buildMediaHubSections({
  feedVideos = [],
  myVideos = [],
  continueWatching = [],
  recommendedVideos = [],
} = {}) {
  const normalizedFeed = asArray(feedVideos).map((item) => normalizeVideoItem(item, 'feed')).filter(Boolean)
  const normalizedMine = asArray(myVideos).map((item) => normalizeVideoItem(item, 'library')).filter(Boolean)
  const normalizedRecommended = asArray(recommendedVideos).map((item) => normalizeVideoItem(item, 'recommended')).filter(Boolean)
  const normalizedContinue = asArray(continueWatching).map(normalizeContinueEntry).filter(Boolean)
  const allItems = dedupeItems([normalizedRecommended, normalizedFeed, normalizedMine]).sort(sortNewestFirst)
  const movieItems = allItems.filter(isMovieItem).sort(sortNewestFirst)
  const showItems = allItems.filter(isShowItem).sort(sortNewestFirst)
  const musicAndCreators = allItems.filter(isMusicOrCreatorItem).sort(sortNewestFirst)
  const recentlySeeded = normalizedFeed.slice().sort(sortNewestFirst)
  const yourLibrary = normalizedMine.slice().sort(sortNewestFirst)
  const featured = chooseFeatured([...normalizedRecommended, ...normalizedContinue, ...normalizedFeed, ...normalizedMine])

  return {
    featured: { id: 'featured', title: 'Featured from the swarm', item: featured },
    continueWatching: makeRail('continue-watching', 'Continue watching', normalizedContinue, null, 10),
    movies: makeRail('movies', 'Movies', movieItems, 'Feature-length media on your network'),
    shows: makeRail('shows', 'Shows', showItems, 'Episodes and series from peers'),
    newEpisodes: makeRail('new-episodes', 'New episodes', showItems, null),
    musicAndCreators: makeRail('music-creators', 'Music & creators', musicAndCreators, null),
    recentlySeeded: makeRail('recently-seeded', 'Recently from the swarm', recentlySeeded, null, 18),
    yourLibrary: makeRail('your-library', 'Your library', yourLibrary, null, 12),
    allItems,
  }
}
```

- [ ] **Step 4: Run mapper tests**

Run:

```bash
node --test packages/app/tests/media-hub.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit mapper slice**

Run:

```bash
git add packages/app/lib/media-hub.js packages/app/tests/media-hub.test.mjs
git commit -m "feat(app): add media hub section mapper"
```

Expected: commit succeeds.

---

### Task 2: Add media cockpit mobile components

**Files:**
- Create: `packages/app/components/media/NetworkStatusPill.tsx`
- Create: `packages/app/components/media/HeroFeatureCard.tsx`
- Create: `packages/app/components/media/MediaRail.tsx`
- Create: `packages/app/components/media/MediaPosterCard.tsx`
- Create: `packages/app/components/media/EpisodeCard.tsx`
- Create: `packages/app/components/media/index.ts`

- [ ] **Step 1: Create `NetworkStatusPill.tsx`**

Create `packages/app/components/media/NetworkStatusPill.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors } from '@/lib/colors'

interface NetworkStatusPillProps {
  peers?: number | null
  label?: string
  tone?: 'live' | 'quiet'
}

export function NetworkStatusPill({ peers = 0, label, tone = 'quiet' }: NetworkStatusPillProps) {
  const safePeers = Math.max(0, Number(peers || 0))
  const text = label || (safePeers > 0 ? `${safePeers} peers` : 'local / cached')
  return (
    <View style={[styles.pill, tone === 'live' && styles.live]}>
      <Feather name={safePeers > 0 ? 'radio' : 'hard-drive'} size={11} color={tone === 'live' ? '#c7d2fe' : colors.textMuted} />
      <Text style={[styles.text, tone === 'live' && styles.liveText]} numberOfLines={1}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  live: {
    backgroundColor: 'rgba(94,106,210,0.18)',
    borderColor: 'rgba(129,140,248,0.34)',
  },
  text: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  liveText: {
    color: '#dbeafe',
  },
})
```

- [ ] **Step 2: Create `HeroFeatureCard.tsx`**

Create `packages/app/components/media/HeroFeatureCard.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge, formatDuration } from '@/lib/formatters'
import { NetworkStatusPill } from './NetworkStatusPill'

interface HeroFeatureCardProps {
  item: any
  peers?: number | null
  onPress: () => void
  onChannelPress?: () => void
}

export function HeroFeatureCard({ item, peers = 0, onPress, onChannelPress }: HeroFeatureCardProps) {
  const badge = formatContentBadge(item)
  const subtitle = item?.subtitle || item?.creatorName || item?.channelName || item?.channel?.name || 'PearTube network'
  const duration = item?.duration || item?.durationSec || 0
  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Play ${item.title}`}
      testID="media-hub-hero"
    >
      <View style={styles.thumbnailFrame}>
        <ThumbnailImage
          thumbnailUrl={item.thumbnailUrl || item.thumbnail}
          duration={duration}
          channelInitial={(item.title || 'P').charAt(0).toUpperCase()}
        />
        <LinearGradient
          colors={['rgba(8,9,10,0.05)', 'rgba(8,9,10,0.52)', 'rgba(8,9,10,0.96)']}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View style={styles.copy}>
        <NetworkStatusPill peers={peers} label={peers ? 'live from swarm' : 'ready to play'} tone={peers ? 'live' : 'quiet'} />
        <Text style={styles.eyebrow} numberOfLines={1}>{badge || 'Featured media'}</Text>
        <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
        <Pressable onPress={onChannelPress} disabled={!onChannelPress} hitSlop={8}>
          <Text style={[styles.subtitle, onChannelPress && styles.subtitleLink]} numberOfLines={1}>{subtitle}</Text>
        </Pressable>
        <View style={styles.actionRow}>
          <View style={styles.playButton}>
            <Feather name="play" color={colors.onPrimary} size={16} />
            <Text style={styles.playText}>Play</Text>
          </View>
          {duration ? <Text style={styles.duration}>{formatDuration(duration)}</Text> : null}
        </View>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 20,
    marginTop: 16,
    height: 310,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  thumbnailFrame: {
    ...StyleSheet.absoluteFillObject,
  },
  copy: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 8,
  },
  eyebrow: {
    color: '#dbeafe',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.9,
  },
  title: {
    color: colors.text,
    fontSize: 30,
    lineHeight: 34,
    fontFamily: fonts.heading,
    letterSpacing: -0.7,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  subtitleLink: {
    color: '#c7d2fe',
  },
  actionRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  playText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  duration: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
})
```

- [ ] **Step 3: Create `MediaRail.tsx`**

Create `packages/app/components/media/MediaRail.tsx`:

```tsx
import { ReactElement } from 'react'
import { ListRenderItem, Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { Rail } from '@/components/primitives'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'

interface MediaRailProps<T> {
  title: string
  subtitle?: string | null
  data: T[]
  itemWidth: number
  renderItem: ListRenderItem<T>
  keyExtractor: (item: T, index: number) => string
  actionLabel?: string
  onActionPress?: () => void
  topSpacing?: number
}

export function MediaRail<T>({
  title,
  subtitle,
  data,
  itemWidth,
  renderItem,
  keyExtractor,
  actionLabel,
  onActionPress,
  topSpacing = 22,
}: MediaRailProps<T>): ReactElement | null {
  if (!Array.isArray(data) || data.length === 0) return null
  return (
    <View style={[styles.section, { marginTop: topSpacing }]} testID={`media-rail-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <View style={styles.header}>
        <View style={styles.titleGroup}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {actionLabel && onActionPress ? (
          <Pressable onPress={onActionPress} style={styles.action} hitSlop={8}>
            <Text style={styles.actionText}>{actionLabel}</Text>
            <Feather name="chevron-right" color={colors.textMuted} size={14} />
          </Pressable>
        ) : null}
      </View>
      <Rail
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        itemWidth={itemWidth}
        gap={12}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    width: '100%',
  },
  header: {
    paddingHorizontal: 20,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 24,
    fontFamily: fonts.heading,
    letterSpacing: -0.25,
  },
  subtitle: {
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '500',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingBottom: 2,
  },
  actionText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
})
```

- [ ] **Step 4: Create `MediaPosterCard.tsx`**

Create `packages/app/components/media/MediaPosterCard.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { GlassCard } from '@/components/primitives'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { colors } from '@/lib/colors'
import { formatContentBadge } from '@/lib/formatters'

export const MEDIA_POSTER_CARD_WIDTH = 150

interface MediaPosterCardProps {
  item: any
  onPress: () => void
}

export function MediaPosterCard({ item, onPress }: MediaPosterCardProps) {
  const badge = formatContentBadge(item)
  return (
    <GlassCard padded={false} style={styles.card} onPress={onPress} accessibilityLabel={`Open ${item.title}`}>
      <View style={styles.posterFrame}>
        <ThumbnailImage
          thumbnailUrl={item.thumbnailUrl || item.thumbnail}
          channelInitial={(item.title || 'P').charAt(0).toUpperCase()}
        />
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} numberOfLines={1}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>{item.subtitle || item.channelName || item.channel?.name || 'PearTube'}</Text>
      </View>
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    width: MEDIA_POSTER_CARD_WIDTH,
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  posterFrame: {
    width: '100%',
    aspectRatio: 2 / 3,
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  badge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    right: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(8,9,10,0.76)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  badgeText: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '800',
  },
  info: {
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 11,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
})
```

- [ ] **Step 5: Create `EpisodeCard.tsx`**

Create `packages/app/components/media/EpisodeCard.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native'
import { GlassCard } from '@/components/primitives'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { colors } from '@/lib/colors'
import { formatContentBadge } from '@/lib/formatters'

export const EPISODE_CARD_WIDTH = 238

interface EpisodeCardProps {
  item: any
  onPress: () => void
  progress?: number
}

export function EpisodeCard({ item, onPress, progress = item?.progress || 0 }: EpisodeCardProps) {
  const badge = formatContentBadge(item)
  const safeProgress = Math.max(0, Math.min(1, Number(progress || 0)))
  return (
    <GlassCard padded={false} style={styles.card} onPress={onPress} accessibilityLabel={`Play ${item.title}`}>
      <View style={styles.thumbFrame}>
        <ThumbnailImage
          thumbnailUrl={item.thumbnailUrl || item.thumbnail}
          duration={item.duration || item.durationSec}
          channelInitial={(item.title || 'P').charAt(0).toUpperCase()}
        />
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
        {safeProgress > 0 ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${safeProgress * 100}%` }]} />
          </View>
        ) : null}
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>{item.subtitle || item.channelName || item.channel?.name || 'PearTube'}</Text>
      </View>
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    width: EPISODE_CARD_WIDTH,
  },
  thumbFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  badge: {
    position: 'absolute',
    left: 8,
    top: 8,
    color: colors.text,
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(8,9,10,0.72)',
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  info: {
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 11,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
})
```

- [ ] **Step 6: Export components**

Create `packages/app/components/media/index.ts`:

```ts
export { EpisodeCard, EPISODE_CARD_WIDTH } from './EpisodeCard'
export { HeroFeatureCard } from './HeroFeatureCard'
export { MediaPosterCard, MEDIA_POSTER_CARD_WIDTH } from './MediaPosterCard'
export { MediaRail } from './MediaRail'
export { NetworkStatusPill } from './NetworkStatusPill'
```

- [ ] **Step 7: Run a syntax/type smoke for component imports**

Run:

```bash
node --test packages/app/tests/media-hub.test.mjs
```

Expected: PASS. This does not compile TSX yet; TSX integration is verified in Task 3.

- [ ] **Step 8: Commit components**

Run:

```bash
git add packages/app/components/media
git commit -m "feat(app): add media cockpit mobile components"
```

Expected: commit succeeds.

---

### Task 3: Reshape mobile Home around hero and media rails

**Files:**
- Modify: `packages/app/app/(tabs)/index.tsx`

- [ ] **Step 1: Add imports to mobile Home**

In `packages/app/app/(tabs)/index.tsx`, add the media-hub import near other lib imports:

```ts
import { buildMediaHubSections, getMediaHubPlaybackKey } from '@/lib/media-hub'
```

Add component imports near `RailCard`/primitive imports:

```ts
import {
  EpisodeCard,
  EPISODE_CARD_WIDTH,
  HeroFeatureCard,
  MediaPosterCard,
  MEDIA_POSTER_CARD_WIDTH,
  MediaRail,
} from '@/components/media'
```

- [ ] **Step 2: Add HomeFeedListItem variants**

Replace the current `HomeFeedListItem` type with:

```ts
type HomeFeedListItem =
  | { type: 'hero' }
  | { type: 'continue-watching' }
  | { type: 'movies' }
  | { type: 'shows' }
  | { type: 'new-episodes' }
  | { type: 'music-creators' }
  | { type: 'recommended' }
  | { type: 'discover-header' }
  | { type: 'discover-loading' }
  | { type: 'discover-empty' }
  | { type: 'discover-row'; videos: VideoData[]; rowIndex: number }
  | { type: 'my-videos-header' }
  | { type: 'my-videos-empty' }
  | { type: 'my-videos-row'; videos: VideoData[]; rowIndex: number }
```

This keeps old discover/my-video rows available while adding semantic sections above them.

- [ ] **Step 3: Build media-hub sections after existing derived video arrays**

After `feedVideosWithThumbs`, `myVideosWithMeta`, and `recommendedVideos` are available, add:

```ts
  const mediaHub = useMemo(() => buildMediaHubSections({
    feedVideos: feedVideosWithThumbs,
    myVideos: myVideosWithMeta,
    continueWatching,
    recommendedVideos,
  }), [feedVideosWithThumbs, myVideosWithMeta, continueWatching, recommendedVideos])
```

Keep this before `homeFeedItems` so the list can use it.

- [ ] **Step 4: Reorder `homeFeedItems`**

Replace the existing `homeFeedItems` useMemo body with:

```ts
  const homeFeedItems = useMemo<HomeFeedListItem[]>(() => {
    const items: HomeFeedListItem[] = []
    if (mediaHub.featured.item) items.push({ type: 'hero' })
    if (mediaHub.continueWatching.items.length > 0) items.push({ type: 'continue-watching' })
    if (mediaHub.movies.items.length > 0) items.push({ type: 'movies' })
    if (mediaHub.shows.items.length > 0) items.push({ type: 'shows' })
    if (mediaHub.newEpisodes.items.length > 0) items.push({ type: 'new-episodes' })
    if (mediaHub.musicAndCreators.items.length > 0) items.push({ type: 'music-creators' })
    if (recommendedVideos.length > 0 && mediaHub.movies.items.length === 0 && mediaHub.shows.items.length === 0) {
      items.push({ type: 'recommended' })
    }
    items.push({ type: 'discover-header' })
    if ((feedLoading || loadingFeedVideos) && feedVideos.length === 0) {
      items.push({ type: 'discover-loading' })
    } else if (discoverRows.length === 0) {
      items.push({ type: 'discover-empty' })
    } else {
      discoverRows.slice(0, 4).forEach((row, rowIndex) => items.push({ type: 'discover-row', videos: row, rowIndex }))
    }

    items.push({ type: 'my-videos-header' })
    if (myVideoRows.length === 0) {
      items.push({ type: 'my-videos-empty' })
    } else {
      myVideoRows.slice(0, 3).forEach((row, rowIndex) => items.push({ type: 'my-videos-row', videos: row, rowIndex }))
    }
    return items
  }, [
    mediaHub,
    recommendedVideos.length,
    discoverRows,
    feedLoading,
    loadingFeedVideos,
    feedVideos.length,
    myVideoRows,
  ])
```

This gives the cockpit hierarchy without deleting discover/my-video fallback sections.

- [ ] **Step 5: Add render helpers for media cards**

Before `renderHomeFeedItem`, add:

```ts
  const openMediaChannel = useCallback((video: any) => {
    const channelKey = video?.channelKey || video?.driveKey
    if (!channelKey) return
    router.push({ pathname: '/channel/[key]', params: { key: channelKey, publicBeeKey: video.publicBeeKey || undefined } })
  }, [router])

  const renderPosterRailItem = useCallback(({ item }: { item: any }) => (
    <MediaPosterCard item={item} onPress={() => playVideo(item)} />
  ), [playVideo])

  const renderEpisodeRailItem = useCallback(({ item }: { item: any }) => (
    <EpisodeCard item={item} onPress={() => playVideo(item)} />
  ), [playVideo])
```

For this first slice, poster cards play the representative item directly. A later title-page slice can route movie/show cards to richer destination pages when profile-level home data is available.

- [ ] **Step 6: Add hero rendering case**

At the top of `renderHomeFeedItem`, before `continue-watching`, add:

```tsx
    if (item.type === 'hero' && mediaHub.featured.item) {
      const hero = mediaHub.featured.item as any
      return (
        <HeroFeatureCard
          item={hero}
          peers={displayPeers}
          onPress={() => playVideo(hero)}
          onChannelPress={(hero.channelKey || hero.driveKey) ? () => openMediaChannel(hero) : undefined}
        />
      )
    }
```

- [ ] **Step 7: Replace Continue Watching rendering with `MediaRail` + `EpisodeCard`**

Replace the current `continue-watching` case with:

```tsx
    if (item.type === 'continue-watching') {
      return (
        <MediaRail
          title="Continue watching"
          data={mediaHub.continueWatching.items}
          itemWidth={EPISODE_CARD_WIDTH}
          keyExtractor={(entry: any) => getMediaHubPlaybackKey(entry)}
          renderItem={({ item: entry }: { item: any }) => (
            <EpisodeCard item={entry} progress={entry.progress} onPress={() => resumeEntry(entry)} />
          )}
          topSpacing={20}
        />
      )
    }
```

- [ ] **Step 8: Add Movies/Shows/New Episodes/Music cases**

After the Continue Watching case, add:

```tsx
    if (item.type === 'movies') {
      return (
        <MediaRail
          title="Movies"
          subtitle={mediaHub.movies.subtitle}
          data={mediaHub.movies.items}
          itemWidth={MEDIA_POSTER_CARD_WIDTH}
          keyExtractor={(video: any) => getMediaHubPlaybackKey(video)}
          renderItem={renderPosterRailItem}
        />
      )
    }

    if (item.type === 'shows') {
      return (
        <MediaRail
          title="Shows"
          subtitle={mediaHub.shows.subtitle}
          data={mediaHub.shows.items}
          itemWidth={MEDIA_POSTER_CARD_WIDTH}
          keyExtractor={(video: any) => getMediaHubPlaybackKey(video)}
          renderItem={renderPosterRailItem}
        />
      )
    }

    if (item.type === 'new-episodes') {
      return (
        <MediaRail
          title="New episodes"
          data={mediaHub.newEpisodes.items}
          itemWidth={EPISODE_CARD_WIDTH}
          keyExtractor={(video: any) => getMediaHubPlaybackKey(video)}
          renderItem={renderEpisodeRailItem}
        />
      )
    }

    if (item.type === 'music-creators') {
      return (
        <MediaRail
          title="Music & creators"
          data={mediaHub.musicAndCreators.items}
          itemWidth={EPISODE_CARD_WIDTH}
          keyExtractor={(video: any) => getMediaHubPlaybackKey(video)}
          renderItem={renderEpisodeRailItem}
        />
      )
    }
```

- [ ] **Step 9: Rename Discover header copy to network media language**

In the existing discover-header render case, change the visible section title:

```tsx
<Text style={{ color: colors.text, fontSize: 18, fontFamily: fonts.heading }}>Recently from the swarm</Text>
```

Keep the existing refresh button, category chips, and `SwarmIndicator` details intact.

- [ ] **Step 10: Update `renderHomeFeedItem` dependencies**

Add these dependencies to the dependency array:

```ts
    mediaHub,
    openMediaChannel,
    renderEpisodeRailItem,
    renderPosterRailItem,
```

Remove `continueWatching` if it is no longer used directly in the callback after the replacement. Keep `resumeEntry`, `playVideo`, `thumbnailCache`, `recommendedVideos`, and refresh/network dependencies that are still used by existing cases.

- [ ] **Step 11: Run focused tests**

Run:

```bash
node --test packages/app/tests/media-hub.test.mjs packages/app/tests/mobile-ui-redesign-regression.test.mjs
```

Expected: PASS for existing tests. The source-level mobile test has not yet been extended, so it may only validate previous design invariants.

- [ ] **Step 12: Commit mobile Home reshape**

Run:

```bash
git add packages/app/app/\(tabs\)/index.tsx
git commit -m "feat(app): reshape mobile home as media cockpit"
```

Expected: commit succeeds.

---

### Task 4: Add source-level regression guards for cockpit UI invariants

**Files:**
- Modify: `packages/app/tests/mobile-ui-redesign-regression.test.mjs`

- [ ] **Step 1: Add a media cockpit Home test**

Append this test to `packages/app/tests/mobile-ui-redesign-regression.test.mjs`:

```js
test('mobile home is organized as a media cockpit without changing playback or discovery paths', () => {
  const source = readApp('app/(tabs)/index.tsx')

  assert.match(source, /buildMediaHubSections/, 'Home should use the shared media-hub mapper instead of inline product grouping')
  assert.match(source, /HeroFeatureCard/, 'Home should render a cinematic hero feature')
  assert.match(source, /MediaRail/, 'Home should render semantic media rails')
  assert.match(source, /MediaPosterCard/, 'Home should have poster cards for movies/shows')
  assert.match(source, /EpisodeCard/, 'Home should have episode/video rail cards')
  assert.match(source, /Recently from the swarm/, 'Discover should be reframed as network media, not the whole product')
  assert.match(source, /const playVideo = useCallback/, 'Home should preserve the existing direct playback function')
  assert.match(source, /rpc\.preparePlayback\(playbackRequest\)/, 'Home playback should still resolve URLs through preparePlayback')
  assert.match(source, /loadAndPlayVideo\(video, result\.url\)/, 'Home playback should still use the existing shared player path')
  assert.match(source, /onPress=\{refreshFeed\}/, 'Public feed refresh should remain available')
  assert.doesNotMatch(source, /getContentCatalog\(/, 'Slice 1 should not add a new backend catalog dependency to Home')
})
```

- [ ] **Step 2: Run regression tests**

Run:

```bash
node --test packages/app/tests/mobile-ui-redesign-regression.test.mjs packages/app/tests/media-hub.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit regression guard**

Run:

```bash
git add packages/app/tests/mobile-ui-redesign-regression.test.mjs
git commit -m "test(app): guard media cockpit home invariants"
```

Expected: commit succeeds.

---

### Task 5: Verify focused app behavior and produce final status

**Files:**
- No new files expected.

- [ ] **Step 1: Run focused UI/data tests**

Run:

```bash
node --test \
  packages/app/tests/content-catalog.test.mjs \
  packages/app/tests/media-hub.test.mjs \
  packages/app/tests/mobile-ui-redesign-regression.test.mjs \
  packages/app/tests/vertical-discovery-regression.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run a TypeScript/static smoke when feasible**

Run:

```bash
npm exec --prefix packages/app -- tsc --noEmit --pretty false
```

Expected: Ideally PASS. If it fails due to pre-existing dependency/module issues, capture the first edited-file errors separately. Do not report global pre-existing type noise as caused by this slice unless it points at files changed in this plan.

- [ ] **Step 3: Inspect git state**

Run:

```bash
git status --short --branch
git log --oneline -n 6
```

Expected: branch has the design commit plus implementation commits. The pre-existing untracked `packages/desktop-native/` may still appear; do not add it unless explicitly instructed.

- [ ] **Step 4: Final report**

Report:

- files changed
- tests run and exact pass/fail result
- whether TypeScript smoke passed or had unrelated/pre-existing noise
- that playback/relay/protocol paths were intentionally untouched
- any remaining risks before Android physical-device release claims
