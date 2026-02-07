import { memo, RefObject, ReactNode } from 'react'
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
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
  if (Platform.OS === 'web') {
    return null
  }

  if (!USE_NITRO_VLC && !VLCPlayer) {
    return null
  }

  return (
    <View style={[styles.container, style]}>
      {USE_NITRO_VLC ? (
        <NitroVlcVideoView
          key={`${playbackSession}:${currentVideoKey || ''}:${videoUrl}`}
          playerRef={playerRef}
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
          style={StyleSheet.absoluteFill}
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
          style={StyleSheet.absoluteFill}
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
  },
})
