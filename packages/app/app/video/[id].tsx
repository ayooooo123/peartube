/**
 * Video Player Screen - YouTube-style dedicated video playback page
 * Shows: video player, title, channel info, P2P stats, action buttons
 * Supports swipe-down to minimize to mini player
 * Uses SHARED player from VideoPlayerContext for continuous playback
 */
import { useState, useEffect, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform, ScrollView, useWindowDimensions, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
// VLC player for iOS/Android
let VLCPlayer: any = null
if (Platform.OS !== 'web') {
  VLCPlayer = require('react-native-vlc-media-player').VLCPlayer
}
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { usePlatform } from '@/lib/PlatformProvider'
import { useVideoPlayerContext, VideoStats } from '@/lib/VideoPlayerContext'

// HRPC methods used: getVideoUrl, prefetchVideo, getVideoStats, getChannelMeta

// Format helpers
function formatSize(bytes: number | string): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number | string): string {
  const value = typeof timestamp === 'string'
    ? (Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.parse(timestamp))
    : Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return 'Unknown'
  const date = new Date(value)
  return date.toLocaleDateString()
}

function formatTimeAgo(timestamp: number | string): string {
  const value = typeof timestamp === 'string'
    ? (Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.parse(timestamp))
    : Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return 'recently'
  const seconds = Math.floor((Date.now() - value) / 1000)
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
  const { rpc: appRpc } = useApp()
  const [globalPeers, setGlobalPeers] = useState(0)

  // Fetch global peer count as fallback when video stats are not available yet.
  useEffect(() => {
    let mounted = true
    let intervalId: NodeJS.Timeout | null = null

    const fetchGlobalStatus = async () => {
      try {
        const swarmStatus = await appRpc?.getSwarmStatus?.()
        const peerCount =
          swarmStatus?.peerCount ??
          swarmStatus?.swarmConnections ??
          swarmStatus?.swarmPeers
        if (mounted && peerCount !== undefined) {
          setGlobalPeers(peerCount)
        }
      } catch {
        // Ignore errors - backend might be unavailable
      }
    }

    if (!stats && appRpc) {
      fetchGlobalStatus()
      intervalId = setInterval(fetchGlobalStatus, 2000)
    }

    return () => {
      mounted = false
      if (intervalId) clearInterval(intervalId)
    }
  }, [stats, appRpc])

  console.log('[P2PStatsBar] Rendering, stats:', stats ? 'present' : 'null', 'globalPeers:', globalPeers)

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  // Get peer count - prefer video stats, fallback to global
  const peerCount = stats?.peerCount ?? globalPeers
  const downloadSpeedValue = Number(stats?.speedMBps ?? 0)
  const uploadSpeedValue = Number(stats?.uploadSpeedMBps ?? 0)
  const downloadSpeedText = Number.isFinite(downloadSpeedValue) ? downloadSpeedValue.toFixed(2) : '0.00'
  const uploadSpeedText = Number.isFinite(uploadSpeedValue) ? uploadSpeedValue.toFixed(2) : '0.00'

  // Status color and label
  const getStatusInfo = () => {
    if (!stats) {
      if (globalPeers > 0) return { color: '#60a5fa', label: 'Connected' }
      return { color: '#6b7280', label: 'Connecting...' }
    }
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
        <View style={styles.statsBarCenter}>
          <Feather name="users" color={colors.textMuted} size={12} />
          <Text style={styles.statsBarText}>{peerCount} peers</Text>
        </View>
        {stats && (
          <View style={styles.statsBarSpeeds}>
            <Text style={styles.statsBarSpeed}>↓ {downloadSpeedText} MB/s</Text>
            <Text style={styles.statsBarUploadSpeed}>↑ {uploadSpeedText} MB/s</Text>
          </View>
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
  const { isPear } = usePlatform()
  const { width: screenWidth } = useWindowDimensions()
  const videoHeight = Math.round(screenWidth * 9 / 16)
  const { rpc } = useApp()

  // VideoPlayerContext - SHARED player for continuous playback
  // Stats come via EVENT_VIDEO_STATS events from backend -> videoStatsEventEmitter -> context
  const {
    videoUrl,
    isPlaying,
    isLoading: loadingVideo,
    videoStats,
    playerRef,
    playbackRate,
    minimizePlayer,
    loadAndPlayVideo,
    setIsLoading,
    // VLC callbacks
    onProgress,
    onPlaying,
    onPaused,
    onBuffering,
    onEnded,
    onError,
  } = useVideoPlayerContext()

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

  // Intercept back navigation (swipe gesture, back button) to minimize instead of close
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      // Set mini mode when leaving screen (for any reason)
      minimizePlayer()
    })
    return unsubscribe
  }, [navigation, minimizePlayer])

  // Load video on mount (only if not coming from mini player which already has video loaded)
  useEffect(() => {
    if (videoData && !fromMiniPlayer && !videoLoaded) {
      loadVideo()
      setVideoLoaded(true)
    } else if (videoData && fromMiniPlayer && (Platform.OS !== 'web' || isPear)) {
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
  }, [videoData, fromMiniPlayer, isPear])

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
        // Use context's loadAndPlayVideo - this uses the shared player
        loadAndPlayVideo(videoData, result.url)

        // Start prefetch and poll for stats
        if (Platform.OS !== 'web' || isPear) {
          // Start prefetch first, then poll after a short delay to ensure stats are initialized
          startPrefetch()
          // Poll for stats - delay slightly to let prefetchVideo initialize stats
          setTimeout(() => startStatsPolling(), 500)
        }
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
        videoId: videoRef,
        publicBeeKey: (videoData as any)?.publicBeeKey || undefined
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
        }
      } catch (err) {
        console.error('[VideoPlayer] Stats polling error:', err)
      }
    }

    pollStats()
    statsPollingRef.current = setInterval(pollStats, 1000)
  }

  // Back/minimize button - beforeRemove listener handles minimizePlayer()
  const goBack = () => {
    router.back()
  }

  const channelName = channelMeta?.name || videoData?.channel?.name || `Channel ${videoData?.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = channelName.charAt(0).toUpperCase()

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Video Player Area */}
      <View style={styles.playerContainer}>
        {/* Minimize button overlay (chevron down) */}
        <Pressable style={styles.backButton} onPress={goBack}>
          <Feather name="chevron-down" color="#fff" size={28} />
        </Pressable>

        <View style={[styles.player, { height: videoHeight }]}>
          {loadingVideo ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="white" size="large" />
              <Text style={styles.loadingText}>Connecting to P2P network...</Text>
            </View>
          ) : videoUrl ? (
            Platform.OS === 'web' ? (
              <video src={videoUrl} controls autoPlay style={{ width: '100%', height: '100%', backgroundColor: '#000' }} />
            ) : (
              <View style={{ width: screenWidth, height: videoHeight }}>
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
                <P2PStatsOverlay
                  stats={localStats || videoStats}
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
        </View>
      </View>

      {/* Video Info & Actions */}
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* P2P Stats Bar */}
        {(Platform.OS !== 'web' || isPear) && <P2PStatsBar stats={localStats || videoStats} />}

        {/* Video Title & Meta */}
        <View style={styles.videoInfo}>
          <Text style={styles.videoTitle}>{videoData?.title || 'Untitled'}</Text>
          <Text style={styles.videoMeta}>
            {formatTimeAgo(videoData?.uploadedAt || Date.now())} · {formatSize(videoData?.size || 0)}
          </Text>
        </View>

        {/* Action Buttons */}
        <View style={styles.actions}>
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="thumbs-up" color={color} size={size} />} label="Like" />
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="thumbs-down" color={color} size={size} />} label="Dislike" />
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="share-2" color={color} size={size} />} label="Share" />
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="download" color={color} size={size} />} label="Download" />
          <ActionButton icon={({ color, size }: { color: string; size: number }) => <Feather name="more-horizontal" color={color} size={size} />} label="More" />
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
    color: '#4ade80',
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
})
