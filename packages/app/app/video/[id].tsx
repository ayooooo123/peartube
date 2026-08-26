/**
 * Video Player Screen - YouTube-style dedicated video playback page
 * Shows: video player, title, channel info, P2P stats, action buttons
 * Supports swipe-down to minimize to mini player
 * Uses SHARED player from VideoPlayerContext for continuous playback
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform, ScrollView, useWindowDimensions, StyleSheet, Alert } from 'react-native'
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { usePlatform } from '@/lib/PlatformProvider'
import { SwarmIndicator } from '@/components/primitives'
import { formatSizeLabel, formatTimeAgo, formatViews } from '@/lib/formatters'
import { getPlayerPageVideoHeight } from '@/lib/video-layout'
import { useVideoPlayerActions, useVideoPlayerSession, VideoStats } from '@/lib/VideoPlayerContext'
import { useCast } from '@/lib/cast'
import { DevicePickerModal, CastRemoteModal } from '@/components/cast'
import { VideoEditModal } from '@/components/VideoEditModal'
import { makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'

// HRPC methods used: preparePlayback, getVideoUrl, getVideoStats, getChannelMeta

function formatDate(timestamp: number | string): string {
  const value = typeof timestamp === 'string'
    ? (Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.parse(timestamp))
    : Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return 'Unknown'
  const date = new Date(value)
  return date.toLocaleDateString()
}

function showCastAlert(message: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message)
    return
  }
  Alert.alert('Chromecast', message)
}

function isStatsComplete(stats: VideoStats | null | undefined) {
  if (!stats) return false
  return Boolean(
    stats.isComplete ||
    stats.status === 'complete' ||
    stats.progress >= 100 ||
    (typeof stats.totalBlocks === 'number' &&
      stats.totalBlocks > 0 &&
      stats.downloadedBlocks >= stats.totalBlocks)
  )
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
  const [globalConnections, setGlobalConnections] = useState(0)
  const [statsExpanded, setStatsExpanded] = useState(false)

  // Fetch global connection count as network diagnostics when video stats are not available yet.
  useEffect(() => {
    let mounted = true
    let intervalId: NodeJS.Timeout | null = null

    const fetchGlobalStatus = async () => {
      try {
        const swarmStatus = await appRpc?.getSwarmStatus?.()
        const connectionCount = swarmStatus?.swarmConnections ?? 0
        if (mounted) {
          setGlobalConnections(connectionCount)
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

  if (__DEV__) {
    console.log('[P2PStatsBar] Rendering, stats:', stats ? 'present' : 'null', 'globalConnections:', globalConnections)
  }

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  const videoPeerCount = stats?.peerCount ?? 0
  const downloadSpeedValue = Number(stats?.speedMBps ?? 0)
  const uploadSpeedValue = Number(stats?.uploadSpeedMBps ?? 0)
  const hasPlayableProgress = downloadSpeedValue > 0
  const downloadSpeedText = Number.isFinite(downloadSpeedValue) ? downloadSpeedValue.toFixed(2) : '0.00'
  const uploadSpeedText = Number.isFinite(uploadSpeedValue) ? uploadSpeedValue.toFixed(2) : '0.00'

  // Status color and label
  const getStatusInfo = () => {
    if (!stats) {
      return { color: '#6b7280', label: 'Waiting for video peers' }
    }
    if (stats.isComplete) return { color: '#4ade80', label: 'Cached' }
    if (stats.status === 'downloading') return { color: '#fbbf24', label: 'Downloading' }
    if (hasPlayableProgress) return { color: '#60a5fa', label: 'Streaming' }
    if (stats.status === 'connecting') return { color: '#60a5fa', label: 'Connecting...' }
    if (stats.status === 'resolving') return { color: '#a78bfa', label: 'Resolving...' }
    if (stats.status === 'error') return { color: '#f87171', label: 'Error' }
    return { color: '#6b7280', label: 'Waiting' }
  }

  const statusInfo = getStatusInfo()

  // Human one-liner shown by default; raw numbers live behind a tap.
  const statusLine = !stats
    ? (globalConnections > 0 ? 'Reaching out to peers…' : 'Waiting for the swarm…')
    : stats.isComplete
      ? 'Saved on this device'
      : stats.status === 'error'
        ? 'Playback hit a snag'
        : videoPeerCount > 0
          ? `Streaming from ${videoPeerCount} ${videoPeerCount === 1 ? 'peer' : 'peers'}`
          : hasPlayableProgress
            ? 'Streaming'
            : 'Reaching out to peers…'

  return (
    <Pressable
      style={styles.statsBar}
      onPress={() => setStatsExpanded((v) => !v)}
      accessibilityRole="button"
      accessibilityLabel={`${statusLine}. Tap for network details`}
      accessibilityState={{ expanded: statsExpanded }}
    >
      {/* Ambient row */}
      <View style={styles.statsBarRow}>
        <View style={styles.statsBarLeft}>
          {stats?.isComplete ? (
            <Feather name="check-circle" size={12} color={colors.primary} />
          ) : (
            <SwarmIndicator peers={stats ? videoPeerCount : globalConnections} size={6} />
          )}
          <Text style={[styles.statsBarText, { color: statusInfo.color }]}>{statusLine}</Text>
        </View>
        <Feather name={statsExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
      </View>

      {/* Progress bar */}
      {stats && !stats.isComplete && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${stats.progress || 0}%` }]} />
        </View>
      )}

      {statsExpanded && !stats && globalConnections > 0 && (
        <View style={styles.statsBarRow2}>
          <Text style={styles.statsBarDetail}>Network online: {globalConnections} connection{globalConnections !== 1 ? 's' : ''}</Text>
        </View>
      )}

      {/* Detail rows */}
      {statsExpanded && stats && (
        <>
          <View style={styles.statsBarRow2}>
            <Text style={styles.statsBarDetail}>{videoPeerCount} video peer{videoPeerCount !== 1 ? 's' : ''}</Text>
            <Text style={styles.statsBarSpeed}>↓ {downloadSpeedText} MB/s</Text>
            <Text style={styles.statsBarUploadSpeed}>↑ {uploadSpeedText} MB/s</Text>
          </View>
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
        </>
      )}
    </Pressable>
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
      <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
    </Pressable>
  )
}

// Channel Info Component
function ChannelInfo({ channelName, channelInitial, onChannelPress }: { channelName: string, channelInitial: string, onChannelPress?: () => void }) {
  return (
    <View style={styles.channelRow}>
      <Pressable
        onPress={onChannelPress}
        disabled={!onChannelPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          flex: 1,
          opacity: pressed ? 0.7 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <View style={styles.channelAvatar}>
          <Text style={styles.channelAvatarText}>{channelInitial}</Text>
        </View>
        <View style={styles.channelInfo}>
          <Text style={[styles.channelName, onChannelPress && styles.channelNameLink]}>{channelName}</Text>
          <Text style={styles.channelSubs}>Channel</Text>
        </View>
      </Pressable>
      <Pressable style={styles.subscribeButton}>
        <Text style={styles.subscribeText}>Subscribe</Text>
      </Pressable>
    </View>
  )
}

export default function VideoPlayerScreen() {
  const { isPear, isDesktop } = usePlatform()

  // Desktop: the VideoPlayerOverlay handles the full YouTube-style layout.
  // This route shouldn't render — the overlay is the video page on desktop.
  if (Platform.OS === 'web' && isDesktop) {
    return null
  }

  return <MobileVideoPlayerScreen />
}

function MobileVideoPlayerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const { isPear } = usePlatform()
  const { width: screenWidth } = useWindowDimensions()
  const videoHeight = getPlayerPageVideoHeight(screenWidth)
  const { rpc, identity } = useApp()
  // VideoPlayerContext - SHARED player for continuous playback
  // Stats come via EVENT_VIDEO_STATS events from backend -> videoStatsEventEmitter -> context
  const {
    currentVideo,
    videoUrl,
    isLoading: loadingVideo,
    playbackError,
    videoStats,
  } = useVideoPlayerSession()
  const { minimizePlayer, loadAndPlayVideo, setIsLoading } = useVideoPlayerActions()

  // Parse video data from params (JSON encoded or URL params)
  const params = useLocalSearchParams()
  const channelKeyParam = params.channel as string | undefined
  const rawPublicBeeParam = params.publicBeeKey ?? params.publicBee
  const publicBeeParam = Array.isArray(rawPublicBeeParam) ? rawPublicBeeParam[0] : (rawPublicBeeParam as string | undefined)
  const videoDataParam = params.videoData ? JSON.parse(params.videoData as string) : null
  const fromMiniPlayer = params.fromMiniPlayer === 'true'

  // Local UI state only
  const [showStats, setShowStats] = useState(false)
  const [channelMeta, setChannelMeta] = useState<{ name?: string } | null>(null)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const [localStats, setLocalStats] = useState<VideoStats | null>(null)
  const [videoData, setVideoData] = useState<any>(videoDataParam)
  const [loadingMeta, setLoadingMeta] = useState(!videoDataParam && !!channelKeyParam)
  const statsPollingRef = useRef<NodeJS.Timeout | null>(null)
  const statsPollingDelayRef = useRef<NodeJS.Timeout | null>(null)
  const mountedRef = useRef(true)
  const loadGenerationRef = useRef(0)

  // Video editing
  const [editingVideo, setEditingVideo] = useState<any>(null)

  // Casting
  const cast = useCast()
  const [showCastPicker, setShowCastPicker] = useState(false)
  const [showCastRemote, setShowCastRemote] = useState(false)
  const [connectingCastDeviceId, setConnectingCastDeviceId] = useState<string | null>(null)
  const [recentCastDeviceId, setRecentCastDeviceId] = useState<string | null>(null)

  const clearStatsPolling = useCallback(() => {
    if (statsPollingDelayRef.current) {
      clearTimeout(statsPollingDelayRef.current)
      statsPollingDelayRef.current = null
    }
    if (statsPollingRef.current) {
      clearInterval(statsPollingRef.current)
      statsPollingRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
      clearStatsPolling()
    }
  }, [clearStatsPolling])

  // Fetch video metadata if not provided (YouTube-style: load from ID)
  useEffect(() => {
    if (videoDataParam || !channelKeyParam || !id || !rpc) return

    let cancelled = false
    const fetchVideoData = async () => {
      if (__DEV__) {
        console.log('[VideoPlayer] Fetching video data for:', id, 'from channel:', channelKeyParam)
      }
      setLoadingMeta(true)
      try {
        const result = await rpc.getVideoData({
          channelKey: channelKeyParam,
          videoId: id,
          publicBeeKey: publicBeeParam || undefined
        })
        const fetchedVideoData = result?.video || result
        if (!cancelled && mountedRef.current && fetchedVideoData) {
          if (__DEV__) {
            console.log('[VideoPlayer] Got video data:', fetchedVideoData.title)
          }
          setVideoData({
            id,
            channelKey: channelKeyParam,
            publicBeeKey: publicBeeParam,
            ...fetchedVideoData
          })
        }
      } catch (err) {
        console.error('[VideoPlayer] Failed to fetch video data:', err)
      } finally {
        if (!cancelled && mountedRef.current) {
          setLoadingMeta(false)
        }
      }
    }

    fetchVideoData()
    return () => {
      cancelled = true
    }
  }, [id, channelKeyParam, publicBeeParam, videoDataParam, rpc])

  // Intercept back navigation (swipe gesture, back button) to minimize instead of close
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      // Set mini mode when leaving screen (for any reason)
      minimizePlayer()
    })
    return unsubscribe
  }, [navigation, minimizePlayer])

  const loadChannelInfo = useCallback(async () => {
    if (!videoData?.channelKey || !rpc) return
    try {
      const result = await rpc.getChannelMeta({
        channelKey: videoData.channelKey,
        publicBeeKey: videoData.publicBeeKey || undefined,
      })
      setChannelMeta(result)
    } catch (err) {
      console.error('[VideoPlayer] Failed to load channel info:', err)
    }
  }, [rpc, videoData?.channelKey, videoData?.publicBeeKey])

  const startStatsPolling = useCallback(() => {
    if (!videoData || !rpc) return
    if (!mountedRef.current) return
    clearStatsPolling()
    const videoRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
      ? videoData.path
      : videoData.id
    if (__DEV__) {
      console.log('[VideoPlayer] Starting stats polling for', videoRef)
    }

    const pollStats = async () => {
      try {
        const result = await rpc.getVideoStats({
          channelKey: videoData.channelKey,
          videoId: videoRef
        })
        const stats = result?.stats
        if (__DEV__) {
          console.log('[VideoPlayer] Got stats:', stats ? `${stats.progress}%` : 'null')
        }
        if (mountedRef.current && stats) {
          setLocalStats(stats as VideoStats)
          if (isStatsComplete(stats as VideoStats) && statsPollingRef.current) {
            clearInterval(statsPollingRef.current)
            statsPollingRef.current = null
          }
        }
      } catch (err) {
        console.error('[VideoPlayer] Stats polling error:', err)
      }
    }

    pollStats()
    statsPollingRef.current = setInterval(pollStats, 1000)
  }, [clearStatsPolling, rpc, videoData])

  const scheduleStatsPolling = useCallback((delayMs = 0) => {
    if (statsPollingDelayRef.current) {
      clearTimeout(statsPollingDelayRef.current)
    }
    statsPollingDelayRef.current = setTimeout(() => {
      statsPollingDelayRef.current = null
      if (!mountedRef.current) return
      startStatsPolling()
    }, delayMs)
  }, [startStatsPolling])

  const loadVideo = useCallback(async () => {
    if (!videoData || !rpc) return
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    clearStatsPolling()
    setLocalStats(null)
    setIsLoading(true)

    try {
      const videoRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
        ? videoData.path
        : videoData.id
      const videoAny = videoData as any
      const playbackRequest = {
        channelKey: videoData.channelKey,
        videoId: videoRef,
        publicBeeKey: videoAny.publicBeeKey || undefined,
        blobId: videoAny.blobId || undefined,
        blobsCoreKey: videoAny.blobsCoreKey || undefined,
        mimeType: videoAny.mimeType || undefined,
      }

      const cacheKey = makeVideoUrlCacheKey(
        videoData.channelKey,
        videoRef,
        videoAny.blobId || undefined,
        videoAny.blobsCoreKey || undefined,
      )
      // Resolve-and-stream: get the blob-server URL and hand it to the player,
      // which fetches byte ranges on demand. No prewarming.
      const result = await rpc.preparePlayback(playbackRequest)
      if (!result || !mountedRef.current || loadGenerationRef.current !== generation) return

      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
        // Use context's loadAndPlayVideo - this uses the shared player
        loadAndPlayVideo(videoData, result.url)

        if (result?.stats) {
          setLocalStats(result.stats as VideoStats)
        }

        if (Platform.OS !== 'web' || isPear) {
          if (!isStatsComplete(result?.stats as VideoStats | null | undefined)) {
            scheduleStatsPolling(0)
          }
        }
      } else {
        if (result?.stats) {
          setLocalStats(result.stats as VideoStats)
        }
        scheduleStatsPolling(0)
      }
    } catch (err) {
      console.error('[VideoPlayer] Failed to load video:', err)
      if (mountedRef.current && loadGenerationRef.current === generation) {
        setIsLoading(false)
      }
    }
  }, [clearStatsPolling, isPear, loadAndPlayVideo, rpc, scheduleStatsPolling, setIsLoading, videoData])

  // Load video when videoData is available (either from params or fetched)
  useEffect(() => {
    if (!videoData || loadingMeta) return
    const channelInfoTimer = setTimeout(() => {
      void loadChannelInfo()
    }, 250)

    const currentRef = (currentVideo?.path && typeof currentVideo.path === 'string' && currentVideo.path.startsWith('/'))
      ? currentVideo.path
      : currentVideo?.id
    const targetRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
      ? videoData.path
      : videoData.id
    const sameChannel = !currentVideo?.channelKey || !videoData?.channelKey || currentVideo.channelKey === videoData.channelKey
    const isSameVideoAsCurrent = Boolean(currentRef && targetRef && currentRef === targetRef && sameChannel)

    if (!videoLoaded) {
      if (isSameVideoAsCurrent && videoUrl && (Platform.OS !== 'web' || isPear)) {
        setIsLoading(false)
        startStatsPolling()
      } else {
        loadVideo()
      }
      setVideoLoaded(true)
    }

    return () => {
      clearTimeout(channelInfoTimer)
      clearStatsPolling()
    }
  }, [videoData, loadingMeta, isPear, videoLoaded, loadVideo, startStatsPolling, loadChannelInfo, currentVideo, videoUrl, setIsLoading, clearStatsPolling])

  // Back/minimize button - beforeRemove listener handles minimizePlayer()
  const goBack = () => {
    router.back()
  }

  const goSearch = () => {
    router.push('/search')
  }

  const channelName = channelMeta?.name || videoData?.channel?.name || `Channel ${videoData?.channelKey?.slice(0, 8) || 'Unknown'}`
  const channelInitial = channelName.charAt(0).toUpperCase()

  // Show loading while fetching video metadata
  if (loadingMeta) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={{ color: colors.textSecondary, marginTop: 16 }}>Loading video...</Text>
      </View>
    )
  }

  const displayedStats = videoStats || localStats

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Video Player Area */}
      <View style={styles.playerContainer}>
        {/* Minimize button overlay (chevron down) */}
        <Pressable testID="player-minimize-button" style={styles.backButton} onPress={goBack}>
          <Feather name="chevron-down" color="#fff" size={28} />
        </Pressable>
        <Pressable style={styles.searchButton} onPress={goSearch}>
          <Feather name="search" color="#fff" size={22} />
        </Pressable>

        {/* Cast button */}
        <Pressable style={styles.castButton} onPress={() => {
          if (cast.isConnected) {
            setShowCastRemote(true)
            return
          }
          cast.startDiscovery()
          setShowCastPicker(true)
        }}>
          <Feather name="cast" color={cast.isConnected ? colors.primary : "#fff"} size={22} />
        </Pressable>

        <View style={[styles.player, { height: videoHeight }]}>
          {playbackError?.terminal ? (
            // The source will not decode on a later attempt, so this replaces
            // the loading gate rather than sitting behind it.
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>{playbackError.message}</Text>
            </View>
          ) : loadingVideo ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color="white" size="large" />
              <Text style={styles.loadingText}>Connecting to P2P network...</Text>
            </View>
          ) : videoUrl ? (
            <View style={{ width: screenWidth, height: videoHeight }}>
              {/* Video is rendered by VideoPlayerOverlay on all platforms */}
              <P2PStatsOverlay
                stats={displayedStats}
                showDetails={showStats}
                onPress={() => setShowStats(!showStats)}
              />
            </View>
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
        {(Platform.OS !== 'web' || isPear) && <P2PStatsBar stats={displayedStats} />}

        {/* Video Title & Meta */}
        <View style={styles.videoInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <Text style={[styles.videoTitle, { flex: 1 }]}>{videoData?.title || 'Untitled'}</Text>
            {identity?.driveKey && identity.driveKey === videoData?.channelKey && (
              <Pressable
                onPress={() => setEditingVideo(videoData)}
                style={{ padding: 8, marginLeft: 8 }}
              >
                <Feather name="edit-2" color={colors.textMuted} size={20} />
              </Pressable>
            )}
          </View>
          {cast.isConnected && (
            <View style={styles.castBanner}>
              <Feather name="cast" color={colors.primary} size={14} />
              <Text style={styles.castBannerText} numberOfLines={1}>
                Casting to {cast.connectedDevice?.name || 'Cast device'}
              </Text>
              <Pressable onPress={() => setShowCastRemote(true)} style={styles.castBannerAction}>
                <Text style={styles.castBannerActionText}>Remote</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  await cast.disconnect()
                  setShowCastRemote(false)
                }}
                style={styles.castBannerAction}
              >
                <Text style={styles.castBannerActionText}>Disconnect</Text>
              </Pressable>
            </View>
          )}
          <Text style={styles.videoMeta}>
            {[formatTimeAgo(videoData?.uploadedAt || Date.now()), formatSizeLabel(videoData?.size)]
              .filter(Boolean)
              .join(' · ')}
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
        <ChannelInfo
          channelName={channelName}
          channelInitial={channelInitial}
          onChannelPress={videoData?.channelKey ? () => router.push({ pathname: '/channel/[key]', params: { key: videoData.channelKey, publicBeeKey: videoData.publicBeeKey || undefined } }) : undefined}
        />

        {/* Divider */}
        <View style={styles.divider} />

        {/* Description */}
        {videoData?.description && (
          <View style={styles.description}>
            <Text style={styles.descriptionText}>{videoData.description}</Text>
          </View>
        )}
      </ScrollView>

      {/* Cast Device Picker Modal */}
      <DevicePickerModal
        visible={showCastPicker}
        devices={cast.devices}
        connectedDevice={cast.connectedDevice}
        connectingDeviceId={connectingCastDeviceId}
        recentDeviceId={recentCastDeviceId}
        isDiscovering={cast.isDiscovering}
        onClose={() => {
          cast.stopDiscovery()
          setShowCastPicker(false)
          setConnectingCastDeviceId(null)
        }}
        onDeviceSelect={async (deviceId: string) => {
          setConnectingCastDeviceId(deviceId)
          try {
            const success = await cast.connect(deviceId)
            if (!success) {
              showCastAlert(cast.lastError || 'Failed to connect to Chromecast device.')
              return
            }
            setRecentCastDeviceId(deviceId)

            let urlToCast = videoUrl
            if (!urlToCast && videoData && rpc?.getVideoUrl) {
              try {
                const videoRef = (videoData.path && typeof videoData.path === 'string' && videoData.path.startsWith('/'))
                  ? videoData.path
                  : videoData.id
                const result = await rpc.getVideoUrl({
                  channelKey: videoData.channelKey,
                  videoId: videoRef,
                })
                urlToCast = result?.url || null
              } catch (err: any) {
                showCastAlert(err?.message || 'Failed to resolve video URL for casting.')
                return
              }
            }

            if (!urlToCast) {
              showCastAlert('Video URL is not ready yet. Try again once playback starts.')
              return
            }

            await cast.play({
              url: urlToCast,
              contentType: videoData?.mimeType || 'video/mp4',
              title: videoData?.title,
            })
            setShowCastPicker(false)
            setShowCastRemote(true)
          } finally {
            setConnectingCastDeviceId(null)
          }
        }}
        onDisconnect={async () => {
          await cast.disconnect()
          setShowCastPicker(false)
          setShowCastRemote(false)
        }}
        onAddManualDevice={cast.addManualDevice}
        onRefresh={cast.startDiscovery}
      />
      <CastRemoteModal
        visible={showCastRemote}
        onClose={() => setShowCastRemote(false)}
        onSwitchDevice={() => {
          setShowCastRemote(false)
          cast.startDiscovery()
          setShowCastPicker(true)
        }}
        videoTitle={videoData?.title || null}
      />

      {/* Video Edit Modal */}
      <VideoEditModal
        visible={!!editingVideo}
        video={editingVideo}
        channelKey={videoData?.channelKey || ''}
        onClose={() => setEditingVideo(null)}
        onSaved={() => {
          setEditingVideo(null)
          if (rpc && videoData?.channelKey && id) {
            rpc.getVideoData({
              channelKey: videoData.channelKey,
              videoId: id,
              publicBeeKey: videoData?.publicBeeKey || undefined,
              blobId: videoData?.blobId || undefined,
              blobsCoreKey: videoData?.blobsCoreKey || undefined,
            }).then((result: any) => {
              if (result) setVideoData((prev: any) => ({ ...prev, ...result }))
            }).catch(() => {})
          }
        }}
      />
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
  searchButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  castButton: {
    position: 'absolute',
    top: 12,
    right: 60,
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
  castBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  castBannerText: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  castBannerAction: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  castBannerActionText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  actionButton: {
    width: '16.66%',
    minWidth: 56,
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  actionLabel: {
    color: colors.text,
    fontSize: 10,
    marginTop: 4,
    maxWidth: '100%',
    textAlign: 'center',
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
  channelNameLink: {
    textDecorationLine: 'underline' as const,
    textDecorationStyle: 'dotted' as const,
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
