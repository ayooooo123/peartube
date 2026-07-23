import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import type { MediaCockpitItem } from './HeroFeatureCard'

export const EPISODE_CARD_WIDTH = 236

export interface EpisodeCardProps {
  item: MediaCockpitItem
  onPress: () => void
  progress?: number | null
}

function EpisodeCardComponent({ item, onPress, progress }: EpisodeCardProps) {
  const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title : 'Untitled episode'
  const subtitle = typeof item.subtitle === 'string' && item.subtitle.trim().length > 0
    ? item.subtitle
    : typeof item.channelName === 'string' && item.channelName.trim().length > 0
      ? item.channelName
      : typeof item.channel?.name === 'string' && item.channel.name.trim().length > 0
        ? item.channel.name
        : typeof item.creatorName === 'string' && item.creatorName.trim().length > 0
          ? item.creatorName
          : null
  const thumbnailUrl = typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim().length > 0
    ? item.thumbnailUrl
    : typeof item.thumbnail === 'string' && item.thumbnail.trim().length > 0
      ? item.thumbnail
      : null
  const duration = typeof item.duration === 'number' && item.duration > 0
    ? item.duration
    : typeof item.durationSec === 'number' && item.durationSec > 0
      ? item.durationSec
      : undefined
  const rawProgress = typeof progress === 'number' ? progress : 0
  const normalizedProgress = rawProgress > 1 ? 1 : rawProgress > 0 ? rawProgress : 0
  const badge = formatContentBadge(item)

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play ${title}`}
      style={styles.card}
    >
      <View style={styles.thumbnailFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={title.charAt(0).toUpperCase()} style={styles.thumbnail} />
        {normalizedProgress > 0 ? (
          <View style={styles.progressTrack} pointerEvents="none">
            <View style={[styles.progressFill, { width: `${Math.round(normalizedProgress * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      <View style={styles.copy}>
        <View style={styles.metaRow}>
          {badge ? <Text style={styles.badge} numberOfLines={1}>{badge}</Text> : null}
          {item.category ? <Text style={styles.meta} numberOfLines={1}>{item.category}</Text> : null}
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
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
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
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.56)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  copy: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  metaRow: {
    minHeight: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 4,
  },
  badge: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
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
})
