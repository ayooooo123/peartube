import { useCallback, useContext, useEffect, useState, useRef, useMemo } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Platform, ScrollView, ActivityIndicator, Alert, StatusBar, Dimensions, TextInput, AppState } from 'react-native'
import { rpc } from '@peartube/platform/rpc'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { usePlatform } from '@/lib/PlatformProvider'
import { useSidebar, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from './desktop/constants'
import { useApp } from '@/lib/AppContext'

// MpvPlayer for Pear Desktop
import { MpvPlayer } from './MpvPlayer'

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  runOnJS,
  Extrapolation,
  cancelAnimation,
} from 'react-native-reanimated'
import { Feather as ExpoFeather, Ionicons as ExpoIonicons } from '@expo/vector-icons'
import * as ScreenOrientation from 'expo-screen-orientation'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { useDownloads } from '@/lib/DownloadsContext'
import { useCurrentDownloadStatus } from '@/hooks/useCurrentDownloadStatus'
import { useSocial } from '@/lib/SocialContext'
import { colors } from '@/lib/colors'
import { getPlayerPageVideoHeight } from '@/lib/video-layout'
import * as MediaSession from '../modules/expo-media-session/src'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { useCast } from '@/lib/cast'
import { DevicePickerModal } from '@/components/cast'

// Import modular video-player components
import {
  // Constants
  MINI_PIP_WIDTH,
  MINI_PIP_HEIGHT,
  MINI_PIP_MARGIN,
  MINI_PIP_CORNER_RADIUS,
  TAB_BAR_HEIGHT,

  SPRING_CONFIG_BOUNCY,
  SPRING_CONFIG_TIGHT,
  DESKTOP_MINI_WIDTH,
  DESKTOP_MINI_HEIGHT,
  DESKTOP_MINI_PADDING,
  DESKTOP_MINI_CONTROLS_HEIGHT,
  PLAYBACK_SPEEDS,
  // Formatters
  formatSize,
  formatTimeAgo,
  formatDuration,
  // Styles
  styles,
  desktopStyles,
  // Components
  P2PStatsBar,
  ChannelInfo,
  ActionButton,
  Scrubber,
  PearInlineVideoView,
} from './video-player'

function showCastAlert(message: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message)
    return
  }
  Alert.alert('Chromecast', message)
}

const ANDROID_ICON_GLYPHS: Record<string, string> = {
  cast: 'TV',
  play: '>',
  pause: '||',
  x: 'X',
  'x-circle': 'X',
  'chevron-up': '^',
  'chevron-down': 'v',
  'rotate-ccw': '<',
  'rotate-cw': '>',
  check: 'OK',
  download: 'D',
  minus: '-',
  plus: '+',
  maximize: '[]',
  minimize: '_',
  'more-horizontal': '...',
  'share-2': 'S',
  'thumbs-up': '+',
  'thumbs-down': '-',
  'corner-up-left': '<',
  'trash-2': 'X',
  tv: 'TV',
}

function resolveAndroidGlyph(name?: string) {
  if (!name) return '?'
  return ANDROID_ICON_GLYPHS[name] || ANDROID_ICON_GLYPHS[name.toLowerCase()] || '?'
}

function Feather(props: React.ComponentProps<typeof ExpoFeather>) {
  if (Platform.OS !== 'android') return <ExpoFeather {...props} />
  const glyph = resolveAndroidGlyph(typeof props.name === 'string' ? props.name : undefined)
  const size = typeof props.size === 'number' ? props.size : 16
  return (
    <Text style={{ color: props.color || '#fff', fontSize: Math.max(12, Math.round(size * 0.85)), fontWeight: '700' }}>
      {glyph}
    </Text>
  )
}

function Ionicons(props: React.ComponentProps<typeof ExpoIonicons>) {
  if (Platform.OS !== 'android') return <ExpoIonicons {...props} />
  const glyph = resolveAndroidGlyph(typeof props.name === 'string' ? props.name : undefined)
  const size = typeof props.size === 'number' ? props.size : 16
  return (
    <Text style={{ color: props.color || '#fff', fontSize: Math.max(12, Math.round(size * 0.85)), fontWeight: '700' }}>
      {glyph}
    </Text>
  )
}

const CHANNEL_META_CACHE_TTL_MS = 5 * 60 * 1000
const channelMetaNameCache = new Map<string, { name: string | null; expiresAt: number }>()
const ZERO_EDGE_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })
type MiniPlayerCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

function getMobileMiniPlayerSnapPosition({
  corner,
  screenWidth,
  screenHeight,
  miniWidth,
  topInset,
  bottomOffset,
}: {
  corner: MiniPlayerCorner
  screenWidth: number
  screenHeight: number
  miniWidth: number
  topInset: number
  bottomOffset: number
}) {
  const leftX = MINI_PIP_MARGIN
  const rightX = screenWidth - miniWidth - MINI_PIP_MARGIN
  const topY = topInset + MINI_PIP_MARGIN
  const bottomY = screenHeight - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - bottomOffset

  return {
    x: corner.includes('right') ? rightX : leftX,
    y: corner.includes('bottom') ? bottomY : topY,
  }
}

