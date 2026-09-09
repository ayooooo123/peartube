import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { Meta, Eyebrow } from '@/components/primitives'
import type { MediaCockpitItem } from './HeroFeatureCard'

export const EPISODE_CARD_WIDTH = 236

export interface EpisodeCardProps {
  item: MediaCockpitItem
  onPress: () => void
  progress?: number | null
}

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function getBadge(item: MediaCockpitItem): string | null {
  const formatted = formatContentBadge(item)
  const kind = pickString(item.contentKind, item.classification?.type)
  if (kind === 'movie') return 'Movie'
  if (kind === 'episode' || kind === 'tv') return 'Episode'
  if (kind === 'season' || kind === 'album' || kind === 'collection') return 'Collection'
  if (kind === 'song' || kind === 'music') return 'Music'
  return formatted || (item.localEntityId ? 'Work' : null)
}

function getArtwork(item: MediaCockpitItem): string | null {
  return pickString(item.stillUrl, item.thumbnailUrl, item.thumbnail, item.backdropUrl, item.posterUrl)
}

function getSubtitle(item: MediaCockpitItem): string | null {
  return pickString(item.subtitle, item.creatorName, item.sourceProviderName, item.publisherName, item.channelName, item.channel?.name)
}

function getSignal(item: MediaCockpitItem): string | null {
  if (typeof item.sourceCount === 'number' && item.sourceCount > 1) return `${item.sourceCount} sources`
  const archiveStatus = pickString(item.archiveStatus, item.availabilityStatus)
  if (archiveStatus === 'local' || archiveStatus === 'complete-local') return 'local copy'
  if (archiveStatus === 'cached' || archiveStatus === 'retained') return 'retained'
  if (item.publicationId || item.localEntityId) return 'provenance'
  return pickString(item.sourceProviderName, item.publisherName)
}

function EpisodeCardComponent({ item, onPress, progress }: EpisodeCardProps) {
  const title = pickString(item.title) || 'Untitled episode'
  const subtitle = getSubtitle(item)
  const thumbnailUrl = getArtwork(item)
  const duration = typeof item.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const rawProgress = typeof progress === 'number' ? progress : 0
  const normalizedProgress = rawProgress > 1 ? 1 : rawProgress > 0 ? rawProgress : 0
  const badge = getBadge(item)
  const signal = getSignal(item)
  const conflictCount = Array.isArray(item.conflicts) ? item.conflicts.length : 0

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play ${title}`}
      style={styles.card}
    >
      <View style={styles.thumbnailFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={title.charAt(0).toUpperCase()} style={styles.thumbnail} />
        {/* Progress bar at bottom: 2px lime line */}
        {normalizedProgress > 0 ? (
          <View style={styles.progressTrack} pointerEvents="none">
            <View style={[styles.progressFill, { width: `${Math.round(normalizedProgress * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      
      <View style={styles.copy}>
        <View style={styles.metaRow}>
          {badge ? <Eyebrow tone="accent">{badge}</Eyebrow> : null}
          {signal ? <Meta tone="muted">{signal}</Meta> : null}
          {conflictCount > 0 ? <Meta tone="warning">CONFLICT</Meta> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  )
}

export const EpisodeCard = memo(EpisodeCardComponent)

const styles = StyleSheet.create({
  card: {
    width: EPISODE_CARD_WIDTH,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
  },
  thumbnailFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  thumbnail: {
    borderRadius: 0,
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: borderWidth.rule,
    backgroundColor: colors.bgActive,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  copy: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  metaRow: {
    minHeight: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
    flexWrap: 'wrap',
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
  },
  subtitle: {
    ...fonts.body.sm,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
})
