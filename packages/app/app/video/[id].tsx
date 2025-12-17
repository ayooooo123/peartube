/**
 * Video Player Screen - YouTube-style dedicated video playback page
 * Shows: video player, title, channel info, P2P stats, action buttons
 * Supports swipe-down to minimize to mini player
 * Uses SHARED player from VideoPlayerContext for continuous playback
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform, ScrollView, useWindowDimensions, StyleSheet, TextInput, RefreshControl, Alert } from 'react-native'
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { runOnJS } from 'react-native-reanimated'
// VLC player for iOS/Android
let VLCPlayer: any = null
if (Platform.OS !== 'web') {
  VLCPlayer = require('react-native-vlc-media-player').VLCPlayer
}
import { ChevronDown, ThumbsUp, ThumbsDown, Share2, Download, MoreHorizontal, Users, Reply, Trash2, X, Play, Pause } from 'lucide-react-native'
import { useApp, colors } from '../_layout'
import { useVideoPlayerContext, VideoStats } from '@/lib/VideoPlayerContext'

// HRPC methods used: getVideoUrl, prefetchVideo, getVideoStats, getChannelMeta

// Format helpers
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString()
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function formatViews(views: number): string {
  if (views < 1000) return `${views} views`
  if (views < 1000000) return `${(views / 1000).toFixed(1)}K views`
  return `${(views / 1000000).toFixed(1)}M views`
}

// P2P Stats Overlay Component
function P2PStatsOverlay({ stats, showDetails, onPress }: {
  stats: VideoStats | null
  showDetails: boolean
  onPress: () => void
}) {
  if (!stats || stats.isComplete) {
    if (stats?.isComplete) {
      return (
        <View style={styles.cachedBadge}>
          <Text style={styles.cachedText}>Cached</Text>
        </View>
      )
    }
    return null
  }

  return (
    <Pressable onPress={onPress} style={styles.statsOverlay}>
      <View style={styles.statsRow}>
        <View style={[
          styles.statusDot,
          { backgroundColor: stats.status === 'downloading' ? '#4ade80' : stats.status === 'error' ? '#f87171' : '#fbbf24' }
        ]} />
        <Text style={styles.statsProgress}>{stats.progress}%</Text>
        {stats.peerCount > 0 && (
          <Text style={styles.statsPeers}>{stats.peerCount} peer{stats.peerCount !== 1 ? 's' : ''}</Text>
        )}
      </View>
      {showDetails && (
        <View style={styles.statsDetails}>
          <Text style={styles.statsDetailText}>{stats.downloadedBlocks}/{stats.totalBlocks} blocks</Text>
          <Text style={styles.statsDetailText}>{stats.speedMBps} MB/s</Text>
        </View>
      )}
    </Pressable>
  )
}

// P2P Stats Bar Component - Enhanced with more details
function P2PStatsBar({ stats }: { stats: VideoStats | null }) {
  console.log('[P2PStatsBar] Rendering, stats:', stats ? 'present' : 'null', stats)

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
            {!stats.isComplete && parseFloat(stats.speedMBps) > 0 && (
              <Text style={styles.statsBarSpeed}>↓ {stats.speedMBps} MB/s</Text>
            )}
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
            {formatBytes(stats.downloadedBytes)} / {formatBytes(stats.totalBytes)}
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

export default function VideoPlayerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const { width: screenWidth } = useWindowDimensions()
  const videoHeight = Math.round(screenWidth * 9 / 16)
  const { rpc } = useApp()

  // VideoPlayerContext for minimize functionality
  const { minimizePlayer, loadAndPlayVideo } = useVideoPlayerContext()

  // Local video state
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showControls, setShowControls] = useState(false)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const playerRef = useRef<any>(null)

  // Parse video data from params (JSON encoded)
  const params = useLocalSearchParams()
  const videoData = params.videoData ? JSON.parse(params.videoData as string) : null
  const fromMiniPlayer = params.fromMiniPlayer === 'true'

  // Local UI state only
  const [showStats, setShowStats] = useState(false)
  const [channelMeta, setChannelMeta] = useState<{ name?: string } | null>(null)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const [localStats, setLocalStats] = useState<VideoStats | null>(null)
  const statsPollingRef = useRef<NodeJS.Timeout | null>(null)

  // Social state (multi-writer channels)
  const [comments, setComments] = useState<any[]>([])
  const [commentText, setCommentText] = useState('')
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [postingComment, setPostingComment] = useState(false)
  const [replyToComment, setReplyToComment] = useState<any>(null)
  const [commentsPage, setCommentsPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(false)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  const [refreshingComments, setRefreshingComments] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const COMMENTS_PER_PAGE = 25

  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({})
  const [userReaction, setUserReaction] = useState<string | null>(null)
  const [reactionsLoading, setReactionsLoading] = useState(false)

  // Get current user's identity key for ownership checks
  const { identity } = useApp()

  // Show controls temporarily
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000)
  }, [])

  // Handle minimize action (called from gesture or button)
  const doMinimize = useCallback(() => {
    if (videoUrl && videoData) {
      loadAndPlayVideo(videoData, videoUrl)
      minimizePlayer()
      router.back()
    }
  }, [videoUrl, videoData, loadAndPlayVideo, minimizePlayer, router])

  // Drag gesture to minimize - use runOnJS for React state updates
  const panGesture = Gesture.Pan()
    .onEnd((event) => {
      if (event.translationY > 100) {
        runOnJS(doMinimize)()
      }
    })

  // VLC callbacks
  const onProgress = useCallback((data: { currentTime: number; duration: number }) => {
    // Track progress if needed
  }, [])

  const onPlaying = useCallback(() => {
    setIsPlaying(true)
  }, [])

  const onPaused = useCallback(() => {
    setIsPlaying(false)
  }, [])

  const onBuffering = useCallback((data: { isBuffering: boolean }) => {
    setIsLoading(data.isBuffering)
  }, [])

  const onEnded = useCallback(() => {
    setIsPlaying(false)
  }, [])

  const onError = useCallback((error: any) => {
    console.error('[VideoPlayer] VLC error:', error)
    setIsLoading(false)
  }, [])

  // Handle tap on video - show controls, and if controls visible, toggle play/pause
  const handleVideoTap = useCallback(() => {
    if (showControls) {
      // Controls are visible - toggle play/pause
      if (isPlaying) {
        setIsPlaying(false)
        playerRef.current?.pause?.()
      } else {
        setIsPlaying(true)
        playerRef.current?.play?.()
      }
    }
    // Always show controls on tap
    showControlsTemporarily()
  }, [isPlaying, showControls, showControlsTemporarily])

  // Load video on mount (only if not coming from mini player which already has video loaded)
  useEffect(() => {
    // Wait for rpc to be ready before loading
    if (!rpc) return

    if (videoData && !fromMiniPlayer && !videoLoaded) {
      loadVideo()
      setVideoLoaded(true)
    } else if (videoData && fromMiniPlayer && Platform.OS !== 'web') {
      // Coming from mini player - start polling for stats
      startStatsPolling()
    }
    if (videoData) {
      loadChannelInfo()
    }

    return () => {
      if (statsPollingRef.current) {
        clearInterval(statsPollingRef.current)
        statsPollingRef.current = null
      }
    }
  }, [videoData, fromMiniPlayer, rpc])

  // Track if we've loaded comments for this video to avoid re-fetching on fullscreen toggle
  const commentsLoadedRef = useRef<string | null>(null)

  // Load comments/reactions (separate effect to handle rpc becoming ready)
  useEffect(() => {
    if (!videoData || !rpc) return

    const videoKey = `${videoData.channelKey}:${videoData.id}`

    // Only load if we haven't already loaded for this video
    if (commentsLoadedRef.current !== videoKey) {
      commentsLoadedRef.current = videoKey
      loadSocial()

      // Best-effort index vector for semantic search
      ;(async () => {
        try {
          if ((rpc as any).indexVideoVectors) {
            await (rpc as any).indexVideoVectors({ channelKey: videoData.channelKey, videoId: videoData.id })
          }
        } catch {}
      })()
    }
  }, [videoData?.id, videoData?.channelKey, rpc])

  const loadSocial = async (page = 0, append = false, forceRefresh = false) => {
    if (!videoData || !rpc) return
    const vid = videoData.id
    const ch = videoData.channelKey
    if (!vid || !ch) return

    // Don't show loading state if we already have comments (unless force refreshing)
    const isInitialLoad = comments.length === 0

    if (!append && (isInitialLoad || forceRefresh)) {
      setCommentsLoading(true)
      setReactionsLoading(true)
    }
    try {
      const [commentsRes, reactionsRes] = await Promise.all([
        (rpc as any).listComments?.({ channelKey: ch, videoId: vid, page, limit: COMMENTS_PER_PAGE }).catch(() => null),
        !append ? (rpc as any).getReactions?.({ channelKey: ch, videoId: vid }).catch(() => null) : Promise.resolve(null),
      ])

      if (commentsRes?.success && Array.isArray(commentsRes.comments)) {
        if (append) {
          setComments(prev => [...prev, ...commentsRes.comments])
        } else {
          setComments(commentsRes.comments)
        }
        setHasMoreComments(commentsRes.comments.length >= COMMENTS_PER_PAGE)
        setCommentsPage(page)
      } else if (!append && isInitialLoad) {
        // Only clear comments if this was initial load and it failed
        setComments([])
        setHasMoreComments(false)
      }
      // If we already have comments and the API fails, keep existing comments

      if (reactionsRes?.success) {
        // Backend returns counts as object map { like: 3, dislike: 1 } not array
        const countsData = reactionsRes.counts || {}
        const counts: Record<string, number> = {}
        if (Array.isArray(countsData)) {
          // Handle legacy array format: [{ reactionType, count }]
          for (const c of countsData) {
            if (c?.reactionType) counts[c.reactionType] = c.count || 0
          }
        } else if (typeof countsData === 'object') {
          // Handle object map format: { like: 3, dislike: 1 }
          for (const [key, value] of Object.entries(countsData)) {
            counts[key] = typeof value === 'number' ? value : 0
          }
        }
        setReactionCounts(counts)
        setUserReaction(reactionsRes.userReaction || null)
      }
      // If reactions fail and we already have data, keep existing data
    } finally {
      setCommentsLoading(false)
      setReactionsLoading(false)
      setLoadingMoreComments(false)
      setRefreshingComments(false)
    }
  }

  const loadMoreComments = useCallback(async () => {
    if (loadingMoreComments || !hasMoreComments) return
    setLoadingMoreComments(true)
    await loadSocial(commentsPage + 1, true)
  }, [loadingMoreComments, hasMoreComments, commentsPage, videoData, rpc])

  const refreshComments = useCallback(async () => {
    setRefreshingComments(true)
    setCommentsPage(0)
    commentsLoadedRef.current = null // Allow reload
    await loadSocial(0, false, true) // forceRefresh = true
  }, [videoData, rpc])

  const deleteComment = async (commentId: string) => {
    if (!videoData || !rpc) return
    const vid = videoData.id
    const ch = videoData.channelKey
    if (!vid || !ch) return

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
              const res = await (rpc as any).removeComment?.({ channelKey: ch, videoId: vid, commentId })
              if (res?.success) {
                setComments(prev => prev.filter(c => c.commentId !== commentId))
              }
            } catch (err) {
              console.error('[VideoPlayer] Delete comment failed:', err)
              Alert.alert('Error', 'Failed to delete comment')
            } finally {
              setDeletingCommentId(null)
            }
          }
        }
      ]
    )
  }

  const toggleReaction = async (type: string) => {
    if (!videoData || !rpc) return
    const vid = videoData.id
    const ch = videoData.channelKey
    if (!vid || !ch) return
    try {
      if (userReaction === type) {
        await (rpc as any).removeReaction?.({ channelKey: ch, videoId: vid })
      } else {
        await (rpc as any).addReaction?.({ channelKey: ch, videoId: vid, reactionType: type })
      }
      await loadSocial()
    } catch (err) {
      console.error('[VideoPlayer] Reaction failed:', err)
    }
  }

  const postComment = async () => {
    if (!videoData || !rpc) return
    const text = commentText.trim()
    if (!text) return
    const vid = videoData.id
    const ch = videoData.channelKey
    if (!vid || !ch) return

    setPostingComment(true)
    try {
      const res = await (rpc as any).addComment?.({
        channelKey: ch,
        videoId: vid,
        text,
        parentId: replyToComment?.commentId || null
      })
      if (res?.success) {
        setCommentText('')
        setReplyToComment(null)
        // Wait a moment for backend to apply the op, then reload comments
        await new Promise(resolve => setTimeout(resolve, 500))
        await loadSocial(0, false)
      }
    } catch (err) {
      console.error('[VideoPlayer] Add comment failed:', err)
    } finally {
      setPostingComment(false)
    }
  }

  const cancelReply = () => {
    setReplyToComment(null)
    setCommentText('')
  }

  // Organize comments into threads (top-level + replies)
  const organizedComments = comments.reduce((acc, c) => {
    if (!c.parentId) {
      acc.push({ ...c, replies: comments.filter(r => r.parentId === c.commentId) })
    }
    return acc
  }, [] as any[])

  // Check if user owns a comment
  const isOwnComment = (comment: any) => {
    if (!identity?.driveKey) return false
    return comment.authorKeyHex === identity.driveKey
  }

  const loadVideo = async () => {
    if (!videoData || !rpc) return
    setIsLoading(true)

    try {
      const videoRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
        ? videoData.path
        : videoData.id

      // Get video URL from backend
      const result = await rpc.getVideoUrl({
        channelKey: videoData.channelKey,
        videoId: videoRef
      })

      if (result?.url) {
        setVideoUrl(result.url)
        setIsPlaying(true)
        setIsLoading(false)

        // Start prefetch and poll for stats
        if (Platform.OS !== 'web') {
          startPrefetch()
          setTimeout(() => startStatsPolling(), 500)
        }
      } else {
        setIsLoading(false)
      }
    } catch (err) {
      console.error('[VideoPlayer] Failed to load video:', err)
      setIsLoading(false)
    }
  }

  const loadChannelInfo = async () => {
    if (!videoData?.channelKey || !rpc) return
    try {
      const result = await rpc.getChannelMeta({ channelKey: videoData.channelKey })
      setChannelMeta(result)
    } catch (err) {
      console.error('[VideoPlayer] Failed to load channel info:', err)
    }
  }

  const startPrefetch = async () => {
    if (!videoData || !rpc) return
    try {
      const videoRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
        ? videoData.path
        : videoData.id
      await rpc.prefetchVideo({
        channelKey: videoData.channelKey,
        videoId: videoRef
      })
    } catch (err) {
      console.error('[VideoPlayer] Prefetch failed:', err)
    }
  }

  const startStatsPolling = () => {
    if (!videoData || !rpc) return
    if (statsPollingRef.current) clearInterval(statsPollingRef.current)
    const videoRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
      ? videoData.path
      : videoData.id
    console.log('[VideoPlayer] Starting stats polling for', videoRef)

    const pollStats = async () => {
      try {
        const result = await rpc.getVideoStats({
          channelKey: videoData.channelKey,
          videoId: videoRef
        })
        const stats = result?.stats
        console.log('[VideoPlayer] Got stats:', stats ? `${stats.progress}%` : 'null')
        if (stats) {
          setLocalStats(stats as VideoStats)
          if (stats.isComplete || stats.status === 'complete') {
            console.log('[VideoPlayer] Video complete, stopping polling')
            if (statsPollingRef.current) {
              clearInterval(statsPollingRef.current)
              statsPollingRef.current = null
            }
          }
        }
      } catch (err) {
        console.error('[VideoPlayer] Stats polling error:', err)
      }
    }

    pollStats()
    statsPollingRef.current = setInterval(pollStats, 1000)
  }

  // Minimize button - minimize to mini player instead of closing
  const handleMinimize = useCallback(() => {
    if (videoUrl && videoData) {
      loadAndPlayVideo(videoData, videoUrl)
      minimizePlayer()
    }
    router.back()
  }, [videoUrl, videoData, loadAndPlayVideo, minimizePlayer, router])

  const channelName = channelMeta?.name || videoData?.channel?.name || `Channel ${videoData?.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = channelName.charAt(0).toUpperCase()

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Video Player Area */}
      <GestureDetector gesture={panGesture}>
        <View style={styles.playerContainer}>
          {/* Minimize button overlay (chevron down) */}
          <Pressable style={styles.backButton} onPress={handleMinimize}>
            <ChevronDown color="#fff" size={28} />
          </Pressable>

          <Pressable style={[styles.player, { height: videoHeight }]} onPress={handleVideoTap}>
            {isLoading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color="white" size="large" />
                <Text style={styles.loadingText}>Connecting to P2P network...</Text>
              </View>
            ) : videoUrl ? (
              Platform.OS === 'web' ? (
                <video src={videoUrl} controls autoPlay style={{ width: '100%', height: '100%', backgroundColor: '#000' }} />
              ) : (
                <View style={{ width: screenWidth, height: videoHeight }} pointerEvents="box-none">
                  {VLCPlayer && (
                    <VLCPlayer
                      ref={playerRef}
                      source={{ uri: videoUrl }}
                      style={{ width: screenWidth, height: videoHeight }}
                      resizeMode="contain"
                      paused={!isPlaying}
                      rate={playbackRate}
                      onProgress={onProgress}
                      onPlaying={onPlaying}
                      onPaused={onPaused}
                      onBuffering={onBuffering}
                      onEnd={onEnded}
                      onError={onError}
                    />
                  )}
                  {/* Play/Pause controls overlay */}
                  {showControls && (
                    <View style={styles.controlsOverlay} pointerEvents="none">
                      {isPlaying ? (
                        <Pause color="#fff" size={48} />
                      ) : (
                        <Play color="#fff" size={48} />
                      )}
                    </View>
                  )}
                  <P2PStatsOverlay
                    stats={localStats}
                    showDetails={showStats}
                    onPress={() => setShowStats(!showStats)}
                  />
                </View>
              )
            ) : (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>Failed to load video</Text>
                <Pressable style={styles.retryButton} onPress={loadVideo}>
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            )}
          </Pressable>
        </View>
      </GestureDetector>

      {/* Video Info & Actions */}
      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshingComments}
            onRefresh={refreshComments}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        {/* P2P Stats Bar */}
        {Platform.OS !== 'web' && <P2PStatsBar stats={localStats} />}

        {/* Video Title & Meta */}
        <View style={styles.videoInfo}>
          <Text style={styles.videoTitle}>{videoData?.title || 'Untitled'}</Text>
          <Text style={styles.videoMeta}>
            {formatTimeAgo(videoData?.uploadedAt || Date.now())} · {formatSize(videoData?.size || 0)}
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
          <ActionButton icon={Download} label="Download" />
          <ActionButton icon={MoreHorizontal} label="More" />
        </View>

        {/* Channel Info */}
        <ChannelInfo channelName={channelName} channelInitial={channelInitial} />

        {/* Divider */}
        <View style={styles.divider} />

        {/* Description */}
        {videoData?.description && (
          <View style={styles.description}>
            <Text style={styles.descriptionText}>{videoData.description}</Text>
          </View>
        )}

        {/* Comments */}
        <View style={styles.commentsSection}>
          <Text style={styles.commentsTitle}>
            {comments.length > 0 ? `${comments.length} Comment${comments.length !== 1 ? 's' : ''}` : 'Comments'}
          </Text>

          {/* Reply indicator */}
          {replyToComment && (
            <View style={styles.replyIndicator}>
              <Text style={styles.replyIndicatorText}>
                Replying to {(replyToComment.authorKeyHex || '').slice(0, 8)}…
              </Text>
              <Pressable onPress={cancelReply} style={styles.cancelReplyButton}>
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

          {commentsLoading ? (
            <View style={{ paddingVertical: 12 }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : comments.length === 0 ? (
            <Text style={styles.commentsEmpty}>No comments yet. Be the first to comment!</Text>
          ) : (
            <View style={{ gap: 12, paddingBottom: 24 }}>
              {organizedComments.map((c: any) => (
                <View key={c.commentId}>
                  {/* Main comment */}
                  <View style={styles.commentItem}>
                    <View style={styles.commentHeader}>
                      <Text style={styles.commentAuthor}>
                        {(c.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(c.timestamp || Date.now())}
                      </Text>
                      <View style={styles.commentActions}>
                        <Pressable
                          onPress={() => setReplyToComment(c)}
                          style={styles.commentActionButton}
                        >
                          <Reply color={colors.textMuted} size={14} />
                        </Pressable>
                        {isOwnComment(c) && (
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
                    <Text style={styles.commentText}>{c.text}</Text>
                  </View>

                  {/* Replies */}
                  {c.replies && c.replies.length > 0 && (
                    <View style={styles.repliesContainer}>
                      {c.replies.map((reply: any) => (
                        <View key={reply.commentId} style={styles.replyItem}>
                          <View style={styles.commentHeader}>
                            <Text style={styles.commentAuthor}>
                              {(reply.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(reply.timestamp || Date.now())}
                            </Text>
                            {isOwnComment(reply) && (
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
                          <Text style={styles.commentText}>{reply.text}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              ))}

              {/* Load more button */}
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
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  playerContainer: {
    backgroundColor: '#000',
  },
  backButton: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  player: {
    width: '100%',
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    color: '#fff',
    marginTop: 12,
    fontSize: 14,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: '#fff',
    fontSize: 14,
  },
  retryButton: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: colors.primary,
    borderRadius: 20,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
  },
  content: {
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
  commentsSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  commentsTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10,
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
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  commentAuthor: {
    color: colors.textMuted,
    fontSize: 12,
    flex: 1,
  },
  commentActions: {
    flexDirection: 'row',
    gap: 8,
  },
  commentActionButton: {
    padding: 4,
  },
  commentText: {
    color: colors.text,
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
  // P2P Stats Overlay
  statsOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statsProgress: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  statsPeers: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
  },
  statsDetails: {
    marginTop: 6,
  },
  statsDetailText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 10,
  },
  cachedBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(74, 222, 128, 0.9)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  cachedText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '600',
  },
  // P2P Stats Bar
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
  statsBarSpeed: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  statsBarRow2: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  statsBarDetail: {
    color: colors.textMuted,
    fontSize: 11,
  },
  statsBarProgress: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  statsBarProgressComplete: {
    color: '#4ade80',
  },
  progressBarBg: {
    marginTop: 8,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  controlsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
})
