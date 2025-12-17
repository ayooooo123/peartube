/**
 * MiniPlayer - YouTube-style floating mini player
 * Shows at bottom of screen when video is minimized
 * Uses SHARED player from context for continuous playback
 */
import { View, Text, Pressable, StyleSheet, Animated, PanResponder, Platform } from 'react-native'
import { useRef } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Play, Pause, X } from 'lucide-react-native'

import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { colors } from '@/lib/colors'

const MINI_PLAYER_HEIGHT = 64
const MINI_VIDEO_WIDTH = 120

export function MiniPlayer() {
  const insets = useSafeAreaInsets()
  const {
    currentVideo,
    isPlaying,
    playerMode,
    currentTime,
    duration,
    pauseVideo,
    resumeVideo,
    closeVideo,
    maximizePlayer,
  } = useVideoPlayerContext()

  // Animation for swipe-to-dismiss gesture
  const swipeY = useRef(new Animated.Value(0)).current

  // Swipe gesture to dismiss (swipe down to close)
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => {
        // Only respond to vertical swipes (down)
        return gesture.dy > 10 && Math.abs(gesture.dy) > Math.abs(gesture.dx)
      },
      onPanResponderMove: (_, gesture) => {
        // Follow finger during swipe down
        if (gesture.dy > 0) {
          swipeY.setValue(gesture.dy)
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > 50 || gesture.vy > 0.5) {
          // Swipe down to dismiss
          Animated.timing(swipeY, {
            toValue: 200,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            swipeY.setValue(0)
            closeVideo()
          })
        } else {
          // Snap back
          Animated.spring(swipeY, {
            toValue: 0,
            useNativeDriver: true,
          }).start()
        }
      },
    })
  ).current

  // Don't render if no video or not in mini mode
  console.log('[MiniPlayer] playerMode:', playerMode, 'currentVideo:', currentVideo?.title)
  if (!currentVideo || playerMode !== 'mini') {
    return null
  }

  const handlePress = () => {
    // Expand the global overlay player back to fullscreen
    maximizePlayer()
  }

  const handlePlayPause = () => {
    if (isPlaying) {
      pauseVideo()
    } else {
      resumeVideo()
    }
  }

  // Tab bar height from _layout.tsx: height = 42 + insets.bottom, paddingBottom = max(8, insets.bottom)
  // On Android with gesture nav, insets.bottom can be small/0 but tab bar still has visual height
  // Use a minimum that accounts for the tab bar's actual rendered height
  const TAB_BAR_BASE_HEIGHT = 42
  const minBottomPadding = Math.max(8, insets.bottom)

  // On Android, add extra padding for gesture navigation area
  const androidExtraPadding = Platform.OS === 'android' ? 8 : 0
  const totalTabBarHeight = TAB_BAR_BASE_HEIGHT + minBottomPadding + androidExtraPadding

  return (
    <Animated.View
      style={[
        styles.container,
        {
          bottom: totalTabBarHeight,
          transform: [{ translateY: swipeY }],
        },
      ]}
      {...panResponder.panHandlers}
    >
      {/* Mini video thumbnail */}
      <Pressable style={styles.videoContainer} onPress={handlePress}>
        <View style={styles.videoPlaceholder}>
          <Text style={styles.placeholderText}>
            {currentVideo.title.charAt(0).toUpperCase()}
          </Text>
        </View>
      </Pressable>

      {/* Video info */}
      <Pressable style={styles.info} onPress={handlePress}>
        <Text style={styles.title} numberOfLines={1}>
          {currentVideo.title}
        </Text>
        <Text style={styles.channel} numberOfLines={1}>
          {currentVideo.channel?.name || 'Unknown channel'}
        </Text>
      </Pressable>

      {/* Controls */}
      <View style={styles.controls}>
        <Pressable style={styles.controlButton} onPress={handlePlayPause}>
          {isPlaying ? (
            <Pause color={colors.text} size={24} fill={colors.text} />
          ) : (
            <Play color={colors.text} size={24} fill={colors.text} />
          )}
        </Pressable>
        <Pressable style={styles.controlButton} onPress={closeVideo}>
          <X color={colors.text} size={24} />
        </Pressable>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }]} />
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: MINI_PLAYER_HEIGHT,
    backgroundColor: colors.bgSecondary,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    zIndex: 100,
  },
  videoContainer: {
    width: MINI_VIDEO_WIDTH,
    height: MINI_PLAYER_HEIGHT,
    backgroundColor: '#000',
  },
  videoPlaceholder: {
    width: MINI_VIDEO_WIDTH,
    height: MINI_PLAYER_HEIGHT,
    backgroundColor: colors.bgHover,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: colors.primary,
    fontSize: 24,
    fontWeight: '600',
  },
  info: {
    flex: 1,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  channel: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  controlButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  progressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
})
