/**
 * ThumbnailImage - YouTube-style video thumbnail with duration badge
 * Shows gradient placeholder with play icon when no thumbnail available
 *
 * Memoized for optimal FlatList performance.
 */
import { useState, useEffect, useCallback, useMemo, memo } from 'react'
import { View, Image, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { formatDuration } from '@/lib/formatters'

interface ThumbnailImageProps {
  thumbnailUrl?: string | null
  duration?: number // in seconds
  channelInitial?: string
  style?: any
}

const MAX_IMAGE_RETRIES = 2

function ThumbnailImageComponent({
  thumbnailUrl,
  duration,
  channelInitial = 'P',
  style
}: ThumbnailImageProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  const [retryAttempt, setRetryAttempt] = useState(0)

  // Memoize duration text
  const durationText = useMemo(
    () => duration ? formatDuration(duration) : null,
    [duration]
  )

  // Memoize container style
  const containerStyle = useMemo(
    () => [styles.container, style],
    [style]
  )

  // Memoize image source to prevent object recreation
  const imageSource = useMemo(
    () => {
      if (!thumbnailUrl) return null
      if (retryAttempt === 0) return { uri: thumbnailUrl }
      const separator = thumbnailUrl.includes('?') ? '&' : '?'
      return { uri: `${thumbnailUrl}${separator}attempt=${retryAttempt}` }
    },
    [thumbnailUrl, retryAttempt]
  )

  const handleRecoverableError = useCallback(() => {
    if (retryAttempt < MAX_IMAGE_RETRIES) {
      setRetryAttempt((prev) => prev + 1)
      setImageError(false)
      setImageLoading(true)
      return
    }

    setImageError(true)
    setImageLoading(false)
  }, [retryAttempt])

  // Timeout for loading - give up after 8 seconds
  useEffect(() => {
    if (thumbnailUrl && imageLoading && !imageError) {
      const timeout = setTimeout(() => {
        handleRecoverableError()
      }, 8000)
      return () => clearTimeout(timeout)
    }
  }, [thumbnailUrl, imageLoading, imageError, handleRecoverableError])

  // Reset error state when URL changes
  useEffect(() => {
    setImageError(false)
    setImageLoading(Boolean(thumbnailUrl))
    setRetryAttempt(0)
  }, [thumbnailUrl])

  // Memoize callbacks for Image component
  const handleError = useCallback(() => {
    handleRecoverableError()
  }, [handleRecoverableError])
  const handleLoadStart = useCallback(() => setImageLoading(true), [])
  const handleLoadEnd = useCallback(() => setImageLoading(false), [])

  return (
    <View style={containerStyle}>
      {/* Always show placeholder as background, image overlays on top when loaded */}
      <View style={styles.placeholder}>
        <View style={styles.playIconContainer}>
          <Ionicons name="play" color="#9147ff" size={48} />
        </View>
      </View>

      {/* Actual thumbnail image - overlays placeholder when loaded */}
      {imageSource && !imageError && (
        <Image
          source={imageSource}
          style={styles.image}
          resizeMode="contain"
          onError={handleError}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
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

// Custom comparison for memo - only re-render when props that affect rendering change
function arePropsEqual(
  prevProps: ThumbnailImageProps,
  nextProps: ThumbnailImageProps
): boolean {
  return (
    prevProps.thumbnailUrl === nextProps.thumbnailUrl &&
    prevProps.duration === nextProps.duration &&
    prevProps.channelInitial === nextProps.channelInitial &&
    prevProps.style === nextProps.style
  )
}

export const ThumbnailImage = memo(ThumbnailImageComponent, arePropsEqual)

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
    backgroundColor: '#0e0e10',
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
