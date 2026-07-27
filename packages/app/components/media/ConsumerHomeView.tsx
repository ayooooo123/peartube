import React, { memo, useCallback, useMemo } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { MediaEntitySummary } from '@peartube/core'
import { HeroFeatureCard, type MediaCockpitItem } from './HeroFeatureCard'
import { MediaRail } from './MediaRail'
import { MEDIA_POSTER_CARD_WIDTH } from './MediaPosterCard'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { projectHomeRails } from '@/lib/home-rails.js'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'

export type ConsumerHomeState = {
  status?: string
  items?: MediaEntitySummary[] | null
  refreshing?: boolean
}

export type ConsumerHomeDiagnostic = {
  kind?: string
  title?: string
  detail?: string
  actionLabel?: string
  errorCode?: string | null
} | null

export type ConsumerHomeProps = {
  state: ConsumerHomeState
  diagnostic?: ConsumerHomeDiagnostic
  watchState?: unknown[]
  firstSeen?: Record<string, number>
  onRefresh(): void
  onOpenEntity(entityId: string, item: MediaEntitySummary): void
  contentBottomInset?: number
  now?: number
}

type RailItem = MediaEntitySummary & {
  availabilityView?: { label: string; playable: boolean }
  resume?: { fraction: number }
}

function posterArtwork(item: RailItem): string | null {
  const fields = item as unknown as Record<string, unknown>
  const candidates = [
    fields.posterUrl,
    fields.thumbnailUrl,
    fields.thumbnail,
    fields.stillUrl,
    fields.backdropUrl,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }
  return null
}

/**
 * One consumer card. It leads with the title and what a viewer can do with it
 * right now; publisher ids, claim counts, and archive mechanics are detail-view
 * concerns and deliberately absent here.
 *
 * Artwork goes through the same treatment as every other poster in the app.
 * This used to paint a flat surface with the title's first letter, which meant
 * a catalog of real media rendered as a row of grey rectangles.
 */
