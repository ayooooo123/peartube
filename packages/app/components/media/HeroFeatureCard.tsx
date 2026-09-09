import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { Button, Tag, Eyebrow, Meta } from '@/components/primitives'

export interface MediaCockpitItem {
  id?: string | number | null
  videoId?: string | number | null
  title?: string | null
  subtitle?: string | null
  channelName?: string | null
  creatorName?: string | null
  channel?: {
    name?: string | null
  } | null
  thumbnailUrl?: string | null
  thumbnail?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  stillUrl?: string | null
  sourceCount?: number | null
  sourceProviderName?: string | null
  publisherName?: string | null
  archiveStatus?: string | null
  availabilityStatus?: string | null
  conflicts?: Array<unknown> | null
  provenance?: Array<unknown> | null
  localEntityId?: string | null
  publicationId?: string | null
  duration?: number | null
  durationSec?: number | null
  contentKind?: string | null
  classification?: {
    type?: string | null
    year?: number | null
    season?: number | null
    episode?: number | null
  } | null
  category?: string | null
}

export interface HeroFeatureCardProps {
  item: MediaCockpitItem | null | undefined
  onPress: () => void
  onChannelPress?: () => void
  /**
   * What this device can currently do with the feature. A hero that always
   * reads "Play" promises playback even while the media is still replicating,
   * so callers pass the real state and the card stops offering to play.
   */
  playable?: boolean
  availabilityLabel?: string | null
}

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function getEntityBadge(item: MediaCockpitItem): string | null {
  const formatted = formatContentBadge(item)
  const kind = pickString(item.contentKind, item.classification?.type)
  if (kind === 'movie') return 'Movie'
  if (kind === 'episode' || kind === 'tv') return 'Episode'
  if (kind === 'season' || kind === 'album' || kind === 'collection') return 'Collection'
  if (kind === 'song' || kind === 'music') return 'Music'
  return formatted || (item.localEntityId ? 'Work' : null)
}

function getArtwork(item: MediaCockpitItem): string | null {
  return pickString(item.backdropUrl, item.posterUrl, item.stillUrl, item.thumbnailUrl, item.thumbnail)
}

function formatDuration(seconds?: number): string | null {
  if (typeof seconds !== 'number' || seconds <= 0) return null
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}:${mins.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  return `${mins}:${(seconds % 60).toString().padStart(2, '0')}`
}

function HeroFeatureCardComponent({
  item,
  onPress,
  onChannelPress,
  playable = true,
  availabilityLabel = null,
}: HeroFeatureCardProps) {
  if (!item) return null

  const title = pickString(item.title) || 'Featured media'
  const subtitle = pickString(
    item.subtitle,
    item.creatorName,
    item.sourceProviderName,
    item.publisherName,
    item.channelName,
    item.channel?.name,
  )
  const badge = getEntityBadge(item)
  const thumbnailUrl = getArtwork(item)
  const duration = typeof item.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const durationLabel = formatDuration(duration)
  const channelInitial = title.charAt(0).toUpperCase()
  const releaseYear = (() => {
    const value = (item as Record<string, unknown>).year ?? (item as Record<string, unknown>).releaseYear
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 1800 ? String(Math.trunc(parsed)) : null
  })()

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={playable ? `Play ${title}` : `Open ${title}, ${availabilityLabel || 'not playable yet'}`}
      style={styles.card}
    >
      <View style={styles.mediaFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={channelInitial} style={styles.thumbnail} />
        {durationLabel && (
          <View pointerEvents="none" style={styles.durationBadge}>
            <Tag label={durationLabel} tone="inverse" />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.metaRow}>
          {badge ? <Eyebrow tone="accent">{badge}</Eyebrow> : null}
          {releaseYear ? <Meta tone="secondary">{releaseYear}</Meta> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? (
          onChannelPress ? (
            <Pressable onPress={onChannelPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open publisher for ${title}`}>
              <Text style={[styles.subtitle, styles.subtitleAction]} numberOfLines={1}>{subtitle}</Text>
            </Pressable>
          ) : (
            <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
          )
        ) : null}
        <View style={styles.buttonRow}>
          <Button 
            label="PLAY" 
            variant={playable ? 'primary' : 'secondary'} 
            size="md"
            onPress={onPress}
            disabled={!playable}
          />
          <Button 
            label="DETAILS" 
            variant="secondary" 
            size="md"
            onPress={onPress}
          />
        </View>
        {!playable && availabilityLabel && (
          <Text style={styles.pendingLabel}>{availabilityLabel}</Text>
        )}
      </View>
    </Pressable>
  )
}

export const HeroFeatureCard = memo(HeroFeatureCardComponent)

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
  },
  mediaFrame: {
    position: 'relative',
    backgroundColor: colors.bg,
  },
  thumbnail: {
    borderRadius: 0,
  },
  durationBadge: {
    position: 'absolute',
    bottom: spacing.md,
    right: spacing.md,
    zIndex: 2,
  },
  body: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  metaRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
  },
  subtitle: {
    ...fonts.body.sm,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  subtitleAction: {
    color: colors.swarm,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  pendingLabel: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
})
