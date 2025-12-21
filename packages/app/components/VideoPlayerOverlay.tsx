/**
 * VideoPlayerOverlay - YouTube-style animated video player
 * Single view that animates between mini player and fullscreen
 * Uses react-native-reanimated for smooth 60fps animations
 * Uses VLC player for broad codec support
 */
import { useCallback, useEffect, useState, useRef, useMemo } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions, Platform, ScrollView, ActivityIndicator, Alert, StatusBar, Dimensions, TextInput } from 'react-native'
import * as FileSystem from 'expo-file-system'
import { rpc } from '@peartube/platform/rpc'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { usePlatform } from '@/lib/PlatformProvider'
import { useSidebar, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from './desktop/constants'
import { useApp } from '@/lib/AppContext'

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
import { Play, Pause, X, ChevronDown, ThumbsUp, ThumbsDown, Share2, Download, MoreHorizontal, Users, RotateCcw, RotateCw, Maximize, Minimize, Reply, Trash2 } from 'lucide-react-native'
import * as ScreenOrientation from 'expo-screen-orientation'
import { useVideoPlayerContext, VideoStats } from '@/lib/VideoPlayerContext'
import { colors } from '@/lib/colors'
import { useTabBarMetrics } from '@/lib/tabBarHeight'

// Constants
const MINI_PLAYER_HEIGHT = 64
const MINI_VIDEO_WIDTH = 120
const TAB_BAR_HEIGHT = 42
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
  const { isDesktop, isPear } = usePlatform()
  const { isCollapsed } = useSidebar()
  const { identity } = useApp()
  const isWindowLandscape = screenWidth > screenHeight
  const exitGateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const exitGateLastSnapshotRef = useRef<string | null>(null)
  const exitGateStableCountRef = useRef(0)
  const exitGateAttemptsRef = useRef(0)

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

  // Dynamic sidebar width for desktop overlay positioning
  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

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

  const { height: reportedTabBarHeight, paddingBottom: reportedTabBarPadding } = useTabBarMetrics()

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
  // State for true fullscreen (landscape, hidden UI)
  const [isLandscapeFullscreen, setIsLandscapeFullscreen] = useState(false)
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
      // Tap on video thumbnail in mini mode -> maximize
      maximizePlayer()
    }
  }, [playerMode, isLandscapeFullscreen, showControls, showControlsTemporarily, maximizePlayer])


  // Animation progress: 0 = mini, 1 = fullscreen
  const animProgress = useSharedValue(0)
  const translateY = useSharedValue(0)
  const isGestureActive = useSharedValue(false)

  // Calculate positions using measured tab bar metrics (preferred) with a safe fallback.
  // Pixel/Android gesture nav can report a non-zero bottom inset; never ignore it.
  const expectedTabBarHeight = TAB_BAR_HEIGHT + Math.max(insets.bottom, reportedTabBarPadding || 0)
  const miniPlayerBottom = Math.max(reportedTabBarHeight || 0, expectedTabBarHeight)
  const fullscreenTop = insets.top

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

  // Animate when playerMode changes
  useEffect(() => {
    if (playerMode === 'fullscreen') {
      animProgress.value = withSpring(1, SPRING_CONFIG)
    } else if (playerMode === 'mini') {
      animProgress.value = withSpring(0, SPRING_CONFIG)
    }
  }, [playerMode])

  // Pan gesture for dragging between states
  // Disabled in landscape mode to prevent interfering with video controls
  const panGesture = Gesture.Pan()
    .enabled(!isLandscapeFullscreen)
    .activeOffsetY([-10, 10]) // Require 10px vertical drag before activating (prevents tap from triggering)
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

  // Only pan gesture; mini expand is triggered by tapping the mini info row (see render)
  const composedGesture = panGesture

  // Animated styles for the container
  // On Android, add bottom inset to fullscreen height so it covers the navigation bar
  const fullscreenHeight = Platform.OS === 'android' ? screenHeight + insets.bottom : screenHeight

  const containerStyle = useAnimatedStyle(() => {
    // In landscape fullscreen, fill the entire screen
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        left: 0,
        top: 0,
        width: landscapeWidth.value,
        height: landscapeHeight.value,
        zIndex: 9999,
        backgroundColor: '#000',
      }
    }

    // Interpolate position for portrait mode (mini <-> fullscreen)
    const top = interpolate(
      animProgress.value,
      [0, 1],
      [screenHeight - miniPlayerBottom - MINI_PLAYER_HEIGHT, 0],
      Extrapolation.CLAMP
    )

    const height = interpolate(
      animProgress.value,
      [0, 1],
      [MINI_PLAYER_HEIGHT, fullscreenHeight],
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
    // In landscape fullscreen, fill the container
    if (isLandscapeFullscreenShared.value) {
      return {
        width: landscapeWidth.value,
        height: landscapeHeight.value,
      }
    }

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

  // Video player style - adds top padding for status bar/notch in fullscreen (portrait only)
  const videoPlayerStyle = useAnimatedStyle(() => {
    // In landscape, fill the container (no top padding - status bar hidden)
    if (isLandscapeFullscreenShared.value) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }
    }

    const topPadding = interpolate(
      animProgress.value,
      [0, 1],
      [0, insets.top],
      Extrapolation.CLAMP
    )

    return {
      position: 'absolute',
      top: topPadding,
      left: 0,
      right: 0,
      bottom: 0,
    }
  })

  // Progress bar style - positions at bottom, adjusts for landscape
  const progressBarStyle = useAnimatedStyle(() => {
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
  })

  // Time display style - positions above progress bar
  const timeDisplayStyle = useAnimatedStyle(() => {
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
  })

  // Fullscreen button style
  const fullscreenButtonStyle = useAnimatedStyle(() => {
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
        // Return to portrait when exiting fullscreen
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

  // State for download
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadBanner, setDownloadBanner] = useState<string | null>(null)
  const bannerTimeout = useRef<NodeJS.Timeout | null>(null)

  // Handle video download - streams from Hyperdrive and opens share sheet
  const handleDownload = useCallback(async () => {
    if (!currentVideo || isDownloading) return

    // Only supported on native platforms
    if (Platform.OS === 'web') {
      Alert.alert('Download', 'Download is only available on mobile devices')
      return
    }

    // Ensure RPC is ready
    if (!rpc) {
      Alert.alert('Download Failed', 'Backend not ready yet. Please try again in a moment.')
      return
    }

    try {
      setIsDownloading(true)

      // Generate safe filename
      const safeTitle = currentVideo.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)
      const ext = currentVideo.mimeType?.includes('webm') ? 'webm' : currentVideo.mimeType?.includes('matroska') ? 'mkv' : 'mp4'
      const filename = `${safeTitle}_${currentVideo.id.slice(0, 8)}.${ext}`

      // Write to Documents directory (visible in Files app)
      const downloadsDir = `${FileSystem.documentDirectory}Downloads/`
      await FileSystem.makeDirectoryAsync(downloadsDir, { intermediates: true }).catch(() => {})
      const destPath = `${downloadsDir}${filename}`

      // Get channel key from the video
      const channelKey = currentVideo.channelKey || currentVideo.channel?.key

      if (!channelKey) {
        Alert.alert('Download Failed', 'Could not determine channel for this video')
        setIsDownloading(false)
        return
      }

      console.log('[Download] Starting download via RPC:', currentVideo.title)

      // Request a direct blob URL from backend
      const result = await rpc.downloadVideo({
        channelKey,
        videoId: currentVideo.path || currentVideo.id,
        destPath: '', // Not used, but required by RPC spec
      })

      if (result?.success) {
        if (result?.filePath) {
          console.log('[Download] Downloading from blob URL:', result.filePath)
          const downloadRes = await FileSystem.downloadAsync(result.filePath, destPath)
          if (downloadRes.status !== 200) {
            throw new Error(`HTTP ${downloadRes.status}`)
          }
        } else if (result?.data) {
          // Fallback for older backends that return base64
          console.log('[Download] Got base64 payload, size:', result.size, 'writing to:', destPath)
          await FileSystem.writeAsStringAsync(destPath, result.data, {
            encoding: FileSystem.EncodingType.Base64,
          })
        } else {
          throw new Error('Backend did not return a URL or data')
        }

        Alert.alert(
          'Download Complete',
          `"${currentVideo.title}" saved to:\nFiles > On My iPhone > PearTube > Downloads`
        )
        const msg = `Saved to Files > PearTube/Downloads\n${destPath.replace('file://', '')}`
        setDownloadBanner(msg)
        if (bannerTimeout.current) clearTimeout(bannerTimeout.current)
        bannerTimeout.current = setTimeout(() => setDownloadBanner(null), 4000)
      } else {
        Alert.alert('Download Failed', result?.error || 'Unknown error')
      }
    } catch (err: any) {
      console.error('[Download] Error:', err)
      Alert.alert('Download Failed', err.message || 'Failed to download video')
    } finally {
      setIsDownloading(false)
    }
  }, [currentVideo, isDownloading])

  // Always register cleanup hooks (even when no video) to avoid changing hook order
  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
      if (bannerTimeout.current) clearTimeout(bannerTimeout.current)
    }
  }, [])

  // Don't render if no video
  if (!currentVideo || playerMode === 'hidden') {
    return null
  }

  const channelName =
    channelMetaName ||
    currentVideo.channel?.name ||
    `Channel ${currentVideo.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = channelName.charAt(0).toUpperCase()

  // Desktop: YouTube-style layout (not fullscreen overlay)
  if (isDesktop && Platform.OS === 'web') {
    return (
      <div style={{ ...desktopStyles.overlay, left: sidebarWidth, transition: 'left 0.2s ease' }}>
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
                  style={{ width: '100%', height: '100%', backgroundColor: '#000', borderRadius: 12, outline: 'none' }}
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

  // Mobile: Single render path - landscape uses View wrapper, portrait uses Animated.View
  // The VLCPlayer stays mounted across orientation changes for smooth transitions
  const renderVideoPlayer = () => (
    <>
      {Platform.OS !== 'web' && videoUrl && VLCPlayer && (
        <VLCPlayer
          key={currentVideo?.id || videoUrl}
          ref={playerRef}
          source={{
            uri: videoUrl,
            initType: 2,
            initOptions: [
              '--network-caching=15000',
              '--file-caching=5000',
              '--live-caching=5000',
              '--disc-caching=5000',
              '--avcodec-hw=any',
              '--avcodec-threads=0',
            ],
          }}
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
      )}
      {Platform.OS === 'web' && videoUrl && (
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

  // Render - all styles are animated, no React state conditionals in JSX to prevent VLC remounting
  const content = (
    <Animated.View style={[styles.container, containerStyle]}>
          {/* Video area */}
          <Animated.View style={[styles.videoWrapper, videoStyle]}>
            {/* Background - fills the parent container */}
            <Pressable
              style={styles.videoBackground}
              onPress={handleVideoTap}
            >
              <Animated.View style={videoPlayerStyle}>
                {renderVideoPlayer()}
              </Animated.View>

              {/* Loading overlay */}
            {isLoading && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator color="white" size="large" />
                <Text style={styles.loadingText}>Connecting to P2P...</Text>
              </View>
            )}

            {/* Custom controls overlay - shown on tap in fullscreen or landscape */}
            {(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && (
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

          {/* Fullscreen minimize button - only show with controls, not in landscape */}
          {playerMode === 'fullscreen' && showControls && !isLandscapeFullscreen && (
            <Animated.View style={[styles.minimizeButton, fullscreenContentStyle]}>
              <Pressable onPress={minimizePlayer} style={styles.minimizeButtonInner}>
                <ChevronDown color="#fff" size={28} />
              </Pressable>
            </Animated.View>
          )}

          {/* Speed control button - only show with controls */}
          {playerMode === 'fullscreen' && showControls && !isLandscapeFullscreen && (
            <Animated.View style={[styles.speedButton, fullscreenContentStyle]}>
              <Pressable onPress={cyclePlaybackSpeed} style={styles.speedButtonInner}>
                <Text style={styles.speedButtonText}>{playbackRate}x</Text>
              </Pressable>
            </Animated.View>
          )}

          {/* Fullscreen button - only show with controls */}
          {playerMode === 'fullscreen' && showControls && (
            <Animated.View style={fullscreenButtonStyle}>
              <Pressable onPress={toggleLandscapeFullscreen} style={styles.fullscreenButtonInner}>
                {/* Icon changes based on state but doesn't affect VLC */}
                {isLandscapeFullscreen ? (
                  <Minimize color="#fff" size={22} />
                ) : (
                  <Maximize color="#fff" size={22} />
                )}
              </Pressable>
            </Animated.View>
          )}

          {/* YouTube-style thin progress bar - always visible, seekable */}
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
            {/* Time preview bubble when seeking */}
            {isSeeking && (
              <View style={[
                styles.seekTimePreview,
                { left: `${(seekPosition / duration) * 100}%` }
              ]}>
                <Text style={styles.seekTimeText}>{formatDuration(seekPosition)}</Text>
              </View>
            )}
            {/* Progress bar - expands when seeking */}
            <View style={[styles.thinProgressBg, isSeeking && styles.thinProgressBgActive]}>
              <View
                style={[
                  styles.thinProgressFill,
                  isSeeking && styles.thinProgressFillActive,
                  { width: `${(isSeeking ? seekPosition / duration : playbackProgress) * 100}%` }
                ]}
              />
            </View>
            {/* Scrubber handle - only visible when seeking */}
            {isSeeking && (
              <View style={[
                styles.scrubberHandle,
                { left: `${(seekPosition / duration) * 100}%` }
              ]} />
            )}
          </Animated.View>

          {/* Time display - only show with controls */}
          {(playerMode === 'fullscreen' || isLandscapeFullscreen) && showControls && (
            <Animated.View style={timeDisplayStyle}>
              <Text style={styles.timeText}>
                {formatDuration(isSeeking ? seekPosition : currentTime)} / {formatDuration(duration)}
              </Text>
            </Animated.View>
          )}
        </Animated.View>

        {/* Mini player info row - hidden in landscape (and during landscape exit gating) */}
        {!isLandscapeFullscreen && !pendingLandscapeExit && (
          <Animated.View style={[styles.miniInfo, miniInfoStyle]}>
            <Pressable onPress={maximizePlayer} style={StyleSheet.absoluteFill}>
              <View style={styles.miniInfoText}>
                <Text style={styles.miniTitle} numberOfLines={1}>
                  {currentVideo.title}
                </Text>
                <Text style={styles.miniChannel} numberOfLines={1}>
                  {channelName}
                </Text>
              </View>
            </Pressable>
          </Animated.View>
        )}

        {/* Mini player controls - hidden in landscape (and during landscape exit gating) */}
        {!isLandscapeFullscreen && !pendingLandscapeExit && (
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
        )}

        {/* Mini player progress bar - hidden in landscape (and during landscape exit gating) */}
        {!isLandscapeFullscreen && !pendingLandscapeExit && (
          <Animated.View style={[styles.miniProgressBar, miniInfoStyle]}>
            <View style={[styles.miniProgressFill, { width: `${playbackProgress * 100}%` }]} />
          </Animated.View>
        )}

        {/* Fullscreen content - hidden in landscape (and during landscape exit gating) */}
        {!isLandscapeFullscreen && !pendingLandscapeExit && (
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
              <ActionButton
                icon={ThumbsUp}
                label={`Like${reactionCounts.like ? ` (${reactionCounts.like})` : ''}`}
                active={userReaction === 'like'}
                onPress={() => toggleReaction('like')}
              />
              <ActionButton
                icon={ThumbsDown}
                label={`Dislike${reactionCounts.dislike ? ` (${reactionCounts.dislike})` : ''}`}
                active={userReaction === 'dislike'}
                onPress={() => toggleReaction('dislike')}
              />
              <ActionButton icon={Share2} label="Share" />
              <ActionButton icon={Download} label={isDownloading ? "Downloading..." : "Download"} onPress={handleDownload} />
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
                    <RotateCcw color={colors.primary} size={16} />
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
                    <X color={colors.textMuted} size={16} />
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
                              <Reply color={colors.textMuted} size={14} />
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
                                  <Trash2 color="#f87171" size={14} />
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
                                      <Trash2 color="#f87171" size={14} />
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

        {downloadBanner && (
          <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
            <Text style={styles.toastTitle}>Download Complete</Text>
            <Text style={styles.toastText}>{downloadBanner}</Text>
          </View>
        )}
    </Animated.View>
  )

  // Always use same structure to prevent remounting
  // GestureDetector is disabled in landscape via the enabled property on the gesture
  return (
    <GestureDetector gesture={composedGesture}>
      {content}
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  // Landscape fullscreen styles
  landscapeContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 9999,
  },
  landscapeAnimatedContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  landscapeExitButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  landscapeTimeDisplay: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    zIndex: 20,
  },
  landscapeProgressContainer: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    height: 24,
    justifyContent: 'center',
    zIndex: 20,
  },
  landscapeVideoWrapper: {
    ...StyleSheet.absoluteFillObject,
    flex: 1,
    backgroundColor: '#000',
  },
  videoWrapper: {
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  videoBackground: {
    flex: 1,
    backgroundColor: '#000',
  },
  landscapeVideoBackground: {
    ...StyleSheet.absoluteFillObject,
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
  fullscreenButton: {
    position: 'absolute',
    bottom: 44,
    right: 12,
    zIndex: 10,
  },
  fullscreenButtonLandscape: {
    bottom: 16,
    right: 16,
  },
  fullscreenButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // YouTube-style thin progress bar (always visible, seekable)
  thinProgressContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 32, // Larger touch target
    justifyContent: 'flex-end',
    zIndex: 15,
  },
  thinProgressContainerLandscape: {
    position: 'absolute',
    bottom: 0,
    left: 16,
    right: 16,
    height: 32,
    justifyContent: 'flex-end',
    zIndex: 15,
  },
  thinProgressBg: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  thinProgressBgActive: {
    height: 6,
  },
  thinProgressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  thinProgressFillActive: {
    backgroundColor: colors.primary,
  },
  // Scrubber handle when seeking
  scrubberHandle: {
    position: 'absolute',
    bottom: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    marginLeft: -8,
    marginBottom: -5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  // Time preview bubble
  seekTimePreview: {
    position: 'absolute',
    bottom: 20,
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    marginLeft: -30, // Center the bubble
  },
  seekTimeText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    minWidth: 40,
  },
  // Time display (shown with controls)
  timeDisplay: {
    position: 'absolute',
    bottom: 24,
    left: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    zIndex: 10,
  },
  timeDisplayLandscape: {
    bottom: 16,
    left: 16,
  },
  // Fullscreen progress bar (shown with controls)
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
    backgroundColor: 'transparent',
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
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  toastTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  toastText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
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
  // Comments styles
  commentsSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
  },
  commentsTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10,
  },
  commentsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  refreshButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  replyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primary + '20',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 8,
  },
  replyIndicatorText: {
    color: colors.primary,
    fontSize: 13,
  },
  cancelReplyButton: {
    padding: 4,
  },
  commentComposer: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
  },
  commentInput: {
    color: colors.text,
    minHeight: 44,
    fontSize: 14,
    padding: 0,
  },
  commentButton: {
    alignSelf: 'flex-end',
    marginTop: 10,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  commentButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  commentsEmpty: {
    color: colors.textMuted,
    fontSize: 13,
    paddingVertical: 8,
  },
  commentItem: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 10,
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  commentAuthor: {
    color: colors.textMuted,
    fontSize: 12,
    flex: 1,
  },
  adminBadge: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
    color: colors.primary,
    fontWeight: '600',
  },
  pendingBadge: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
    color: colors.textMuted,
  },
  commentActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 'auto',
  },
  commentActionButton: {
    padding: 4,
  },
  commentText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  commentTextPending: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  repliesContainer: {
    marginLeft: 20,
    marginTop: 8,
    gap: 8,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: 12,
  },
  replyItem: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 8,
  },
  loadMoreButton: {
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: colors.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  loadMoreText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '500',
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