function HomeCard({ item, onPress }: { item: RailItem; onPress(): void }) {
  const availability = item.availabilityView
  const resumePercent = item.resume ? Math.round(item.resume.fraction * 100) : null
  const title = item.title || 'Untitled'
  const accessibilityLabel = [
    title,
    availability?.label,
    resumePercent === null ? null : `${resumePercent} percent watched`,
  ].filter(Boolean).join(', ')

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.posterFrame}>
        <ThumbnailImage
          thumbnailUrl={posterArtwork(item)}
          channelInitial={title.charAt(0).toUpperCase()}
          style={styles.poster}
        />
        <View pointerEvents="none" style={styles.posterScrim} />
        {resumePercent === null ? null : (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${resumePercent}%` }]} />
          </View>
        )}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>{title}</Text>
      {item.subtitle ? <Text style={styles.cardSubtitle} numberOfLines={1}>{item.subtitle}</Text> : null}
      {availability ? (
        <Text style={[styles.availability, !availability.playable && styles.availabilityMuted]} numberOfLines={1}>
          {availability.label}
        </Text>
      ) : null}
    </Pressable>
  )
}

const MemoizedHomeCard = memo(HomeCard)

export function ConsumerHomeView({
  state,
  diagnostic = null,
  watchState = [],
  firstSeen = {},
  onRefresh,
  onOpenEntity,
  contentBottomInset = 24,
  now,
}: ConsumerHomeProps) {
  const items = useMemo(() => (Array.isArray(state.items) ? state.items : []), [state.items])
  const rails = useMemo(
    () => projectHomeRails({ items, watchState, firstSeen, now: now ?? Date.now() }),
    [items, watchState, firstSeen, now],
  )

  // Home leads with one feature so the screen has a focal point instead of
  // opening on a row of thumbnails. Anything resumable comes first, then
  // whatever is playable, and only then the newest title - a catalog that is
  // still replicating still deserves a hero, it just must not offer to play.
  const featured = useMemo(() => {
    const ordered = [
      ...(rails.find(rail => rail.id === 'continue-watching')?.items ?? []),
      ...rails.flatMap(rail => rail.items ?? []),
    ] as RailItem[]
    return ordered.find(item => item.availabilityView?.playable === true) ?? ordered[0] ?? null
  }, [rails])

  const renderItem = useCallback(({ item }: { item: RailItem }) => (
    <MemoizedHomeCard item={item} onPress={() => onOpenEntity(item.entityId, item)} />
  ), [onOpenEntity])

  if (rails.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={[styles.emptyContent, { paddingBottom: contentBottomInset }]}
        refreshControl={<RefreshControl refreshing={state.refreshing === true} onRefresh={onRefresh} />}
      >
        {state.status === 'loading' ? <ActivityIndicator color={colors.primary} /> : null}
        <Text style={styles.emptyTitle}>{diagnostic?.title || 'Nothing to watch yet'}</Text>
        <Text style={styles.emptyDetail}>
          {diagnostic?.detail || 'No peers have shared anything this device can play yet.'}
        </Text>
        {diagnostic?.errorCode ? <Text style={styles.emptyCode}>{diagnostic.errorCode}</Text> : null}
        <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.emptyAction}>
          <Text style={styles.emptyActionLabel}>{diagnostic?.actionLabel || 'Check again'}</Text>
        </Pressable>
      </ScrollView>
    )
  }

  return (
    <ScrollView
      testID="consumer-home"
      contentContainerStyle={{ paddingBottom: contentBottomInset }}
      refreshControl={<RefreshControl refreshing={state.refreshing === true} onRefresh={onRefresh} />}
      showsVerticalScrollIndicator={false}
    >
      {featured ? (
        <View style={styles.hero}>
          <HeroFeatureCard
            item={featured as unknown as MediaCockpitItem}
            playable={featured.availabilityView?.playable === true}
            availabilityLabel={featured.availabilityView?.label ?? null}
            onPress={() => onOpenEntity(featured.entityId, featured)}
            onDetailsPress={() => onOpenEntity(featured.entityId, featured)}
          />
        </View>
      ) : null}
      {rails.map(rail => (
        <MediaRail
          key={rail.id}
          title={rail.title}
          subtitle={rail.subtitle ?? undefined}
          data={rail.items as RailItem[]}
          itemWidth={MEDIA_POSTER_CARD_WIDTH}
          renderItem={renderItem}
          keyExtractor={(item: RailItem) => `${rail.id}:${item.entityId}`}
        />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  hero: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  card: {
    width: MEDIA_POSTER_CARD_WIDTH,
  },
  cardPressed: {
    opacity: 0.75,
  },
  posterFrame: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 18,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
  },
  // ThumbnailImage defaults to a 16:9 video still. Inside a 2:3 poster frame it
  // has to fill the frame instead of imposing its own ratio and corners.
  poster: {
    width: '100%',
    height: '100%',
    aspectRatio: undefined,
    borderRadius: 0,
  },
  posterScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 74,
    backgroundColor: 'rgba(0,0,0,0.34)',
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: colors.border,
  },
  progressFill: {
    height: 3,
    backgroundColor: colors.primary,
  },
  cardTitle: {
    marginTop: 8,
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 13,
  },
  cardSubtitle: {
    marginTop: 2,
    color: colors.textMuted,
    fontFamily: fonts.headingMedium,
    fontSize: 11,
  },
  availability: {
    marginTop: 4,
    color: colors.primary,
    fontFamily: fonts.headingMedium,
    fontSize: 11,
  },
  availabilityMuted: {
    color: colors.textMuted,
  },
  emptyContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 17,
    textAlign: 'center',
  },
  emptyDetail: {
    color: colors.textMuted,
    fontFamily: fonts.headingMedium,
    fontSize: 13,
    textAlign: 'center',
  },
  emptyCode: {
    color: colors.textMuted,
    
    fontSize: 11,
  },
  emptyAction: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  emptyActionLabel: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 13,
  },
})
