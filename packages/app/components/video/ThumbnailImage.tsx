/**
 * ThumbnailImage - YouTube-style video thumbnail with duration badge
 * Shows gradient placeholder with play icon when no thumbnail available
 */
import { useState } from 'react'
import { View, Image, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Play } from 'lucide-react-native'

interface ThumbnailImageProps {
  thumbnailUrl?: string | null
  duration?: number // in seconds
  channelInitial?: string
  style?: any
}

// Format duration as mm:ss or h:mm:ss
function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return ''
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function ThumbnailImage({
  thumbnailUrl,
  duration,
  channelInitial = 'P',
  style
}: ThumbnailImageProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  const durationText = duration ? formatDuration(duration) : null

  return (
    <View style={[styles.container, style]}>
      {/* Always show placeholder as background, image overlays on top when loaded */}
      <View style={styles.placeholder}>
        <View style={styles.playIconContainer}>
          <Play color="#9147ff" size={48} fill="#9147ff" />
        </View>
      </View>

      {/* Actual thumbnail image - overlays placeholder when loaded */}
      {thumbnailUrl && !imageError && (
        <Image
          source={{ uri: thumbnailUrl }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImageError(true)}
          onLoadStart={() => setImageLoading(true)}
          onLoadEnd={() => setImageLoading(false)}
        />
      )}

      {/* Loading indicator */}
      {imageLoading && thumbnailUrl && !imageError && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#9147ff" size="small" />
        </View>
      )}

      {/* Duration badge - bottom right */}
      {durationText && (
        <View style={styles.durationBadge}>
          <Text style={styles.durationText}>{durationText}</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#1f1f23',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1f1f23',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1f1f23',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(145, 71, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  durationText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
})

export default ThumbnailImage
