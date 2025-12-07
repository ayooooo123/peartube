/**
 * VideoCard - YouTube-style video card for feed display
 * Shows: thumbnail (16:9), duration badge, channel avatar, title, channel name, time ago
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { ThumbnailImage } from './ThumbnailImage'

export interface VideoData {
  id: string
  title: string
  path: string
  size: number
  uploadedAt: number
  channelKey: string
  thumbnailUrl?: string | null
  duration?: number
  description?: string
  mimeType?: string
  channel?: {
    name: string
    avatarUrl?: string
  }
}

interface VideoCardProps {
  video: VideoData
  onPress: () => void
  showChannelInfo?: boolean
}

// Format time ago - handles invalid timestamps gracefully
function formatTimeAgo(timestamp: number | undefined | null): string {
  // Handle invalid timestamps
  if (!timestamp || isNaN(timestamp) || timestamp <= 0) {
    return 'recently'
  }

  const seconds = Math.floor((Date.now() - timestamp) / 1000)

  // Handle future dates or invalid calculations
  if (isNaN(seconds) || seconds < 0) {
    return 'recently'
  }

  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

// Get channel initial for avatar placeholder
function getChannelInitial(name?: string, key?: string): string {
  if (name) return name.charAt(0).toUpperCase()
  if (key) return key.charAt(0).toUpperCase()
  return 'P'
}

export function VideoCard({ video, onPress, showChannelInfo = true }: VideoCardProps) {
  const channelName = video.channel?.name || `Channel ${video.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = getChannelInitial(video.channel?.name, video.channelKey)
  const timeAgo = formatTimeAgo(video.uploadedAt)

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        pressed && styles.pressed
      ]}
    >
      {/* Thumbnail */}
      <ThumbnailImage
        thumbnailUrl={video.thumbnailUrl}
        duration={video.duration}
        channelInitial={channelInitial}
      />

      {/* Video info row */}
      <View style={styles.infoRow}>
        {/* Channel avatar */}
        {showChannelInfo && (
          <View style={styles.avatarContainer}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{channelInitial}</Text>
            </View>
          </View>
        )}

        {/* Title and metadata */}
        <View style={styles.textContainer}>
          <Text style={styles.title} numberOfLines={2}>
            {video.title}
          </Text>
          <View style={styles.metaRow}>
            {showChannelInfo && (
              <>
                <Text style={styles.channelName} numberOfLines={1}>
                  {channelName}
                </Text>
                <Text style={styles.dot}>·</Text>
              </>
            )}
            <Text style={styles.timeAgo}>{timeAgo}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  )
}

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
