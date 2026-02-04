/**
 * VideoPlayerOverlay - YouTube-style animated video player
 * Single view that animates between mini player and fullscreen
 * Uses react-native-reanimated for smooth 60fps animations
 * Uses VLC player for broad codec support
 *
 * See ./video-player/ for modular components
 */
import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Platform, ScrollView, ActivityIndicator, Alert, StatusBar, Dimensions, TextInput } from 'react-native'
import { rpc } from '@peartube/platform/rpc'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { usePlatform } from '@/lib/PlatformProvider'
import { useSidebar, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from './desktop/constants'
import { useApp } from '@/lib/AppContext'

// VLC player for iOS/Android (conditionally loaded)
let VLCPlayer: any = null
if (Platform.OS !== 'web') {
  VLCPlayer = require('react-native-vlc-media-player').VLCPlayer
}

// MpvPlayer for Pear Desktop
import { MpvPlayer, MpvPlayerRef } from './MpvPlayer'

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  runOnJS,
  Extrapolation,
} from 'react-native-reanimated'
import { Feather, Ionicons } from '@expo/vector-icons'
import * as ScreenOrientation from 'expo-screen-orientation'
import { useVideoPlayerContext, VideoStats } from '@/lib/VideoPlayerContext'
import { useDownloads } from '@/lib/DownloadsContext'
import { colors } from '@/lib/colors'
import * as MediaSession from '../modules/expo-media-session/src'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { useCast } from '@/lib/cast'
import { CastButton, DevicePickerModal } from '@/components/cast'

// Import modular video-player components
import {
  // Constants
  MINI_PIP_WIDTH,
  MINI_PIP_HEIGHT,
  MINI_PIP_MARGIN,
  MINI_PIP_CORNER_RADIUS,
  TAB_BAR_HEIGHT,
  ANIMATION_DURATION,
  SWIPE_DISMISS_THRESHOLD,
  SWIPE_VELOCITY_THRESHOLD,
  SPRING_CONFIG,
  SPRING_CONFIG_BOUNCY,
  SPRING_CONFIG_TIGHT,
  DESKTOP_MINI_WIDTH,
  DESKTOP_MINI_HEIGHT,
  DESKTOP_MINI_PADDING,
  DESKTOP_MINI_CONTROLS_HEIGHT,
  PLAYBACK_SPEEDS,
  COMMENTS_PER_PAGE,
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
  TimeDisplay,
  SeekFeedback,
  LoadingOverlay,
  DesktopMiniPlayer,
  VideoContainer,
} from './video-player'

function showCastAlert(message: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message)
    return
  }
  Alert.alert('Chromecast', message)
}

