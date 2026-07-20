/**
 * VideoCard - YouTube-style video card for feed display
 * Shows: thumbnail (16:9), duration badge, channel avatar, title, channel name, time ago
 *
 * Memoized for optimal FlatList performance - only re-renders when video data changes.
 */
import { memo, useMemo, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors } from '@/lib/colors'
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated'
import { ThumbnailImage } from './ThumbnailImage'
import { formatTimeAgo, formatContentBadge } from '@/lib/formatters'
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

// Get channel initial for avatar placeholder
function getChannelInitial(name?: string, key?: string): string {
  if (name) return name.charAt(0).toUpperCase()
  if (key) return key.charAt(0).toUpperCase()
  return 'P'
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
                    <Text style={styles.channelNameLink} numberOfLines={1}>
                      {channelName}
                    </Text>
                  </AnimatedPressable>
                  <Text style={styles.dot}>·</Text>
                </>
              ) : showChannelInfo ? (
                <>
                  <Text style={styles.channelName} numberOfLines={1}>
                    {channelName}
                  </Text>
                  <Text style={styles.dot}>·</Text>
                </>
              ) : null}
              <Text style={styles.timeAgo}>{timeAgo}</Text>
              {contentBadge ? (
                <>
                  <Text style={styles.dot}>·</Text>
                  <Text style={styles.contentBadge}>{contentBadge}</Text>
                </>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  )
}

// Custom comparison for React.memo - only re-render if video data actually changed
function arePropsEqual(prevProps: VideoCardProps, nextProps: VideoCardProps): boolean {
  // Quick reference check first
  if (prevProps.video === nextProps.video &&
      prevProps.onPress === nextProps.onPress &&
      prevProps.onChannelPress === nextProps.onChannelPress &&
      prevProps.showChannelInfo === nextProps.showChannelInfo) {
    return true
  }

  // Deep comparison of video data that affects rendering
  const prev = prevProps.video
  const next = nextProps.video

  return (
    prev.id === next.id &&
    prev.title === next.title &&
    prev.thumbnailUrl === next.thumbnailUrl &&
    prev.thumbnail === next.thumbnail &&
    prev.duration === next.duration &&
    prev.uploadedAt === next.uploadedAt &&
    prev.createdAt === next.createdAt &&
    prev.channelKey === next.channelKey &&
    prev.driveKey === next.driveKey &&
    prev.creatorName === next.creatorName &&
    prev.contentKind === next.contentKind &&
    prev.seasonNumber === next.seasonNumber &&
    prev.episodeNumber === next.episodeNumber &&
    prev.channel?.name === next.channel?.name &&
    prevProps.onPress === nextProps.onPress &&
    prevProps.showChannelInfo === nextProps.showChannelInfo &&
    prevProps.onChannelPress === nextProps.onChannelPress
  )
}

export const VideoCard = memo(VideoCardComponent, arePropsEqual)

const styles = StyleSheet.create({
  container: {
    width: '100%',
    marginBottom: 18,
    paddingHorizontal: 14,
  },
  surface: {
    overflow: 'hidden',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glass,
  },
  thumbnailFrame: {
    overflow: 'hidden',
    borderTopLeftRadius: 17,
    borderTopRightRadius: 17,
    backgroundColor: colors.bg,
  },
  pressed: {
    opacity: 0.78,
    transform: [{ scale: 0.99 }],
  },
  infoRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
  },
  avatarContainer: {
    marginRight: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: colors.onPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  textContainer: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '590' as any,
    lineHeight: 21,
    marginBottom: 5,
    letterSpacing: -0.18,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  channelName: {
    color: colors.textSecondary,
    fontSize: 12,
    maxWidth: 150,
  },
  channelNameLink: {
    color: colors.textSecondary,
    fontSize: 12,
    maxWidth: 150,
    fontWeight: '500',
  },
  dot: {
    color: colors.textMuted,
    fontSize: 12,
    marginHorizontal: 5,
  },
  timeAgo: {
    color: colors.textMuted,
    fontSize: 12,
  },
  contentBadge: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
})

export default VideoCard
