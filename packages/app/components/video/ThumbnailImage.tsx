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
import { colors } from '@/lib/colors'

interface ThumbnailImageProps {
  thumbnailUrl?: string | null
  duration?: number // in seconds
  channelInitial?: string
  style?: any
}

const MAX_IMAGE_RETRIES = 2

// TEMPORARY on-device diagnostic. Renders a tiny badge on each thumbnail showing
// which URI scheme the backend handed us (data/http/file/none) and whether the
// <Image> actually loaded it (OK) or failed (ERR). This is the fastest way to
// tell, from a screenshot, why thumbnails are blank on Android. Remove once the
// root cause is confirmed.
const THUMBNAIL_DEBUG_BADGE = true

function uriScheme(url?: string | null): string {
  if (!url) return 'none'
  if (url.startsWith('data:')) return 'data'
  if (url.startsWith('file:')) return 'file'
  if (url.startsWith('http:')) return 'http'
  if (url.startsWith('https:')) return 'https'
  return 'other'
}

function ThumbnailImageComponent({
  thumbnailUrl,
  duration,
  channelInitial = 'P',
  style
}: ThumbnailImageProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [retryAttempt, setRetryAttempt] = useState(0)

  // Reset error state during render when the URL changes so a stale
  // error/loading frame never paints for the new thumbnail
  const [prevThumbnailUrl, setPrevThumbnailUrl] = useState(thumbnailUrl)
  if (prevThumbnailUrl !== thumbnailUrl) {
    setPrevThumbnailUrl(thumbnailUrl)
    setImageError(false)
    setImageLoading(Boolean(thumbnailUrl))
    setImageLoaded(false)
    setErrorMsg('')
    setRetryAttempt(0)
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
      // Data URLs are self-contained — appending a cache-busting query string
      // would corrupt the trailing base64, so never rewrite them.
      if (retryAttempt === 0 || thumbnailUrl.startsWith('data:')) return { uri: thumbnailUrl }
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

  // Memoize callbacks for Image component
  const handleError = useCallback((e: any) => {
    const reason = e?.nativeEvent?.error
    if (reason) setErrorMsg(String(reason))
    handleRecoverableError()
  }, [handleRecoverableError])
  const handleLoadStart = useCallback(() => setImageLoading(true), [])
  const handleLoadEnd = useCallback(() => setImageLoading(false), [])
  const handleLoad = useCallback(() => setImageLoaded(true), [])

  const debugBadge = useMemo(() => {
    if (!THUMBNAIL_DEBUG_BADGE) return null
    const scheme = uriScheme(thumbnailUrl)
    const state = imageError ? 'ERR' : imageLoaded ? 'OK' : thumbnailUrl ? '...' : '—'
    const len = thumbnailUrl ? thumbnailUrl.length : 0
    const reason = errorMsg ? ` ${errorMsg.slice(0, 60)}` : ''
    return `${scheme}/${state}${len ? ` ${len}` : ''}${reason}`
  }, [thumbnailUrl, imageError, imageLoaded, errorMsg])

  return (
    <View style={containerStyle}>
      {/* Always show placeholder as background, image overlays on top when loaded */}
      <View style={styles.placeholder}>
        <View style={styles.playIconContainer}>
          <Ionicons name="play" color={colors.primary} size={48} />
        </View>
      </View>

      {/* Actual thumbnail image - overlays placeholder when loaded */}
      {imageSource && !imageError && (
        <Image
          source={imageSource}
          style={styles.image}
          resizeMode="cover"
          onError={handleError}
          onLoad={handleLoad}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
        />
      )}

      {/* TEMPORARY diagnostic badge (top-left) */}
      {debugBadge && (
        <View style={styles.debugBadge}>
          <Text style={styles.debugBadgeText} numberOfLines={3}>{debugBadge}</Text>
        </View>
      )}

      {/* Loading indicator */}
      {imageLoading && thumbnailUrl && !imageError && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={colors.primary} size="small" />
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
    backgroundColor: colors.bgElevated,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgElevated,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgElevated,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primaryLight,
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
  debugBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    backgroundColor: 'rgba(255,0,0,0.85)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  debugBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  durationText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
})

export default ThumbnailImage
