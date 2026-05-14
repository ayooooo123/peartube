import { memo, RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ImageBackground, LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import type { VideoData } from '@peartube/core'
import { colors } from '@/lib/colors'
import { PearInlineVideoView } from '@/components/video-player/PearInlineVideoView'
import type { PlayerPort } from '@/lib/video-player'

type VerticalShortsPlayerProps = {
  testID?: string
  playerRef: RefObject<PlayerPort | null>
  videoUrl: string | null
  video: VideoData
  playbackSession: number
  isActive: boolean
  isLoading?: boolean
  thumbnailUrl?: string | null
  controlsVisible?: boolean
  progressBottomOffset?: number
  onControlsVisibleChange?: (visible: boolean) => void
  onReplay?: () => void
}

function getShortsVideoKey(video: VideoData, fallbackUrl?: string | null) {
  return `${video.channelKey || 'channel'}:${video.id || video.path || fallbackUrl || 'video'}`
}

function clampProgress(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
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
  controlsVisible = true,
  progressBottomOffset = 150,
  onControlsVisibleChange,
  onReplay,
}: VerticalShortsPlayerProps) {
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)
  const [hasPlaybackError, setHasPlaybackError] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [seekPosition, setSeekPosition] = useState<number | undefined>(undefined)
  const [pendingSeekMs, setPendingSeekMs] = useState<number | undefined>(undefined)
  const [progressBarWidth, setProgressBarWidth] = useState(0)
  const [playbackProgress, setPlaybackProgress] = useState({ currentTime: 0, duration: 0 })
  const videoKey = getShortsVideoKey(video, videoUrl)

  useEffect(() => {
    setHasPlaybackError(false)
    setVideoSize(null)
    setIsPaused(false)
    setSeekPosition(undefined)
    setPendingSeekMs(undefined)
    setPlaybackProgress({ currentTime: 0, duration: 0 })
  }, [videoKey])

  useEffect(() => {
    return () => {
      const player = playerRef.current
      if (!player) return

      try {
        void player.exitPictureInPicture?.()
      } catch {
        // Best effort teardown; individual native calls may already be disposed.
      }

      try {
        void player.stop?.()
      } catch {
        // Best effort teardown; individual native calls may already be disposed.
      }

      try {
        void player.destroy?.()
      } catch {
        // Best effort teardown; individual native calls may already be disposed.
      }
    }
  }, [playerRef])

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

  const handleProgress = useCallback((event: any) => {
    const currentTime = Math.max(0, Number(event?.currentTime || 0))
    const duration = Math.max(0, Number(event?.duration || 0))
    setPlaybackProgress({ currentTime, duration })
    if (duration > 0 && pendingSeekMs !== undefined && Math.abs(currentTime - pendingSeekMs) < 900) {
      setSeekPosition(undefined)
      setPendingSeekMs(undefined)
    }
  }, [pendingSeekMs])

  const handleError = useCallback((error: any) => {
    setHasPlaybackError(true)
    console.log('[VerticalShortsPlayer] Playback failed:', error?.message || error)
  }, [])

  const toggleControlsVisibility = useCallback(() => {
    onControlsVisibleChange?.(!controlsVisible)
  }, [controlsVisible, onControlsVisibleChange])

  const pauseShorts = useCallback(() => {
    setIsPaused(true)
    void playerRef.current?.pause?.()
  }, [playerRef])

  const playShorts = useCallback(() => {
    setIsPaused(false)
    void playerRef.current?.play?.()
  }, [playerRef])

  const restartShorts = useCallback(() => {
    setIsPaused(false)
    setSeekPosition(0)
    setPendingSeekMs(0)
    setPlaybackProgress((prev) => ({ ...prev, currentTime: 0 }))
    void playerRef.current?.seek?.(0)
    void playerRef.current?.play?.()
  }, [playerRef])

  const handleProgressBarLayout = useCallback((event: LayoutChangeEvent) => {
    setProgressBarWidth(event.nativeEvent.layout.width)
  }, [])

  const handleProgressBarPress = useCallback((event: any) => {
    if (progressBarWidth <= 0 || playbackProgress.duration <= 0) return
    const locationX = Number(event?.nativeEvent?.locationX || 0)
    const progress = clampProgress(locationX / progressBarWidth)
    const nextTime = progress * playbackProgress.duration
    setSeekPosition(progress)
    setPendingSeekMs(nextTime)
    setPlaybackProgress((prev) => ({ ...prev, currentTime: nextTime }))
    void playerRef.current?.seek?.(nextTime / 1000)
  }, [playbackProgress.duration, playerRef, progressBarWidth])

  const showPlayer = Boolean(videoUrl && isActive && !hasPlaybackError)
  const showPoster = !showPlayer && Boolean(thumbnailUrl)
  const effectiveProgress = playbackProgress.duration > 0
    ? clampProgress(playbackProgress.currentTime / playbackProgress.duration)
    : 0

  return (
    <Pressable
      testID={testID}
      style={styles.container}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Vertical video player for ${video.title || 'video'}`}
      onPress={toggleControlsVisibility}
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
          isPlaying={isActive && !isPaused}
          autoEnterPipOnLeave={false}
          playbackRate={1}
          seekPosition={seekPosition}
          videoTitle={video.title}
          channelName={video.channel?.name || 'Channel'}
          thumbnailUrl={thumbnailUrl || undefined}
          onVideoStateChange={handleVideoStateChange}
          onProgress={handleProgress}
          onPlaying={() => setIsPaused(false)}
          onEnded={restartShorts}
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

      {showPlayer && controlsVisible ? (
        <View style={styles.centerPlaybackControls} pointerEvents="box-none">
          <Pressable
            onPress={isPaused ? playShorts : pauseShorts}
            style={styles.centerControlButton}
            accessibilityLabel={isPaused ? 'Play Shorts video' : 'Pause Shorts video'}
          >
            <Feather name={isPaused ? 'play' : 'pause'} color="#fff" size={30} />
          </Pressable>
        </View>
      ) : null}

      {(showPlayer || isActive) && controlsVisible ? (
        <View style={[styles.progressDock, { bottom: progressBottomOffset }]} pointerEvents="box-none">
          <Pressable
            onPress={handleProgressBarPress}
            onLayout={handleProgressBarLayout}
            style={styles.progressTrack}
            accessibilityRole="adjustable"
            accessibilityLabel="Shorts progress bar"
          >
            <View style={[styles.progressRail]}>
              <View style={[styles.progressFill, { width: `${effectiveProgress * 100}%` }]} />
            </View>
          </Pressable>
        </View>
      ) : null}
    </Pressable>
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
  progressDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingBottom: 0,
  },
  centerPlaybackControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '34%',
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  centerControlButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.34)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  progressTrack: {
    height: 14,
    justifyContent: 'center',
  },
  progressRail: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.34)',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.primary,
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
