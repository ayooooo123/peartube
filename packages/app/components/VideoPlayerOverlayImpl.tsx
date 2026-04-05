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
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { useCast } from '@/lib/cast'
import { DevicePickerModal } from '@/components/cast'

// Import modular video-player components
import {
  // Constants
  MINI_PIP_MARGIN,
  MINI_PIP_CORNER_RADIUS,
  MINI_PIP_COMPACT_WIDTH_FRACTION,
  MINI_PIP_COMPACT_WIDTH_MIN,
  MINI_PIP_COMPACT_WIDTH_MAX,
  MINI_PIP_EXPANDED_WIDTH_FRACTION,
  MINI_PIP_EXPANDED_WIDTH_MIN,
  MINI_PIP_EXPANDED_WIDTH_MAX,
  TAB_BAR_HEIGHT,

  SPRING_CONFIG_BOUNCY,
  SPRING_CONFIG_TIGHT,
  SPRING_CONFIG_MINI_SNAP,
  SNAP_LOW_SPEED,
  SNAP_FLING_SPEED,
  SNAP_TOSS_HORIZON,
  SNAP_FLING_HORIZON,
  SNAP_HYSTERESIS_PX,
  MINI_DRAG_SCALE,
  MINI_SHADOW_DOCKED,
  MINI_SHADOW_DRAGGING,
  MINI_DRAG_OVERSHOOT_X,
  MINI_DRAG_OVERSHOOT_TOP,
  MINI_DRAG_OVERSHOOT_BOTTOM,
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

// Use the real @expo/vector-icons components on all platforms.
// The font files are linked into Android assets by the withVectorIconFonts plugin.
const Feather = ExpoFeather
const Ionicons = ExpoIonicons

const CHANNEL_META_CACHE_TTL_MS = 5 * 60 * 1000
const channelMetaNameCache = new Map<string, { name: string | null; expiresAt: number }>()
const ZERO_EDGE_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })
type MiniPlayerCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

// ── Responsive mini-player geometry worklets ──────────────────────────

interface MiniBounds {
  leftBound: number
  rightBound: number
  topBound: number
  bottomBound: number
}

interface Anchor { x: number; y: number; corner: MiniPlayerCorner }

function computeMiniSize(screenWidth: number, aspectRatio: number, sizeMode: 'compact' | 'expanded' = 'compact') {
  'worklet'
  const ar = aspectRatio > 0 ? aspectRatio : 16 / 9
  const fraction = sizeMode === 'expanded' ? MINI_PIP_EXPANDED_WIDTH_FRACTION : MINI_PIP_COMPACT_WIDTH_FRACTION
  const minW = sizeMode === 'expanded' ? MINI_PIP_EXPANDED_WIDTH_MIN : MINI_PIP_COMPACT_WIDTH_MIN
  const maxW = sizeMode === 'expanded' ? MINI_PIP_EXPANDED_WIDTH_MAX : MINI_PIP_COMPACT_WIDTH_MAX
  const w = Math.max(minW, Math.min(maxW, Math.round(screenWidth * fraction)))
  const h = Math.round(w / ar)
  return { width: w, height: h }
}

function computeMiniBounds(
  screenWidth: number,
  screenHeight: number,
  insetTop: number,
  insetRight: number,
  insetBottom: number,
  insetLeft: number,
  bottomChrome: number,
  miniWidth: number,
  miniHeight: number,
): MiniBounds {
  'worklet'
  const margin = MINI_PIP_MARGIN
  const bottomMargin = Math.max(insetBottom + margin, bottomChrome + margin)
  return {
    leftBound: insetLeft + margin,
    rightBound: screenWidth - insetRight - margin - miniWidth,
    topBound: insetTop + margin,
    bottomBound: screenHeight - bottomMargin - miniHeight,
  }
}

function getCornerAnchors(bounds: MiniBounds): [Anchor, Anchor, Anchor, Anchor] {
  'worklet'
  return [
    { x: bounds.leftBound,  y: bounds.topBound,    corner: 'top-left' },
    { x: bounds.rightBound, y: bounds.topBound,    corner: 'top-right' },
    { x: bounds.leftBound,  y: bounds.bottomBound, corner: 'bottom-left' },
    { x: bounds.rightBound, y: bounds.bottomBound, corner: 'bottom-right' },
  ]
}

function resolveSnapTarget(
  releaseX: number,
  releaseY: number,
  vx: number,
  vy: number,
  anchors: readonly Anchor[],
  miniWidth: number,
  miniHeight: number,
  currentCorner: MiniPlayerCorner,
  bounds: MiniBounds,
): Anchor {
  'worklet'
  const speed = Math.sqrt(vx * vx + vy * vy)

  // Projection horizon by velocity regime
  let horizon = 0
  if (speed >= SNAP_FLING_SPEED) {
    horizon = SNAP_FLING_HORIZON
  } else if (speed >= SNAP_LOW_SPEED) {
    horizon = SNAP_TOSS_HORIZON
  }

  // Project release point, clamp to legal bounds
  let targetX = releaseX + vx * horizon
  let targetY = releaseY + vy * horizon
  targetX = Math.max(bounds.leftBound, Math.min(bounds.rightBound, targetX))
  targetY = Math.max(bounds.topBound, Math.min(bounds.bottomBound, targetY))

  // Target card center
  const tcx = targetX + miniWidth / 2
  const tcy = targetY + miniHeight / 2

  // Score each anchor by squared Euclidean center distance
  let bestAnchor = anchors[0]
  let bestScore = Infinity
  let currentAnchorScore = Infinity

  for (let i = 0; i < anchors.length; i++) {
    const acx = anchors[i].x + miniWidth / 2
    const acy = anchors[i].y + miniHeight / 2
    const score = (acx - tcx) * (acx - tcx) + (acy - tcy) * (acy - tcy)
    if (score < bestScore) {
      bestScore = score
      bestAnchor = anchors[i]
    }
    if (anchors[i].corner === currentCorner) {
      currentAnchorScore = score
    }
  }

  // Hysteresis: on slow release, prefer current corner if it's close enough
  if (speed < SNAP_LOW_SPEED && currentAnchorScore < Infinity) {
    const bestDist = Math.sqrt(bestScore)
    const currentDist = Math.sqrt(currentAnchorScore)
    if (currentDist - bestDist < SNAP_HYSTERESIS_PX) {
      for (let i = 0; i < anchors.length; i++) {
        if (anchors[i].corner === currentCorner) return anchors[i]
      }
    }
  }

  return bestAnchor
}

// ── JS-side snap position helper ──────────────────────────────────────

