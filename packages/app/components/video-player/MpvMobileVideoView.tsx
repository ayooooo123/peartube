import { memo, ReactNode, RefObject } from 'react'
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { MpvVideoView } from './MpvVideoView'

type MpvMobileVideoViewProps = {
  style?: StyleProp<ViewStyle>
  playerRef: RefObject<any>
  videoUrl: string
  playbackSession: number
  currentVideoKey?: string
  isPlaying: boolean
  playbackRate: number
  seekPosition?: number
  isInPipMode?: boolean
  pipWindowSize?: { width: number; height: number } | null
  pipEnabled?: boolean
  videoAspectRatio?: number | null
  onLoad?: (data: any) => void
  onProgress?: (data: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onBuffering?: (data: any) => void
  onEnded?: () => void
  onError?: (error: any) => void
  onVideoStateChange?: (data: any) => void
  onPictureInPictureChanged?: (event: { isInPictureInPicture: boolean; width: number; height: number }) => void
  children?: ReactNode
}

export const MpvMobileVideoView = memo(function MpvMobileVideoView({
  style,
  playerRef,
  videoUrl,
  playbackSession,
  currentVideoKey,
  isPlaying,
  playbackRate,
  seekPosition,
  isInPipMode,
  pipWindowSize,
  pipEnabled,
  videoAspectRatio,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onBuffering,
  onEnded,
  onError,
  onVideoStateChange,
  onPictureInPictureChanged,
  children,
}: MpvMobileVideoViewProps) {
  if (Platform.OS === 'web') {
    return null
  }

  return (
    <View style={[styles.container, style]}>
      <MpvVideoView
        key={`${playbackSession}:${currentVideoKey || ''}:${videoUrl}`}
        playerRef={playerRef}
        source={{
          uri: videoUrl,
        }}
        style={StyleSheet.absoluteFill}
        paused={!isPlaying}
        rate={playbackRate}
        seek={seekPosition}
        resizeMode="contain"
        pipEnabled={pipEnabled}
        onLoad={onLoad}
        onProgress={onProgress}
        onPlaying={onPlaying}
        onPaused={onPaused}
        onBuffering={onBuffering}
        onEnded={onEnded}
        onError={onError}
        onVideoStateChange={onVideoStateChange}
        onPictureInPictureChanged={onPictureInPictureChanged}
      />
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
