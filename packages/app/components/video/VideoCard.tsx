/**
 * VideoCard - YouTube-style video card for feed display
 * Shows: thumbnail (16:9), duration badge, channel avatar, title, channel name, time ago
 *
 * Memoized for optimal FlatList performance - only re-renders when video data changes.
 */
import { memo, useMemo, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated'
import { ThumbnailImage } from './ThumbnailImage'
import { formatTimeAgo, formatContentBadge } from '@/lib/formatters'
import { Tag, Meta, Eyebrow } from '@/components/primitives'
import type { ContentCoordinates } from '@/lib/formatters'

export interface VideoData {
  id: string
  title: string
  path?: string
  size?: number
  uploadedAt?: number
  createdAt?: number
  channelKey?: string
  driveKey?: string
  publicBeeKey?: string | null
  thumbnailUrl?: string | null
  thumbnail?: string | null
  duration?: number
  description?: string
  mimeType?: string
  category?: string
  creatorName?: string | null
  score?: number  // Search relevance score
  contentKind?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  mediaProvider?: string | null
  mediaId?: string | null
  classification?: ContentCoordinates['classification']
  channel?: {
    name: string
    avatarUrl?: string
  }
}

interface VideoCardProps {
  video: VideoData
  onPress: () => void
  onChannelPress?: () => void
  showChannelInfo?: boolean
  testID?: string
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function getChannelInitial(name?: string, key?: string): string {
  if (name) return name.charAt(0).toUpperCase()
  if (key) return key.charAt(0).toUpperCase()
  return 'P'
}

function formatDuration(seconds?: number): string | null {
  if (typeof seconds !== 'number' || seconds <= 0) return null
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}:${mins.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  return `${mins}:${(seconds % 60).toString().padStart(2, '0')}`
}

function VideoCardComponent({ video, onPress, onChannelPress, showChannelInfo = true, testID }: VideoCardProps) {
  const channelKey = video.channelKey || video.driveKey

  // Memoize derived values to prevent recalculation on every render
  const channelName = useMemo(
    () => video.creatorName || video.channel?.name || `Channel ${channelKey?.slice(0, 8) || 'Unknown'}`,
    [video.creatorName, video.channel?.name, channelKey]
  )

  const channelInitial = useMemo(
    () => getChannelInitial(channelName, channelKey),
    [channelName, channelKey]
  )

  const timeAgo = useMemo(
    () => formatTimeAgo(video.uploadedAt || video.createdAt),
    [video.uploadedAt, video.createdAt]
  )

  const contentBadge = useMemo(
    () => formatContentBadge(video),
    [video.contentKind, video.seasonNumber, video.episodeNumber, video.classification]
  )

  const durationLabel = useMemo(
    () => formatDuration(video.duration),
    [video.duration]
  )

  // Memoize press handler to maintain referential equality
  const handlePress = useCallback(() => {
    onPress()
  }, [onPress])

  // Memoize pressed style function
  const getPressedStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.container,
      pressed && styles.pressed
    ],
    []
  )

  // Channel press feedback (spring animation)
  const channelScale = useSharedValue(1)
  const channelOpacity = useSharedValue(1)
  const channelPressIn = useCallback(() => {
    channelScale.value = withSpring(0.9, { damping: 15, stiffness: 400 })
    channelOpacity.value = withTiming(0.7, { duration: 100 })
  }, [channelScale, channelOpacity])
  const channelPressOut = useCallback(() => {
    channelScale.value = withSpring(1, { damping: 15, stiffness: 400 })
    channelOpacity.value = withTiming(1, { duration: 100 })
  }, [channelScale, channelOpacity])
  const channelAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: channelScale.value }],
    opacity: channelOpacity.value,
  }))

  return (
    <Pressable
      onPress={handlePress}
      style={getPressedStyle}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Play ${video.title}`}
    >
      <View style={styles.surface}>
        <View style={styles.thumbnailFrame}>
          <ThumbnailImage
            thumbnailUrl={video.thumbnailUrl || video.thumbnail}
            duration={video.duration}
            channelInitial={channelInitial}
          />
          {durationLabel && (
            <View pointerEvents="none" style={styles.durationBadge}>
              <Tag label={durationLabel} tone="inverse" />
            </View>
          )}
        </View>

        <View style={styles.infoRow}>
          {showChannelInfo && onChannelPress ? (
            <AnimatedPressable
              onPress={onChannelPress}
              onPressIn={channelPressIn}
              onPressOut={channelPressOut}
              style={[styles.avatarContainer, channelAnimStyle]}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Open ${channelName}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{channelInitial}</Text>
              </View>
            </AnimatedPressable>
          ) : showChannelInfo ? (
            <View style={styles.avatarContainer}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{channelInitial}</Text>
              </View>
            </View>
          ) : null}

          <View style={styles.textContainer}>
            <Text style={styles.title} numberOfLines={2}>
              {video.title}
            </Text>
            <View style={styles.metaRow}>
              {showChannelInfo && onChannelPress ? (
                <>
                  <AnimatedPressable
                    onPress={onChannelPress}
                    onPressIn={channelPressIn}
                    onPressOut={channelPressOut}
                    style={channelAnimStyle}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${channelName}`}
                  >
                    <Meta tone="secondary" numberOfLines={1}>{channelName}</Meta>
                  </AnimatedPressable>
                  <Meta tone="secondary">·</Meta>
                </>
              ) : showChannelInfo ? (
                <>
                  <Meta tone="secondary" numberOfLines={1}>{channelName}</Meta>
                  <Meta tone="secondary">·</Meta>
                </>
              ) : null}
              <Meta tone="muted">{timeAgo}</Meta>
              {contentBadge ? (
                <>
                  <Meta tone="secondary">·</Meta>
                  <Meta tone="secondary">{contentBadge}</Meta>
                </>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  )
}

