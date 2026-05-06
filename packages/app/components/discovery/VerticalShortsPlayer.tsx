import { memo, RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ImageBackground, Pressable, StyleSheet, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import type { VideoData } from '@peartube/core'
import { colors } from '@/lib/colors'
import { PearInlineVideoView } from '@/components/video-player/PearInlineVideoView'

type VerticalShortsPlayerProps = {
  testID?: string
  playerRef: RefObject<any>
  videoUrl: string | null
  video: VideoData
  playbackSession: number
  isActive: boolean
  isLoading?: boolean
  thumbnailUrl?: string | null
  onReplay?: () => void
}

function getShortsVideoKey(video: VideoData, fallbackUrl?: string | null) {
  return `${video.channelKey || 'channel'}:${video.id || video.path || fallbackUrl || 'video'}`
}

export const VerticalShortsPlayer = memo(function VerticalShortsPlayer({
  testID,
  playerRef,
  videoUrl,
  video,
  playbackSession,
  isActive,
  isLoading = false,
  thumbnailUrl,
  onReplay,
}: VerticalShortsPlayerProps) {
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)
  const [hasPlaybackError, setHasPlaybackError] = useState(false)
  const videoKey = getShortsVideoKey(video, videoUrl)

  useEffect(() => {
    setHasPlaybackError(false)
    setVideoSize(null)
  }, [videoKey])

  const isLandscape = useMemo(() => {
    if (!videoSize) return false
    return videoSize.width > videoSize.height * 1.12
  }, [videoSize])

  const handleVideoStateChange = useCallback((event: any) => {
    if (event?.type !== 'video-size') return
    const width = Number(event.mVideoWidth || event.width)
    const height = Number(event.mVideoHeight || event.height)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      setVideoSize({ width, height })
    }
  }, [])

  const handleError = useCallback((error: any) => {
    setHasPlaybackError(true)
    console.log('[VerticalShortsPlayer] Playback failed:', error?.message || error)
  }, [])

  const showPlayer = Boolean(videoUrl && isActive && !hasPlaybackError)
  const showPoster = !showPlayer && Boolean(thumbnailUrl)

  return (
    <View
      testID={testID}
      style={styles.container}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Vertical video player for ${video.title || 'video'}`}
    >
      {showPoster ? (
        <ImageBackground
          source={{ uri: thumbnailUrl || undefined }}
          style={StyleSheet.absoluteFill}
          imageStyle={styles.posterImage}
        />
      ) : null}

      {showPlayer ? (
        <PearInlineVideoView
          playerRef={playerRef}
          videoUrl={videoUrl as string}
          playbackSession={playbackSession}
          currentVideoKey={videoKey}
          isPlaying={isActive}
          playbackRate={1}
          videoTitle={video.title}
          channelName={video.channel?.name || 'Channel'}
          thumbnailUrl={thumbnailUrl || undefined}
          onVideoStateChange={handleVideoStateChange}
          onError={handleError}
          style={[
            styles.videoSurface,
            isLandscape ? styles.landscapeVideoSurface : styles.verticalVideoSurface,
          ]}
        />
      ) : null}

      {showPlayer && isLandscape ? (
        <View pointerEvents="none" style={styles.landscapeMatte} />
      ) : null}

      {isLoading ? (
        <View style={styles.centerOverlay}>
          <ActivityIndicator color="#fff" size="large" />
        </View>
      ) : null}

      {!showPlayer && !isLoading ? (
        <Pressable onPress={onReplay} style={styles.playButtonShell} accessibilityLabel="Play vertical video">
          <Feather name={hasPlaybackError ? 'rotate-cw' : 'play'} color="#fff" size={42} />
        </Pressable>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  posterImage: {
    opacity: 0.44,
    resizeMode: 'cover',
  },
  videoSurface: {
    backgroundColor: '#000',
  },
  verticalVideoSurface: {
    ...StyleSheet.absoluteFillObject,
  },
  landscapeVideoSurface: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '25%',
    height: '50%',
  },
  landscapeMatte: {
    ...StyleSheet.absoluteFillObject,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  playButtonShell: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 86,
    height: 86,
    marginLeft: -43,
    marginTop: -43,
    borderRadius: 43,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
})
