import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import { colors, radius, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { usePosterArtwork } from '@/hooks/usePosterArtwork'
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

/**
 * The scrim under the overlaid title, as a true vertical ramp from fully
 * transparent to near-opaque. It is built off the black token rather than
 * written as literal rgba so the alpha ladder stays in one place: a flat
 * rectangle reads as a hard-edged band across the artwork, which is the whole
 * reason this is a gradient.
 */
const OVERLAY_GRADIENT = [
  `${colors.contrast}00`,
  `${colors.contrast}b3`,
  `${colors.contrast}f2`,
] as const
// A caption needs the ramp to bite sooner than a title alone does.
const OVERLAY_STOPS_WITH_META = [0, 0.4, 1] as const
const OVERLAY_STOPS_TITLE_ONLY = [0, 0.6, 1] as const

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
      <View style={styles.frame}>
        <ThumbnailImage
          thumbnailUrl={artwork}
          channelInitial={title.charAt(0).toUpperCase()}
          style={styles.poster}
        />
        {/* An unreleased title is dimmed so it reads as a placeholder on the shelf. */}
        {unreleased ? <View pointerEvents="none" style={styles.unreleasedDim} /> : null}
        {unreleased ? (
          <View pointerEvents="none" style={styles.statusChip}>
            <Ionicons name="time-outline" size={13} color={colors.textMuted} />
            <Text style={styles.statusChipText}>Soon</Text>
          </View>
        ) : null}
        {percent === null ? null : (
          <View pointerEvents="none" style={styles.progressBadge}>
            <Text style={styles.progressBadgeText}>{percent}%</Text>
          </View>
        )}
        {/*
          Title and metadata sit on the artwork rather than under it, so the
          card is the poster. The gradient exists only because this text does:
          it is rendered inside the same block and leaves with it.
        */}
        <View pointerEvents="none" style={styles.overlay}>
          <LinearGradient
            pointerEvents="none"
            colors={OVERLAY_GRADIENT}
            locations={meta ? OVERLAY_STOPS_WITH_META : OVERLAY_STOPS_TITLE_ONLY}
            style={StyleSheet.absoluteFill}
          />
          <Text style={styles.title} numberOfLines={2}>{title}</Text>
          {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
        </View>
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
  frame: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.bgHover,
  },
  poster: {
    width: '100%',
    height: '100%',
    aspectRatio: undefined,
    borderRadius: 0,
  },
  unreleasedDim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: `${colors.contrast}8c`,
    zIndex: 2,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: '40%',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    zIndex: 3,
  },
  title: {
    ...fonts.body.sm,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
  },
  meta: {
    ...fonts.caption.sm,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  statusChip: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.scrim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    zIndex: 4,
  },
  statusChipText: {
    ...fonts.caption.sm,
    fontWeight: '600',
    color: colors.text,
  },
  progressBadge: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.scrim,
    zIndex: 4,
  },
  progressBadgeText: {
    ...fonts.caption.sm,
    fontWeight: '600',
    color: colors.text,
  },
})
