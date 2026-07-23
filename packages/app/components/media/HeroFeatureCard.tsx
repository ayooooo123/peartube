import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatContentBadge } from '@/lib/formatters'
import { ThumbnailImage } from '@/components/video/ThumbnailImage'
import { NetworkStatusPill } from './NetworkStatusPill'

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
  peers?: number | null
  onPress: () => void
  onChannelPress?: () => void
}


function HeroFeatureCardComponent({ item, peers, onPress, onChannelPress }: HeroFeatureCardProps) {
  if (!item) return null

  const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title : 'Featured media'
  const subtitle = typeof item.subtitle === 'string' && item.subtitle.trim().length > 0
    ? item.subtitle
    : typeof item.channelName === 'string' && item.channelName.trim().length > 0
      ? item.channelName
      : typeof item.channel?.name === 'string' && item.channel.name.trim().length > 0
        ? item.channel.name
        : typeof item.creatorName === 'string' && item.creatorName.trim().length > 0
          ? item.creatorName
          : null
  const badge = formatContentBadge(item)
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
  const channelInitial = title.charAt(0).toUpperCase()

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play ${title}`}
      style={styles.card}
    >
      <View style={styles.mediaFrame}>
        <ThumbnailImage thumbnailUrl={thumbnailUrl} duration={duration} channelInitial={channelInitial} style={styles.thumbnail} />
        <View pointerEvents="none" style={styles.scrimTop} />
        <View pointerEvents="none" style={styles.scrimBottom} />
        <View style={styles.mediaTopRow}>
          <Text style={styles.kicker} numberOfLines={1}>Featured from the swarm</Text>
          <NetworkStatusPill peers={peers} tone={peers && peers > 0 ? 'live' : 'ready'} />
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.metaRow}>
          {badge ? <Text style={styles.badge} numberOfLines={1}>{badge}</Text> : null}
          {item.category ? <Text style={styles.meta} numberOfLines={1}>{item.category}</Text> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {subtitle ? (
          onChannelPress ? (
            <Pressable onPress={onChannelPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open ${subtitle}`}>
              <Text style={[styles.subtitle, styles.subtitleAction]} numberOfLines={1}>{subtitle}</Text>
            </Pressable>
          ) : (
            <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
          )
        ) : null}
        <View style={styles.playButton}>
          <Ionicons name="play" size={16} color={colors.onPrimary} />
          <Text style={styles.playText}>Play</Text>
        </View>
      </View>
    </Pressable>
  )
}

export const HeroFeatureCard = memo(HeroFeatureCardComponent)

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    shadowColor: '#000000',
    shadowOpacity: 0.32,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 6,
  },
  scrimTop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  mediaFrame: {
    position: 'relative',
    backgroundColor: colors.bg,
  },
  thumbnail: {
    borderRadius: 0,
  },
  scrimBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 96,
    backgroundColor: 'rgba(0,0,0,0.36)',
  },
  mediaTopRow: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  kicker: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.44)',
  },
  body: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
  },
  metaRow: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  badge: {
    color: colors.onPrimary,
    backgroundColor: colors.primary,
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: '800',
  },
  meta: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.heading,
    fontSize: 26,
    lineHeight: 31,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 7,
  },
  subtitleAction: {
    color: colors.swarm,
  },
  playButton: {
    alignSelf: 'flex-start',
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 999,
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  playText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
})
