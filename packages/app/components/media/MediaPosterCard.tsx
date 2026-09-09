import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { usePosterArtwork } from '@/hooks/usePosterArtwork'
import { Tag, SwarmIndicator } from '@/components/primitives'
import type { MediaCockpitItem } from './HeroFeatureCard'

/**
 * Default column width for a poster card. A grid that measures its own columns
 * passes `width`; a rail or any caller without a measurement gets this. Sized
 * so the overlaid title still reads at two lines on a phone.
 */
export const MEDIA_POSTER_CARD_WIDTH = 160

/**
 * What a poster card reads off a catalog entry. The cockpit fields carry the
 * artwork locators and provenance; the rest are the display facts the home
 * projection attaches (`resume`) or the publisher claims (`releaseYear`).
 */
export type MediaPosterCardItem = MediaCockpitItem & {
  entityId?: string | null
  releaseYear?: number | null
  year?: number | string | null
  resume?: { fraction?: number | null } | null
  percentWatched?: number | null
}

export interface MediaPosterCardProps {
  item: MediaPosterCardItem
  onPress: () => void
  /** Column width; defaults to {@link MEDIA_POSTER_CARD_WIDTH}. */
  width?: number
}

// Below this the badge tells a viewer nothing they did not already know.
const MIN_PROGRESS_PERCENT = 5

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * The line under the title. A year is what a viewer scans a shelf for, so it
 * leads; the publisher's own subtitle follows when there is room for both.
 */
function metaLine(item: MediaPosterCardItem, releaseYear: number | null): string | null {
  const subtitle = pickString(item.subtitle, item.creatorName, item.sourceProviderName, item.publisherName, item.channelName, item.channel?.name)
  if (releaseYear && subtitle) return `${releaseYear} · ${subtitle}`
  return releaseYear ? String(releaseYear) : subtitle
}

/**
 * Watch progress as a percentage, or null when there is none worth showing.
 * The home projection expresses it as a fraction of the runtime; a catalog
 * entry may already carry a percentage.
 */
function progressPercent(item: MediaPosterCardItem): number | null {
  const fraction = Number(item.resume?.fraction)
  const percent = Number.isFinite(fraction) && fraction > 0
    ? fraction * 100
    : Number(item.percentWatched)
  if (!Number.isFinite(percent)) return null
  const rounded = Math.round(Math.min(100, Math.max(0, percent)))
  return rounded >= MIN_PROGRESS_PERCENT ? rounded : null
}

function formatDuration(seconds?: number): string | null {
  if (typeof seconds !== 'number' || seconds <= 0) return null
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}:${mins.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  return `${mins}:${(seconds % 60).toString().padStart(2, '0')}`
}

function MediaPosterCardComponent({ item, onPress, width = MEDIA_POSTER_CARD_WIDTH }: MediaPosterCardProps) {
  const title = pickString(item.title) || 'Untitled media'
  // A publisher-claimed year, sanity-bounded so a stray 0 or a millisecond
  // timestamp never prints as one.
  const claimedYear = Number(item.releaseYear ?? item.year)
  const releaseYear = Number.isFinite(claimedYear) && claimedYear > 1800 ? Math.trunc(claimedYear) : null
  const meta = metaLine(item, releaseYear)
  // Cover art claimed as a blob lives in the publisher's own core and resolves
  // through the local blob server. The locators below are only the fallback for
  // older claims that name an origin; neither is ever rendered directly.
  const artwork = usePosterArtwork(item, pickString(item.posterUrl, item.thumbnailUrl, item.thumbnail, item.stillUrl, item.backdropUrl))
  const percent = progressPercent(item)
  // Release status, held to what a consumer actually receives: the catalog
  // carries a claimed year and nothing finer, so the one honest distinction is
  // "not out yet". There is no theatrical/home split to draw here.
  const unreleased = releaseYear !== null && releaseYear > new Date().getFullYear()

  const duration = typeof item.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const durationLabel = formatDuration(duration)

  const accessibilityLabel = [
    title,
    meta,
    percent === null ? null : `${percent} percent watched`,
    unreleased ? 'not yet released' : null,
  ].filter(Boolean).join(', ')

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.card, { width }, pressed && styles.cardPressed]}
    >
      <View style={styles.imageContainer}>
        <ThumbnailImage
          thumbnailUrl={artwork}
          channelInitial={title.charAt(0).toUpperCase()}
          style={styles.image}
        />
        {/* Unreleased titles are dimmed */}
        {unreleased ? <View pointerEvents="none" style={styles.unreleasedDim} /> : null}
        {/* Duration badge in bottom-right */}
        {durationLabel ? (
          <View pointerEvents="none" style={styles.durationBadge}>
            <Tag label={durationLabel} tone="inverse" />
          </View>
        ) : null}
        {/* Progress bar along bottom edge */}
        {percent !== null && !unreleased ? (
          <View pointerEvents="none" style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>
        ) : null}
      </View>

      <View style={styles.textContainer}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
      </View>

      {/* Peer presence indicator */}
      <View style={styles.peerIndicator}>
        <SwarmIndicator peers={0} label="count" size={6} />
      </View>
    </Pressable>
  )
}

export const MediaPosterCard = memo(MediaPosterCardComponent)

const styles = StyleSheet.create({
  card: {
    width: MEDIA_POSTER_CARD_WIDTH,
  },
  cardPressed: {
    opacity: 0.82,
  },
  imageContainer: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radius.card,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  image: {
    width: '100%',
    height: '100%',
    aspectRatio: undefined,
    borderRadius: 0,
  },
  unreleasedDim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
    zIndex: 1,
  },
  durationBadge: {
    position: 'absolute',
    bottom: spacing.xs,
    right: spacing.xs,
    zIndex: 2,
  },
  progressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: borderWidth.rule,
    backgroundColor: colors.bgActive,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  textContainer: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
  },
  meta: {
    ...fonts.meta.sm,
    color: colors.textMuted,
  },
  peerIndicator: {
    marginTop: spacing.xs,
  },
})