export function VideoPlayerOverlay() {
  const insets = useSafeAreaInsets()
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const screenMetrics = Dimensions.get('screen')
  const { isDesktop, isPear } = usePlatform()

  // Debug log on mount
  useEffect(() => {
    console.log('[VideoPlayerOverlay] Mounted. isPear:', isPear, 'isDesktop:', isDesktop, 'Platform.OS:', Platform.OS)
    if (typeof window !== 'undefined') {
      console.log('[VideoPlayerOverlay] window.Pear:', !!(window as any).Pear)
      console.log('[VideoPlayerOverlay] PearWorkerClient:', !!(window as any).PearWorkerClient)
      console.log('[VideoPlayerOverlay] userAgent:', navigator?.userAgent?.substring(0, 100))
    }
  }, [isPear, isDesktop])

  const { isCollapsed } = useSidebar()
  const { identity } = useApp()
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
    progress: playbackProgress,
    playbackRate,
    vlcSeekPosition,
    isInPipMode,
    setIsInPipMode,
    pipWindowSize,
    setPipWindowSize,
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
    onVideoStateChange,
  } = useVideoPlayerContext()

  // Simplified PiP state tracking - trust the native event, don't over-engineer
  // Complex early detection and long transition buffers were fighting VLC's surface handling
  const wasInPipRef = useRef(false)

  useEffect(() => {
    if (isInPipMode) {
      wasInPipRef.current = true
    } else if (wasInPipRef.current) {
      wasInPipRef.current = false
      autoPipEnabledRef.current = false  // Reset overlay pattern on PiP exit
      showControlsTemporarily()
    }
  }, [isInPipMode])

  // Use screen fallback only when window dimensions are clearly stale (much smaller than screen)
  // This handles the brief moment when useWindowDimensions returns PiP-sized values after exit
  const useScreenFallback = !isInPipMode && (
    windowWidth < screenMetrics.width * 0.5 || windowHeight < screenMetrics.height * 0.5
  )

  // In PiP mode, use window dimensions directly - don't override with pipWindowSize
  // The native pipWindowSize values can be wrong (full screen size instead of PiP size)
  // React Native's useWindowDimensions gives us the actual window size
  const baseScreenWidth = useScreenFallback ? screenMetrics.width : windowWidth
  const baseScreenHeight = useScreenFallback ? screenMetrics.height : windowHeight
  const screenWidth = baseScreenWidth
  const screenHeight = baseScreenHeight
  const isWindowLandscape = screenWidth > screenHeight

  // Always use 16:9 for video height calculation - don't special case PiP
  // In PiP mode, the container fills the window and VLC handles aspect ratio via resizeMode="contain"
  const videoHeight = Math.round(screenWidth * 9 / 16)

  // Debug logging for PiP layout issues
  if (isInPipMode && Platform.OS === 'android') {
    console.log('[VideoPlayerOverlay] PiP layout:', {
      isInPipMode,
      pipWindowSize,
      pipContainerSize: isInPipMode && pipWindowSize ? pipWindowSize : undefined,
      useScreenFallback,
      screenWidth,
      screenHeight,
      videoHeight,
      windowWidth,
      windowHeight,
      playerMode,
    })
  }

  // Desktop video dimensions (YouTube-style - video takes ~70% width, max 1280px)
  const desktopVideoWidth = Math.min(screenWidth * 0.65, 1280)
  const desktopVideoHeight = Math.round(desktopVideoWidth * 9 / 16)

  useEffect(() => {
    if (!currentVideo || playerMode === 'hidden') return
    const player = Platform.OS === 'web' ? (isPear ? 'mpv' : 'web') : 'vlc'
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
  const progressBarRef = useRef<View>(null)
  const progressBarWidth = useRef(0)
  const videoWrapperRef = useRef<View>(null)
  const [pipSupported, setPipSupported] = useState<boolean | null>(null)

  // State for showing custom controls overlay
  const [showControls, setShowControls] = useState(false)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  // State for true fullscreen (landscape, hidden UI)
  const [isLandscapeFullscreen, setIsLandscapeFullscreen] = useState(false)
  const autoPipEnabledRef = useRef(false)
  
  // Desktop mini player drag state
  const [miniPlayerCorner, setMiniPlayerCorner] = useState<'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'>('bottom-right')
  const [isDraggingMiniPlayer, setIsDraggingMiniPlayer] = useState(false)
  const [miniPlayerDragOffset, setMiniPlayerDragOffset] = useState({ x: 0, y: 0 })
  const miniPlayerDragStartRef = useRef({ x: 0, y: 0, cornerX: 0, cornerY: 0 })
  const [pendingLandscapeExit, setPendingLandscapeExit] = useState(false)
  const isLandscapeFullscreenShared = useSharedValue(false)
  const [channelMetaName, setChannelMetaName] = useState<string | null>(null)

  // ---------------------------------------
  // Social (comments + reactions) state
  // Lives in the overlay so it persists across minimize/maximize/fullscreen.
  // ---------------------------------------
  const [comments, setComments] = useState<any[]>([])
  const [pendingComments, setPendingComments] = useState<any[]>([])
  const [commentText, setCommentText] = useState('')
  const [replyToComment, setReplyToComment] = useState<any>(null)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [postingComment, setPostingComment] = useState(false)
  const [commentsPage, setCommentsPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(false)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  const [refreshingComments, setRefreshingComments] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)

  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({})
  const [userReaction, setUserReaction] = useState<string | null>(null)

  // Casting state
  const [showCastPicker, setShowCastPicker] = useState(false)
  const [isConnectingCast, setIsConnectingCast] = useState(false)
  const cast = useCast()
  const isCasting = cast.isConnected
  const castDeviceName = cast.connectedDevice?.name || 'Casting device'
  const castPlayback = cast.playbackState
  const castIsPlaying = castPlayback.state === 'playing' || castPlayback.state === 'buffering'
  const effectiveCurrentTime = isCasting ? castPlayback.currentTime : currentTime
  const effectiveDuration = isCasting ? castPlayback.duration : duration
  const effectiveIsPlaying = isCasting ? castIsPlaying : isPlaying
  const effectiveProgress = effectiveDuration > 0 ? effectiveCurrentTime / effectiveDuration : 0
  const showLoadingOverlay = isCasting ? castPlayback.state === 'buffering' : isLoading
  const loadingLabel = isCasting ? `Casting to ${castDeviceName}...` : 'Connecting to P2P...'
  const castAutoPlayRef = useRef<string | null>(null)
  const castAutoPlayInFlightRef = useRef(false)

  // Sync seek position with current time when not seeking
  useEffect(() => {
    if (!isSeeking) {
      setSeekPosition(effectiveCurrentTime)
    }
  }, [effectiveCurrentTime, isSeeking])



  const COMMENTS_PER_PAGE = 25

  const currentVideoKey = useMemo(() => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return null
    return `${currentVideo.channelKey}:${currentVideo.id}`
  }, [currentVideo?.channelKey, currentVideo?.id])

  const displayComments = useMemo(() => {
    if (pendingComments.length === 0) return comments
    const merged = new Map<string, any>()
    for (const c of comments) merged.set(c.commentId, c)
    for (const p of pendingComments) {
      const id = p.commentId || p.localId
      if (!id) continue
      if (!merged.has(id)) merged.set(id, p)
    }
    return Array.from(merged.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  }, [comments, pendingComments])

  const organizedComments = useMemo(() => {
    const byParent = new Map<string, any[]>()
    for (const c of displayComments) {
      const parentId = c?.parentId || ''
      if (!parentId) continue
      if (!byParent.has(parentId)) byParent.set(parentId, [])
      byParent.get(parentId)!.push(c)
    }
    const out: any[] = []
    for (const c of displayComments) {
      const parentId = c?.parentId || ''
      if (parentId) continue
      out.push({ ...c, replies: byParent.get(c.commentId) || [] })
    }
    return out
  }, [displayComments])

  const isOwnComment = useCallback((c: any) => {
    if (!identity?.driveKey) return false
    return c?.authorKeyHex === identity.driveKey
  }, [identity?.driveKey])

  const loadSocial = useCallback(async (page = 0, append = false, forceRefresh = false) => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    if (!rpc?.listComments || !rpc?.getReactions) return

    const ch = currentVideo.channelKey
    const canonicalVid = currentVideo.id
    const pubBee = (currentVideo as any).publicBeeKey || undefined  // Pass for comments key discovery

    const isInitialLoad = comments.length === 0
    if (!append && (isInitialLoad || forceRefresh)) {
      setCommentsLoading(true)
    }

    try {
      const [commentsRes, reactionsRes] = await Promise.all([
        rpc.listComments?.({ channelKey: ch, videoId: canonicalVid, publicBeeKey: pubBee, page, limit: COMMENTS_PER_PAGE }).catch(() => null),
        !append ? rpc.getReactions?.({ channelKey: ch, videoId: canonicalVid, publicBeeKey: pubBee }).catch(() => null) : Promise.resolve(null),
      ])

      const primaryOk = Boolean(commentsRes?.success && Array.isArray(commentsRes.comments))
      const primaryComments = primaryOk ? commentsRes.comments : []
      console.log('[VideoPlayer] listComments response:', { success: commentsRes?.success, count: primaryComments.length })
      if (primaryComments.length > 0) {
        console.log('[VideoPlayer] First comment isAdmin:', primaryComments[0]?.isAdmin, 'authorKeyHex:', primaryComments[0]?.authorKeyHex?.slice(0, 16))
        console.log('[VideoPlayer] Comments with isAdmin=true:', primaryComments.filter((c: any) => c.isAdmin).length)
      }

      if (append) {
        if (primaryComments.length > 0) setComments(prev => [...prev, ...primaryComments])
        setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
        setCommentsPage(page)
        if (primaryComments.length > 0) {
          const newIds = new Set(primaryComments.map((c: any) => c.commentId))
          setPendingComments(prev => prev.filter((p) => !p.commentId || !newIds.has(p.commentId)))
        }
      } else {
        if (primaryComments.length > 0) {
          setComments(primaryComments)
          setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
          setCommentsPage(page)
          const knownIds = new Set(primaryComments.map((c: any) => c.commentId))
          setPendingComments(prev => prev.filter((p) => !p.commentId || !knownIds.has(p.commentId)))
        } else if (isInitialLoad) {
          setComments([])
          setHasMoreComments(false)
        }
      }

      if (reactionsRes?.success) {
        const toCountMap = (countsData: any): Record<string, number> => {
          const counts: Record<string, number> = {}
          if (Array.isArray(countsData)) {
            for (const c of countsData) {
              if (c?.reactionType) counts[c.reactionType] = c.count || 0
            }
          } else if (countsData && typeof countsData === 'object') {
            for (const [k, v] of Object.entries(countsData)) {
              counts[k] = typeof v === 'number' ? v : 0
            }
          }
          return counts
        }

        setReactionCounts(toCountMap(reactionsRes.counts || {}))
        setUserReaction(reactionsRes.userReaction || null)
      }
    } finally {
      setCommentsLoading(false)
      setLoadingMoreComments(false)
      setRefreshingComments(false)
    }
  }, [currentVideo?.channelKey, currentVideo?.id, comments.length, rpc])

  // Reload social when the current video changes
  useEffect(() => {
    if (!currentVideoKey) return
    setComments([])
    setCommentText('')
    setReplyToComment(null)
    setCommentsPage(0)
    setHasMoreComments(false)
    setReactionCounts({})
    setUserReaction(null)
    // Best-effort load
    loadSocial(0, false, true).catch(() => {})
    // Best-effort index vectors (enables semantic search)
    rpc?.indexVideoVectors?.({ channelKey: currentVideo!.channelKey, videoId: currentVideo!.id }).catch(() => {})
  }, [currentVideoKey])

  // Keep comments/reactions reasonably fresh while the overlay is open.
  // This ensures comments posted on another device (e.g. desktop) show up on mobile without manual refresh.
  useEffect(() => {
    if (!currentVideoKey) return
    // Only poll when the player is visible; avoid work when hidden.
    if (playerMode === 'hidden') return
    // If in true landscape fullscreen we hide the scroll content; skip polling to reduce churn.
    if (isLandscapeFullscreen || pendingLandscapeExit) return

    const interval = setInterval(() => {
      // Best-effort refresh without forcing loading spinners
      loadSocial(0, false, false).catch(() => {})
    }, 5000)

    return () => clearInterval(interval)
  }, [currentVideoKey, playerMode, isLandscapeFullscreen, pendingLandscapeExit, loadSocial])

  const refreshComments = useCallback(async () => {
    setRefreshingComments(true)
    await loadSocial(0, false, true)
  }, [loadSocial])

  const loadMoreComments = useCallback(async () => {
    if (loadingMoreComments || !hasMoreComments) return
    setLoadingMoreComments(true)
    await loadSocial(commentsPage + 1, true, false)
  }, [loadingMoreComments, hasMoreComments, commentsPage, loadSocial])

  const postComment = useCallback(async () => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    const text = commentText.trim()
    if (!text) return
    const parentId = replyToComment?.commentId || null
    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const authorKeyHex = identity?.driveKey || 'local'
    setPendingComments(prev => [{
      commentId: localId,
      localId,
      text,
      authorKeyHex,
      timestamp: Date.now(),
      parentId,
      pendingState: 'sending',
    }, ...prev])
    setCommentText('')
    setReplyToComment(null)
    setPostingComment(true)
    try {
      const res = await rpc.addComment?.({
        channelKey: currentVideo.channelKey,
        videoId: currentVideo.id,
        publicBeeKey: (currentVideo as any).publicBeeKey || undefined,
        text,
        parentId
      })
      if (res?.success) {
        setPendingComments(prev => prev.map((p) => {
          if (p.localId !== localId) return p
          return {
            ...p,
            commentId: res.commentId || p.commentId,
            pendingState: res.queued ? 'queued' : 'pending',
          }
        }))
        await loadSocial(0, false, true)
      } else {
        setPendingComments(prev => prev.map((p) => (
          p.localId === localId ? { ...p, pendingState: 'failed' } : p
        )))
      }
    } catch {
      setPendingComments(prev => prev.map((p) => (
        p.localId === localId ? { ...p, pendingState: 'failed' } : p
      )))
    } finally {
      setPostingComment(false)
    }
  }, [currentVideoKey, commentText, replyToComment, loadSocial, rpc, identity?.driveKey])

  const deleteComment = useCallback(async (commentId: string) => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    if (pendingComments.some((p) => p.commentId === commentId || p.localId === commentId)) {
      setPendingComments(prev => prev.filter(p => p.commentId !== commentId && p.localId !== commentId))
      return
    }
    const pubBee = (currentVideo as any).publicBeeKey || undefined
    Alert.alert(
      'Delete Comment',
      'Are you sure you want to delete this comment?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingCommentId(commentId)
            try {
              const res = await rpc.removeComment?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee, commentId })
              if (res?.success) {
                setComments(prev => prev.filter(c => c.commentId !== commentId))
              }
            } finally {
              setDeletingCommentId(null)
            }
          }
        }
      ]
    )
  }, [currentVideoKey, rpc])

  const toggleReaction = useCallback(async (type: string) => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    const pubBee = (currentVideo as any).publicBeeKey || undefined
    try {
      if (userReaction === type) {
        await rpc.removeReaction?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee })
      } else {
        await rpc.removeReaction?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee })
        await rpc.addReaction?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee, reactionType: type })
      }
      await loadSocial(0, false, true)
    } catch {}
  }, [currentVideoKey, userReaction, loadSocial, rpc])

  // Cast handlers
  const handleCastPress = useCallback(() => {
    setShowCastPicker(true)
    cast.startDiscovery()
  }, [cast])

  const handleCastDeviceSelect = useCallback(async (deviceId: string) => {
    setIsConnectingCast(true)
    // Set in-flight flag BEFORE connect to prevent auto-cast effect from also calling play
    // The auto-cast effect checks this flag and bails out if true
    castAutoPlayInFlightRef.current = true
    try {
      const success = await cast.connect(deviceId)
      if (!success) {
        showCastAlert('Failed to connect to Chromecast device.')
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
          const videoAny = currentVideo as any
          const result = await rpc.getVideoUrl({
            channelKey: currentVideo.channelKey,
            videoId: videoRef,
            publicBeeKey: videoAny.publicBeeKey || undefined,
            blobId: videoAny.blobId || undefined,
            blobsCoreKey: videoAny.blobsCoreKey || undefined,
            mimeType: videoAny.mimeType || undefined,
          })
          urlToCast = result?.url || null
        } catch (err: any) {
          showCastAlert(err?.message || 'Failed to resolve video URL for casting.')
          castAutoPlayInFlightRef.current = false
          return
        }
      }

      if (!urlToCast) {
        showCastAlert('Video URL is not ready yet. Try again once playback starts.')
        castAutoPlayInFlightRef.current = false
        return
      }

      // Set ref BEFORE play to prevent auto-cast effect from also calling play
      castAutoPlayRef.current = `${currentVideo.channelKey}:${currentVideo.id}`
      setShowCastPicker(false)

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
  }, [cast, videoUrl, currentVideo, currentTime, rpc])

  const handleCastDisconnect = useCallback(async () => {
    await cast.disconnect()
  }, [cast])

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
          const videoAny = currentVideo as any
          const result = await rpc.getVideoUrl({
            channelKey: currentVideo.channelKey,
            videoId: videoRef,
            publicBeeKey: videoAny.publicBeeKey || undefined,
            blobId: videoAny.blobId || undefined,
            blobsCoreKey: videoAny.blobsCoreKey || undefined,
            mimeType: videoAny.mimeType || undefined,
          })
          urlToCast = result?.url || null
        }

        if (!urlToCast || cancelled) return

        const success = await cast.play({
          url: urlToCast,
          contentType: currentVideo.mimeType || 'video/mp4',
          title: currentVideo.title,
          time: Math.floor(currentTime || 0),
        })

        if (!cancelled) {
          // Always set castAutoPlayRef to prevent retry loops on failure
          castAutoPlayRef.current = castKey
        }
      } finally {
        castAutoPlayInFlightRef.current = false
      }
    }

    startCast()
    return () => {
      cancelled = true
    }
  }, [isCasting, currentVideo?.channelKey, currentVideo?.id, videoUrl, rpc, cast])

  // Check PiP support once on Android
  useEffect(() => {
    if (Platform.OS !== 'android') return
    let cancelled = false
    MediaSession.isPictureInPictureSupported?.()
      .then((supported) => {
        if (!cancelled) setPipSupported(supported)
      })
      .catch(() => {
        if (!cancelled) setPipSupported(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Set simple PiP source rect once - let OS handle the rest
  // No need to constantly update on layout changes
  const updatePipSourceRect = useCallback(() => {
    if (Platform.OS !== 'android') return
    if (pipSupported === false || isInPipMode) return

    // Simple fixed rect - OS handles animation from current position
    const screen = Dimensions.get('screen')
    MediaSession.setPictureInPictureSourceRect({
      x: 0,
      y: 0,
      width: screen.width,
      height: Math.round(screen.width * 9 / 16),
    })
  }, [pipSupported, isInPipMode])

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

  // Toggle controls on tap (fullscreen) or maximize (mini)
  const handleVideoTap = useCallback(() => {
    if (playerMode === 'fullscreen' || isLandscapeFullscreen) {
      if (showControls) {
        setShowControls(false)
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current)
        }
      } else {
        showControlsTemporarily()
      }
    } else if (playerMode === 'mini') {
      // Tap mini player to maximize (YouTube-style)
      maximizePlayer()
    }
  }, [playerMode, isLandscapeFullscreen, showControls, showControlsTemporarily, maximizePlayer])

  const handleVlcPipStatusChanged = useCallback((event: { isInPictureInPicture: boolean; width: number; height: number }) => {
    console.log('[VideoPlayerOverlay] VLC PiP status changed:', event.isInPictureInPicture, event.width, event.height)
    setIsInPipMode(event.isInPictureInPicture)
    if (event.isInPictureInPicture && event.width > 0 && event.height > 0) {
      setPipWindowSize({ width: event.width, height: event.height })
    } else if (!event.isInPictureInPicture) {
      setPipWindowSize(null)
    }
  }, [setIsInPipMode, setPipWindowSize])

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
  const translateY = useSharedValue(0)
  const isGestureActive = useSharedValue(false)
  const isInPipModeShared = useSharedValue(false)
  const isAutoPipEnabledShared = useSharedValue(false)
  const screenWidthShared = useSharedValue(screenWidth)
  const screenHeightShared = useSharedValue(screenHeight)
  const videoHeightShared = useSharedValue(videoHeight)
  const insetTopShared = useSharedValue(insets.top)
  const insetBottomShared = useSharedValue(insets.bottom)
  
  const miniPipX = useSharedValue(screenWidth - MINI_PIP_WIDTH - MINI_PIP_MARGIN)
  const miniPipY = useSharedValue(screenHeight - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - TAB_BAR_HEIGHT - insets.bottom)
  const miniPipStartX = useSharedValue(0)
  const miniPipStartY = useSharedValue(0)

  // Swipe-to-dismiss values
  const swipeDismissX = useSharedValue(0)
  const swipeDismissOpacity = useSharedValue(1)
  const isSwipeDismissing = useSharedValue(false)

  // Track whether gesture started in fullscreen (1) or mini (0) mode
  // Using number instead of string to avoid potential worklet string comparison issues
  const gestureStartedInFullscreen = useSharedValue(0)

  // CRITICAL: Update shared values SYNCHRONOUSLY during render, NOT in useEffect
  // useEffect runs AFTER the render commit, so worklets would see stale values
  // This is especially important for PiP mode where dimensions change rapidly
  // Trust the native isInPipMode event directly - don't add complex detection logic
  isInPipModeShared.value = isInPipMode
  isAutoPipEnabledShared.value = autoPipEnabledRef.current
  screenWidthShared.value = screenWidth
  screenHeightShared.value = screenHeight
  videoHeightShared.value = videoHeight
  insetTopShared.value = insets.top
  insetBottomShared.value = insets.bottom

  // Ensure animProgress matches playerMode on initial render and after PiP exit
  // This prevents the video from being stuck at wrong size
  if (playerMode === 'fullscreen' && !isInPipMode) {
    animProgress.value = 1
  }

  // Calculate positions using measured tab bar metrics (preferred) with a safe fallback.
  // Pixel/Android gesture nav can report a non-zero bottom inset; never ignore it.
  const expectedTabBarHeight = TAB_BAR_HEIGHT + Math.max(insets.bottom, reportedTabBarPadding || 0)
  const miniPlayerBottom = Math.max(reportedTabBarHeight || 0, expectedTabBarHeight)

  const miniPlayerBottomShared = useSharedValue(miniPlayerBottom)
  useEffect(() => {
    miniPlayerBottomShared.value = miniPlayerBottom
  }, [miniPlayerBottom])

  useEffect(() => {
    if (playerMode === 'mini') {
      // Bottom-right corner, above tab bar
      const safeRight = screenWidth - MINI_PIP_WIDTH - MINI_PIP_MARGIN
      const safeBottom = screenHeight - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - miniPlayerBottom
      // Use spring for bouncy entrance animation
      miniPipX.value = withSpring(safeRight, SPRING_CONFIG_BOUNCY)
      miniPipY.value = withSpring(safeBottom, SPRING_CONFIG_BOUNCY)
    }
  }, [screenWidth, screenHeight, playerMode, miniPlayerBottom])

  // When exiting landscape fullscreen, keep rendering the fullscreen container until window dimensions AND insets settle.
  // The tricky part: StatusBar visibility + safe area insets can lag behind the orientation lock by a few frames.
  // If we show portrait info/actions too early, it lays out against transient dimensions/insets and visibly jumps.
  useEffect(() => {
    if (!pendingLandscapeExit) return
    if (isWindowLandscape) return

    // Ensure status bar is restored *before* we reveal portrait content.
    StatusBar.setHidden(false)

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

      try {
        const result = await rpc.getChannelMeta({ channelKey })
        if (cancelled) return
        setChannelMetaName(result?.name || null)
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
    if (playerMode === 'fullscreen') {
      animProgress.value = withTiming(1, { duration: 250 })
    } else if (playerMode === 'mini') {
      animProgress.value = withTiming(0, { duration: 250 })
    }
  }, [playerMode])

  // Memoize gesture to prevent recreation on every render
  // Move enabled check inside worklets instead of using .enabled() with JS variable
  // This keeps the gesture handler stable and prevents mid-gesture interruptions
  const panGesture = useMemo(() => Gesture.Pan()
    .onStart(() => {
      'worklet'
      // Skip gesture if in landscape fullscreen mode
      if (isLandscapeFullscreenShared.value) {
        return
      }
      isGestureActive.value = true
      miniPipStartX.value = miniPipX.value
      miniPipStartY.value = miniPipY.value
      // Reset swipe dismiss values
      swipeDismissX.value = 0
      swipeDismissOpacity.value = 1
      isSwipeDismissing.value = false
      // Track mode at gesture start (1 = fullscreen, 0 = mini)
      gestureStartedInFullscreen.value = animProgress.value >= 0.5 ? 1 : 0
    })
    .onUpdate((event) => {
      'worklet'
      // Skip if gesture was started in disabled state
      if (isLandscapeFullscreenShared.value || !isGestureActive.value) {
        return
      }
      // Use gestureStartedInFullscreen for consistent behavior throughout entire gesture
      if (gestureStartedInFullscreen.value === 0) {
        // Mini player mode - always allow dragging, decide dismiss vs reposition on release
        const safeTop = insetTopShared.value + MINI_PIP_MARGIN
        const safeBottom = screenHeightShared.value - MINI_PIP_HEIGHT - MINI_PIP_MARGIN
        const safeLeft = MINI_PIP_MARGIN
        const safeRight = screenWidthShared.value - MINI_PIP_WIDTH - MINI_PIP_MARGIN

        const newX = miniPipStartX.value + event.translationX
        const newY = miniPipStartY.value + event.translationY

        // Allow dragging freely within bounds
        miniPipX.value = Math.max(safeLeft, Math.min(safeRight, newX))
        miniPipY.value = Math.max(safeTop, Math.min(safeBottom, newY))

        // Track if this looks like a dismiss gesture (for visual feedback)
        // Only show dismiss feedback when dragging past the edge bounds
        const pastLeftEdge = newX < safeLeft - 20
        const pastRightEdge = newX > safeRight + 20
        if (pastLeftEdge || pastRightEdge) {
          isSwipeDismissing.value = true
          // Calculate how far past the edge
          const overflowX = pastLeftEdge ? (safeLeft - newX) : (newX - safeRight)
          swipeDismissX.value = pastLeftEdge ? -overflowX : overflowX
          // Fade opacity based on overflow
          const progress = Math.min(overflowX / SWIPE_DISMISS_THRESHOLD, 1)
          swipeDismissOpacity.value = 1 - (progress * 0.4)
        } else {
          isSwipeDismissing.value = false
          swipeDismissX.value = 0
          swipeDismissOpacity.value = 1
        }
      } else {
        // Fullscreen mode - drag to minimize
        const totalDistance = screenHeightShared.value - miniPlayerBottomShared.value - insetTopShared.value - MINI_PIP_HEIGHT
        const dragProgress = -event.translationY / totalDistance
        animProgress.value = Math.max(0, Math.min(1, 1 + dragProgress))
      }
    })
    .onEnd((event) => {
      'worklet'
      // Always reset gesture active state first
      const wasActive = isGestureActive.value
      isGestureActive.value = false

      // Skip if gesture was never activated (landscape mode)
      if (!wasActive) {
        return
      }

      // Handle mini player gestures (swipe dismiss or corner snap)
      if (gestureStartedInFullscreen.value === 0) {
        const safeTop = insetTopShared.value + MINI_PIP_MARGIN
        const safeBottom = screenHeightShared.value - MINI_PIP_HEIGHT - MINI_PIP_MARGIN - miniPlayerBottomShared.value
        const safeLeft = MINI_PIP_MARGIN
        const safeRight = screenWidthShared.value - MINI_PIP_WIDTH - MINI_PIP_MARGIN

        // Check if this should be a dismiss gesture:
        // - High horizontal velocity (fast swipe)
        // - OR was showing dismiss feedback (dragged past edge)
        const absVelocityX = Math.abs(event.velocityX)
        const shouldDismiss = absVelocityX >= SWIPE_VELOCITY_THRESHOLD || isSwipeDismissing.value

        if (shouldDismiss && absVelocityX > 200) {
          // Dismiss - animate off screen in swipe direction
          const direction = event.velocityX > 0 ? 1 : -1
          swipeDismissX.value = withTiming(direction * screenWidthShared.value, { duration: 200 })
          swipeDismissOpacity.value = withTiming(0, { duration: 200 })
          // Animate position off screen too
          miniPipX.value = withTiming(direction > 0 ? screenWidthShared.value : -MINI_PIP_WIDTH, { duration: 200 })
          runOnJS(closeVideo)()
        } else {
          // Snap to nearest corner with bouncy animation
          const centerX = miniPipX.value + MINI_PIP_WIDTH / 2
          const centerY = miniPipY.value + MINI_PIP_HEIGHT / 2
          const screenCenterX = screenWidthShared.value / 2
          const screenCenterY = (safeTop + safeBottom) / 2

          // Factor in velocity for more natural feeling (throw towards corner)
          const velocityInfluence = 30
          const adjustedCenterX = centerX + (event.velocityX / velocityInfluence)
          const adjustedCenterY = centerY + (event.velocityY / velocityInfluence)

          const targetX = adjustedCenterX < screenCenterX ? safeLeft : safeRight
          const targetY = adjustedCenterY < screenCenterY ? safeTop : safeBottom

          // Animate to corner with bouncy spring
          miniPipX.value = withSpring(targetX, SPRING_CONFIG_BOUNCY)
          miniPipY.value = withSpring(targetY, SPRING_CONFIG_BOUNCY)

          // Reset any dismiss visual feedback
          swipeDismissX.value = withSpring(0, SPRING_CONFIG_BOUNCY)
          swipeDismissOpacity.value = withSpring(1, SPRING_CONFIG_BOUNCY)
        }
        // Always reset swipe dismiss state
        isSwipeDismissing.value = false
      } else if (gestureStartedInFullscreen.value === 1) {
        // YouTube-like snap behavior with velocity-based decisions
        const velocity = event.velocityY
        const position = animProgress.value

        // Determine snap direction based on position and velocity
        let shouldMinimize = false

        if (velocity > 300) {
          // Fast swipe down - minimize
          shouldMinimize = true
        } else if (velocity < -300) {
          // Fast swipe up - maximize
          shouldMinimize = false
        } else if (position < 0.75) {
          // Below commitment threshold (0.75): need to drag 25% down to minimize
          // In the uncertain zone (0.5-0.75), velocity decides
          // Tiny velocity (> 20 px/s) in direction determines outcome
          shouldMinimize = velocity > 20
        } else {
          // Above 0.75: stay fullscreen unless velocity says otherwise
          shouldMinimize = velocity > 100
        }

        if (shouldMinimize) {
          animProgress.value = withSpring(0, SPRING_CONFIG_TIGHT)
          runOnJS(minimizePlayer)()
        } else {
          animProgress.value = withSpring(1, SPRING_CONFIG_BOUNCY)
          runOnJS(maximizePlayer)()
        }
      } else {
        // Fallback: snap to nearest state to prevent stuck states
        if (animProgress.value < 0.5) {
          animProgress.value = withSpring(0, SPRING_CONFIG_TIGHT)
        } else {
          animProgress.value = withSpring(1, SPRING_CONFIG_BOUNCY)
        }
      }
    }), [closeVideo, minimizePlayer, maximizePlayer])

  const composedGesture = panGesture

  // Animated styles for the container
  // On Android, add bottom inset to fullscreen height so it covers the navigation bar
  const fullscreenHeight = Platform.OS === 'android' ? screenHeight + insets.bottom : screenHeight

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

    if (isInPipModeShared.value) {
      // In PiP mode: fill the small PiP window completely
      return {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: 9999,
        borderRadius: 0,
        backgroundColor: '#000',
      }
    }

    // Fullscreen container fills entire window to show video + content below
    const isAndroid = Platform.OS === 'android'
    const fullscreenHeightShared = screenHeightShared.value + insetBottomShared.value

    const width = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_WIDTH, screenWidthShared.value],
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

    // Fullscreen video starts at top=0 (fills entire window)
    // This prevents the 50/50 PiP issue where video appears offset
    const top = interpolate(
      animProgress.value,
      [0, 1],
      [miniPipY.value, 0],
      Extrapolation.CLAMP
    )

    const borderRadius = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_CORNER_RADIUS, 0],
      Extrapolation.CLAMP
    )

    // Apply swipe dismiss transform only in mini mode
    const swipeTransform = animProgress.value < 0.5 && swipeDismissX.value !== 0
      ? [{ translateX: swipeDismissX.value }]
      : []
    const swipeOpacity = animProgress.value < 0.5 ? swipeDismissOpacity.value : 1

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
      shadowOpacity: animProgress.value < 0.5 ? 0.4 : 0,
      shadowRadius: 8,
      elevation: animProgress.value < 0.5 ? 10 : 0,
      transform: swipeTransform,
      opacity: swipeOpacity,
    }
  }, [])

  const videoStyle = useAnimatedStyle(() => {
    'worklet'
    if (isLandscapeFullscreenShared.value) {
      return {
        width: landscapeWidth.value,
        height: landscapeHeight.value,
      }
    }

    if (isInPipModeShared.value) {
      // In PiP mode: use flex to fill container naturally
      // Don't set explicit dimensions - let the container (which fills PiP window) control size
      return {
        flex: 1,
        width: '100%',
        height: '100%',
      }
    }

    const width = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_WIDTH, screenWidthShared.value],
      Extrapolation.CLAMP
    )

    const cutoutInset = Platform.OS === 'android' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value && animProgress.value >= 0.95
      ? insetTopShared.value
      : 0
    // Normal video height - same activity shrinks for PiP (single-player architecture)
    const height = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PIP_HEIGHT, videoHeightShared.value + cutoutInset],
      Extrapolation.CLAMP
    )

    return {
      width,
      height,
      flex: undefined,
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

    const cutoutInset = Platform.OS === 'android' && !isInPipModeShared.value && !isLandscapeFullscreenShared.value && animProgress.value >= 0.95
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

  // Mini player controls opacity
  const miniControlsStyle = useAnimatedStyle(() => {
    'worklet'
    const opacity = interpolate(
      animProgress.value,
      [0, 0.3],
      [1, 0],
      Extrapolation.CLAMP
    )
    return { opacity }
  }, [])

  // Video player positioning - always fill container
  const videoPlayerStyle = useAnimatedStyle(() => {
    'worklet'
    return {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    }
  }, [])

  // Controls overlay positioning - always fill the container
  const controlsOverlayStyle = useAnimatedStyle(() => {
    'worklet'
    return {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
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

    // In portrait, use fullscreenContentStyle opacity
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
      }
    }

    return {
      position: 'absolute',
      bottom: 24,
      left: 12,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
      zIndex: 10,
    }
  }, [])

  // Fullscreen button style
  const fullscreenButtonStyle = useAnimatedStyle(() => {
    'worklet'
    const opacity = interpolate(
      animProgress.value,
      [0.5, 1],
      [0, 1],
      Extrapolation.CLAMP
    )

    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        bottom: 56,
        right: 16,
        zIndex: 10,
        opacity: 1,
      }
    }

    return {
      position: 'absolute',
      bottom: 44,
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


  // Available playback speeds
  const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

  // Cycle through playback speeds
  const cyclePlaybackSpeed = useCallback(() => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate)
    const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length
    setPlaybackRate(PLAYBACK_SPEEDS[nextIndex])
  }, [playbackRate, setPlaybackRate])

  // Toggle true fullscreen (landscape mode)
  // Uses shared values so VLC doesn't remount - position should be preserved
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
      if (isLandscapeFullscreenShared.value) {
        // Return to portrait when video player unmounts
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        StatusBar.setHidden(false)
      }
    }
  }, [])

  // Exit landscape fullscreen when player mode changes to mini or hidden
  useEffect(() => {
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
    const shouldInset = playerMode === 'fullscreen' && !isInPipMode && !isLandscapeFullscreen
    MediaSession.setSurfaceViewInset(shouldInset ? -1 : 0).catch(() => {})
  }, [playerMode, isInPipMode, isLandscapeFullscreen])

  useEffect(() => {
    if (Platform.OS !== 'android') return
  }, [])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    if (pipSupported === false) return
    const shouldEnableAutoPip =
      pipSupported !== false &&
      (playerMode === 'fullscreen' || playerMode === 'mini') &&
      currentVideo !== null &&
      !isCasting
    const shouldAutoPip = shouldEnableAutoPip
    autoPipEnabledRef.current = shouldAutoPip
    if (shouldEnableAutoPip) {
      updatePipSourceRect()
    }
    if (isInPipMode) return
    console.log('[VideoPlayerOverlay] Auto-PiP effect, playerMode:', playerMode, 'hasVideo:', !!currentVideo, 'enabling:', shouldAutoPip)
    MediaSession.setAutoPictureInPicture(shouldAutoPip)
      .then(() => console.log('[VideoPlayerOverlay] Auto-PiP set:', shouldAutoPip))
      .catch((err) => console.error('[VideoPlayerOverlay] Auto-PiP failed:', err))
  }, [playerMode, currentVideo, isCasting, pipSupported, isInPipMode, updatePipSourceRect])

  // PiP entry is handled natively via onUserLeaveHint in MainActivity
  // Same activity shrinks, same player continues (single-player architecture)

  // Downloads context for browser-style download manager
  const { addDownload, downloads } = useDownloads()

  // Check if current video is being downloaded or already downloaded
  const currentDownload = currentVideo ? downloads.find(d =>
    d.id === `${currentVideo.channelKey}:${currentVideo.id || currentVideo.path}`
  ) : null
  const isDownloading = currentDownload?.status === 'downloading' || currentDownload?.status === 'queued' || currentDownload?.status === 'saving'
  const isDownloaded = currentDownload?.status === 'complete'

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
    console.log('[VideoPlayerOverlay] State:', {
      hasCurrentVideo: !!currentVideo,
      videoId: currentVideo?.id,
      playerMode,
      videoUrl: videoUrl?.substring(0, 50),
      isPear,
      isDesktop,
    })
  }, [currentVideo, playerMode, videoUrl, isPear, isDesktop])

  // Don't render if no video
  if (!currentVideo || playerMode === 'hidden') {
    return null
  }

  const channelName =
    channelMetaName ||
    currentVideo.channel?.name ||
    `Channel ${currentVideo.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = channelName.charAt(0).toUpperCase()

  // Desktop mini player dimensions
  const DESKTOP_MINI_WIDTH = 320
  const DESKTOP_MINI_HEIGHT = 180
  const DESKTOP_MINI_PADDING = 24
  const DESKTOP_MINI_CONTROLS_HEIGHT = 48

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
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={maximizePlayer}>
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
            onClick={maximizePlayer}
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
                    onClick={() => cast.disconnect()}
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
                    Like ({reactions.like || 0})
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
                    Dislike ({reactions.dislike || 0})
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

  // Mobile: Single render path - landscape uses View wrapper, portrait uses Animated.View
  // The VLCPlayer stays mounted across orientation changes for smooth transitions
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

    const networkCachingMs = videoStats?.isComplete ? 0 : 300

    return (
      <>
        {Platform.OS !== 'web' && videoUrl && VLCPlayer && (
          <VLCPlayer
            key={`${playbackSession}:${currentVideo?.channelKey || ''}:${currentVideo?.id || videoUrl}`}
            ref={playerRef}
            source={{
              uri: videoUrl,
              initType: 2,
              initOptions: [
                // Small buffer for uncached streams to avoid immediate underruns
                `--network-caching=${networkCachingMs}`,
                `--file-caching=${networkCachingMs}`,
                `--live-caching=${networkCachingMs}`,
                `--disc-caching=${networkCachingMs}`,
                '--avcodec-hw=any',
                '--avcodec-threads=0',
              ],
            }}
            style={
              // During Android PiP: resize the view to match PiP window dimensions
              // After PiP exit: use explicit 16:9 dimensions to avoid full-height layout issues
              isInPipMode && Platform.OS === 'android' && pipWindowSize
                ? { width: pipWindowSize.width, height: pipWindowSize.height, position: 'absolute' as const, top: 0, left: 0 }
                : Platform.OS === 'android'
                  ? { width: screenWidth, height: videoHeight, position: 'absolute' as const, top: 0, left: 0 }
                  : StyleSheet.absoluteFill
            }
            paused={!isPlaying}
            playInBackground={true}
            rate={playbackRate}
            seek={vlcSeekPosition !== undefined ? vlcSeekPosition : -1}
            resizeMode="contain"
            autoAspectRatio={true}
            onLoad={handleVideoLoad}
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

  // Render - all styles are animated, no React state conditionals in JSX to prevent VLC remounting
  const content = (
    <Animated.View style={[styles.container, containerStyle]}>
          <GestureDetector gesture={composedGesture}>
          <Animated.View
            ref={videoWrapperRef}
            style={[styles.videoWrapper, videoStyle]}
          >
            {/* Background - fills the parent container */}
            <Pressable
              style={styles.videoBackground}
              onPress={handleVideoTap}
            >
              <Animated.View style={videoPlayerStyle}>
                {renderVideoPlayer()}
              </Animated.View>


            {showLoadingOverlay && !isInPipMode && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator color="white" size="large" />
                <Text style={styles.loadingText}>{loadingLabel}</Text>
              </View>
            )}

            {(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && !isInPipMode && (
              <Animated.View style={[styles.controlsOverlayBase, controlsOverlayStyle]}>
                <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('left')}>
                  <Feather name="rotate-ccw" color="#fff" size={32} />
                  <Text style={styles.controlButtonText}>10s</Text>
                </Pressable>

                <Pressable style={styles.controlButtonLarge} onPress={handlePlayPause}>
                  {effectiveIsPlaying ? (
                    <Ionicons name="pause" color="#fff" size={48} />
                  ) : (
                    <Ionicons name="play" color="#fff" size={48} />
                  )}
                </Pressable>

                <Pressable style={styles.controlButton} onPress={() => handleDoubleTapSeek('right')}>
                  <Feather name="rotate-cw" color="#fff" size={32} />
                  <Text style={styles.controlButtonText}>10s</Text>
                </Pressable>
              </Animated.View>
            )}

            {seekFeedback && !isInPipMode && (
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
          </Pressable>

          {playerMode === 'fullscreen' && showControls && !isLandscapeFullscreen && !isInPipMode && (
            <Animated.View style={[styles.minimizeButton, fullscreenButtonsOpacityStyle]}>
              <Pressable onPress={minimizePlayer} style={styles.minimizeButtonInner}>
                <Feather name="chevron-down" color="#fff" size={28} />
              </Pressable>
            </Animated.View>
          )}

          {playerMode === 'fullscreen' && showControls && !isLandscapeFullscreen && !isInPipMode && (
            <Animated.View style={[styles.speedButton, fullscreenButtonsOpacityStyle]}>
              <Pressable onPress={cyclePlaybackSpeed} style={styles.speedButtonInner}>
                <Text style={styles.speedButtonText}>{playbackRate}x</Text>
              </Pressable>
            </Animated.View>
          )}

          {playerMode === 'fullscreen' && showControls && !isInPipMode && (
            <Animated.View style={[styles.castButton, fullscreenButtonsOpacityStyle]}>
              <Pressable onPress={handleCastPress} style={styles.castButtonInner}>
                <Feather name="cast" color={cast.isConnected ? colors.primary : "#fff"} size={22} />
              </Pressable>
            </Animated.View>
          )}

          {playerMode === 'fullscreen' && showControls && !isInPipMode && (
            <Animated.View style={fullscreenButtonStyle}>
              <Pressable onPress={toggleLandscapeFullscreen} style={styles.fullscreenButtonInner}>
                {isLandscapeFullscreen ? (
                  <Feather name="minimize" color="#fff" size={22} />
                ) : (
                  <Feather name="maximize" color="#fff" size={22} />
                )}
              </Pressable>
            </Animated.View>
          )}

          {!isInPipMode && (
            <Animated.View
              style={progressBarStyle}
              ref={progressBarRef}
              onLayout={(e) => {
                progressBarWidth.current = e.nativeEvent.layout.width
              }}
              onTouchStart={(e) => {
                const locationX = e.nativeEvent.locationX
                const progress = Math.max(0, Math.min(1, locationX / progressBarWidth.current))
                setIsSeeking(true)
                setSeekPosition(progress * effectiveDuration)
              }}
              onTouchMove={(e) => {
                if (isSeeking) {
                  const locationX = e.nativeEvent.locationX
                  const progress = Math.max(0, Math.min(1, locationX / progressBarWidth.current))
                  setSeekPosition(progress * effectiveDuration)
                }
              }}
              onTouchEnd={() => {
                if (isSeeking) {
                  if (isCasting) {
                    cast.seek(seekPosition)
                  } else {
                    seekTo(seekPosition)
                  }
                  setIsSeeking(false)
                }
              }}
            >
              {isSeeking && (
                <View style={[
                  styles.seekTimePreview,
                  { left: `${(seekPosition / (effectiveDuration || 1)) * 100}%` }
                ]}>
                  <Text style={styles.seekTimeText}>{formatDuration(seekPosition)}</Text>
                </View>
              )}
              <View style={[styles.thinProgressBg, isSeeking && styles.thinProgressBgActive]}>
                <View
                  style={[
                    styles.thinProgressFill,
                    isSeeking && styles.thinProgressFillActive,
                    { width: `${(isSeeking ? seekPosition / (effectiveDuration || 1) : effectiveProgress) * 100}%` }
                  ]}
                />
              </View>
              {isSeeking && (
                <View style={[
                  styles.scrubberHandle,
                  { left: `${(seekPosition / (effectiveDuration || 1)) * 100}%` }
                ]} />
              )}
            </Animated.View>
          )}

          {(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && !isInPipMode && (
            <Animated.View style={timeDisplayStyle}>
              <Text style={styles.timeText}>
                {formatDuration(isSeeking ? seekPosition : effectiveCurrentTime)} / {formatDuration(effectiveDuration)}
              </Text>
            </Animated.View>
          )}

          {/* Mini PiP controls - INSIDE GestureDetector so pan gesture works through them */}
          {playerMode === 'mini' && !isLandscapeFullscreen && !pendingLandscapeExit && !isInPipMode && showControls && (
            <Animated.View style={[styles.miniPipOverlay, miniInfoStyle]} pointerEvents="box-none">
              <View style={styles.miniPipTopRow} pointerEvents="box-none">
                <Pressable style={styles.miniPipSmallButton} onPress={closeVideo}>
                  <Feather name="x" size={18} color="#fff" />
                </Pressable>
                <Pressable style={styles.miniPipSmallButton} onPress={maximizePlayer}>
                  <Feather name="maximize-2" size={18} color="#fff" />
                </Pressable>
              </View>
              <View style={styles.miniPipControlsRow}>
                <Pressable style={styles.miniPipSkipButton} onPress={() => handleDoubleTapSeek('left')}>
                  <Feather name="rotate-ccw" size={18} color="#fff" />
                </Pressable>
                <Pressable style={styles.miniPipPlayButton} onPress={handlePlayPause}>
                  <Ionicons name={effectiveIsPlaying ? 'pause' : 'play'} size={28} color="#fff" />
                </Pressable>
                <Pressable style={styles.miniPipSkipButton} onPress={() => handleDoubleTapSeek('right')}>
                  <Feather name="rotate-cw" size={18} color="#fff" />
                </Pressable>
              </View>
            </Animated.View>
          )}

          {/* Mini PiP progress bar - always visible when mini */}
          {playerMode === 'mini' && !isLandscapeFullscreen && !pendingLandscapeExit && !isInPipMode && (
            <Animated.View style={[styles.miniPipProgressBar, miniInfoStyle]} pointerEvents="none">
              <View style={[styles.miniPipProgressFill, { width: `${effectiveProgress * 100}%` }]} />
            </Animated.View>
          )}
        </Animated.View>
        </GestureDetector>

        {!isLandscapeFullscreen && !pendingLandscapeExit && !isInPipMode && (
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
                  <Pressable onPress={() => cast.disconnect()} style={styles.castBannerAction}>
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
                  label={cast.isConnected ? "Casting" : "Cast"}
                  active={cast.isConnected}
                  onPress={handleCastPress}
                  loading={isConnectingCast}
                />
              )}
              <ActionButton
                icon={({ color, size }: { color: string; size: number }) => isDownloaded ? <Feather name="check" color={color} size={size} /> : <Feather name="download" color={color} size={size} />}
                label={isDownloaded ? "Saved" : "Download"}
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

  // Always use same structure to prevent remounting
  // GestureDetector wraps only video area - comments scroll freely
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
