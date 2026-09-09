/**
 * ThumbnailImage - YouTube-style video thumbnail with duration badge
 * Shows placeholder with play icon when no thumbnail available
 *
 * Memoized for optimal FlatList performance.
 */
import { useState, useEffect, useCallback, useMemo, memo } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, Image } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { formatDuration } from '@/lib/formatters'
import { colors, radius, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'

interface ThumbnailImageProps {
  thumbnailUrl?: string | null
  duration?: number // in seconds
  channelInitial?: string
  style?: any
  onError?: () => void
}

const MAX_IMAGE_RETRIES = 2

function ThumbnailImageComponent({
  thumbnailUrl,
  duration,
  channelInitial = 'P',
  style,
  onError,
}: ThumbnailImageProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [retryAttempt, setRetryAttempt] = useState(0)

  // Reset error state during render when the URL changes so a stale
  // error/loading frame never paints for the new thumbnail
  const [prevThumbnailUrl, setPrevThumbnailUrl] = useState(thumbnailUrl)
  if (prevThumbnailUrl !== thumbnailUrl) {
    setPrevThumbnailUrl(thumbnailUrl)
    setImageError(false)
    setImageLoading(true)
    setImageLoaded(false)
  }

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
      return { uri: thumbnailUrl }
    },
    [thumbnailUrl, retryAttempt]
  )

  const handleRecoverableError = useCallback(() => {
    if (retryAttempt < MAX_IMAGE_RETRIES) {
      setRetryAttempt(prev => prev + 1)
      setImageError(false)
      setImageLoading(true)
    } else {
      setImageError(true)
      if (onError) onError()
    }
  }, [onError, retryAttempt])

  // Timeout for loading - give up after 8 seconds
  useEffect(() => {
    if (!imageLoading || imageError || imageLoaded || !thumbnailUrl) return
    const timeout = setTimeout(() => {
      handleRecoverableError()
    }, 8000)
    return () => clearTimeout(timeout)
  }, [thumbnailUrl, imageLoading, imageError, handleRecoverableError])

  // Memoize callbacks for Image component
  const handleError = useCallback(() => {
    handleRecoverableError()
  }, [handleRecoverableError])
  const handleLoadStart = useCallback(() => setImageLoading(true), [])
  const handleLoadEnd = useCallback(() => setImageLoading(false), [])
  const handleLoad = useCallback(() => setImageLoaded(true), [])

  return (
    <View style={containerStyle}>
      {/* Placeholder when no image or error */}
      {!imageLoaded && !imageError ? (
        <View style={styles.placeholder}>
          <View style={styles.playIconContainer}>
            <Ionicons name="play" size={40} color={colors.onPrimary} />
          </View>
        </View>
      ) : null}

      {/* Loading spinner */}
      {imageLoading && !imageError ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : null}

      {/* Actual image */}
      {imageSource ? (
        <Image
          source={imageSource}
          style={styles.image}
          resizeMode="cover"
          onError={handleError}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onLoad={handleLoad}
        />
      ) : null}

      {/* Duration badge */}
      {durationText ? (
        <View style={styles.durationBadge}>
          <Text style={styles.durationText}>{durationText}</Text>
        </View>
      ) : null}
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
    prevProps.style === nextProps.style &&
    prevProps.onError === nextProps.onError
  )
}

export const ThumbnailImage = memo(ThumbnailImageComponent, arePropsEqual)

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    overflow: 'hidden',
    position: 'relative',
  },
  image: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 0,
  },
  playIconContainer: {
    width: 80,
    height: 80,
    borderRadius: radius.card,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    backgroundColor: colors.overlayButton,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: radius.card,
    zIndex: 4,
  },
  durationText: {
    ...fonts.meta.xs,
    color: colors.text,
  },
})

export default ThumbnailImage