export function VideoPlayerOverlay() {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_EDGE_INSETS
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const screenMetrics = Dimensions.get('screen')
  const { isDesktop, isPear } = usePlatform()

  // Debug log on mount
  useEffect(() => {
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] Mounted. isPear:', isPear, 'isDesktop:', isDesktop, 'Platform.OS:', Platform.OS)
      if (typeof window !== 'undefined') {
        const windowState = window as unknown as Record<string, unknown>
        console.log('[VideoPlayerOverlay] window.Pear:', !!windowState.Pear)
        console.log('[VideoPlayerOverlay] PearWorkerClient:', !!windowState.PearWorkerClient)
        console.log('[VideoPlayerOverlay] userAgent:', navigator?.userAgent?.substring(0, 100))
      }
    }
  }, [isPear, isDesktop])

  const { isCollapsed } = useSidebar()
  const { identity } = useApp()
  const {
    comments,
    commentText,
    setCommentText,
    replyToComment,
    setReplyToComment,
    commentsLoading,
    postingComment,
    hasMoreComments,
    loadingMoreComments,
    refreshingComments,
    deletingCommentId,
    reactionCounts,
    userReaction,
    refreshComments,
    loadMoreComments,
    postComment,
    deleteComment,
    toggleReaction,
    displayComments,
    organizedComments,
  } = useSocial()
  const exitGateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const exitGateLastSnapshotRef = useRef<string | null>(null)
  const exitGateStableCountRef = useRef(0)
  const exitGateAttemptsRef = useRef(0)
  const playerLogKeyRef = useRef<string | null>(null)

  // For landscape fullscreen, track screen dimensions as shared values
  // This allows animated styles to use current screen size without React re-renders
  const landscapeWidth = useSharedValue(Dimensions.get('screen').width)
  const landscapeHeight = useSharedValue(Dimensions.get('screen').height)

  useEffect(() => {
    const updateDims = () => {
      const screen = Dimensions.get('screen')
      landscapeWidth.value = screen.width
      landscapeHeight.value = screen.height
    }
    updateDims()
    const subscription = Dimensions.addEventListener('change', updateDims)
    return () => subscription.remove()
  }, [])

  // Note: Orientation change mid-gesture is handled implicitly:
  // - The Dimensions change listener above updates shared values
  // - The panGesture is disabled during landscape fullscreen
  // - When exiting landscape, the layout settles before showing portrait content

  // Dynamic sidebar width for desktop overlay positioning
  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  const {
    currentVideo,
    videoUrl,
    isPlaying,
    isLoading,
    playerMode,
    videoStats,
    playbackSession,
    playerRef,
    currentTime,
    duration,
    playbackRate,
    seekPosition: playerSeekPosition,
    isInPipMode,
    androidSplitPlayerEnabled,
    setIsInPipMode,
    pipWindowSize,
    setPipWindowSize,
    videoAspectRatio,
    pauseVideo,
    resumeVideo,
    closeVideo,
    minimizePlayer,
    maximizePlayer,
    maximizedForPipRef,
    seekBy,
    seekTo,
    setPlaybackRate,
    onProgress,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
    onVideoStateChange,
  } = useVideoPlayerContext()

  // Simplified PiP state tracking - trust the native event, don't over-engineer
  const wasInPipRef = useRef(false)
  // Android 12+ seamless PiP can shrink the Activity window before the JS PiP event arrives.
  // Freeze PiP layout branches early based on window shrink, but avoid re-activating them
  // during the PiP exit tail where window metrics can stay small for a few frames.
  const pipExitBlockEarlyDetectRef = useRef(false)
  const pipModePrevRef = useRef(false)

  useEffect(() => {
    if (isInPipMode) {
      wasInPipRef.current = true
      // PiP has system-level controls; keep fullscreen overlay hidden.
      setShowControls(false)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
        controlsTimeoutRef.current = null
      }
    } else if (wasInPipRef.current) {
      wasInPipRef.current = false
      autoPipEnabledRef.current = false  // Reset overlay pattern on PiP exit
      showControlsTemporarily()
    }
  }, [isInPipMode])

  // On Android in fullscreen, ALWAYS use real screen dimensions for layout.
  // Why: Android PiP (especially Android 12+ seamless mode) shrinks the Activity
  // window BEFORE onPictureInPictureModeChanged fires the JS event. This causes
  // useWindowDimensions to return intermediate/PiP-sized values while isInPipMode
  // is still false. The non-PiP fullscreen branches of animated styles would use
  // artifact. Using screen dimensions (which never change) prevents any layout
  // disruption during PiP transitions.
  // Also handles PiP EXIT where useWindowDimensions briefly returns stale PiP sizes.
  const isAndroidFullscreen = Platform.OS === 'android' && playerMode === 'fullscreen'
  const useScreenFallback = isAndroidFullscreen || (
    !isInPipMode &&
    windowWidth < screenMetrics.width * 0.6 && windowHeight < screenMetrics.height * 0.4
  )

  // In PiP mode, use window dimensions directly - don't override with pipWindowSize
  // The native pipWindowSize values can be wrong (full screen size instead of PiP size)
  // React Native's useWindowDimensions gives us the actual window size
  const baseScreenWidth = useScreenFallback ? screenMetrics.width : windowWidth
  const baseScreenHeight = useScreenFallback ? screenMetrics.height : windowHeight
  const screenWidth = baseScreenWidth
  const screenHeight = baseScreenHeight
  const isWindowLandscape = screenWidth > screenHeight

  // Keep the player page frame stable and let the native video view letterbox within it.
  const videoHeight = getPlayerPageVideoHeight(screenWidth)
  const effectiveAR = videoAspectRatio || 16 / 9

  const pipLayoutLastLogAtRef = useRef(0)
  const pipLayoutLastPayloadRef = useRef<string | null>(null)
  useEffect(() => {
    if (!__DEV__) return
    if (Platform.OS !== 'android') return

    const isPipLayoutDebugActive = playerMode === 'fullscreen' && (
      isInPipMode || (
        windowWidth < screenMetrics.width * 0.9
        && windowHeight < screenMetrics.height * 0.9
      )
    )
    if (!isPipLayoutDebugActive) return

    const payload = {
      isInPipMode,
      isPipLayoutDebugActive,
      pipWindowSize,
      pipContainerSize: isInPipMode && pipWindowSize ? pipWindowSize : undefined,
      useScreenFallback,
      screenWidth,
      screenHeight,
      videoHeight,
      windowWidth,
      windowHeight,
      playerMode,
    }

    const now = Date.now()
    const payloadKey = JSON.stringify(payload)
    const minIntervalMs = 500
    if (now - pipLayoutLastLogAtRef.current < minIntervalMs && payloadKey === pipLayoutLastPayloadRef.current) return

    pipLayoutLastLogAtRef.current = now
    pipLayoutLastPayloadRef.current = payloadKey
    console.log('[VideoPlayerOverlay] PiP layout:', payload)
  }, [
    isInPipMode,
    pipWindowSize?.width,
    pipWindowSize?.height,
    useScreenFallback,
    screenWidth,
    screenHeight,
    videoHeight,
    windowWidth,
    windowHeight,
    playerMode,
  ])

  // Desktop video dimensions (YouTube-style - video takes ~70% width, max 1280px)
  const desktopVideoWidth = Math.min(screenWidth * 0.65, 1280)
  const desktopVideoHeightRaw = Math.round(desktopVideoWidth / effectiveAR)
  const desktopVideoHeight = effectiveAR < 1
    ? Math.min(desktopVideoHeightRaw, Math.round(screenHeight * 0.8))
    : desktopVideoHeightRaw
  const dynMiniWidth = Math.min(Math.round(MINI_PIP_HEIGHT * effectiveAR), MINI_PIP_WIDTH)

  useEffect(() => {
    if (!currentVideo || playerMode === 'hidden') return
    const player = Platform.OS === 'web' ? (isPear ? 'mpv' : 'web') : 'react-native-video'
    const channelKey = currentVideo.channelKey || currentVideo.channel?.key || ''
    const logKey = `${player}:${channelKey}:${currentVideo.id || videoUrl || ''}`
    if (playerLogKeyRef.current === logKey) return
    playerLogKeyRef.current = logKey
    if (typeof window !== 'undefined') {
      ;(window as any).__PEARTUBE_PLAYER__ = {
        player,
        videoId: currentVideo.id,
        channelKey,
      }
    }
    console.log('[VideoPlayerOverlay] Using player:', player, 'video:', currentVideo.id, 'channel:', channelKey)
  }, [currentVideo?.id, currentVideo?.channelKey, currentVideo?.channel?.key, videoUrl, playerMode])

  const { height: reportedTabBarHeight, paddingBottom: reportedTabBarPadding } = useTabBarMetrics()

  // State for showing seek feedback
  const [seekFeedback, setSeekFeedback] = useState<'left' | 'right' | null>(null)

  // State for drag seeking
  const [isSeeking, setIsSeeking] = useState(false)
  const [seekPosition, setSeekPosition] = useState(0)
  const [scrubPendingTime, setScrubPendingTime] = useState<number | null>(null)
  const scrubPendingSinceRef = useRef(0)
  const videoWrapperRef = useRef<View>(null)
  const [pipSupported, setPipSupported] = useState<boolean | null>(null)

  // State for showing custom controls overlay
  const [showControls, setShowControls] = useState(false)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  // State for true fullscreen (landscape, hidden UI)
  const [isLandscapeFullscreen, setIsLandscapeFullscreen] = useState(false)
  const autoPipEnabledRef = useRef(false)
  const [iosPipEnabled, setIosPipEnabled] = useState(false)

  // Mini player corner/drag state
  const [miniPlayerCorner, setMiniPlayerCorner] = useState<MiniPlayerCorner>('bottom-right')
  const [isDraggingMiniPlayer, setIsDraggingMiniPlayer] = useState(false)
  const [miniPlayerDragOffset, setMiniPlayerDragOffset] = useState({ x: 0, y: 0 })
  const miniPlayerDragStartRef = useRef({ x: 0, y: 0, cornerX: 0, cornerY: 0 })
  const [pendingLandscapeExit, setPendingLandscapeExit] = useState(false)
  const disableMiniLayoutOnAndroidSplit = Platform.OS === 'android' && androidSplitPlayerEnabled
  const showLegacyMiniUi =
    playerMode === 'mini' &&
    !isLandscapeFullscreen &&
    !pendingLandscapeExit &&
    !isInPipMode &&
    !disableMiniLayoutOnAndroidSplit
  const isLandscapeFullscreenShared = useSharedValue(false)
  const [channelMetaName, setChannelMetaName] = useState<string | null>(null)

  // Casting state
  const [showCastPicker, setShowCastPicker] = useState(false)
  const [isConnectingCast, setIsConnectingCast] = useState(false)
  const cast = useCast()
  const castPlay = cast.play
  const isCasting = cast.isConnected
  const castDeviceName = cast.connectedDevice?.name || 'Casting device'
  const castPlayback = cast.playbackState
  const castIsPlaying = castPlayback.state === 'playing' || castPlayback.state === 'buffering'
  const effectiveCurrentTime = isCasting ? castPlayback.currentTime : currentTime
  const effectiveDuration = isCasting ? castPlayback.duration : duration
  const effectiveIsPlaying = isCasting ? castIsPlaying : isPlaying
  const effectiveProgress = effectiveDuration > 0 ? effectiveCurrentTime / effectiveDuration : 0

  // Debounce cast buffering — brief BUFFERING from HLS segment transitions shouldn't flash the overlay
  const [castBufferingDebounced, setCastBufferingDebounced] = useState(false)
  const castBufferingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const isBuffering = castPlayback.state === 'buffering'
    if (isBuffering) {
      if (!castBufferingTimerRef.current) {
        castBufferingTimerRef.current = setTimeout(() => {
          setCastBufferingDebounced(true)
        }, 2000)
      }
    } else {
      if (castBufferingTimerRef.current) {
        clearTimeout(castBufferingTimerRef.current)
        castBufferingTimerRef.current = null
      }
      setCastBufferingDebounced(false)
    }
    return () => {
      if (castBufferingTimerRef.current) {
        clearTimeout(castBufferingTimerRef.current)
        castBufferingTimerRef.current = null
      }
    }
  }, [castPlayback.state])

  const showLoadingOverlay = isCasting ? castBufferingDebounced : isLoading
  const loadingLabel = isCasting ? `Casting to ${castDeviceName}...` : 'Connecting to P2P...'
  const castAutoPlayRef = useRef<string | null>(null)
  const castAutoPlayInFlightRef = useRef(false)

  // Sync seek position with current time when not seeking
  useEffect(() => {
    if (!isSeeking) {
      setSeekPosition(effectiveCurrentTime)
    }
  }, [effectiveCurrentTime, isSeeking])

  // Clear scrub pending lock once playback catches up (or after a timeout).
  // This prevents the scrubber UI from snapping back to stale progress right after commit.
  useEffect(() => {
    if (scrubPendingTime === null) return
    if (effectiveDuration <= 0) {
      setScrubPendingTime(null)
      return
    }

    const ageMs = Date.now() - scrubPendingSinceRef.current
    const closeEnough = Math.abs(effectiveCurrentTime - scrubPendingTime) < 0.75
    if (closeEnough || ageMs > 1500) {
      setScrubPendingTime(null)
    }
  }, [scrubPendingTime, effectiveCurrentTime, effectiveDuration])


  const isOwnComment = useCallback((c: any) => {
    if (!identity?.driveKey) return false
    return c?.authorKeyHex === identity.driveKey
  }, [identity?.driveKey])

  // Cast handlers
  const handleCastPress = useCallback(() => {
    setShowCastPicker(true)
    cast.startDiscovery()
  }, [cast])

  const handleCastDeviceSelect = useCallback(async (deviceId: string) => {
    setShowCastPicker(false)
    setIsConnectingCast(true)
    // Set in-flight flag BEFORE connect to prevent auto-cast effect from also calling play
    // The auto-cast effect checks this flag and bails out if true
    castAutoPlayInFlightRef.current = true
    try {
      pauseVideo()
      const success = await cast.connect(deviceId)
      if (!success) {
        setShowCastPicker(true)
        showCastAlert(cast.lastError || 'Failed to connect to Chromecast device.')
        castAutoPlayInFlightRef.current = false
        return
      }

      if (!currentVideo) {
        showCastAlert('No video selected for casting yet.')
        castAutoPlayInFlightRef.current = false
        return
      }

      let urlToCast = videoUrl
      if (!urlToCast && rpc?.getVideoUrl) {
        try {
          const videoRef = (currentVideo.path && typeof currentVideo.path === 'string' && currentVideo.path.startsWith('/'))
            ? currentVideo.path
            : currentVideo.id
          const result = await rpc.getVideoUrl({
            channelKey: currentVideo.channelKey,
            videoId: videoRef,
          })
          urlToCast = result?.url || null
        } catch (err: any) {
          setShowCastPicker(true)
          showCastAlert(err?.message || 'Failed to resolve video URL for casting.')
          castAutoPlayInFlightRef.current = false
          return
        }
      }

      if (!urlToCast) {
        setShowCastPicker(true)
        showCastAlert('Video URL is not ready yet. Try again once playback starts.')
        castAutoPlayInFlightRef.current = false
        return
      }

      // Set ref BEFORE play to prevent auto-cast effect from also calling play
      castAutoPlayRef.current = `${currentVideo.channelKey}:${currentVideo.id}`

      // Start casting the current video
      await cast.play({
        url: urlToCast,
        contentType: currentVideo.mimeType || 'video/mp4',
        title: currentVideo.title,
        time: currentTime,
      })
    } finally {
      setIsConnectingCast(false)
      // Reset in-flight flag - auto-cast effect can now run for different videos
      castAutoPlayInFlightRef.current = false
    }
  }, [cast, videoUrl, currentVideo, currentTime, rpc, pauseVideo])

  const handleCastDisconnect = useCallback(async () => {
    await cast.disconnect()
    if (currentVideo && videoUrl) {
      setTimeout(() => {
        resumeVideo()
      }, 80)
    }
  }, [cast, currentVideo, videoUrl, resumeVideo])

  const handleCloseCastPicker = useCallback(() => {
    setShowCastPicker(false)
    cast.stopDiscovery()
  }, [cast])

  // Auto-cast any loaded video while connected.
  useEffect(() => {
    if (!isCasting) {
      castAutoPlayRef.current = null
      castAutoPlayInFlightRef.current = false
      return
    }

    if (!currentVideo?.channelKey || !currentVideo?.id) return
    if (castAutoPlayInFlightRef.current) return

    const castKey = `${currentVideo.channelKey}:${currentVideo.id}`
    if (castAutoPlayRef.current === castKey) return

    let cancelled = false
    const startCast = async () => {
      castAutoPlayInFlightRef.current = true
      try {
        let urlToCast = videoUrl
        if (!urlToCast && rpc?.getVideoUrl) {
          const videoRef = (currentVideo.path && typeof currentVideo.path === 'string' && currentVideo.path.startsWith('/'))
            ? currentVideo.path
            : currentVideo.id
          const result = await rpc.getVideoUrl({
            channelKey: currentVideo.channelKey,
            videoId: videoRef,
          })
          urlToCast = result?.url || null
        }

        if (!urlToCast || cancelled) return

        castAutoPlayRef.current = castKey
        await castPlay({
          url: urlToCast,
          contentType: currentVideo.mimeType || 'video/mp4',
          title: currentVideo.title,
          time: Math.floor(currentTime || 0),
        })
      } finally {
        castAutoPlayInFlightRef.current = false
      }
    }

    startCast()
    return () => {
      cancelled = true
    }
  }, [isCasting, currentVideo?.channelKey, currentVideo?.id, videoUrl, rpc, castPlay])

  useEffect(() => {
    if (Platform.OS === 'web') return
    let cancelled = false
    console.log('[VideoPlayerOverlay] Checking PiP support...')
    MediaSession.isPictureInPictureSupported?.()
      .then((supported) => {
        console.log('[VideoPlayerOverlay] PiP supported:', supported)
        if (!cancelled) setPipSupported(supported)
      })
      .catch((err) => {
        console.log('[VideoPlayerOverlay] PiP support check failed:', err)
        if (!cancelled) setPipSupported(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // PiP source rect is computed natively from the actual SurfaceView/TextureView
  // position (see getVideoSourceRect in MediaSessionModule.kt). No JS-side rect needed.

  // Native overlay disabled - testing simple padding approach

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

  useEffect(() => {
    if (wasInPipRef.current && !isInPipMode && playerMode === 'fullscreen') {
      showControlsTemporarily()
      // Force layout recalculation after PiP exit — iOS PiP can leave
      // isPipLayoutActiveShared stale, causing the video to center vertically
      // instead of pinning to the top in portrait fullscreen.
      isPipLayoutActiveShared.value = false
      animProgress.value = 1
    }
  }, [isInPipMode, playerMode, showControlsTemporarily])

  const handlePipStatusChanged = useCallback((event: { isInPictureInPicture: boolean; width: number; height: number }) => {
    console.log('[VideoPlayerOverlay] PiP status changed:', event.isInPictureInPicture, event.width, event.height)
    setIsInPipMode(event.isInPictureInPicture)
    if (event.isInPictureInPicture && event.width > 0 && event.height > 0) {
      setPipWindowSize({ width: event.width, height: event.height })
    } else if (!event.isInPictureInPicture) {
      setPipWindowSize(null)
      if (AppState.currentState === 'active') {
        maximizePlayer()
      }
    }
  }, [setIsInPipMode, setPipWindowSize, maximizePlayer])

  // Handle video load - set PiP aspect ratio to match actual video dimensions
  const handleVideoLoad = useCallback((info: { duration?: number; videoSize?: { width: number; height: number } }) => {
    const width = info?.videoSize?.width
    const height = info?.videoSize?.height
    console.log('[VideoPlayerOverlay] Video loaded with dimensions:', width, 'x', height)

    // Update Android PiP aspect ratio to match video dimensions
    // This prevents zoom/stretch when entering PiP mode
    if (Platform.OS === 'android' && width && height && width > 0 && height > 0) {
      MediaSession.setPictureInPictureAspectRatio(width, height)
    }
  }, [])

   // Animation progress: 0 = mini, 1 = fullscreen
    // Initialize based on playerMode to avoid layout flash on first render
    const animProgress = useSharedValue(playerMode === 'fullscreen' ? 1 : 0)
    const isGestureActive = useSharedValue(false)
   const isInPipModeShared = useSharedValue(false)
   // Early PiP layout activation — true when PiP layout (frozen dims + translateY)
   // should be applied. Fires BEFORE isInPipMode by detecting window dimension
   // shrinkage from useWindowDimensions. On Android 12+ seamless PiP, the Activity
   // window shrinks gradually during the enter animation, so this catches the
   // transition gap where isInPipMode is still false but layout must be frozen.
   const isPipLayoutActiveShared = useSharedValue(false)
   const isAutoPipEnabledShared = useSharedValue(false)
  const isFullscreenShared = useSharedValue(playerMode === 'fullscreen')
  const splitPanTranslationY = useSharedValue(0)
  // Controls whether overlay elements (progress bar, time display, buttons) use
  // bottom-relative positioning (true) or top-computed positioning from
  // videoWrapperHeightShared (false). On mobile the container is already pushed
  // below the notch, so bottom-relative is correct and simpler. The false
  // branch adds insetTop again which would double-offset on Android.
  // TODO: unify positioning branches and remove this flag entirely.
  const useBottomRelativeOverlayShared = useSharedValue(Platform.OS !== 'web')
    const screenWidthShared = useSharedValue(screenWidth)
    const screenHeightShared = useSharedValue(screenHeight)
    // Raw activity window size from useWindowDimensions(). This changes during
    // Android 12+ seamless PiP (the window shrinks). Kept separate from screenWidth/
    // screenHeight which may be forced to real screen dims via useScreenFallback.
    const windowWidthShared = useSharedValue(windowWidth)
    const windowHeightShared = useSharedValue(windowHeight)
   // Real device screen dimensions — independent of PiP window resize.
   // Android system PiP: Activity stays fullscreen at compositor level,
   // so layout must use real screen size, not PiP-sized window dimensions.
    const realScreenWidthShared = useSharedValue(screenMetrics.width)
    const realScreenHeightShared = useSharedValue(screenMetrics.height)
    const videoHeightShared = useSharedValue(videoHeight)
    const miniPipDynWidthShared = useSharedValue(dynMiniWidth)
    const videoWrapperHeightShared = useSharedValue(videoHeight)
   const insetTopShared = useSharedValue(insets.top)
   const insetBottomShared = useSharedValue(insets.bottom)
    // Stable inset refs — Android PiP enter/exit can transiently report insetTop=0.
    // If we commit that 0, we lose cutout compensation in fullscreen and PiP.
    // Treat non-zero insets as authoritative; ignore 0 unless we truly have no
    // previous non-zero value.
    const stableInsetTopRef = useRef(insets.top)
    const stableInsetBottomRef = useRef(insets.bottom)
    const lastNonZeroInsetTopRef = useRef(insets.top)
    const lastNonZeroInsetBottomRef = useRef(insets.bottom)

    if (Platform.OS === 'android' && !isWindowLandscape) {
      if (insets.top > 0) lastNonZeroInsetTopRef.current = insets.top
      if (insets.bottom > 0) lastNonZeroInsetBottomRef.current = insets.bottom
    }

    const isAndroidFullscreenPipTransition = Platform.OS === 'android'
      && playerMode === 'fullscreen'
      && (
        isInPipMode || (
          windowWidth < screenMetrics.width * 0.9
          && windowHeight < screenMetrics.height * 0.9
        )
      )

    const resolvedInsetTop = (Platform.OS === 'android'
      && !isWindowLandscape
      && insets.top === 0
      && lastNonZeroInsetTopRef.current > 0)
      ? lastNonZeroInsetTopRef.current
      : insets.top

    const resolvedInsetBottom = (Platform.OS === 'android'
      && !isWindowLandscape
      && insets.bottom === 0
      && lastNonZeroInsetBottomRef.current > 0)
      ? lastNonZeroInsetBottomRef.current
      : insets.bottom

    // Outside the transition window we can freely update stable refs.
    // During the window, we still allow updates that INCREASE the inset (recovery),
    // but never updates that would drop it (0 glitch).
    if (!isAndroidFullscreenPipTransition) {
      stableInsetTopRef.current = resolvedInsetTop
      stableInsetBottomRef.current = resolvedInsetBottom
    } else {
      if (resolvedInsetTop > stableInsetTopRef.current) stableInsetTopRef.current = resolvedInsetTop
      if (resolvedInsetBottom > stableInsetBottomRef.current) stableInsetBottomRef.current = resolvedInsetBottom
    }
   // Frozen copies of layout values — updated ONLY when NOT in PiP.
   // Android PiP constraint: TextureView LayoutParams must NOT change during PiP
   // (resizing kills the SurfaceTexture → black screen). The PiP style branches
   // must produce EXACTLY the same dimensions as fullscreen. But videoHeight,
   // insetTop etc. get PiP-sized values once isInPipMode is true (because
   // useScreenFallback disables → screenWidth = PiP width). These frozen copies
   // hold the last fullscreen values so PiP branches can reproduce them.
   const frozenVideoHeightShared = useSharedValue(videoHeight)
   const frozenInsetTopShared = useSharedValue(insets.top)
   const frozenInsetBottomShared = useSharedValue(insets.bottom)

  // Calculate positions using measured tab bar metrics (preferred) with a safe fallback.
  // Pixel/Android gesture nav can report a non-zero bottom inset; never ignore it.
  const expectedTabBarHeight = TAB_BAR_HEIGHT + Math.max(insets.bottom, reportedTabBarPadding || 0)
  const miniPlayerBottom = Math.max(reportedTabBarHeight || 0, expectedTabBarHeight)
  const initialMiniPlayerPosition = getMobileMiniPlayerSnapPosition({
    corner: miniPlayerCorner,
    screenWidth,
    screenHeight,
    miniWidth: dynMiniWidth,
    topInset: stableInsetTopRef.current,
    bottomOffset: miniPlayerBottom,
  })

  // Mini player position: keep the selected corner across minimize/restore cycles on native.
  const miniPipX = useSharedValue(initialMiniPlayerPosition.x)
  const miniPipY = useSharedValue(initialMiniPlayerPosition.y)
  const isMiniPlayerModeShared = useSharedValue(playerMode === 'mini')
  const isMiniPlayerDraggingShared = useSharedValue(false)
  const miniDragStartXShared = useSharedValue(initialMiniPlayerPosition.x)
  const miniDragStartYShared = useSharedValue(initialMiniPlayerPosition.y)

  // Track whether gesture started in fullscreen (1) or mini (0) mode
  // Using number instead of string to avoid potential worklet string comparison issues
  const gestureStartedInFullscreen = useSharedValue(0)

   // CRITICAL: Update shared values SYNCHRONOUSLY during render, NOT in useEffect
   // useEffect runs AFTER the render commit, so worklets would see stale values
   // This is especially important for PiP mode where dimensions change rapidly
   isInPipModeShared.value = isInPipMode
   // Early PiP layout detection: activate PiP layout branches as soon as window
   // dimensions shrink, even before the JS isInPipMode event arrives.
   // On Android 12+ with setAutoEnterEnabled, the Activity window animates to PiP
   // dimensions BEFORE onPictureInPictureModeChanged fires. Without early detection,
   // the non-PiP fullscreen branches would run with intermediate/PiP-sized dimensions,
   // The 0.9 threshold catches even the START of the seamless PiP animation.
   // Uses AND (both dimensions must shrink) to avoid false positives in
   // split-screen mode where only one dimension is reduced.
    const prevIsInPipMode = pipModePrevRef.current
    pipModePrevRef.current = isInPipMode

    const isAndroidFullscreenForPip = Platform.OS === 'android' && playerMode === 'fullscreen'
    const isWindowShrunkForPip = isAndroidFullscreenForPip
      && windowWidth < screenMetrics.width * 0.9
      && windowHeight < screenMetrics.height * 0.9

    if (isAndroidFullscreenForPip) {
      if (!prevIsInPipMode && isInPipMode) {
        pipExitBlockEarlyDetectRef.current = false
      } else if (prevIsInPipMode && !isInPipMode) {
        // Exiting PiP: block early detection unconditionally. Android can report
        // stale PiP-sized window metrics for a few frames after exit; if we let the
        // shrink heuristic re-activate PiP layout in fullscreen, we lose the cutout
        // gap and can see transient artifacts.
        pipExitBlockEarlyDetectRef.current = true
      } else if (pipExitBlockEarlyDetectRef.current && !isWindowShrunkForPip) {
        pipExitBlockEarlyDetectRef.current = false
      }
    } else {
      pipExitBlockEarlyDetectRef.current = false
    }

    const isPipLayoutActive = isInPipMode || (!pipExitBlockEarlyDetectRef.current && isWindowShrunkForPip)
    isPipLayoutActiveShared.value = isPipLayoutActive
    isAutoPipEnabledShared.value = autoPipEnabledRef.current
    isFullscreenShared.value = playerMode === 'fullscreen'
    isMiniPlayerModeShared.value = playerMode === 'mini'
    screenWidthShared.value = screenWidth
    screenHeightShared.value = screenHeight
    windowWidthShared.value = windowWidth
    windowHeightShared.value = windowHeight
    realScreenWidthShared.value = screenMetrics.width
   realScreenHeightShared.value = screenMetrics.height
   videoHeightShared.value = videoHeight
   miniPipDynWidthShared.value = dynMiniWidth
   insetTopShared.value = stableInsetTopRef.current
   insetBottomShared.value = stableInsetBottomRef.current
   // Only update frozen values when NOT in PiP (or PiP-like transition) —
   // they hold pre-PiP fullscreen values. Use isPipLayoutActive (not isInPipMode)
   // so values freeze as soon as window dimensions start shrinking.
    if (!isPipLayoutActive) {
      frozenVideoHeightShared.value = videoHeight
      if (stableInsetTopRef.current > 0 || frozenInsetTopShared.value === 0) {
        frozenInsetTopShared.value = stableInsetTopRef.current
      }
      if (stableInsetBottomRef.current > 0 || frozenInsetBottomShared.value === 0) {
        frozenInsetBottomShared.value = stableInsetBottomRef.current
      }
    }

  // Note: animProgress is driven by the playerMode effect. Avoid forcing it during render.

  const miniPlayerBottomShared = useSharedValue(miniPlayerBottom)
  useEffect(() => {
    miniPlayerBottomShared.value = miniPlayerBottom
  }, [miniPlayerBottom])

  useEffect(() => {
    if (playerMode !== 'mini' || isDraggingMiniPlayer) return
    const nextMiniPlayerPosition = getMobileMiniPlayerSnapPosition({
      corner: miniPlayerCorner,
      screenWidth,
      screenHeight,
      miniWidth: dynMiniWidth,
      topInset: Math.max(stableInsetTopRef.current, insets.top),
      bottomOffset: miniPlayerBottom,
    })
    miniPipX.value = withSpring(nextMiniPlayerPosition.x, SPRING_CONFIG_TIGHT)
    miniPipY.value = withSpring(nextMiniPlayerPosition.y, SPRING_CONFIG_TIGHT)
  }, [playerMode, screenWidth, screenHeight, miniPlayerBottom, dynMiniWidth, miniPlayerCorner, insets.top, isDraggingMiniPlayer])

  // When exiting landscape fullscreen, keep rendering the fullscreen container until window dimensions AND insets settle.
  // The tricky part: StatusBar visibility + safe area insets can lag behind the orientation lock by a few frames.
  // If we show portrait info/actions too early, it lays out against transient dimensions/insets and visibly jumps.
  useEffect(() => {
    if (!pendingLandscapeExit) return
    if (isWindowLandscape) return

    // Ensure status bar is restored *before* we reveal portrait content.
    if (Platform.OS !== 'web') StatusBar.setHidden(false)

    // Wait for a stable snapshot of layout inputs before clearing landscape flags.
    // This avoids the portrait info/actions rendering against a transient (stale) top inset / window size.
    if (exitGateTimeoutRef.current) clearTimeout(exitGateTimeoutRef.current)
    exitGateLastSnapshotRef.current = null
    exitGateStableCountRef.current = 0
    exitGateAttemptsRef.current = 0

    const tick = () => {
      exitGateAttemptsRef.current += 1

      const snapshot = JSON.stringify({
        screenWidth,
        screenHeight,
        insetTop: insets.top,
        insetBottom: insets.bottom,
        tabBarHeight: reportedTabBarHeight,
        tabBarPadding: reportedTabBarPadding,
      })

      if (exitGateLastSnapshotRef.current === snapshot) {
        exitGateStableCountRef.current += 1
      } else {
        exitGateLastSnapshotRef.current = snapshot
        exitGateStableCountRef.current = 0
      }

      // Require 2 consecutive stable ticks, but also cap total wait to ~400ms to avoid getting stuck.
      if (exitGateStableCountRef.current >= 2 || exitGateAttemptsRef.current >= 8) {
        isLandscapeFullscreenShared.value = false
        setIsLandscapeFullscreen(false)
        setPendingLandscapeExit(false)
        exitGateTimeoutRef.current = null
        return
      }

      exitGateTimeoutRef.current = setTimeout(tick, 50)
    }

    // Kick off on next tick.
    exitGateTimeoutRef.current = setTimeout(tick, 0)

    return () => {
      if (exitGateTimeoutRef.current) {
        clearTimeout(exitGateTimeoutRef.current)
        exitGateTimeoutRef.current = null
      }
    }
  }, [
    pendingLandscapeExit,
    isWindowLandscape,
    screenWidth,
    screenHeight,
    insets.top,
    insets.bottom,
    reportedTabBarHeight,
    reportedTabBarPadding,
  ])

  // Fetch channel metadata so the channel row remains stable even when currentVideo lacks embedded channel info.
  useEffect(() => {
    let cancelled = false

    async function loadChannelMeta() {
      const channelKey = currentVideo?.channelKey || currentVideo?.channel?.key
      if (!channelKey || !rpc?.getChannelMeta) {
        setChannelMetaName(null)
        return
      }

      const now = Date.now()
      const cached = channelMetaNameCache.get(channelKey)
      if (cached && cached.expiresAt > now) {
        setChannelMetaName(cached.name)
        return
      }

      try {
        const result = await rpc.getChannelMeta({ channelKey })
        if (cancelled) return
        const name = result?.name || null
        channelMetaNameCache.set(channelKey, {
          name,
          expiresAt: now + CHANNEL_META_CACHE_TTL_MS,
        })
        setChannelMetaName(name)
      } catch (err) {
        if (cancelled) return
        console.warn('[VideoPlayerOverlay] Failed to load channel meta:', err)
        setChannelMetaName(null)
      }
    }

    loadChannelMeta()
    return () => {
      cancelled = true
    }
  }, [currentVideo?.channelKey])

  useEffect(() => {
    // Keep animProgress driven by JS mode changes.
    // Avoid forcing animProgress synchronously during render (it kills transitions
    // and can fight gesture worklets).
    if (isInPipMode) return
    if (disableMiniLayoutOnAndroidSplit) {
      animProgress.value = withTiming(1, { duration: 150 })
      return
    }
    if (playerMode === 'fullscreen') {
      if (maximizedForPipRef.current) {
        // Snap instantly — user is going to background, no need to animate
        animProgress.value = 1
      } else {
        animProgress.value = withTiming(1, { duration: 250 })
      }
    } else if (playerMode === 'mini') {
      animProgress.value = withTiming(0, { duration: 250 })
      showControlsTemporarily()
    } else if (playerMode === 'hidden') {
      animProgress.value = withTiming(0, { duration: 150 })
    }
  }, [playerMode, isInPipMode, disableMiniLayoutOnAndroidSplit])

  const maximizeFromMini = useCallback(() => {
    maximizePlayer()
  }, [maximizePlayer])

  const closeFromMini = useCallback(() => {
    setShowControls(false)
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
      controlsTimeoutRef.current = null
    }
    cancelAnimation(animProgress)
    closeVideo()
  }, [closeVideo, animProgress])

  const handleVideoTap = useCallback(() => {
    if (isInPipMode) return
    if (playerMode === 'fullscreen' || isLandscapeFullscreen || playerMode === 'mini') {
      if (showControls) {
        setShowControls(false)
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current)
        }
      } else {
        showControlsTemporarily()
      }
    }
  }, [isInPipMode, playerMode, isLandscapeFullscreen, showControls, showControlsTemporarily])

  // Memoize gesture to prevent recreation on every render.
  // The same pan path handles fullscreen drag-to-minimize and mobile mini-player drag/snap.
  const panGesture = useMemo(() => Gesture.Pan()
    .minDistance(12)
    .maxPointers(1)
    .onStart(() => {
      'worklet'
      if (isMiniPlayerModeShared.value && Platform.OS !== 'web' && !disableMiniLayoutOnAndroidSplit) {
        isGestureActive.value = true
        isMiniPlayerDraggingShared.value = true
        miniDragStartXShared.value = miniPipX.value
        miniDragStartYShared.value = miniPipY.value
        runOnJS(setIsDraggingMiniPlayer)(true)
        return
      }
      if (disableMiniLayoutOnAndroidSplit) {
        if (!isFullscreenShared.value) return
        if (isLandscapeFullscreenShared.value) return
        if (isPipLayoutActiveShared.value) return
        isGestureActive.value = true
        splitPanTranslationY.value = 0
        return
      }
      if (isLandscapeFullscreenShared.value) return
      if (isPipLayoutActiveShared.value) return

      const startedInFullscreen = isFullscreenShared.value ? 1 : 0
      if (startedInFullscreen === 0) return

      isGestureActive.value = true
      cancelAnimation(animProgress)
      animProgress.value = 1
      gestureStartedInFullscreen.value = 1
    })
    .onUpdate((event) => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        const minX = MINI_PIP_MARGIN
        const maxX = screenWidthShared.value - miniPipDynWidthShared.value - MINI_PIP_MARGIN
        const minY = insetTopShared.value + MINI_PIP_MARGIN
        const maxY = screenHeightShared.value - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - miniPlayerBottomShared.value

        miniPipX.value = Math.max(minX, Math.min(maxX, miniDragStartXShared.value + event.translationX))
        miniPipY.value = Math.max(minY, Math.min(maxY, miniDragStartYShared.value + event.translationY))
        return
      }
      if (disableMiniLayoutOnAndroidSplit) {
        if (!isGestureActive.value) return
        splitPanTranslationY.value = event.translationY
        return
      }
      if (!isGestureActive.value) return
      if (isLandscapeFullscreenShared.value) return
      if (isPipLayoutActiveShared.value) return

      const totalDistance = screenHeightShared.value - miniPlayerBottomShared.value - insetTopShared.value - MINI_PIP_HEIGHT
      const dragProgress = -event.translationY / totalDistance
      animProgress.value = Math.max(0, Math.min(1, 1 + dragProgress))
    })
    .onEnd((event) => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        isMiniPlayerDraggingShared.value = false
        isGestureActive.value = false

        const leftX = MINI_PIP_MARGIN
        const rightX = screenWidthShared.value - miniPipDynWidthShared.value - MINI_PIP_MARGIN
        const topY = insetTopShared.value + MINI_PIP_MARGIN
        const bottomY = screenHeightShared.value - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - miniPlayerBottomShared.value
        const isRight = miniPipX.value + miniPipDynWidthShared.value / 2 > screenWidthShared.value / 2
        const isBottom = miniPipY.value > (topY + bottomY) / 2
        const targetX = isRight ? rightX : leftX
        const targetY = isBottom ? bottomY : topY
        const newCorner = `${isBottom ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as MiniPlayerCorner

        miniPipX.value = withSpring(targetX, SPRING_CONFIG_TIGHT)
        miniPipY.value = withSpring(targetY, SPRING_CONFIG_TIGHT)
        runOnJS(setMiniPlayerCorner)(newCorner)
        runOnJS(setIsDraggingMiniPlayer)(false)
        return
      }
      if (disableMiniLayoutOnAndroidSplit) {
        const wasActive = isGestureActive.value
        isGestureActive.value = false
        const dragDownDistance = splitPanTranslationY.value
        splitPanTranslationY.value = 0
        if (wasActive && (dragDownDistance > 80 || event.velocityY > 500)) {
          runOnJS(minimizePlayer)()
          animProgress.value = withTiming(1, { duration: 120 })
          return
        }
        animProgress.value = withTiming(1, { duration: 120 })
        return
      }
      const wasActive = isGestureActive.value
      isGestureActive.value = false
      if (!wasActive) return
      if (isPipLayoutActiveShared.value) return

      const velocity = event.velocityY
      const position = animProgress.value

      let shouldMinimize = false
      if (velocity > 300) {
        shouldMinimize = true
      } else if (velocity < -300) {
        shouldMinimize = false
      } else if (position < 0.75) {
        shouldMinimize = velocity > 20
      } else {
        shouldMinimize = velocity > 100
      }

      if (shouldMinimize) {
        animProgress.value = withSpring(0, SPRING_CONFIG_TIGHT)
          runOnJS(minimizePlayer)()
      } else {
        animProgress.value = withSpring(1, SPRING_CONFIG_BOUNCY)
        runOnJS(maximizePlayer)()
      }
    })
    .onFinalize(() => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        isMiniPlayerDraggingShared.value = false
        runOnJS(setIsDraggingMiniPlayer)(false)
      }
      isGestureActive.value = false
      splitPanTranslationY.value = 0
  }), [disableMiniLayoutOnAndroidSplit, minimizePlayer, maximizePlayer])

  const composedGesture = panGesture

   // Animated styles for the container
   const containerStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        left: 0,
        top: 0,
        width: landscapeWidth.value,
        height: landscapeHeight.value,
        zIndex: 9999,
        backgroundColor: '#000',
        borderRadius: 0,
      }
    }

    if (isPipLayoutActiveShared.value) {
      if (Platform.OS === 'android') {
        // Android PiP: freeze layout at fullscreen dimensions.
        // Uses isPipLayoutActiveShared instead of isInPipModeShared to activate
        // BEFORE the JS PiP event — as soon as window dimensions start shrinking
        // (Android 12+ seamless PiP animation). This prevents any layout change
        // during the transition gap.
        // realScreenWidth/Height come from Dimensions.get('screen') and never
        // change, unlike screenWidthShared which gets PiP-sized values.
        //
        return {
          position: 'absolute',
          left: 0,
          top: 0,
          width: realScreenWidthShared.value,
          height: realScreenHeightShared.value,
          zIndex: 9999,
          borderRadius: 0,
          overflow: 'hidden',
          backgroundColor: '#000',
          elevation: 0,
          opacity: 1,
        }
      }
      // iOS: PiP handled at player level, use explicit dimensions
      // IMPORTANT: must use width/height (not right/bottom) so Reanimated
      // applies the same property set as the normal branch — otherwise stale
      // right/bottom values stick after PiP exit and break layout.
      return {
        position: 'absolute',
        left: 0,
        top: 0,
        width: screenWidthShared.value,
        height: screenHeightShared.value + insetBottomShared.value,
        zIndex: 9999,
        borderRadius: 0,
        backgroundColor: '#000',
      }
    }

    // On Android portrait, keep the entire fullscreen player page below the cutout
    // instead of translating the render surface inside a fixed-height slot.
    const fullscreenTopInset = Platform.OS === 'android' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value
      ? insetTopShared.value
      : 0
    const fullscreenHeightShared = screenHeightShared.value + insetBottomShared.value - fullscreenTopInset

    const width = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynWidthShared.value, screenWidthShared.value],
      Extrapolation.CLAMP
    )

    const height = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_HEIGHT, fullscreenHeightShared],
      Extrapolation.CLAMP
    )

    const left = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipX.value, 0],
      Extrapolation.CLAMP
    )

    const top = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipY.value, fullscreenTopInset],
      Extrapolation.CLAMP
    )

    const borderRadius = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_CORNER_RADIUS, 0],
      Extrapolation.CLAMP
    )

    const isMini = animProgress.value < 0.5

    return {
      position: 'absolute',
      left,
      top,
      width,
      height,
      zIndex: 9999,
      borderRadius,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: isMini ? 0.4 : 0,
      shadowRadius: 8,
      elevation: (Platform.OS !== 'android' && isMini) ? 10 : 0,
    }
  }, [])

  const videoStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        width: landscapeWidth.value,
        height: landscapeHeight.value,
        transform: [],
      }
    }

    if (isPipLayoutActiveShared.value) {
      if (Platform.OS === 'android') {
        // Freeze at EXACTLY the same dimensions as fullscreen to prevent
        // any Yoga relayout. TextureView LayoutParams change = black screen.
        // Android cutout handling already happens natively via MediaSession.
        return {
          width: realScreenWidthShared.value,
          height: frozenVideoHeightShared.value,
          flex: undefined,
          transform: [],
        }
        }
      // iOS: use explicit dimensions — never flex:1 (Reanimated won't clear it on branch switch)
      return {
        width: screenWidthShared.value,
        height: videoHeightShared.value,
        flex: undefined,
        transform: [],
      }
    }

    const cutoutFactor = interpolate(animProgress.value, [0.8, 1], [0, 1], Extrapolation.CLAMP)
    const effectiveInsetTop = Platform.OS !== 'web' && !isLandscapeFullscreenShared.value
      ? Math.max(frozenInsetTopShared.value, insetTopShared.value)
      : 0
    // Android already shifts/covers the SurfaceView natively. Doing it again in JS
    // makes the fullscreen player slot taller than the watch page spacer.
    const cutoutInset = Platform.OS === 'ios' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value
      ? effectiveInsetTop * cutoutFactor
      : 0

    const fullW = screenWidthShared.value
    const fullH = videoHeightShared.value + cutoutInset

    const miniScale = fullW > 0
      ? MINI_PIP_WIDTH / fullW
      : 1

    const scale = interpolate(
      animProgress.value,
      [0, 1],
      [miniScale, 1],
      Extrapolation.CLAMP
    )

    return {
      width: fullW,
      height: fullH,
      flex: undefined,
      transformOrigin: 'left top',
      transform: [{ scale }],
    }
  }, [])

  // Animated styles for mini player info (fades out when expanding)
  const miniInfoStyle = useAnimatedStyle(() => {
    'worklet'
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
  }, [])

  // Animated styles for fullscreen content (fades in when expanding)
  // Uses absolute positioning to avoid flex layout issues with animated parent containers.
  // Positioned at top: videoHeight to start exactly where the video ends.
  const fullscreenContentStyle = useAnimatedStyle(() => {
    'worklet'
    // When in fullscreen mode (animProgress = 1), always show content at full opacity
    // The interpolation is only for the mini->fullscreen animation transition
    const isFullscreen = animProgress.value >= 0.95
    const opacity = isFullscreen ? 1 : interpolate(
      animProgress.value,
      [0.5, 1],
      [0, 1],
      Extrapolation.CLAMP
    )

    const cutoutInset = Platform.OS === 'ios' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value && animProgress.value >= 0.95
      ? insetTopShared.value
      : 0
    // Calculate top position - video height for fullscreen, mini pip height for mini
    const top = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_HEIGHT, videoHeightShared.value + cutoutInset],
      Extrapolation.CLAMP
    )

    return {
      position: 'absolute',
      top,
      left: 0,
      right: 0,
      bottom: 0,
      opacity,
      display: animProgress.value < 0.3 ? 'none' : 'flex',
    }
  }, [])

   // Opacity-only style for overlay buttons (minimize, speed, cast) - no position overrides
   const fullscreenButtonsOpacityStyle = useAnimatedStyle(() => {
     'worklet'
     if (isFullscreenShared.value) {
       return {
         opacity: 1,
         display: 'flex',
       }
     }

     const isFullscreen = animProgress.value >= 0.95
     const opacity = isFullscreen ? 1 : interpolate(
       animProgress.value,
       [0.5, 1],
       [0, 1],
       Extrapolation.CLAMP
     )

     return {
       opacity,
       display: animProgress.value < 0.3 ? 'none' : 'flex',
     }
   }, [])

   // Video player positioning - always fill container
  const videoPlayerStyle = useAnimatedStyle(() => {
    'worklet'
    // Android PiP: freeze at EXACTLY the same position as fullscreen.
    // Cutout handling is already applied natively, so the JS wrapper stays at top: 0.
    if (isPipLayoutActiveShared.value && Platform.OS === 'android') {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }
    }
    // iOS PiP: explicit width/height (not right/bottom) for Reanimated consistency
    if (isPipLayoutActiveShared.value) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        width: screenWidthShared.value,
        height: videoHeightShared.value,
      }
    }
    // Only iOS needs JS-level cutout compensation here. Android fullscreen uses
    // the native MediaSession overlay + SurfaceView inset instead.
    const cutoutFactor = interpolate(animProgress.value, [0.8, 1], [0, 1], Extrapolation.CLAMP)
    const effectiveInsetTop = Platform.OS !== 'web' && !isLandscapeFullscreenShared.value
      ? Math.max(frozenInsetTopShared.value, insetTopShared.value)
      : 0
    const cutoutOffset = Platform.OS === 'ios'
      && !isInPipModeShared.value
      && !isLandscapeFullscreenShared.value
        ? effectiveInsetTop * cutoutFactor
        : 0
    return {
      position: 'absolute',
      top: cutoutOffset,
      left: 0,
      right: 0,
      bottom: 0,
    }
  }, [])

  // Controls overlay positioning - always fill the container
  const controlsOverlayStyle = useAnimatedStyle(() => {
    'worklet'
    if (useBottomRelativeOverlayShared.value || isLandscapeFullscreenShared.value || isInPipModeShared.value || animProgress.value < 0.95) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }
    }
    const wrapperHeight = useBottomRelativeOverlayShared.value
      ? videoHeightShared.value
      : (videoWrapperHeightShared.value > 0
        ? videoWrapperHeightShared.value
        : videoHeightShared.value)
    return {
      position: 'absolute',
      top: 0,
      left: 0,
      width: screenWidthShared.value,
      height: wrapperHeight,
    }
  }, [])

   // Progress bar style - positions at bottom, adjusts for landscape
  const progressBarStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 16,
         left: 16,
         right: 16,
         height: 32,
         justifyContent: 'flex-end',
         zIndex: 15,
         opacity: 1,
       }
     }

    if (useBottomRelativeOverlayShared.value) {
      const opacity = interpolate(
        animProgress.value,
        [0.5, 1],
        [0, 1],
        Extrapolation.CLAMP
      )
      return {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'flex-end',
        zIndex: 15,
        opacity: isFullscreenShared.value ? 1 : opacity,
      }
    }

    const cutoutInset = useBottomRelativeOverlayShared.value
      ? 0
      : Platform.OS === 'ios'
        && !isInPipModeShared.value
        && !isLandscapeFullscreenShared.value
        && animProgress.value >= 0.95
          ? insetTopShared.value
          : 0
    const baseHeight = (useBottomRelativeOverlayShared.value
      ? videoHeightShared.value
      : (videoWrapperHeightShared.value > 0
        ? videoWrapperHeightShared.value
        : videoHeightShared.value)) + cutoutInset

    if (isFullscreenShared.value) {
      return {
        position: 'absolute',
        top: baseHeight - 32,
        bottom: undefined,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'flex-end',
        zIndex: 15,
        opacity: 1,
      }
    }

      // In portrait, use fullscreenContentStyle opacity
      const opacity = interpolate(
        animProgress.value,
        [0.5, 1],
        [0, 1],
        Extrapolation.CLAMP
      )

    return {
      position: 'absolute',
      top: baseHeight - 32,
      bottom: undefined,
      left: 0,
      right: 0,
      height: 32,
      justifyContent: 'flex-end',
      zIndex: 15,
      opacity,
    }
  }, [])

   // Time display style - positions above progress bar
  const timeDisplayStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 56,
         left: 16,
         backgroundColor: 'rgba(0,0,0,0.6)',
         paddingHorizontal: 8,
         paddingVertical: 4,
         borderRadius: 4,
         zIndex: 10,
         opacity: 1,
       }
     }

    if (useBottomRelativeOverlayShared.value) {
      const opacity = isFullscreenShared.value ? 1 : 0
      return {
        position: 'absolute',
        bottom: 24,
        left: 12,
        backgroundColor: 'rgba(0,0,0,0.6)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        zIndex: 10,
        opacity,
      }
    }

    const cutoutInset = useBottomRelativeOverlayShared.value
      ? 0
      : Platform.OS === 'ios'
        && !isInPipModeShared.value
        && !isLandscapeFullscreenShared.value
        && animProgress.value >= 0.95
          ? insetTopShared.value
          : 0
    const baseHeight = (useBottomRelativeOverlayShared.value
      ? videoHeightShared.value
      : (videoWrapperHeightShared.value > 0
        ? videoWrapperHeightShared.value
        : videoHeightShared.value)) + cutoutInset

    if (isFullscreenShared.value) {
      return {
        position: 'absolute',
        top: baseHeight - 56,
        bottom: undefined,
        left: 12,
        backgroundColor: 'rgba(0,0,0,0.6)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        zIndex: 10,
        opacity: 1,
      }
    }

    return {
      position: 'absolute',
      top: baseHeight - 56,
      bottom: undefined,
      left: 12,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
      zIndex: 10,
      opacity: 0,
    }
  }, [])

  const actionButtonOffset = 84

  const minimizeButtonStyle = useAnimatedStyle(() => {
    'worklet'
    if (useBottomRelativeOverlayShared.value) {
      return {
        top: 12,
      }
    }
    return {
      top: insetTopShared.value + 12,
    }
  }, [])

  const speedButtonStyle = useAnimatedStyle(() => {
    'worklet'
    if (useBottomRelativeOverlayShared.value) {
      return {
        top: 12,
      }
    }
    return {
      top: insetTopShared.value + 12,
    }
  }, [])

  const castButtonStyle = useAnimatedStyle(() => {
    'worklet'
     if (isLandscapeFullscreenShared.value) {
       return {
         bottom: 64,
       }
     }

    if (useBottomRelativeOverlayShared.value) {
      return {
        bottom: 24,
      }
    }

    const cutoutInset = useBottomRelativeOverlayShared.value
      ? 0
      : Platform.OS === 'ios'
        && !isInPipModeShared.value
        && !isLandscapeFullscreenShared.value
        && animProgress.value >= 0.95
          ? insetTopShared.value
          : 0
     const baseHeight = (useBottomRelativeOverlayShared.value
       ? videoHeightShared.value
       : (videoWrapperHeightShared.value > 0
         ? videoWrapperHeightShared.value
         : videoHeightShared.value)) + cutoutInset

     return {
       top: baseHeight - actionButtonOffset,
     }
    }, [])

   // Fullscreen button style
  const fullscreenButtonStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 64,
        right: 16,
        zIndex: 10,
        opacity: 1,
      }
    }

    if (useBottomRelativeOverlayShared.value) {
      const opacity = interpolate(
        animProgress.value,
        [0.5, 1],
        [0, 1],
        Extrapolation.CLAMP
      )
      return {
        position: 'absolute',
        bottom: 24,
        right: 12,
        zIndex: 10,
        opacity: isFullscreenShared.value ? 1 : opacity,
      }
    }

     const cutoutInset = useBottomRelativeOverlayShared.value
       ? 0
       : Platform.OS === 'ios'
         && !isInPipModeShared.value
         && !isLandscapeFullscreenShared.value
         && animProgress.value >= 0.95
           ? insetTopShared.value
           : 0
     const baseHeight = (useBottomRelativeOverlayShared.value
       ? videoHeightShared.value
       : (videoWrapperHeightShared.value > 0
         ? videoWrapperHeightShared.value
         : videoHeightShared.value)) + cutoutInset

     if (isFullscreenShared.value) {
      return {
        position: 'absolute',
        top: baseHeight - actionButtonOffset,
        bottom: undefined,
        right: 12,
          zIndex: 10,
          opacity: 1,
        }
      }

      const opacity = interpolate(
        animProgress.value,
        [0.5, 1],
        [0, 1],
        Extrapolation.CLAMP
      )

     return {
       position: 'absolute',
       top: baseHeight - actionButtonOffset,
       bottom: undefined,
       right: 12,
       zIndex: 10,
       opacity,
     }
   }, [])

  // Note: videoAreaStyle wrapper removed - fullscreenContent now uses absolute positioning
  // with top: videoHeight to position content below video, avoiding flex layout issues

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    if (isCasting) {
      if (castIsPlaying) {
        cast.pause()
      } else {
        cast.resume()
      }
      return
    }

    if (isPlaying) {
      pauseVideo()
    } else {
      resumeVideo()
    }
  }, [isCasting, castIsPlaying, cast, isPlaying, pauseVideo, resumeVideo])

  const handleDesktopSeekStart = useCallback(() => {
    if (effectiveDuration > 0) {
      setIsSeeking(true)
    }
  }, [effectiveDuration])

  const handleDesktopSeekChange = useCallback((event: any) => {
    const value = Number(event?.target?.value)
    if (!Number.isFinite(value)) return
    setSeekPosition(value)
  }, [])

  const handleDesktopSeekEnd = useCallback(() => {
    if (effectiveDuration <= 0) return
    if (isSeeking) {
      if (isCasting) {
        cast.seek(seekPosition)
      } else {
        seekTo(seekPosition)
      }
      setIsSeeking(false)
    }
  }, [effectiveDuration, isSeeking, seekPosition, isCasting, cast, seekTo])

  // Handle double-tap seek - 10s forward/backward
  const handleDoubleTapSeek = useCallback((direction: 'left' | 'right') => {
    const delta = direction === 'left' ? -10 : 10
    if (isCasting) {
      const nextTime = Math.max(0, Math.min(effectiveCurrentTime + delta, effectiveDuration || 0))
      cast.seek(nextTime)
    } else {
      seekBy(delta)
    }
    setSeekFeedback(direction)
    setTimeout(() => setSeekFeedback(null), 500)
  }, [isCasting, effectiveCurrentTime, effectiveDuration, cast, seekBy])

  const handleScrubCommit = useCallback((timeSeconds: number) => {
    if (effectiveDuration <= 0) return
    const clamped = Math.max(0, Math.min(timeSeconds, effectiveDuration))
    setScrubPendingTime(clamped)
    scrubPendingSinceRef.current = Date.now()
    if (isCasting) {
      cast.seek(clamped)
    } else {
      seekTo(clamped)
    }
  }, [effectiveDuration, isCasting, cast, seekTo])


  // Cycle through playback speeds
  const cyclePlaybackSpeed = useCallback(() => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate)
    const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length
    setPlaybackRate(PLAYBACK_SPEEDS[nextIndex])
  }, [playbackRate, setPlaybackRate])

  // Toggle true fullscreen (landscape mode)
  const toggleLandscapeFullscreen = useCallback(async () => {
    if (Platform.OS === 'web') return

    try {
      if (pendingLandscapeExit) return

      if (isLandscapeFullscreen) {
        // Exit fullscreen - return to portrait.
        // Important: don't flip the React/Shared flags until the window has remeasured.
        setPendingLandscapeExit(true)
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
      } else {
        // Enter fullscreen - force landscape
        StatusBar.setHidden(true)
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE)
        isLandscapeFullscreenShared.value = true
        setIsLandscapeFullscreen(true)
        setPendingLandscapeExit(false)
        showControlsTemporarily()
      }
    } catch (err) {
      console.error('[VideoPlayer] Failed to change orientation:', err)
      // If the orientation lock failed, force state to a consistent "not landscape" config.
      isLandscapeFullscreenShared.value = false
      setIsLandscapeFullscreen(false)
      setPendingLandscapeExit(false)
      StatusBar.setHidden(false)
    }
  }, [isLandscapeFullscreen, pendingLandscapeExit, showControlsTemporarily])

  // Clean up orientation on unmount or video close
  useEffect(() => {
    return () => {
      if (isLandscapeFullscreenShared.value && Platform.OS !== 'web') {
        // Return to portrait when video player unmounts
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        StatusBar.setHidden(false)
      }
    }
  }, [])

  // Exit landscape fullscreen when player mode changes to mini or hidden
  useEffect(() => {
    if (Platform.OS === 'web') return
    if ((playerMode === 'mini' || playerMode === 'hidden') && isLandscapeFullscreen) {
      if (!pendingLandscapeExit) {
        setPendingLandscapeExit(true)
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch((err) => {
          console.error('[VideoPlayer] Failed to lock portrait on mode change:', err)
          isLandscapeFullscreenShared.value = false
          setIsLandscapeFullscreen(false)
          setPendingLandscapeExit(false)
          StatusBar.setHidden(false)
        })
      }
    }
  }, [playerMode, isLandscapeFullscreen, pendingLandscapeExit])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    // The inline Android watch player now uses the shared Media3 PlayerView host.
    // Translating its underlying SurfaceView down clips the fixed 16:9 player slot,
    // so keep the inline surface flush and let layout/insets be handled above it.
    MediaSession.setSurfaceViewInset(0).catch(() => {})
  }, [playerMode, isInPipMode, isLandscapeFullscreen])

  useEffect(() => {
    if (Platform.OS === 'web') return
    if (Platform.OS === 'android' && pipSupported === false) return
    const shouldAutoPip = Platform.OS === 'android'
      ? currentVideo !== null && !isCasting && isPlaying
      : (playerMode === 'fullscreen' || (playerMode === 'mini' && !disableMiniLayoutOnAndroidSplit)) &&
        currentVideo !== null &&
        !isCasting
    autoPipEnabledRef.current = shouldAutoPip
    if (isInPipMode) return
    console.log('[VideoPlayerOverlay] Auto-PiP effect, playerMode:', playerMode, 'hasVideo:', !!currentVideo, 'enabling:', shouldAutoPip)
    if (Platform.OS === 'android') {
      let cancelled = false
      const applyAutoPip = async () => {
        try {
          let enabled = shouldAutoPip
          if (androidSplitPlayerEnabled) {
            const inPlayerActivity = await MediaSession.isInPlayerActivity()
            if (cancelled) return
            enabled = enabled && inPlayerActivity
          }
          await MediaSession.setAutoPictureInPicture(enabled)
          if (!cancelled) {
            console.log('[VideoPlayerOverlay] Auto-PiP set:', enabled)
          }
        } catch (err) {
          if (!cancelled) {
            console.error('[VideoPlayerOverlay] Auto-PiP failed:', err)
          }
        }
      }
      applyAutoPip()
      return () => {
        cancelled = true
      }
    } else if (Platform.OS === 'ios') {
