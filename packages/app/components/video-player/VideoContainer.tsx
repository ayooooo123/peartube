/**
 * VideoContainer - Platform-specific video player switching
 *
 * Renders VLCPlayer on iOS/Android and MpvPlayer on Pear Desktop.
 * Also handles the casting placeholder when casting is active.
 */

import { memo, forwardRef, RefObject } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { usePlatform } from '@/lib/PlatformProvider'
import { colors } from '@/lib/colors'
import { MpvPlayer, MpvPlayerRef } from '../MpvPlayer'
import { styles } from './styles'

// VLC player for iOS/Android (conditionally loaded)
let VLCPlayer: any = null
if (Platform.OS !== 'web') {
  VLCPlayer = require('react-native-vlc-media-player').VLCPlayer
}

export interface VideoContainerProps {
  // Video state
  videoUrl: string | null
  currentVideo: {
    title: string
    channelKey?: string
    id?: string
    path?: string
    thumbnailUrl?: string
  } | null
  playbackSession: number

  // Player ref (typed as any since it could be VLC or MPV)
  playerRef: RefObject<any>

  // Playback control
  isPlaying: boolean
  playbackRate: number
  vlcSeekPosition?: number

  // Casting
  isCasting: boolean
  castDeviceName?: string

  // PiP (Android)
  isInPipMode?: boolean
  pipWindowSize?: { width: number; height: number } | null

  // Dimensions for Android non-PiP mode
  screenWidth?: number
  videoHeight?: number

  // VLC Callbacks (iOS/Android)
  onLoad?: (data: any) => void
  onProgress?: (data: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onBuffering?: (data: any) => void
  onEnded?: () => void
  onError?: (error: any) => void
  onVideoStateChange?: (data: any) => void

  // Style override
  style?: any
}

export const VideoContainer = memo(
  forwardRef<any, VideoContainerProps>(function VideoContainer(
    {
      videoUrl,
      currentVideo,
      playbackSession,
      playerRef,
      isPlaying,
      playbackRate,
      vlcSeekPosition,
      isCasting,
      castDeviceName,
      isInPipMode,
      pipWindowSize,
      screenWidth,
      videoHeight,
      onLoad,
      onProgress,
      onPlaying,
      onPaused,
      onBuffering,
      onEnded,
      onError,
      onVideoStateChange,
      style,
    },
    ref
  ) {
    const { isPear } = usePlatform()

    // Casting placeholder
    if (isCasting) {
      return (
        <View style={[styles.castPlaceholder, style]}>
          <Feather name="cast" size={40} color={colors.primary} />
          <Text style={styles.castPlaceholderTitle}>
            Casting to {castDeviceName || 'device'}
          </Text>
          <Text style={styles.castPlaceholderSubtitle} numberOfLines={1}>
            {currentVideo?.title}
          </Text>
        </View>
      )
    }

    // No video URL - show placeholder
    if (!videoUrl) {
      return (
        <View style={[styles.videoPlaceholder, style]}>
          <Text style={styles.placeholderText}>
            {currentVideo?.title?.charAt(0).toUpperCase() || '?'}
          </Text>
        </View>
      )
    }

    // VLC Player for iOS/Android
    if (Platform.OS !== 'web' && VLCPlayer) {
      // Calculate style based on PiP state
      const vlcStyle =
        isInPipMode && Platform.OS === 'android' && pipWindowSize
          ? {
              width: pipWindowSize.width,
              height: pipWindowSize.height,
              position: 'absolute' as const,
              top: 0,
              left: 0,
            }
          : Platform.OS === 'android' && screenWidth && videoHeight
          ? {
              width: screenWidth,
              height: videoHeight,
              position: 'absolute' as const,
              top: 0,
              left: 0,
            }
          : StyleSheet.absoluteFill

      return (
        <VLCPlayer
          key={`${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
          ref={playerRef}
          source={{
            uri: videoUrl,
            initType: 2,
            initOptions: [
              // No caching - blob server is localhost, start immediately
              '--network-caching=0',
              '--file-caching=0',
              '--live-caching=0',
              '--disc-caching=0',
              '--avcodec-hw=any',
              '--avcodec-threads=0',
            ],
          }}
          style={vlcStyle}
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
            isInPipMode && Platform.OS === 'android' && pipWindowSize
              ? pipWindowSize
              : null
          }
        />
      )
    }

    // MPV Player for Pear Desktop
    if (Platform.OS === 'web' && isPear) {
      return (
        <MpvPlayer
          key={`mpv:${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
          ref={playerRef as RefObject<MpvPlayerRef>}
          url={videoUrl}
          autoPlay
          onCanPlay={onPlaying}
          onPaused={onPaused}
          onPlaying={onPlaying}
          onEnded={onEnded}
          onError={(err) => onError?.({ nativeEvent: { error: err } })}
          onProgress={(data) =>
            onProgress?.({
              currentTime: data.currentTime * 1000,
              duration: data.duration * 1000,
            })
          }
          style={[{ width: '100%', height: '100%', backgroundColor: '#000' }, style]}
        />
      )
    }

    // Fallback for non-Pear web (shouldn't happen in production)
    return (
      <View style={[styles.videoPlaceholder, style]}>
        <Text style={styles.placeholderText}>
          {currentVideo?.title?.charAt(0).toUpperCase() || '?'}
        </Text>
      </View>
    )
  })
)