function getMobileMiniPlayerSnapPosition({
  corner,
  screenWidth,
  screenHeight,
  topInset,
  rightInset,
  bottomInset,
  leftInset,
  bottomOffset,
  aspectRatio,
  sizeMode,
}: {
  corner: MiniPlayerCorner
  screenWidth: number
  screenHeight: number
  topInset: number
  rightInset: number
  bottomInset: number
  leftInset: number
  bottomOffset: number
  aspectRatio: number
  sizeMode: 'compact' | 'expanded'
}) {
  const { width: miniWidth, height: miniHeight } = computeMiniSize(screenWidth, aspectRatio, sizeMode)
  const bounds = computeMiniBounds(
    screenWidth,
    screenHeight,
    topInset,
    rightInset,
    bottomInset,
    leftInset,
    bottomOffset,
    miniWidth,
    miniHeight,
  )
  const anchors = getCornerAnchors(bounds)
  const anchor = anchors.find(a => a.corner === corner) ?? anchors[3] // default BR
  return { x: anchor.x, y: anchor.y, width: miniWidth, height: miniHeight }
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
  const [showControls, setShowControls] = useState(false)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [miniPlayerCorner, setMiniPlayerCorner] = useState<MiniPlayerCorner>('bottom-right')
  const [miniPlayerSizeMode, setMiniPlayerSizeMode] = useState<'compact' | 'expanded'>('compact')
  const [isDraggingMiniPlayer, setIsDraggingMiniPlayer] = useState(false)
  const [miniPlayerDragOffset, setMiniPlayerDragOffset] = useState({ x: 0, y: 0 })
  const miniPlayerDragStartRef = useRef({ x: 0, y: 0, cornerX: 0, cornerY: 0 })

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
      showControlsTemporarily()
      // PiP re-arm is handled by the main auto-PiP effect using a ref flag.
    }
  }, [isInPipMode, showControlsTemporarily])

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
  const { width: dynMiniWidth, height: dynMiniHeight } = computeMiniSize(screenWidth, effectiveAR, miniPlayerSizeMode)

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
  const pipExitNeedsRearmRef = useRef(false)

  // State for true fullscreen (landscape, hidden UI)
  const [isLandscapeFullscreen, setIsLandscapeFullscreen] = useState(false)
  const autoPipEnabledRef = useRef(false)
  const [iosPipEnabled, setIosPipEnabled] = useState(false)

  // Mini player corner/drag state
  const [pendingLandscapeExit, setPendingLandscapeExit] = useState(false)
  const disableMiniLayoutOnAndroidSplit = Platform.OS === 'android' && androidSplitPlayerEnabled
  const showLegacyMiniUi =
    playerMode === 'mini' &&
    !isLandscapeFullscreen &&
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
    // PiP support is now handled natively by react-native-video
    // showNotificationControls=true means PiP is available on Android
    setPipSupported(true)
  }, [])

  // PiP source rect is computed natively from the actual SurfaceView/TextureView
  // position. No JS-side rect needed.

  // Native overlay disabled - testing simple padding approach

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

      if (Platform.OS !== 'android' && AppState.currentState === 'active') {
        maximizePlayer('overlay-pip-exit-ios')
      }
    }
  }, [setIsInPipMode, setPipWindowSize, maximizePlayer, pipSupported, currentVideo, isCasting])

  // Handle video load - set PiP aspect ratio to match actual video dimensions
  const handleVideoLoad = useCallback((info: { duration?: number; videoSize?: { width: number; height: number } }) => {
    const width = info?.videoSize?.width
    const height = info?.videoSize?.height
    console.log('[VideoPlayerOverlay] Video loaded with dimensions:', width, 'x', height)
    // PiP aspect ratio is handled natively by react-native-video
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
   const insetLeftShared = useSharedValue(insets.left)
   const insetRightShared = useSharedValue(insets.right)
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
    topInset: stableInsetTopRef.current,
    rightInset: insets.right,
    bottomInset: insets.bottom,
    leftInset: insets.left,
    bottomOffset: miniPlayerBottom,
    aspectRatio: effectiveAR,
    sizeMode: miniPlayerSizeMode,
  })

  // Mini player position: keep the selected corner across minimize/restore cycles on native.
  const miniPipX = useSharedValue(initialMiniPlayerPosition.x)
  const miniPipY = useSharedValue(initialMiniPlayerPosition.y)
  const isMiniPlayerModeShared = useSharedValue(playerMode === 'mini')
  const isMiniPlayerDraggingShared = useSharedValue(false)
  const miniDragStartXShared = useSharedValue(initialMiniPlayerPosition.x)
  const miniDragStartYShared = useSharedValue(initialMiniPlayerPosition.y)
  // UI-thread mirror of miniPlayerCorner for snap hysteresis (JS state can't be read in worklet)
  const currentDockCornerShared = useSharedValue<MiniPlayerCorner>(miniPlayerCorner)
  // Aspect ratio + size mode on UI thread for computeMiniSize in gesture worklets
  const aspectRatioShared = useSharedValue(effectiveAR)
  const miniPlayerSizeModeShared = useSharedValue<'compact' | 'expanded'>(miniPlayerSizeMode)
  // Dynamic mini height shared value for animated style interpolations
  const miniPipDynHeightShared = useSharedValue(dynMiniHeight)

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
   aspectRatioShared.value = effectiveAR

   // IMPORTANT: while in mini mode, miniPipDynWidth/Height and sizeMode are
   // animation/stateful values managed by gestures/effects. Don't overwrite them
   // synchronously during render or compact->expanded toggles will flash and revert.
   if (playerMode !== 'mini') {
     miniPipDynWidthShared.value = dynMiniWidth
     miniPipDynHeightShared.value = dynMiniHeight
     miniPlayerSizeModeShared.value = miniPlayerSizeMode
   }
   insetLeftShared.value = insets.left
   insetRightShared.value = insets.right
   insetTopShared.value = stableInsetTopRef.current
   insetBottomShared.value = stableInsetBottomRef.current
   currentDockCornerShared.value = miniPlayerCorner
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
    const nextPos = getMobileMiniPlayerSnapPosition({
      corner: miniPlayerCorner,
      screenWidth,
      screenHeight,
      topInset: Math.max(stableInsetTopRef.current, insets.top),
      rightInset: insets.right,
      bottomInset: insets.bottom,
      leftInset: insets.left,
      bottomOffset: miniPlayerBottom,
      aspectRatio: effectiveAR,
      sizeMode: miniPlayerSizeMode,
    })
    miniPipX.value = withSpring(nextPos.x, SPRING_CONFIG_MINI_SNAP)
    miniPipY.value = withSpring(nextPos.y, SPRING_CONFIG_MINI_SNAP)
    miniPipDynWidthShared.value = withSpring(nextPos.width, SPRING_CONFIG_MINI_SNAP)
    miniPipDynHeightShared.value = withSpring(nextPos.height, SPRING_CONFIG_MINI_SNAP)
    miniPlayerSizeModeShared.value = miniPlayerSizeMode
    currentDockCornerShared.value = miniPlayerCorner
  }, [playerMode, screenWidth, screenHeight, miniPlayerBottom, dynMiniWidth, dynMiniHeight, miniPlayerCorner, miniPlayerSizeMode, insets.top, insets.right, insets.bottom, insets.left, isDraggingMiniPlayer, effectiveAR])

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
    } else if (playerMode === 'hidden') {
      animProgress.value = withTiming(0, { duration: 150 })
    }
  }, [playerMode, isInPipMode, disableMiniLayoutOnAndroidSplit])

  const maximizeFromMini = useCallback(() => {
    maximizePlayer('overlay-mini-button')
  }, [maximizePlayer])

  const toggleMiniPlayerSizeMode = useCallback(() => {
    setMiniPlayerSizeMode((prev) => (prev === 'compact' ? 'expanded' : 'compact'))
  }, [])

  const closeFromMini = useCallback(() => {
    setShowControls(false)
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
      controlsTimeoutRef.current = null
    }
    cancelAnimation(animProgress)
    pauseVideo()
    closeVideo()
  }, [closeVideo, pauseVideo, animProgress])

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
        cancelAnimation(miniPipX)
        cancelAnimation(miniPipY)
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
        const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value, miniPlayerSizeModeShared.value)
        const bounds = computeMiniBounds(
          screenWidthShared.value,
          screenHeightShared.value,
          insetTopShared.value,
          insetRightShared.value,
          insetBottomShared.value,
          insetLeftShared.value,
          miniPlayerBottomShared.value,
          mw,
          mh,
        )
        miniPipX.value = Math.max(bounds.leftBound - MINI_DRAG_OVERSHOOT_X, Math.min(bounds.rightBound + MINI_DRAG_OVERSHOOT_X,
          miniDragStartXShared.value + event.translationX))
        miniPipY.value = Math.max(bounds.topBound - MINI_DRAG_OVERSHOOT_TOP, Math.min(bounds.bottomBound + MINI_DRAG_OVERSHOOT_BOTTOM,
          miniDragStartYShared.value + event.translationY))
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

      const totalDistance = screenHeightShared.value - miniPlayerBottomShared.value - insetTopShared.value - miniPipDynHeightShared.value
      const dragProgress = -event.translationY / totalDistance
      animProgress.value = Math.max(0, Math.min(1, 1 + dragProgress))
    })
    .onEnd((event) => {
      'worklet'
      if (isMiniPlayerDraggingShared.value) {
        isMiniPlayerDraggingShared.value = false
        isGestureActive.value = false

        const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value, miniPlayerSizeModeShared.value)
        const bounds = computeMiniBounds(
          screenWidthShared.value,
          screenHeightShared.value,
          insetTopShared.value,
          insetRightShared.value,
          insetBottomShared.value,
          insetLeftShared.value,
          miniPlayerBottomShared.value,
          mw,
          mh,
        )
        const anchors = getCornerAnchors(bounds)
        const snap = resolveSnapTarget(
          miniPipX.value, miniPipY.value,
          event.velocityX, event.velocityY,
          anchors, mw, mh,
          currentDockCornerShared.value,
          bounds,
        )

        miniPipX.value = withSpring(snap.x, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityX })
        miniPipY.value = withSpring(snap.y, { ...SPRING_CONFIG_MINI_SNAP, velocity: event.velocityY })
        currentDockCornerShared.value = snap.corner
        runOnJS(setMiniPlayerCorner)(snap.corner)
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
        runOnJS(maximizePlayer)('overlay-pan-snap')
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

  const miniSingleTapGesture = useMemo(() => Gesture.Tap()
    .maxDuration(250)
    .maxDistance(12)
    .onEnd((_evt, success) => {
      'worklet'
      if (!success) return
      if (!isMiniPlayerModeShared.value) return
      runOnJS(handleVideoTap)()
    }), [handleVideoTap])

  const miniDoubleTapGesture = useMemo(() => Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(240)
    .maxDuration(250)
    .maxDistance(16)
    .onEnd((_evt, success) => {
      'worklet'
      if (!success) return
      if (!isMiniPlayerModeShared.value) return

      const nextMode = miniPlayerSizeModeShared.value === 'compact' ? 'expanded' : 'compact'
      miniPlayerSizeModeShared.value = nextMode

      const { width: mw, height: mh } = computeMiniSize(screenWidthShared.value, aspectRatioShared.value, nextMode)
      const bounds = computeMiniBounds(
        screenWidthShared.value,
        screenHeightShared.value,
        insetTopShared.value,
        insetRightShared.value,
        insetBottomShared.value,
        insetLeftShared.value,
        miniPlayerBottomShared.value,
        mw,
        mh,
      )
      const anchors = getCornerAnchors(bounds)
      let target = anchors[3]
      for (let i = 0; i < anchors.length; i++) {
        if (anchors[i].corner === currentDockCornerShared.value) {
          target = anchors[i]
          break
        }
      }

      miniPipX.value = withSpring(target.x, SPRING_CONFIG_MINI_SNAP)
      miniPipY.value = withSpring(target.y, SPRING_CONFIG_MINI_SNAP)
      miniPipDynWidthShared.value = withSpring(mw, SPRING_CONFIG_MINI_SNAP)
      miniPipDynHeightShared.value = withSpring(mh, SPRING_CONFIG_MINI_SNAP)

      runOnJS(toggleMiniPlayerSizeMode)()
    }), [toggleMiniPlayerSizeMode])

  const composedGesture = useMemo(
    // Priority order:
    // 1. pan if movement occurs
    // 2. double tap for compact/expanded toggle
    // 3. single tap for mini controls
    () => Gesture.Exclusive(panGesture, miniDoubleTapGesture, miniSingleTapGesture),
    [panGesture, miniDoubleTapGesture, miniSingleTapGesture]
  )

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
      [miniPipDynHeightShared.value, fullscreenHeightShared],
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
    const isDragging = isMiniPlayerDraggingShared.value

    // Shadow tuning: stronger when dragging, softer when docked, zero in fullscreen
    const shadowOp = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.opacity : MINI_SHADOW_DOCKED.opacity)
      : 0
    const shadowRad = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.radius : MINI_SHADOW_DOCKED.radius)
      : 0
    const shadowOY = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.offsetY : MINI_SHADOW_DOCKED.offsetY)
      : 0
    const elev = isMini
      ? (isDragging ? MINI_SHADOW_DRAGGING.elevation : MINI_SHADOW_DOCKED.elevation)
      : 0

    // Subtle scale-down while dragging
    const scale = isMini && isDragging ? MINI_DRAG_SCALE : 1

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
      shadowOffset: { width: 0, height: shadowOY },
      shadowOpacity: shadowOp,
      shadowRadius: shadowRad,
      elevation: Platform.OS === 'android' ? elev : 0,
      transform: [{ scale }],
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
      // iOS PiP: use explicit dimensions — never flex:1 (Reanimated won't clear it on branch switch)
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
    const cutoutInset = Platform.OS === 'ios' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value
      ? effectiveInsetTop * cutoutFactor
      : 0

    const fullW = screenWidthShared.value
    const fullH = videoHeightShared.value + cutoutInset

    // Android mini-mode PiP reliability: keep the native player layer at a
    // fullscreen-width baseline, but make the baseline height match the ACTUAL
    // video aspect ratio instead of the generic player-page frame. Otherwise the
    // scaled mini wrapper carries fullscreen letterboxing into the mini player.
    if (Platform.OS === 'android' && isMiniPlayerModeShared.value) {
      const videoAr = aspectRatioShared.value > 0 ? aspectRatioShared.value : 16 / 9
      const baselineH = fullW / videoAr
      const scaleX = fullW > 0 ? miniPipDynWidthShared.value / fullW : 1
      const scaleY = baselineH > 0 ? miniPipDynHeightShared.value / baselineH : 1
      return {
        width: fullW,
        height: baselineH,
        flex: undefined,
        transformOrigin: 'left top',
        transform: [{ scaleX }, { scaleY }],
      }
    }

    // Non-Android-mini: interpolate directly to the same mini dimensions as the
    // outer container so the wrapper and video stay aligned.
    const width = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynWidthShared.value, fullW],
      Extrapolation.CLAMP
    )
    const height = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipDynHeightShared.value, fullH],
      Extrapolation.CLAMP
    )

    return {
      width,
      height,
      flex: undefined,
      transform: [],
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
      [miniPipDynHeightShared.value, videoHeightShared.value + cutoutInset],
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
    // Landscape fullscreen: near bottom
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 12,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'center',
        zIndex: 15,
        opacity: 1,
      }
    }

    // Bottom-relative overlay (e.g. fullscreen portrait with bottom-relative positioning)
    if (useBottomRelativeOverlayShared.value) {
      const opacity = interpolate(
        animProgress.value,
        [0.5, 1],
        [0, 1],
        Extrapolation.CLAMP
      )
      return {
        position: 'absolute',
        bottom: isFullscreenShared.value ? 12 : 0,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'center',
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

    // Fullscreen portrait: near video bottom
    if (isFullscreenShared.value) {
      return {
        position: 'absolute',
        top: baseHeight - 32 - 12,
        bottom: undefined,
        left: 0,
        right: 0,
        height: 32,
        justifyContent: 'center',
        zIndex: 15,
        opacity: 1,
      }
    }

    // Portrait non-fullscreen: flush at video bottom.
    // No opacity animation here — the Scrubber's own `visible` prop
    // (driven by showControls) is the sole visibility controller.
    return {
      position: 'absolute',
      top: baseHeight - 32,
      bottom: undefined,
      left: 0,
      right: 0,
      height: 32,
      justifyContent: 'center',
      zIndex: 15,
    }
  }, [])

   // Time display style - positions above progress bar
  const timeDisplayStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 44,
        left: 24,
        right: 24,
        zIndex: 10,
        opacity: 1,
      }
    }

    if (useBottomRelativeOverlayShared.value) {
      const opacity = isFullscreenShared.value ? 1 : 0
      return {
        position: 'absolute',
        bottom: 44,
        left: 24,
        right: 24,
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
        top: baseHeight - 32 - 12 - 24,
        bottom: undefined,
        left: 24,
        right: 24,
        zIndex: 10,
        opacity: 1,
      }
    }

    return {
      position: 'absolute',
      top: baseHeight - 32 - 12 - 24,
      bottom: undefined,
      left: 16,
      right: 16,
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

  const handleScrubStart = useCallback(() => {
    // Pause the auto-hide timer while scrubbing
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
      controlsTimeoutRef.current = null
    }
    setShowControls(true)
  }, [])

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
    // Restart auto-hide timer after scrub ends
    showControlsTemporarily()
  }, [effectiveDuration, isCasting, cast, seekTo, showControlsTemporarily])


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

  // PiP and surface inset handling is now done natively by react-native-video
  // setSurfaceViewInset and setAutoPictureInPicture are no longer needed

  // Unified PiP arming effect - now handled natively by react-native-video
  useEffect(() => {
    if (Platform.OS === 'web') return
    if (isInPipMode) return

    if (Platform.OS === 'android') {
      const shouldEnable =
        (playerMode === 'fullscreen' || playerMode === 'mini') &&
        currentVideo !== null &&
        !isCasting
      autoPipEnabledRef.current = shouldEnable
      // PiP arming is now handled natively by react-native-video's showNotificationControls
      return
    } else if (Platform.OS === 'ios') {
      const shouldEnable =
        (playerMode === 'fullscreen' || (playerMode === 'mini' && !disableMiniLayoutOnAndroidSplit)) &&
        currentVideo !== null &&
        !isCasting
      autoPipEnabledRef.current = shouldEnable
      setIosPipEnabled(shouldEnable)
    }
  }, [playerMode, currentVideo, isCasting, pipSupported, isInPipMode, disableMiniLayoutOnAndroidSplit, isLandscapeFullscreen])

  // Downloads context for browser-style download manager
  const { addDownload } = useDownloads()
  const currentDownloadStatus = useCurrentDownloadStatus(
    currentVideo?.id || currentVideo?.path,
    currentVideo?.channelKey || currentVideo?.channel?.key
  )
  const isDownloading = currentDownloadStatus === 'downloading' || currentDownloadStatus === 'queued'
  const isDownloaded = currentDownloadStatus === 'complete'

  // Handle video download - adds to downloads queue
  const handleDownload = useCallback(async () => {
    if (!currentVideo || isDownloading) return

    // Ensure RPC is ready
    if (!rpc) {
      Alert.alert('Download Failed', 'Backend not ready yet. Please try again in a moment.')
      return
    }

    // Get channel key from the video
    const channelKey = currentVideo.channelKey || currentVideo.channel?.key
    if (!channelKey) {
      Alert.alert('Download Failed', 'Could not determine channel for this video')
      return
    }

    // Add to downloads queue - DownloadsContext handles the rest
    await addDownload({
      ...currentVideo,
      channelKey,
    }, rpc)
  }, [currentVideo, isDownloading, addDownload])

  // Always register cleanup hooks (even when no video) to avoid changing hook order
  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    }
  }, [])

  // Debug: log player state
  useEffect(() => {
    if (__DEV__) {
      console.log('[VideoPlayerOverlay] State:', {
        hasCurrentVideo: !!currentVideo,
        videoId: currentVideo?.id,
        playerMode,
        videoUrl: videoUrl?.substring(0, 50),
        isPear,
        isDesktop,
      })
    }
  }, [currentVideo, playerMode, videoUrl, isPear, isDesktop])

  if (!currentVideo) {
    return null
  }

  if (disableMiniLayoutOnAndroidSplit && playerMode === 'mini' && !isInPipMode) {
    return null
  }

  const channelName =
    channelMetaName ||
    currentVideo.channel?.name ||
    `Channel ${currentVideo.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = channelName.charAt(0).toUpperCase()

  // Calculate mini player position based on corner
  const getMiniPlayerPosition = () => {
    const baseX = miniPlayerCorner.includes('right') ? screenWidth - DESKTOP_MINI_WIDTH - DESKTOP_MINI_PADDING - sidebarWidth : DESKTOP_MINI_PADDING
    const baseY = miniPlayerCorner.includes('bottom') ? screenHeight - DESKTOP_MINI_HEIGHT - DESKTOP_MINI_CONTROLS_HEIGHT - DESKTOP_MINI_PADDING - 108 : DESKTOP_MINI_PADDING + 108

    if (isDraggingMiniPlayer) {
      return {
        x: baseX + miniPlayerDragOffset.x,
        y: baseY + miniPlayerDragOffset.y,
      }
    }
    return { x: baseX, y: baseY }
  }

  // Handle mini player drag start
  const handleMiniPlayerDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDraggingMiniPlayer(true)
    const pos = getMiniPlayerPosition()
    miniPlayerDragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      cornerX: pos.x,
      cornerY: pos.y,
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - miniPlayerDragStartRef.current.x
      const deltaY = moveEvent.clientY - miniPlayerDragStartRef.current.y
      setMiniPlayerDragOffset({ x: deltaX, y: deltaY })
    }

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      const finalX = miniPlayerDragStartRef.current.cornerX + (upEvent.clientX - miniPlayerDragStartRef.current.x)
      const finalY = miniPlayerDragStartRef.current.cornerY + (upEvent.clientY - miniPlayerDragStartRef.current.y)

      const centerX = finalX + DESKTOP_MINI_WIDTH / 2
      const centerY = finalY + (DESKTOP_MINI_HEIGHT + DESKTOP_MINI_CONTROLS_HEIGHT) / 2
      const screenCenterX = (screenWidth - sidebarWidth) / 2 + sidebarWidth
      const screenCenterY = screenHeight / 2

      const isRight = centerX > screenCenterX
      const isBottom = centerY > screenCenterY

      const newCorner = `${isBottom ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as typeof miniPlayerCorner
      setMiniPlayerCorner(newCorner)
      setMiniPlayerDragOffset({ x: 0, y: 0 })
      setIsDraggingMiniPlayer(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  // Desktop mini player mode
  if (isDesktop && Platform.OS === 'web' && playerMode === 'mini') {
    const miniPos = getMiniPlayerPosition()

    return (
      <div
        style={{
          position: 'fixed',
          left: miniPos.x,
          top: miniPos.y,
          width: DESKTOP_MINI_WIDTH,
          zIndex: 9999,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: colors.bg,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
          border: `1px solid ${colors.border}`,
          cursor: isDraggingMiniPlayer ? 'grabbing' : 'default',
          userSelect: 'none',
          transition: isDraggingMiniPlayer ? 'none' : 'left 0.2s ease, top 0.2s ease',
        }}
      >
        {/* Drag handle - top bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 32,
            cursor: isDraggingMiniPlayer ? 'grabbing' : 'grab',
            zIndex: 10,
          }}
          onMouseDown={handleMiniPlayerDragStart}
        />

        {/* Video container */}
        <div
          style={{
            width: DESKTOP_MINI_WIDTH,
            height: DESKTOP_MINI_HEIGHT,
            backgroundColor: '#000',
            position: 'relative',
          }}
        >
          {isCasting ? (
            <div style={{ ...desktopStyles.castPlaceholder, height: DESKTOP_MINI_HEIGHT }}>
              <Feather name="cast" color={colors.primary} size={24} />
              <span style={{ fontSize: 12, color: colors.textMuted }}>Casting...</span>
            </div>
          ) : videoUrl ? (
            <MpvPlayer
              key={`mpv-mini:${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
              ref={playerRef}
              url={videoUrl}
              autoPlay
              onCanPlay={onPlaying}
              onPaused={onPaused}
              onPlaying={onPlaying}
              onEnded={onEnded}
              onError={(err) => onError?.({ nativeEvent: { error: err } } as any)}
              onProgress={(data) => onProgress?.({
                currentTime: data.currentTime * 1000,
                duration: data.duration * 1000,
              } as any)}
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <div style={{ ...desktopStyles.placeholder, height: DESKTOP_MINI_HEIGHT }}>
              <span style={{ fontSize: 32, color: colors.primary, fontWeight: '600' }}>
                {currentVideo.title.charAt(0).toUpperCase()}
              </span>
            </div>
          )}

          {/* Hover overlay with play/pause */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0, 0, 0, 0.3)',
              opacity: 0,
              transition: 'opacity 0.15s ease',
            }}
            className="mini-player-overlay"
            onClick={handlePlayPause}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: 'rgba(0, 0, 0, 0.7)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {effectiveIsPlaying ? (
                <Ionicons name="pause" color="#fff" size={24} />
              ) : (
                <Ionicons name="play" color="#fff" size={24} />
              )}
            </div>
          </div>

          {/* Progress bar at bottom of video */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 3,
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${effectiveProgress * 100}%`,
                backgroundColor: colors.primary,
                transition: 'width 0.1s linear',
              }}
            />
          </div>
        </div>

        {/* Controls bar */}
        <div
          style={{
            height: DESKTOP_MINI_CONTROLS_HEIGHT,
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            backgroundColor: colors.bgSecondary,
          }}
        >
          {/* Title and channel */}
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={maximizeFromMini}>
            <div
              style={{
                fontSize: 13,
                fontWeight: '500',
                color: colors.text,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {currentVideo.title}
            </div>
            <div
              style={{
                fontSize: 11,
                color: colors.textMuted,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {channelName}
            </div>
          </div>

          {/* Control buttons */}
          <button
            onClick={handlePlayPause}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              border: 'none',
              backgroundColor: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'background-color 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.bgHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            {effectiveIsPlaying ? (
              <Ionicons name="pause" color={colors.text} size={18} />
            ) : (
              <Ionicons name="play" color={colors.text} size={18} />
            )}
          </button>

          <button
            onClick={maximizeFromMini}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              border: 'none',
              backgroundColor: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'background-color 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.bgHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            title="Expand"
          >
            <Feather name="chevron-up" color={colors.text} size={18} />
          </button>

          <button
            onClick={closeVideo}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              border: 'none',
              backgroundColor: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'background-color 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.bgHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            title="Close"
          >
            <Feather name="x" color={colors.text} size={18} />
          </button>
        </div>

        {/* CSS for hover effect on video overlay */}
        <style>{`
          .mini-player-overlay:hover {
            opacity: 1 !important;
          }
        `}</style>
      </div>
    )
  }

  // Desktop: YouTube-style layout (fullscreen overlay)
  if (isDesktop && Platform.OS === 'web') {
    return (
      <div style={{ ...desktopStyles.overlay, left: sidebarWidth, transition: 'left 0.2s ease' }}>
        <div style={desktopStyles.container}>
          {/* Main content area */}
          <div style={desktopStyles.mainColumn}>
            {/* Video player */}
            <div style={{ ...desktopStyles.videoWrapper, width: desktopVideoWidth, height: desktopVideoHeight }}>
              {isCasting ? (
                <div style={desktopStyles.castPlaceholder}>
                  <Feather name="cast" color={colors.primary} size={40} />
                  <div style={desktopStyles.castTextBlock}>
                    <span style={desktopStyles.castTitle}>Casting to {castDeviceName}</span>
                    <span style={desktopStyles.castSubtitle}>{currentVideo.title}</span>
                  </div>
                </div>
              ) : videoUrl ? (
                <MpvPlayer
                  key={`mpv:${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
                  ref={playerRef}
                  url={videoUrl}
                  autoPlay
                  onCanPlay={onPlaying}
                  onPaused={onPaused}
                  onPlaying={onPlaying}
                  onEnded={onEnded}
                  onError={(err) => onError?.({ nativeEvent: { error: err } } as any)}
                  onProgress={(data) => onProgress?.({
                    currentTime: data.currentTime * 1000,
                    duration: data.duration * 1000,
                  } as any)}
                  style={{ width: '100%', height: '100%', borderRadius: 12 }}
                />
              ) : (
                <div style={desktopStyles.placeholder}>
                  <span style={desktopStyles.placeholderText}>{currentVideo.title.charAt(0).toUpperCase()}</span>
                </div>
              )}
              {showLoadingOverlay && (
                <div style={desktopStyles.loadingOverlay}>
                  <ActivityIndicator color="white" size="large" />
                  <Text style={{ color: '#fff', marginTop: 12 }}>{loadingLabel}</Text>
                </div>
              )}
            </div>

            {/* Desktop playback controls */}
            <div style={desktopStyles.playerControls}>
              <button onClick={handlePlayPause} style={desktopStyles.controlButton} aria-label={effectiveIsPlaying ? 'Pause' : 'Play'}>
                <Feather name={effectiveIsPlaying ? 'pause' : 'play'} color={colors.text} size={16} />
              </button>
              <div style={desktopStyles.seekRow}>
                <input
                  type="range"
                  min={0}
                  max={effectiveDuration || 0}
                  step={0.1}
                  value={isSeeking ? seekPosition : effectiveCurrentTime}
                  disabled={effectiveDuration <= 0}
                  onMouseDown={handleDesktopSeekStart}
                  onTouchStart={handleDesktopSeekStart}
                  onChange={handleDesktopSeekChange}
                  onMouseUp={handleDesktopSeekEnd}
                  onTouchEnd={handleDesktopSeekEnd}
                  style={desktopStyles.seekInput}
                />
                <span style={desktopStyles.timeLabel}>
                  {formatDuration(isSeeking ? seekPosition : effectiveCurrentTime)} / {formatDuration(effectiveDuration)}
                </span>
              </div>
            </div>

            {/* Video info */}
            <div style={desktopStyles.videoInfo}>
              <h1 style={desktopStyles.title}>{currentVideo.title}</h1>
              {isCasting && (
                <div style={desktopStyles.castBanner}>
                  <Feather name="cast" color={colors.primary} size={14} />
                  <span style={desktopStyles.castBannerText}>Casting to {castDeviceName}</span>
                  <button
                    onClick={handleCastDisconnect}
                    style={desktopStyles.castDisconnectButton}
                    aria-label="Disconnect casting"
                  >
                    Disconnect
                  </button>
                </div>
              )}

              {/* P2P Stats Bar - matching mobile design */}
              <div style={desktopStyles.p2pStatsBar}>
                {/* Main stats row */}
                <div style={desktopStyles.p2pStatsRow}>
                  <div style={desktopStyles.p2pStatItem}>
                    <div style={{
                      ...desktopStyles.statusDot,
                      backgroundColor: videoStats?.isComplete ? '#4ade80' : videoStats?.status === 'downloading' ? '#fbbf24' : '#6b7280'
                    }} />
                    <span style={{
                      ...desktopStyles.statusLabel,
                      color: videoStats?.isComplete ? '#4ade80' : videoStats?.status === 'downloading' ? '#fbbf24' : '#6b7280'
                    }}>
                      {videoStats?.isComplete ? 'Cached' : videoStats?.status === 'downloading' ? 'Downloading' : 'Connecting'}
                    </span>
                  </div>
                  <span style={desktopStyles.p2pStatText}>{videoStats?.peerCount ?? 0} peers</span>
                  <span style={desktopStyles.p2pStatSpeed}>↓ {Number(videoStats?.speedMBps ?? 0).toFixed(2)} MB/s</span>
                  <span style={desktopStyles.p2pStatSpeedUp}>↑ {Number(videoStats?.uploadSpeedMBps ?? 0).toFixed(2)} MB/s</span>
                </div>
                {/* Details row */}
                <div style={desktopStyles.p2pStatsRowSecondary}>
                  <span style={desktopStyles.p2pStatDetail}>
                    {formatSize(videoStats?.downloadedBytes || 0)} / {formatSize(videoStats?.totalBytes || 0)}
                  </span>
                  <span style={desktopStyles.p2pStatDetail}>
                    {videoStats?.downloadedBlocks || 0} / {videoStats?.totalBlocks || 0} blocks
                  </span>
                  <span style={{
                    ...desktopStyles.p2pStatProgress,
                    color: videoStats?.isComplete ? '#4ade80' : colors.text
                  }}>
                    {videoStats?.progress ?? 0}%
                  </span>
                </div>
              </div>

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
                  <span style={desktopStyles.channelKey}>{currentVideo.channelKey?.slice(0, 16)}...</span>
                </div>
              </div>

              {/* Action buttons - Like, Dislike, Download */}
              <div style={desktopStyles.actions}>
                <button
                  onClick={() => toggleReaction('like')}
                  style={{
                    ...desktopStyles.reactionButton,
                    backgroundColor: userReaction === 'like' ? colors.primary : colors.bgSecondary,
                  }}
                >
                  <span style={{ color: userReaction === 'like' ? '#fff' : colors.text }}>
                    Like ({reactionCounts.like || 0})
                  </span>
                </button>
                <button
                  onClick={() => toggleReaction('dislike')}
                  style={{
                    ...desktopStyles.reactionButton,
                    backgroundColor: userReaction === 'dislike' ? colors.textSecondary : colors.bgSecondary,
                  }}
                >
                  <span style={{ color: userReaction === 'dislike' ? '#fff' : colors.text }}>
                    Dislike ({reactionCounts.dislike || 0})
                  </span>
                </button>
                <button
                  onClick={isDownloaded ? undefined : handleDownload}
                  disabled={isDownloaded || isDownloading}
                  style={{
                    ...desktopStyles.actionButton,
                    opacity: isDownloaded ? 0.7 : 1,
                    cursor: isDownloaded ? 'default' : 'pointer',
                  }}
                >
                  <Feather name={isDownloaded ? 'check' : 'download'} color={isDownloaded ? colors.primary : colors.text} size={18} />
                  <span style={desktopStyles.actionLabel}>
                    {isDownloaded ? 'Downloaded' : isDownloading ? 'Downloading...' : 'Download'}
                  </span>
                </button>
              </div>

              {/* Description */}
              {currentVideo.description && (
                <div style={desktopStyles.description}>
                  <p style={desktopStyles.descriptionText}>{currentVideo.description}</p>
                </div>
              )}

              {/* Comments Section */}
              <div style={desktopStyles.commentsSection}>
                <div style={desktopStyles.commentsHeader}>
                  <h3 style={desktopStyles.commentsTitle}>
                    {displayComments.length > 0 ? `${displayComments.length} Comment${displayComments.length !== 1 ? 's' : ''}` : 'Comments'}
                  </h3>
                  <button onClick={refreshComments} disabled={refreshingComments} style={desktopStyles.refreshButton}>
                    <Feather name="rotate-ccw" color={colors.primary} size={14} />
                    <span>{refreshingComments ? 'Refreshing...' : 'Refresh'}</span>
                  </button>
                </div>

                {/* Comment composer */}
                <div style={desktopStyles.commentComposer}>
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment..."
                    style={desktopStyles.commentInput}
                    onKeyDown={(e) => { if (e.key === 'Enter' && commentText.trim()) postComment() }}
                  />
                  <button
                    onClick={postComment}
                    disabled={postingComment || !commentText.trim()}
                    style={{ ...desktopStyles.postButton, opacity: (postingComment || !commentText.trim()) ? 0.5 : 1 }}
                  >
                    {postingComment ? 'Posting...' : 'Post'}
                  </button>
                </div>

                {/* Comments list */}
                <div style={desktopStyles.commentsList}>
                  {commentsLoading && displayComments.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center' as const }}>
                      <ActivityIndicator color={colors.primary} />
                    </div>
                  ) : displayComments.length === 0 ? (
                    <p style={desktopStyles.noComments}>No comments yet. Be the first to comment!</p>
                  ) : (
                    organizedComments.map((c: any) => (
                      <div key={c.commentId} style={desktopStyles.commentItem}>
                        <div style={desktopStyles.commentHeader}>
                          <span style={desktopStyles.commentAuthor}>
                            {(c.authorKeyHex || '').slice(0, 12)}…
                          </span>
                          <span style={desktopStyles.commentTime}>
                            {formatTimeAgo(c.timestamp || Date.now())}
                          </span>
                          {c.isAdmin && <span style={desktopStyles.adminBadge}>Admin</span>}
                        </div>
                        <p style={desktopStyles.commentText}>{c.content}</p>
                        {c.replies?.length > 0 && (
                          <div style={desktopStyles.replies}>
                            {c.replies.map((r: any) => (
                              <div key={r.commentId} style={desktopStyles.replyItem}>
                                <span style={desktopStyles.commentAuthor}>{(r.authorKeyHex || '').slice(0, 12)}…</span>
                                <p style={desktopStyles.commentText}>{r.content}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Minimize button */}
          <button onClick={minimizePlayer} style={desktopStyles.minimizeButton} aria-label="Minimize">
            <Feather name="minus" color={colors.text} size={24} />
          </button>

          {/* Close button */}
          <button onClick={closeVideo} style={desktopStyles.closeButton} aria-label="Close">
            <Feather name="x" color={colors.text} size={24} />
          </button>
        </div>
      </div>
    )
  }

  const overlayContent = (
    <>
      {showLoadingOverlay && !isInPipMode && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="white" size="large" />
          <Text style={styles.loadingText}>{loadingLabel}</Text>
        </View>
      )}

      {(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && !isInPipMode && (
        <Animated.View pointerEvents="box-none" style={[styles.controlsOverlayBase, controlsOverlayStyle]}>
          <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('left')}>
            <Feather name="rotate-ccw" color="#fff" size={22} />
          </Pressable>

          <Pressable style={styles.controlButtonLarge} onPress={handlePlayPause}>
            {effectiveIsPlaying ? (
              <Ionicons name="pause" color="#fff" size={32} />
            ) : (
              <Ionicons name="play" color="#fff" size={32} />
            )}
          </Pressable>

          <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('right')}>
            <Feather name="rotate-cw" color="#fff" size={22} />
          </Pressable>
        </Animated.View>
      )}

      {seekFeedback && (
        <View style={[
          styles.seekFeedback,
          seekFeedback === 'left' ? styles.seekFeedbackLeft : styles.seekFeedbackRight
        ]}>
          {seekFeedback === 'left' ? (
            <Feather name="rotate-ccw" color="#fff" size={32} />
          ) : (
            <Feather name="rotate-cw" color="#fff" size={32} />
          )}
          <Text style={styles.seekFeedbackText}>10s</Text>
        </View>
      )}

      {playerMode === 'fullscreen' && showControls && !isLandscapeFullscreen && !isInPipMode && (
        <Animated.View style={[styles.minimizeButton, fullscreenButtonsOpacityStyle, minimizeButtonStyle]}>
          <Pressable testID="player-minimize-button" onPress={minimizePlayer} style={styles.minimizeButtonInner}>
            <Feather name="chevron-down" color="#fff" size={28} />
          </Pressable>
        </Animated.View>
      )}

      {playerMode === 'fullscreen' && showControls && !isLandscapeFullscreen && !isInPipMode && (
        <Animated.View style={[styles.speedButton, fullscreenButtonsOpacityStyle, speedButtonStyle]}>
          <Pressable onPress={cyclePlaybackSpeed} style={styles.speedButtonInner}>
            <Text style={styles.speedButtonText}>{playbackRate}x</Text>
          </Pressable>
        </Animated.View>
      )}

      {/* Cast button moved into time display row below */}

      {!isInPipMode && Platform.OS !== 'web' && playerMode !== 'mini' && playerMode !== 'hidden' && showControls && (
        <Scrubber
          containerStyle={progressBarStyle}
          duration={effectiveDuration}
          currentTime={effectiveCurrentTime}
          progress={effectiveProgress}
          bufferProgress={videoStats?.progress != null ? videoStats.progress / 100 : 0}
          pendingSeekTime={scrubPendingTime}
          disabled={effectiveDuration <= 0}
          externalGesture={panGesture}
          onScrubStart={handleScrubStart}
          onSeekCommit={handleScrubCommit}
        />
      )}

      {!isInPipMode && Platform.OS === 'web' && (
        <Animated.View style={progressBarStyle} pointerEvents="none">
          <View style={styles.thinProgressBg}>
            <View style={[styles.thinProgressFill, { width: `${effectiveProgress * 100}%` }]} />
          </View>
        </Animated.View>
      )}

      {(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && !isInPipMode && (
        <Animated.View style={timeDisplayStyle}>
          <View style={styles.timeDisplayRow}>
            <Text style={styles.timeText}>
              <Text style={styles.timeTextCurrent}>
                {formatDuration(isSeeking ? seekPosition : effectiveCurrentTime)}
              </Text>
              <Text style={styles.timeTextMuted}>
                {' / '}
                {formatDuration(effectiveDuration)}
              </Text>
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Pressable onPress={handleCastPress} style={styles.timeDisplayAction}>
                <Feather name="cast" color={cast.isConnected ? colors.primary : '#efeff1'} size={18} />
              </Pressable>
              <Pressable onPress={toggleLandscapeFullscreen} style={styles.timeDisplayAction}>
                <Feather
                  name={isLandscapeFullscreen ? 'minimize' : 'maximize'}
                  color="#efeff1"
                  size={20}
                />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      )}

      {/* Mini player progress bar removed — clean mini player without scrubber */}
    </>
  )

  // Mobile: Single render path - landscape uses View wrapper, portrait uses Animated.View.
  // The shared inline video view stays mounted across orientation changes for smooth transitions.
  const renderVideoPlayer = () => {
    if (isCasting) {
      return (
        <View style={styles.castPlaceholder}>
          <Feather name="cast" size={40} color={colors.primary} />
          <Text style={styles.castPlaceholderTitle}>Casting to {castDeviceName}</Text>
          <Text style={styles.castPlaceholderSubtitle} numberOfLines={1}>
            {currentVideo.title}
          </Text>
        </View>
      )
    }

    return (
      <>
        {Platform.OS !== 'web' && videoUrl && (
          <PearInlineVideoView
            style={StyleSheet.absoluteFill}
            playerRef={playerRef}
            videoUrl={videoUrl}
            playbackSession={playbackSession}
            currentVideoKey={`${currentVideo?.channelKey || ''}:${currentVideo?.id || ''}`}
            isPlaying={isPlaying}
            playbackRate={playbackRate}
            seekPosition={playerSeekPosition}
            isInPipMode={isInPipMode}
            pipWindowSize={pipWindowSize}
            pipEnabled={iosPipEnabled}
            videoTitle={currentVideo?.title}
            channelName={currentVideo?.channel?.name}
            thumbnailUrl={currentVideo?.thumbnailUrl}
            onLoad={handleVideoLoad}
            onPictureInPictureChanged={handlePipStatusChanged}
            onProgress={onProgress}
            onPlaying={onPlaying}
            onPaused={onPaused}
            onBuffering={onBuffering}
            onEnded={onEnded}
            onError={onError}
            onVideoStateChange={onVideoStateChange}
          />
        )}
        {Platform.OS === 'web' && isPear && videoUrl && (
          <MpvPlayer
            key={`mpv:${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
            ref={playerRef}
            url={videoUrl}
            autoPlay
            onCanPlay={onPlaying}
            onPaused={onPaused}
            onPlaying={onPlaying}
            onEnded={onEnded}
            onError={(err) => onError?.({ nativeEvent: { error: err } } as any)}
            onProgress={(data) => onProgress?.({
              currentTime: data.currentTime * 1000,
              duration: data.duration * 1000,
            } as any)}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
          />
        )}
        {!videoUrl && (
          <View style={styles.videoPlaceholder}>
            <Text style={styles.placeholderText}>
              {currentVideo.title.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
      </>
    )
  }

  const content = (
    <Animated.View style={[styles.container, containerStyle]}>
      <GestureDetector gesture={composedGesture}>
        <Animated.View
          ref={videoWrapperRef}
          style={[styles.videoWrapper, videoStyle]}
          onLayout={(event) => {
            const { height: h } = event.nativeEvent.layout
            if (h > 0 && h !== videoWrapperHeightShared.value) {
              videoWrapperHeightShared.value = h
            }
          }}
        >
          {Platform.OS === 'web' ? (
            <Pressable
              style={styles.videoBackground}
              onPress={handleVideoTap}
            >
              <Animated.View style={videoPlayerStyle}>
                {renderVideoPlayer()}
              </Animated.View>

              {overlayContent}
            </Pressable>
          ) : (
            <>
              <Animated.View style={videoPlayerStyle}>
                {renderVideoPlayer()}
              </Animated.View>
              {!isInPipMode && playerMode !== 'mini' && !showControls && (
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={handleVideoTap}
                  testID="video-tap-overlay"
                />
              )}
              {!isInPipMode && playerMode !== 'mini' && showControls && (
                <Pressable
                  // Leave the entire bottom controls region completely clear so
                  // scrubber/timestamps/buttons never compete with the tap overlay.
                  style={[StyleSheet.absoluteFill, { bottom: 140 }]}
                  onPress={handleVideoTap}
                  testID="video-tap-overlay-upper"
                />
              )}
              {overlayContent}
            </>
          )}
        </Animated.View>
      </GestureDetector>

      {showLegacyMiniUi && showControls && (
        <>
          <View style={styles.miniPipTopRow} pointerEvents="box-none">
            <Pressable
              style={styles.miniPipSmallButton}
              onPress={closeFromMini}
              testID="mini-player-close"
            >
              <Feather name="x" size={18} color="#fff" />
            </Pressable>
            <Pressable
              style={styles.miniPipSmallButton}
              onPress={() => setTimeout(maximizeFromMini, 0)}
              testID="mini-player-maximize"
            >
              <Feather name="chevron-up" size={18} color="#fff" />
            </Pressable>
          </View>
          <Pressable
            style={styles.miniPipPlayPauseButton}
            onPress={handlePlayPause}
            testID="mini-player-play-pause"
          >
            <Feather name={isPlaying ? 'pause' : 'play'} size={22} color="#fff" />
          </Pressable>
        </>
      )}

      {!isLandscapeFullscreen && !isInPipMode && (
        <Animated.View
          style={[styles.fullscreenContent, fullscreenContentStyle]}
        >
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* P2P Stats - show on native and Pear desktop */}
            {(Platform.OS !== 'web' || isPear) && <P2PStatsBar stats={videoStats} />}

            {/* Video Info */}
            <View style={styles.videoInfo}>
              <Text style={styles.videoTitle}>{currentVideo.title}</Text>
              {isCasting && (
                <View style={styles.castBanner}>
                  <Feather name="cast" color={colors.primary} size={14} />
                  <Text style={styles.castBannerText}>Casting to {castDeviceName}</Text>
                  <Pressable onPress={handleCastDisconnect} style={styles.castBannerAction}>
                    <Text style={styles.castBannerActionText}>Disconnect</Text>
                  </Pressable>
                </View>
              )}
              <Text style={styles.videoMeta}>
                {formatTimeAgo(currentVideo.uploadedAt)} · {formatSize(currentVideo.size)}
              </Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actions}>
              <ActionButton
                icon={({ color, size }: { color: string; size: number }) => <Feather name="thumbs-up" color={color} size={size} />}
                label={`Like${reactionCounts.like ? ` (${reactionCounts.like})` : ''}`}
                active={userReaction === 'like'}
                onPress={() => toggleReaction('like')}
              />
              <ActionButton
                icon={({ color, size }: { color: string; size: number }) => <Feather name="thumbs-down" color={color} size={size} />}
                label={`Dislike${reactionCounts.dislike ? ` (${reactionCounts.dislike})` : ''}`}
                active={userReaction === 'dislike'}
                onPress={() => toggleReaction('dislike')}
              />
              <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="share-2" color={color} size={size} />} label="Share" />
              {cast.available && (
                <ActionButton
                  icon={({ color, size }: { color: string; size: number }) => <Feather name="cast" color={color} size={size} />}
                  label={cast.isConnected ? 'Casting' : 'Cast'}
                  active={cast.isConnected}
                  onPress={handleCastPress}
                  loading={isConnectingCast}
                />
              )}
              <ActionButton
                icon={({ color, size }: { color: string; size: number }) => isDownloaded ? <Feather name="check" color={color} size={size} /> : <Feather name="download" color={color} size={size} />}
                label={isDownloaded ? 'Saved' : 'Download'}
                onPress={isDownloaded ? undefined : handleDownload}
                loading={isDownloading}
              />
              <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="more-horizontal" color={color} size={size} />} label="More" />
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

            {/* Comments */}
            <View style={styles.commentsSection}>
              <View style={styles.commentsHeader}>
                <Text style={styles.commentsTitle}>
                  {displayComments.length > 0 ? `${displayComments.length} Comment${displayComments.length !== 1 ? 's' : ''}` : 'Comments'}
                </Text>
                <Pressable
                  onPress={refreshComments}
                  disabled={refreshingComments}
                  style={[styles.refreshButton, refreshingComments && { opacity: 0.5 }]}
                >
                  {refreshingComments ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Feather name="rotate-ccw" color={colors.primary} size={16} />
                  )}
                  <Text style={styles.refreshButtonText}>Refresh</Text>
                </Pressable>
              </View>

              {replyToComment && (
                <View style={styles.replyIndicator}>
                  <Text style={styles.replyIndicatorText}>
                    Replying to {(replyToComment.authorKeyHex || '').slice(0, 8)}…
                  </Text>
                  <Pressable onPress={() => { setReplyToComment(null); setCommentText('') }} style={styles.cancelReplyButton}>
                    <Feather name="x" color={colors.textMuted} size={16} />
                  </Pressable>
                </View>
              )}

              <View style={styles.commentComposer}>
                <TextInput
                  value={commentText}
                  onChangeText={setCommentText}
                  placeholder={replyToComment ? 'Write a reply…' : 'Add a comment…'}
                  placeholderTextColor={colors.textMuted}
                  style={styles.commentInput}
                  multiline
                />
                <Pressable
                  onPress={postComment}
                  disabled={postingComment || !commentText.trim()}
                  style={[styles.commentButton, (postingComment || !commentText.trim()) && { opacity: 0.5 }]}
                >
                  <Text style={styles.commentButtonText}>{postingComment ? 'Posting…' : 'Post'}</Text>
                </Pressable>
              </View>

              {commentsLoading && displayComments.length === 0 ? (
                <View style={{ paddingVertical: 12 }}>
                  <ActivityIndicator color={colors.primary} />
                </View>
              ) : displayComments.length === 0 ? (
                <Text style={styles.commentsEmpty}>No comments yet. Be the first to comment!</Text>
              ) : (
                <View style={{ gap: 12, paddingBottom: 24 }}>
                  {organizedComments.map((c: any) => (
                    <View key={c.commentId}>
                      <View style={styles.commentItem}>
                        <View style={styles.commentHeader}>
                          <Text style={styles.commentAuthor}>
                            {(c.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(c.timestamp || Date.now())}
                          </Text>
                          {c.isAdmin && (
                            <Text style={styles.adminBadge}>Admin</Text>
                          )}
                          {c.pendingState && (
                            <Text style={styles.pendingBadge}>
                              {c.pendingState === 'failed' ? 'Failed' : 'Pending'}
                            </Text>
                          )}
                          <View style={styles.commentActions}>
                            <Pressable onPress={() => setReplyToComment(c)} style={styles.commentActionButton}>
                              <Feather name="corner-up-left" color={colors.textMuted} size={14} />
                            </Pressable>
                            {(isOwnComment(c) || c.pendingState) && (
                              <Pressable
                                onPress={() => deleteComment(c.commentId)}
                                disabled={deletingCommentId === c.commentId}
                                style={styles.commentActionButton}
                              >
                                {deletingCommentId === c.commentId ? (
                                  <ActivityIndicator size="small" color={colors.textMuted} />
                                ) : (
                                  <Feather name="trash-2" color="#f87171" size={14} />
                                )}
                              </Pressable>
                            )}
                          </View>
                        </View>
                        <Text style={c.pendingState ? styles.commentTextPending : styles.commentText}>{c.text}</Text>
                      </View>

                      {c.replies && c.replies.length > 0 && (
                        <View style={styles.repliesContainer}>
                          {c.replies.map((reply: any) => (
                            <View key={reply.commentId} style={styles.replyItem}>
                              <View style={styles.commentHeader}>
                                <Text style={styles.commentAuthor}>
                                  {(reply.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(reply.timestamp || Date.now())}
                                </Text>
                                {reply.isAdmin && (
                                  <Text style={styles.adminBadge}>Admin</Text>
                                )}
                                {reply.pendingState && (
                                  <Text style={styles.pendingBadge}>
                                    {reply.pendingState === 'failed' ? 'Failed' : 'Pending'}
                                  </Text>
                                )}
                                {(isOwnComment(reply) || reply.pendingState) && (
                                  <Pressable
                                    onPress={() => deleteComment(reply.commentId)}
                                    disabled={deletingCommentId === reply.commentId}
                                    style={styles.commentActionButton}
                                  >
                                    {deletingCommentId === reply.commentId ? (
                                      <ActivityIndicator size="small" color={colors.textMuted} />
                                    ) : (
                                      <Feather name="trash-2" color="#f87171" size={14} />
                                    )}
                                  </Pressable>
                                )}
                              </View>
                              <Text style={reply.pendingState ? styles.commentTextPending : styles.commentText}>{reply.text}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  ))}

                  {hasMoreComments && (
                    <Pressable
                      onPress={loadMoreComments}
                      disabled={loadingMoreComments}
                      style={styles.loadMoreButton}
                    >
                      {loadingMoreComments ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : (
                        <Text style={styles.loadMoreText}>Load more comments</Text>
                      )}
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </ScrollView>
        </Animated.View>
      )}
    </Animated.View>
  )

  return (
    <>
      {content}
      <DevicePickerModal
        visible={showCastPicker}
        onClose={handleCloseCastPicker}
        devices={cast.devices}
        connectedDevice={cast.connectedDevice}
        isDiscovering={cast.isDiscovering}
        onDeviceSelect={handleCastDeviceSelect}
        onDisconnect={handleCastDisconnect}
        onAddManualDevice={cast.addManualDevice}
        onRefresh={cast.startDiscovery}
      />
    </>
  )
}
