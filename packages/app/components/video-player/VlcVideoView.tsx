import { memo, RefObject, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutRectangle, Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { NitroVlcVideoView } from './NitroVlcVideoView'

let VLCPlayer: any = null
if (Platform.OS !== 'web') {
  VLCPlayer = require('react-native-vlc-media-player').VLCPlayer
}

// FORCE ENABLED: Nitro VLC is always active
const USE_NITRO_VLC = true

type VlcVideoViewProps = {
  style?: StyleProp<ViewStyle>
  playerRef: RefObject<any>
  videoUrl: string
  playbackSession: number
  currentVideoKey?: string
  isPlaying: boolean
  playbackRate: number
  vlcSeekPosition?: number
  networkCachingMs: number
  isInPipMode?: boolean
  pipWindowSize?: { width: number; height: number } | null
  videoAspectRatio?: number | null
  onLoad?: (data: any) => void
  onProgress?: (data: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onBuffering?: (data: any) => void
  onEnded?: () => void
  onError?: (error: any) => void
  onVideoStateChange?: (data: any) => void
  children?: ReactNode
}

type Size = { width: number; height: number }

const calculateVideoDimensions = (parentLayout?: Size, aspectRatio?: number | null): Size => {
  const ratio = aspectRatio && aspectRatio > 0 ? aspectRatio : 16 / 9
  const parent = parentLayout || { width: 16, height: 9 }

  const widthFromHeight = parent.height * ratio
  const heightFromWidth = parent.width / ratio

  if (heightFromWidth > parent.height) {
    return {
      width: Math.round(widthFromHeight),
      height: Math.round(parent.height),
    }
  }

  return {
    width: Math.round(parent.width),
    height: Math.round(heightFromWidth),
  }
}

export const VlcVideoView = memo(function VlcVideoView({
  style,
  playerRef,
  videoUrl,
  playbackSession,
  currentVideoKey,
  isPlaying,
  playbackRate,
  vlcSeekPosition,
  networkCachingMs,
  isInPipMode,
  pipWindowSize,
  videoAspectRatio,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  children,
}: VlcVideoViewProps) {
  const [layout, setLayout] = useState<LayoutRectangle | null>(null)
  const isAndroidPip = Boolean(isInPipMode && Platform.OS === 'android')
  const nitroPlayerRef = useRef<any>(null)
  const nitroPlayerAdapter = useMemo(
    () => ({
      play: () => nitroPlayerRef.current?.play?.(),
      pause: () => nitroPlayerRef.current?.pause?.(),
      stop: () => nitroPlayerRef.current?.stop?.(),
      seek: (position: number) => nitroPlayerRef.current?.seek?.(position),
      resume: (shouldPlay: boolean) => {
        if (shouldPlay) {
          nitroPlayerRef.current?.play?.()
        } else {
          nitroPlayerRef.current?.pause?.()
        }
      },
    }),
    []
  )

  const handleLayout = useCallback((event: { nativeEvent: { layout: LayoutRectangle } }) => {
    const nextLayout = event.nativeEvent.layout
    if (nextLayout.width < 2 || nextLayout.height < 2) return
    setLayout((prev) => {
      if (prev && prev.width === nextLayout.width && prev.height === nextLayout.height) {
        return prev
      }
      return nextLayout
    })
  }, [])

  const playerSize = useMemo(() => {
    if (isAndroidPip) {
      return null
    }

    if (layout?.width && layout?.height) {
      return calculateVideoDimensions({ width: layout.width, height: layout.height }, videoAspectRatio)
    }

    return null
  }, [isAndroidPip, layout, videoAspectRatio])

  const playerStyle = useMemo(
    () => (isAndroidPip
      ? StyleSheet.absoluteFill
      : (playerSize
        ? {
            width: playerSize.width,
            height: playerSize.height,
          }
        : StyleSheet.absoluteFill)),
    [isAndroidPip, playerSize]
  )

  useEffect(() => {
    if (!USE_NITRO_VLC) return
    if (!playerRef) return
    playerRef.current = nitroPlayerAdapter
    return () => {
      if (playerRef.current === nitroPlayerAdapter) {
        playerRef.current = null
      }
    }
  }, [playerRef, nitroPlayerAdapter])

  if (Platform.OS === 'web') {
    return null
  }

  if (!USE_NITRO_VLC && !VLCPlayer) {
    return null
  }

  return (
    <View style={[styles.container, isAndroidPip && styles.pipContainer, style]} onLayout={handleLayout}>
      {USE_NITRO_VLC ? (
        <NitroVlcVideoView
          key={`${playbackSession}:${currentVideoKey || ''}:${videoUrl}`}
          playerRef={nitroPlayerRef}
          source={{
            uri: videoUrl,
            initType: 2,
            initOptions: [
              `--network-caching=${networkCachingMs}`,
              `--file-caching=${networkCachingMs}`,
              `--live-caching=${networkCachingMs}`,
              `--disc-caching=${networkCachingMs}`,
              '--avcodec-hw=any',
              '--avcodec-threads=0',
            ],
          }}
          style={playerStyle}
          paused={!isPlaying}
          playInBackground={true}
          rate={playbackRate}
          seek={vlcSeekPosition}
          resizeMode="contain"
          autoAspectRatio={true}
          onLoad={onLoad}
          onProgress={onProgress}
          onPlaying={onPlaying}
          onPaused={onPaused}
          onBuffering={onBuffering}
          onEnded={onEnded}
          onError={onError}
          onVideoStateChange={onVideoStateChange}
        />
      ) : (
        <VLCPlayer
          key={`${playbackSession}:${currentVideoKey || ''}:${videoUrl}`}
          ref={playerRef}
          source={{
            uri: videoUrl,
            initType: 2,
            initOptions: [
              `--network-caching=${networkCachingMs}`,
              `--file-caching=${networkCachingMs}`,
              `--live-caching=${networkCachingMs}`,
              `--disc-caching=${networkCachingMs}`,
              '--avcodec-hw=any',
              '--avcodec-threads=0',
            ],
          }}
          style={playerStyle}
          paused={!isPlaying}
          playInBackground={true}
          rate={playbackRate}
          seek={vlcSeekPosition !== undefined ? vlcSeekPosition : -1}
          resizeMode="contain"
          autoAspectRatio={true}
          onLoad={onLoad}
          onProgress={onProgress}
          onPlaying={onPlaying}
          onPaused={onPaused}
          onBuffering={onBuffering}
          onEnd={onEnded}
          onError={onError}
          onVideoStateChange={onVideoStateChange}
          pipContainerSize={
            isAndroidPip && layout?.width && layout?.height
              ? { width: layout.width, height: layout.height }
              : null
          }
        />
      )}
      {children}
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  pipContainer: {
    alignItems: 'stretch',
  },
})
