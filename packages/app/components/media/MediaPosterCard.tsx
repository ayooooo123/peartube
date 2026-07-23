import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import type { MediaCockpitItem } from './HeroFeatureCard'

export const MEDIA_POSTER_CARD_WIDTH = 154

export interface MediaPosterCardProps {
  item: MediaCockpitItem
  onPress: () => void
}

function MediaPosterCardComponent({ item, onPress }: MediaPosterCardProps) {
  const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title : 'Untitled media'
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
  const badge = formatContentBadge(item)

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play ${title}`}
      style={styles.card}
    >
      <View style={styles.posterFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={title.charAt(0).toUpperCase()} style={styles.thumbnail} />
        {badge ? (
          <View style={styles.badgeWrap} pointerEvents="none">
            <Text style={styles.badge} numberOfLines={1}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
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
    borderRadius: 18,
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
})
