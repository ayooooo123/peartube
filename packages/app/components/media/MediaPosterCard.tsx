import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import type { MediaCockpitItem } from './HeroFeatureCard'

export const MEDIA_POSTER_CARD_WIDTH = 160

export interface MediaPosterCardProps {
  item: MediaCockpitItem
  onPress: () => void
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
  return pickString(item.posterUrl, item.thumbnailUrl, item.thumbnail, item.stillUrl, item.backdropUrl)
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

function MediaPosterCardComponent({ item, onPress }: MediaPosterCardProps) {
  const title = pickString(item.title) || 'Untitled media'
  const subtitle = getSubtitle(item)
  const thumbnailUrl = getArtwork(item)
  const duration = typeof item.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const badge = getBadge(item)
  const signal = getSignal(item)
  const conflictCount = Array.isArray(item.conflicts) ? item.conflicts.length : 0

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      style={styles.card}
    >
      <View style={styles.posterFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={title.charAt(0).toUpperCase()} style={styles.thumbnail} />
        <View pointerEvents="none" style={styles.posterScrim} />
        {badge ? (
          <View style={styles.badgeWrap} pointerEvents="none">
            <Text style={styles.badge} numberOfLines={1}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        <View style={styles.signalRow}>
          {signal ? <Text style={styles.signal} numberOfLines={1}>{signal}</Text> : null}
          {conflictCount > 0 ? <Text style={styles.signalWarn} numberOfLines={1}>conflict</Text> : null}
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
  posterFrame: {
    width: '100%',
    aspectRatio: 2 / 3,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  thumbnail: {
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
  badgeWrap: {
    position: 'absolute',
    left: 9,
    right: 9,
    bottom: 9,
    alignItems: 'flex-start',
  },
  badge: {
    maxWidth: '100%',
    color: colors.onPrimary,
    backgroundColor: colors.primary,
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 10,
    fontWeight: '800',
  },
  copy: {
    paddingTop: 10,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 14,
    lineHeight: 18,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  signalRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 7,
  },
  signal: {
    color: colors.primary,
    borderWidth: 1,
    borderColor: 'rgba(163,230,53,0.26)',
    backgroundColor: 'rgba(163,230,53,0.08)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  signalWarn: {
    color: '#fde68a',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.28)',
    backgroundColor: 'rgba(251,191,36,0.10)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
})