const VIDEO_COMPARE_FIELDS = [
  'id',
  'title',
  'thumbnailUrl',
  'thumbnail',
  'duration',
  'uploadedAt',
  'createdAt',
  'channelKey',
  'driveKey',
  'creatorName',
  'contentKind',
  'seasonNumber',
  'episodeNumber',
] as const

function areCallbacksAndFlagsEqual(prevProps: VideoCardProps, nextProps: VideoCardProps): boolean {
  return (
    prevProps.onPress === nextProps.onPress &&
    prevProps.onChannelPress === nextProps.onChannelPress &&
    prevProps.showChannelInfo === nextProps.showChannelInfo
  )
}

function areVideoPropertiesEqual(prev: VideoCardProps['video'], next: VideoCardProps['video']): boolean {
  if (prev === next) return true
  for (const field of VIDEO_COMPARE_FIELDS) {
    if (prev[field] !== next[field]) return false
  }
  return prev.channel?.name === next.channel?.name
}

// Custom comparison for React.memo - only re-render if video data actually changed
function arePropsEqual(prevProps: VideoCardProps, nextProps: VideoCardProps): boolean {
  if (prevProps === nextProps) return true
  if (!areCallbacksAndFlagsEqual(prevProps, nextProps)) return false
  return areVideoPropertiesEqual(prevProps.video, nextProps.video)
}

export const VideoCard = memo(VideoCardComponent, arePropsEqual)

const styles = StyleSheet.create({
  container: {
    width: '100%',
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  surface: {
    overflow: 'hidden',
    borderRadius: radius.card,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
  },
  thumbnailFrame: {
    position: 'relative',
    overflow: 'hidden',
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    backgroundColor: colors.bg,
  },
  pressed: {
    opacity: 0.78,
    transform: [{ scale: 0.99 }],
  },
  durationBadge: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    zIndex: 2,
  },
  infoRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  avatarContainer: {
    marginRight: spacing.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.card,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  textContainer: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
})

export default VideoCard
