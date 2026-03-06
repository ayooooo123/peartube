/**
 * VideoCard - YouTube-style video card for feed display
 * Shows: thumbnail (16:9), duration badge, channel avatar, title, channel name, time ago
 *
 * Memoized for optimal FlatList performance - only re-renders when video data changes.
 */
import { memo, useMemo, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated'
import { ThumbnailImage } from './ThumbnailImage'
import { formatTimeAgo } from '@/lib/formatters'

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
  score?: number  // Search relevance score
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
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

// Get channel initial for avatar placeholder
function getChannelInitial(name?: string, key?: string): string {
  if (name) return name.charAt(0).toUpperCase()
  if (key) return key.charAt(0).toUpperCase()
  return 'P'
}

function VideoCardComponent({ video, onPress, onChannelPress, showChannelInfo = true }: VideoCardProps) {
  const channelKey = video.channelKey || video.driveKey

  // Memoize derived values to prevent recalculation on every render
  const channelName = useMemo(
    () => video.channel?.name || `Channel ${channelKey?.slice(0, 8) || 'Unknown'}`,
    [video.channel?.name, channelKey]
  )

  const channelInitial = useMemo(
    () => getChannelInitial(video.channel?.name, channelKey),
    [video.channel?.name, channelKey]
  )

  const timeAgo = useMemo(
    () => formatTimeAgo(video.uploadedAt || video.createdAt),
    [video.uploadedAt, video.createdAt]
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
    <Pressable onPress={handlePress} style={getPressedStyle}>
      {/* Thumbnail */}
      <ThumbnailImage
        thumbnailUrl={video.thumbnailUrl || video.thumbnail}
        duration={video.duration}
        channelInitial={channelInitial}
      />

      {/* Video info row */}
      <View style={styles.infoRow}>
        {/* Channel avatar */}
        {showChannelInfo && onChannelPress ? (
          <AnimatedPressable
            onPress={onChannelPress}
            onPressIn={channelPressIn}
            onPressOut={channelPressOut}
            style={[styles.avatarContainer, channelAnimStyle]}
            hitSlop={4}
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

        {/* Title and metadata */}
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
                  hitSlop={4}
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
    prev.channel?.name === next.channel?.name &&
    prevProps.showChannelInfo === nextProps.showChannelInfo &&
    prevProps.onChannelPress === nextProps.onChannelPress
  )
}

export const VideoCard = memo(VideoCardComponent, arePropsEqual)

const styles = StyleSheet.create({
  container: {
    width: '100%',
    marginBottom: 16,
  },
  pressed: {
    opacity: 0.7,
  },
  infoRow: {
    flexDirection: 'row',
    marginTop: 8,
    paddingHorizontal: 12,
  },
  avatarContainer: {
    marginRight: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#9147ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    color: '#efeff1',
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  channelName: {
    color: '#adadb8',
    fontSize: 12,
    maxWidth: 150,
  },
  channelNameLink: {
    color: '#adadb8',
    fontSize: 12,
    maxWidth: 150,
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
  },
  dot: {
    color: '#adadb8',
    fontSize: 12,
    marginHorizontal: 4,
  },
  timeAgo: {
    color: '#adadb8',
    fontSize: 12,
  },
})

export default VideoCard
