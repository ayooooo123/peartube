/**
 * VideoPlayerOverlay - YouTube-style animated video player
 * Single view that animates between mini player and fullscreen
 * Uses react-native-reanimated for smooth 60fps animations
 * Uses VLC player for broad codec support
 */
import { useCallback, useEffect, useState, useRef } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Platform, ScrollView, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { usePlatform } from '@/lib/PlatformProvider'

// VLC player for iOS/Android
let VLCPlayer: any = null
if (Platform.OS !== 'web') {
  VLCPlayer = require('react-native-vlc-media-player').VLCPlayer
}
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  runOnJS,
  Extrapolation,
} from 'react-native-reanimated'
import { Play, Pause, X, ChevronDown, ThumbsUp, ThumbsDown, Share2, Download, MoreHorizontal, Users, RotateCcw, RotateCw } from 'lucide-react-native'
import { useVideoPlayerContext, VideoStats } from '@/lib/VideoPlayerContext'
import { colors } from '@/lib/colors'

// Constants
const MINI_PLAYER_HEIGHT = 64
const MINI_VIDEO_WIDTH = 120
const TAB_BAR_HEIGHT = 49
const ANIMATION_DURATION = 300

// Spring config for smooth animations
const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
  mass: 0.8,
}

// Format helpers
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// P2P Stats Bar Component - Enhanced with more details
function P2PStatsBar({ stats }: { stats: VideoStats | null }) {
  console.log('[P2PStatsBar-Overlay] Rendering, stats:', stats ? 'present' : 'null', stats)

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  // Status color and label
  const getStatusInfo = () => {
    if (!stats) return { color: '#6b7280', label: 'Loading...' }
    if (stats.isComplete) return { color: '#4ade80', label: 'Cached' }
    if (stats.status === 'downloading') return { color: '#fbbf24', label: 'Downloading' }
    if (stats.status === 'connecting') return { color: '#60a5fa', label: 'Connecting...' }
    if (stats.status === 'resolving') return { color: '#a78bfa', label: 'Resolving...' }
    if (stats.status === 'error') return { color: '#f87171', label: 'Error' }
    return { color: '#6b7280', label: 'Waiting' }
  }

  const statusInfo = getStatusInfo()

  return (
    <View style={styles.statsBar}>
      {/* Top row: Status, Peers, Speed */}
      <View style={styles.statsBarRow}>
        <View style={styles.statsBarLeft}>
          <View style={[styles.statusDot, { backgroundColor: statusInfo.color }]} />
          <Text style={styles.statsBarText}>{statusInfo.label}</Text>
        </View>
        {stats && (
          <>
            <View style={styles.statsBarCenter}>
              <Users color={colors.textMuted} size={12} />
              <Text style={styles.statsBarText}>{stats.peerCount || 0} peers</Text>
            </View>
            <View style={styles.statsBarSpeeds}>
              {/* Download speed - show when downloading */}
              {!stats.isComplete && parseFloat(stats.speedMBps) > 0 && (
                <Text style={styles.statsBarSpeed}>↓ {stats.speedMBps}</Text>
              )}
              {/* Upload speed - show when seeding (always if > 0) */}
              {stats.uploadSpeedMBps && parseFloat(stats.uploadSpeedMBps) > 0 && (
                <Text style={styles.statsBarUploadSpeed}>↑ {stats.uploadSpeedMBps}</Text>
              )}
            </View>
          </>
        )}
      </View>

      {/* Progress bar */}
      {stats && !stats.isComplete && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${stats.progress || 0}%` }]} />
        </View>
      )}

      {/* Bottom row: Bytes, Blocks, Time */}
      {stats && (
        <View style={styles.statsBarRow2}>
          <Text style={styles.statsBarDetail}>
            {formatBytes(stats.downloadedBytes || 0)} / {formatBytes(stats.totalBytes || 0)}
          </Text>
          <Text style={styles.statsBarDetail}>
            {stats.downloadedBlocks || 0} / {stats.totalBlocks || 0} blocks
          </Text>
          {!stats.isComplete && stats.elapsed > 0 && (
            <Text style={styles.statsBarDetail}>
              {stats.elapsed}s
            </Text>
          )}
          <Text style={[styles.statsBarProgress, stats.isComplete && styles.statsBarProgressComplete]}>
            {stats.progress || 0}%
          </Text>
        </View>
      )}
    </View>
  )
}

// Action Button Component
function ActionButton({ icon: Icon, label, onPress, active }: {
  icon: any
  label: string
  onPress?: () => void
  active?: boolean
}) {
  return (
    <Pressable style={styles.actionButton} onPress={onPress}>
      <Icon color={active ? colors.primary : colors.text} size={22} />
      <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
    </Pressable>
  )
}


// Channel Info Component
function ChannelInfo({ channelName, channelInitial }: { channelName: string, channelInitial: string }) {
  return (
    <View style={styles.channelRow}>
      <View style={styles.channelAvatar}>
        <Text style={styles.channelAvatarText}>{channelInitial}</Text>
      </View>
      <View style={styles.channelInfo}>
        <Text style={styles.channelName}>{channelName}</Text>
        <Text style={styles.channelSubs}>Channel</Text>
      </View>
      <Pressable style={styles.subscribeButton}>
        <Text style={styles.subscribeText}>Subscribe</Text>
      </Pressable>
    </View>
  )
}


export function VideoPlayerOverlay() {
  const insets = useSafeAreaInsets()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()
  const { isDesktop } = usePlatform()
  const videoHeight = Math.round(screenWidth * 9 / 16)

  // Desktop video dimensions (YouTube-style - video takes ~70% width, max 1280px)
  const desktopVideoWidth = Math.min(screenWidth * 0.65, 1280)
  const desktopVideoHeight = Math.round(desktopVideoWidth * 9 / 16)

  const {
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playerMode,
    videoStats,
    playerRef,
    currentTime,
    duration,
    progress: playbackProgress, // 0-1 playback progress
    playbackRate,
    vlcSeekPosition,
    pauseVideo,
    resumeVideo,
    closeVideo,
    minimizePlayer,
    maximizePlayer,
    seekBy,
    seekTo,
    setPlaybackRate,
    onProgress,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
  } = useVideoPlayerContext()

  // State for showing seek feedback
  const [seekFeedback, setSeekFeedback] = useState<'left' | 'right' | null>(null)

  // State for drag seeking
  const [isSeeking, setIsSeeking] = useState(false)
  const [seekPosition, setSeekPosition] = useState(0)
  const progressBarRef = useRef<View>(null)
  const progressBarWidth = useRef(0)

  // State for showing custom controls overlay
  const [showControls, setShowControls] = useState(false)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Show controls temporarily
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true)
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false)
    }, 3000)
  }, [])

  // Toggle controls on tap
  const handleVideoTap = useCallback(() => {
    if (playerMode === 'fullscreen') {
      if (showControls) {
        setShowControls(false)
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current)
        }
      } else {
        showControlsTemporarily()
      }
    }
  }, [playerMode, showControls, showControlsTemporarily])


  // Animation progress: 0 = mini, 1 = fullscreen
  const animProgress = useSharedValue(0)
  const translateY = useSharedValue(0)
  const isGestureActive = useSharedValue(false)

  // Calculate positions
  const miniPlayerBottom = TAB_BAR_HEIGHT + insets.bottom
  const fullscreenTop = insets.top

  // Animate when playerMode changes
  useEffect(() => {
    if (playerMode === 'fullscreen') {
      animProgress.value = withSpring(1, SPRING_CONFIG)
    } else if (playerMode === 'mini') {
      animProgress.value = withSpring(0, SPRING_CONFIG)
    }
  }, [playerMode])

  // Pan gesture for dragging between states
  const panGesture = Gesture.Pan()
    .onStart(() => {
      isGestureActive.value = true
    })
    .onUpdate((event) => {
      // Calculate progress based on drag
      const totalDistance = screenHeight - miniPlayerBottom - fullscreenTop - MINI_PLAYER_HEIGHT
      const dragProgress = -event.translationY / totalDistance

      if (playerMode === 'fullscreen') {
        // Dragging down from fullscreen
        animProgress.value = Math.max(0, Math.min(1, 1 + dragProgress))
      } else {
        // Dragging up from mini
        animProgress.value = Math.max(0, Math.min(1, dragProgress))
      }
    })
    .onEnd((event) => {
      isGestureActive.value = false
      const velocity = event.velocityY

      // Determine final state based on progress and velocity
      if (velocity > 500) {
        // Fast swipe down -> minimize
        animProgress.value = withSpring(0, SPRING_CONFIG)
        runOnJS(minimizePlayer)()
      } else if (velocity < -500) {
        // Fast swipe up -> maximize
        animProgress.value = withSpring(1, SPRING_CONFIG)
        runOnJS(maximizePlayer)()
      } else if (animProgress.value > 0.5) {
        // Past halfway -> fullscreen
        animProgress.value = withSpring(1, SPRING_CONFIG)
        runOnJS(maximizePlayer)()
      } else {
        // Below halfway -> mini
        animProgress.value = withSpring(0, SPRING_CONFIG)
        runOnJS(minimizePlayer)()
      }
    })

  // Tap gesture for mini player -> expand (only active in mini mode)
  const tapGesture = Gesture.Tap()
    .enabled(playerMode === 'mini')
    .onEnd(() => {
      runOnJS(maximizePlayer)()
    })

  // Combine gestures - pan for dragging, tap for mini expand
  const composedGesture = Gesture.Race(panGesture, tapGesture)

  // Animated styles for the container
  const containerStyle = useAnimatedStyle(() => {
    // Interpolate position
    const top = interpolate(
      animProgress.value,
      [0, 1],
      [screenHeight - miniPlayerBottom - MINI_PLAYER_HEIGHT, 0],
      Extrapolation.CLAMP
    )

    const height = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PLAYER_HEIGHT, screenHeight],
      Extrapolation.CLAMP
    )

    return {
      position: 'absolute',
      left: 0,
      right: 0,
      top,
      height,
      zIndex: 1000,
    }
  })

  // Animated styles for the video
  const videoStyle = useAnimatedStyle(() => {
    const width = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_VIDEO_WIDTH, screenWidth],
      Extrapolation.CLAMP
    )

    const height = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PLAYER_HEIGHT, videoHeight + insets.top],
      Extrapolation.CLAMP
    )

    return {
      width,
      height,
    }
  })

  // Animated styles for mini player info (fades out when expanding)
  const miniInfoStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      animProgress.value,
      [0, 0.3],
      [1, 0],
      Extrapolation.CLAMP
    )

    return {
      opacity,
      display: animProgress.value > 0.5 ? 'none' : 'flex',
    }
  })

  // Animated styles for fullscreen content (fades in when expanding)
  const fullscreenContentStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      animProgress.value,
      [0.5, 1],
      [0, 1],
      Extrapolation.CLAMP
    )

    return {
      opacity,
      display: animProgress.value < 0.3 ? 'none' : 'flex',
    }
  })

  // Mini player controls opacity
  const miniControlsStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      animProgress.value,
      [0, 0.3],
      [1, 0],
      Extrapolation.CLAMP
    )
    return { opacity }
  })

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pauseVideo()
    } else {
      resumeVideo()
    }
  }, [isPlaying, pauseVideo, resumeVideo])

  // Handle double-tap seek - 10s forward/backward
  const handleDoubleTapSeek = useCallback((direction: 'left' | 'right') => {
    const delta = direction === 'left' ? -10 : 10
    seekBy(delta)
    setSeekFeedback(direction)
    setTimeout(() => setSeekFeedback(null), 500)
  }, [seekBy])


  // Available playback speeds
  const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

  // Cycle through playback speeds
  const cyclePlaybackSpeed = useCallback(() => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate)
    const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length
    setPlaybackRate(PLAYBACK_SPEEDS[nextIndex])
  }, [playbackRate, setPlaybackRate])

  // Don't render if no video
  if (!currentVideo || playerMode === 'hidden') {
    return null
  }

  const channelName = currentVideo.channel?.name || 'Unknown Channel'
  const channelInitial = channelName.charAt(0).toUpperCase()

  // Desktop: YouTube-style layout (not fullscreen overlay)
  if (isDesktop && Platform.OS === 'web') {
    return (
      <div style={desktopStyles.overlay}>
        <div style={desktopStyles.container}>
          {/* Main content area */}
          <div style={desktopStyles.mainColumn}>
            {/* Video player */}
            <div style={{ ...desktopStyles.videoWrapper, width: desktopVideoWidth, height: desktopVideoHeight }}>
              {videoUrl ? (
                <video
                  src={videoUrl}
                  controls
                  autoPlay
                  onCanPlay={onPlaying}
                  onPause={onPaused}
                  onPlay={onPlaying}
                  onEnded={onEnded}
                  onError={onError}
                  style={{ width: '100%', height: '100%', backgroundColor: '#000', borderRadius: 12 }}
                />
              ) : (
                <div style={desktopStyles.placeholder}>
                  <span style={desktopStyles.placeholderText}>{currentVideo.title.charAt(0).toUpperCase()}</span>
                </div>
              )}
              {isLoading && (
                <div style={desktopStyles.loadingOverlay}>
                  <ActivityIndicator color="white" size="large" />
                  <Text style={{ color: '#fff', marginTop: 12 }}>Connecting to P2P...</Text>
                </div>
              )}
            </div>

            {/* Video info */}
            <div style={desktopStyles.videoInfo}>
              <h1 style={desktopStyles.title}>{currentVideo.title}</h1>
              <div style={desktopStyles.meta}>
                <span>{formatTimeAgo(currentVideo.uploadedAt)}</span>
                <span style={desktopStyles.dot}>•</span>
                <span>{formatSize(currentVideo.size)}</span>
              </div>

              {/* Channel info */}
              <div style={desktopStyles.channelRow}>
                <div style={desktopStyles.avatar}>
                  <span style={desktopStyles.avatarText}>{channelInitial}</span>
                </div>
                <div style={desktopStyles.channelInfo}>
                  <span style={desktopStyles.channelName}>{channelName}</span>
                </div>
              </div>

              {/* Description */}
              {currentVideo.description && (
                <div style={desktopStyles.description}>
                  <p style={desktopStyles.descriptionText}>{currentVideo.description}</p>
                </div>
              )}
            </div>
          </div>

          {/* Close button */}
          <button onClick={closeVideo} style={desktopStyles.closeButton} aria-label="Close">
            <X color={colors.text} size={24} />
          </button>
        </div>
      </div>
    )
  }

  // Mobile: Animated overlay
  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View style={[styles.container, containerStyle]}>
        {/* Video area */}
        <Animated.View style={[styles.videoWrapper, videoStyle]}>
          {/* Background */}
          <Pressable style={styles.videoBackground} onPress={handleVideoTap}>
            {Platform.OS !== 'web' && videoUrl && VLCPlayer ? (
              <VLCPlayer
                ref={playerRef}
                source={{ uri: videoUrl }}
                style={StyleSheet.absoluteFill}
                paused={!isPlaying}
                rate={playbackRate}
                seek={vlcSeekPosition !== undefined ? vlcSeekPosition : -1}
                resizeMode="contain"
                onProgress={onProgress}
                onPlaying={onPlaying}
                onPaused={onPaused}
                onBuffering={onBuffering}
                onEnd={onEnded}
                onError={onError}
              />
            ) : Platform.OS === 'web' && videoUrl ? (
              <video
                src={videoUrl}
                controls
                autoPlay
                onCanPlay={onPlaying}
                onPause={onPaused}
                onPlay={onPlaying}
                onEnded={onEnded}
                onError={onError}
                style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
              />
            ) : (
              <View style={styles.videoPlaceholder}>
                <Text style={styles.placeholderText}>
                  {currentVideo.title.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}

            {/* Loading overlay */}
            {isLoading && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator color="white" size="large" />
                <Text style={styles.loadingText}>Connecting to P2P...</Text>
              </View>
            )}

            {/* Custom controls overlay - shown on tap in fullscreen */}
            {playerMode === 'fullscreen' && showControls && (
              <View style={styles.controlsOverlay}>
                {/* Seek backward */}
                <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('left')}>
                  <RotateCcw color="#fff" size={32} />
                  <Text style={styles.controlButtonText}>10s</Text>
                </Pressable>

                {/* Play/Pause */}
                <Pressable style={styles.controlButtonLarge} onPress={handlePlayPause}>
                  {isPlaying ? (
                    <Pause color="#fff" size={48} fill="#fff" />
                  ) : (
                    <Play color="#fff" size={48} fill="#fff" />
                  )}
                </Pressable>

                {/* Seek forward */}
                <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('right')}>
                  <RotateCw color="#fff" size={32} />
                  <Text style={styles.controlButtonText}>10s</Text>
                </Pressable>
              </View>
            )}

            {/* Seek feedback overlay */}
            {seekFeedback && (
              <View style={[
                styles.seekFeedback,
                seekFeedback === 'left' ? styles.seekFeedbackLeft : styles.seekFeedbackRight
              ]}>
                {seekFeedback === 'left' ? (
                  <RotateCcw color="#fff" size={32} />
                ) : (
                  <RotateCw color="#fff" size={32} />
                )}
                <Text style={styles.seekFeedbackText}>10s</Text>
              </View>
            )}
          </Pressable>

          {/* Fullscreen minimize button */}
          <Animated.View style={[styles.minimizeButton, fullscreenContentStyle]}>
            <Pressable onPress={minimizePlayer} style={styles.minimizeButtonInner}>
              <ChevronDown color="#fff" size={28} />
            </Pressable>
          </Animated.View>

          {/* Speed control button */}
          <Animated.View style={[styles.speedButton, fullscreenContentStyle]}>
            <Pressable onPress={cyclePlaybackSpeed} style={styles.speedButtonInner}>
              <Text style={styles.speedButtonText}>{playbackRate}x</Text>
            </Pressable>
          </Animated.View>

          {/* Fullscreen progress bar */}
          <Animated.View style={[styles.fullscreenProgressContainer, fullscreenContentStyle]}>
            <Text style={styles.timeText}>
              {formatDuration(isSeeking ? seekPosition : currentTime)}
            </Text>
            <View
              ref={progressBarRef}
              style={styles.fullscreenProgressBar}
              onLayout={(e) => {
                progressBarWidth.current = e.nativeEvent.layout.width
              }}
              onTouchStart={(e) => {
                const locationX = e.nativeEvent.locationX
                const progress = Math.max(0, Math.min(1, locationX / progressBarWidth.current))
                setIsSeeking(true)
                setSeekPosition(progress * duration)
              }}
              onTouchMove={(e) => {
                if (isSeeking) {
                  const locationX = e.nativeEvent.locationX
                  const progress = Math.max(0, Math.min(1, locationX / progressBarWidth.current))
                  setSeekPosition(progress * duration)
                }
              }}
              onTouchEnd={() => {
                if (isSeeking) {
                  seekTo(seekPosition)
                  setIsSeeking(false)
                }
              }}
            >
              <View style={styles.fullscreenProgressBg}>
                <View
                  style={[
                    styles.fullscreenProgressFill,
                    { width: `${(isSeeking ? seekPosition / duration : playbackProgress) * 100}%` }
                  ]}
                />
                {/* Seek handle */}
                <View
                  style={[
                    styles.seekHandle,
                    { left: `${(isSeeking ? seekPosition / duration : playbackProgress) * 100}%` }
                  ]}
                />
              </View>
            </View>
            <Text style={styles.timeText}>{formatDuration(duration)}</Text>
          </Animated.View>
        </Animated.View>

        {/* Mini player info row */}
        <Animated.View style={[styles.miniInfo, miniInfoStyle]}>
          <View style={styles.miniInfoText}>
            <Text style={styles.miniTitle} numberOfLines={1}>
              {currentVideo.title}
            </Text>
            <Text style={styles.miniChannel} numberOfLines={1}>
              {channelName}
            </Text>
          </View>
        </Animated.View>

        {/* Mini player controls */}
        <Animated.View style={[styles.miniControls, miniControlsStyle]}>
          <Pressable style={styles.miniControlButton} onPress={handlePlayPause}>
            {isPlaying ? (
              <Pause color={colors.text} size={24} fill={colors.text} />
            ) : (
              <Play color={colors.text} size={24} fill={colors.text} />
            )}
          </Pressable>
          <Pressable style={styles.miniControlButton} onPress={closeVideo}>
            <X color={colors.text} size={24} />
          </Pressable>
        </Animated.View>

        {/* Mini player progress bar */}
        <Animated.View style={[styles.miniProgressBar, miniInfoStyle]}>
          <View style={[styles.miniProgressFill, { width: `${playbackProgress * 100}%` }]} />
        </Animated.View>

        {/* Fullscreen content */}
        <Animated.View style={[styles.fullscreenContent, fullscreenContentStyle]}>
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* P2P Stats */}
            {Platform.OS !== 'web' && <P2PStatsBar stats={videoStats} />}

            {/* Video Info */}
            <View style={styles.videoInfo}>
              <Text style={styles.videoTitle}>{currentVideo.title}</Text>
              <Text style={styles.videoMeta}>
                {formatTimeAgo(currentVideo.uploadedAt)} · {formatSize(currentVideo.size)}
              </Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actions}>
              <ActionButton icon={ThumbsUp} label="Like" />
              <ActionButton icon={ThumbsDown} label="Dislike" />
              <ActionButton icon={Share2} label="Share" />
              <ActionButton icon={Download} label="Download" />
              <ActionButton icon={MoreHorizontal} label="More" />
            </View>

            {/* Channel Info */}
            <ChannelInfo channelName={channelName} channelInitial={channelInitial} />

            {/* Divider */}
            <View style={styles.divider} />

            {/* Description */}
            {currentVideo.description && (
              <View style={styles.description}>
                <Text style={styles.descriptionText}>{currentVideo.description}</Text>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  videoWrapper: {
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  videoBackground: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoPlaceholder: {
    flex: 1,
    backgroundColor: colors.bgHover,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: colors.primary,
    fontSize: 32,
    fontWeight: '600',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#fff',
    marginTop: 12,
    fontSize: 14,
  },
  // Custom controls overlay
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 48,
  },
  controlButton: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  controlButtonLarge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButtonText: {
    color: '#fff',
    fontSize: 12,
    marginTop: 4,
  },
  seekFeedback: {
    position: 'absolute',
    top: '50%',
    marginTop: -40,
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  seekFeedbackLeft: {
    left: '15%',
  },
  seekFeedbackRight: {
    right: '15%',
  },
  seekFeedbackText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  minimizeButton: {
    position: 'absolute',
    top: 52,
    left: 12,
    zIndex: 10,
  },
  minimizeButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedButton: {
    position: 'absolute',
    top: 52,
    right: 12,
    zIndex: 10,
  },
  speedButtonInner: {
    minWidth: 50,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  speedButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Fullscreen progress bar
  fullscreenProgressContainer: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 10,
  },
  fullscreenProgressBar: {
    flex: 1,
    height: 24,
    justifyContent: 'center',
  },
  fullscreenProgressBg: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  fullscreenProgressFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  seekHandle: {
    position: 'absolute',
    top: -5,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.primary,
    marginLeft: -7,
  },
  timeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    minWidth: 40,
  },
  // Mini player styles
  miniInfo: {
    position: 'absolute',
    left: MINI_VIDEO_WIDTH,
    right: 100,
    top: 0,
    height: MINI_PLAYER_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  miniInfoText: {
    flex: 1,
    justifyContent: 'center',
  },
  miniTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  miniChannel: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  miniControls: {
    position: 'absolute',
    right: 8,
    top: 0,
    height: MINI_PLAYER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniControlButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  miniProgressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  // Fullscreen content styles
  fullscreenContent: {
    flex: 1,
  },
  scrollContent: {
    flex: 1,
  },
  videoInfo: {
    padding: 16,
  },
  videoTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
  },
  videoMeta: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 6,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  actionButton: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionLabel: {
    color: colors.text,
    fontSize: 11,
    marginTop: 4,
  },
  actionLabelActive: {
    color: colors.primary,
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  channelAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  channelAvatarText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  channelInfo: {
    flex: 1,
    marginLeft: 12,
  },
  channelName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  channelSubs: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  subscribeButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  subscribeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  divider: {
    height: 8,
    backgroundColor: colors.bgSecondary,
    marginVertical: 8,
  },
  description: {
    padding: 16,
  },
  descriptionText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  // P2P Stats Bar styles
  statsBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  statsBarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statsBarRow2: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  statsBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statsBarCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statsBarText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  statsBarDetail: {
    color: colors.textMuted,
    fontSize: 11,
  },
  statsBarSpeeds: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statsBarSpeed: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  statsBarUploadSpeed: {
    color: '#4ade80', // Green for upload
    fontSize: 12,
    fontWeight: '600',
  },
  statsBarProgress: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  statsBarProgressComplete: {
    color: '#4ade80',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  progressBarBg: {
    marginTop: 8,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
})

// Desktop-specific styles (CSS-in-JS for web)
const desktopStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 108, // PEAR_BAR_HEIGHT (52) + HEADER_HEIGHT (56)
    left: 240, // SIDEBAR_WIDTH
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    zIndex: 1000, // Higher than header (100) and sidebar (50) to ensure full coverage
    overflow: 'auto',
  },
  container: {
    display: 'flex',
    flexDirection: 'row',
    padding: 24,
    gap: 24,
    maxWidth: 1600,
  },
  mainColumn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  videoWrapper: {
    position: 'relative',
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgSecondary,
  },
  placeholderText: {
    fontSize: 48,
    color: colors.primary,
    fontWeight: '600',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  videoInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
    margin: 0,
    lineHeight: 1.3,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
    color: colors.textMuted,
  },
  dot: {
    color: colors.textMuted,
  },
  channelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    borderTop: `1px solid ${colors.border}`,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  channelInfo: {
    display: 'flex',
    flexDirection: 'column',
  },
  channelName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  description: {
    paddingTop: 16,
    borderTop: `1px solid ${colors.border}`,
  },
  descriptionText: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 1.6,
    margin: 0,
  },
  closeButton: {
    position: 'absolute',
    top: 24,
    right: 24,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.bgSecondary,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
}
