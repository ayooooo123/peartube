/**
 * Home Tab - YouTube-style Video Feed with P2P Public Feed Discovery
 */
import { useCallback, useState, useEffect, useRef } from 'react'
import { View, Text, RefreshControl, Pressable, ActivityIndicator, Platform, ScrollView, useWindowDimensions, AppState, AppStateStatus, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { X, Globe, RefreshCw, Users, EyeOff } from 'lucide-react-native'
import { useApp, colors } from '../_layout'
import { VideoCard, VideoData } from '../../components/video'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { usePlatform } from '@/lib/PlatformProvider'

// Public feed types
interface FeedEntry {
  driveKey: string
  addedAt: number
  source: 'peer' | 'local'
}

interface ChannelMeta {
  driveKey: string
  name?: string
  description?: string
  videoCount?: number
}

// Format helpers
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

// Detect Pear desktop vs mobile
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && !!(window as any).PearWorkerClient

export default function HomeScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { ready, identity, videos, loading, loadVideos, rpc } = useApp()
  const { loadAndPlayVideo } = useVideoPlayerContext()
  const { isDesktop } = usePlatform()
  const { width: screenWidth } = useWindowDimensions()

  // Calculate video grid columns for desktop
  const getGridColumns = () => {
    if (!isDesktop) return 1
    if (screenWidth >= 1400) return 4
    if (screenWidth >= 1100) return 3
    if (screenWidth >= 800) return 2
    return 1
  }
  const gridColumns = getGridColumns()

  // UI state
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingMyVideos, setRefreshingMyVideos] = useState(false)

  // Public feed state
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [channelMeta, setChannelMeta] = useState<Record<string, ChannelMeta>>({})
  const [feedLoading, setFeedLoading] = useState(false)
  const [peerCount, setPeerCount] = useState(0)
  const [lastFeedRefresh, setLastFeedRefresh] = useState<number | null>(null)
  const [swarmStatus, setSwarmStatus] = useState<{ peers: number; feedConnections?: number; drives?: number } | null>(null)

  // Channel viewing state
  const [viewingChannel, setViewingChannel] = useState<string | null>(null)
  const [channelVideos, setChannelVideos] = useState<VideoData[]>([])
  const [loadingChannel, setLoadingChannel] = useState(false)

  // Aggregated feed videos from all discovered channels
  const [feedVideos, setFeedVideos] = useState<VideoData[]>([])
  const [loadingFeedVideos, setLoadingFeedVideos] = useState(false)

  // Search (local + federated)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<VideoData[]>([])

  // Category filter state
  const categories = ['All', 'Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']
  const [activeCategory, setActiveCategory] = useState('All')

  // Thumbnail cache: key = `${driveKey}:${videoId}` -> url
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})
  const { platformEvents } = useApp()
  const appState = useRef<AppStateStatus>(AppState.currentState)

  // Fetch thumbnail for a video (non-blocking)
  const fetchThumbnail = useCallback(async (driveKey: string, videoId: string) => {
    if (isPear || !rpc) return // Desktop handles thumbnails differently
    const cacheKey = `${driveKey}:${videoId}`
    if (thumbnailCache[cacheKey]) return // Already cached

    try {
      const result = await rpc.getVideoThumbnail({ channelKey: driveKey, videoId })
      const url = result?.dataUrl || result?.url
      if (result?.exists && url) {
        setThumbnailCache(prev => ({ ...prev, [cacheKey]: url }))
      }
    } catch {
      // Silently fail - thumbnails are optional
    }
  }, [rpc, thumbnailCache])

  // Fetch thumbnails for a list of videos
  const fetchThumbnailsForVideos = useCallback((vids: VideoData[]) => {
    if (isPear) return
    for (const video of vids) {
      if (video.channelKey && video.id) {
        fetchThumbnail(video.channelKey, video.id)
      }
    }
  }, [fetchThumbnail])

  // Fetch thumbnails when own videos change
  useEffect(() => {
    if (videos.length > 0 && identity?.driveKey) {
      const vidsWithKey = videos.map(v => ({ ...v, channelKey: identity.driveKey }))
      fetchThumbnailsForVideos(vidsWithKey as VideoData[])
    }
  }, [videos, identity?.driveKey])

  // Load public feed on mount
  useEffect(() => {
    if (ready) {
      loadPublicFeed()
    }
    // Periodic refresh to keep discovery updated
    const interval = setInterval(() => {
      if (ready) {
        refreshFeed()
      }
    }, 30000)

    // Subscribe to feed update events emitted by backend
    const unsub = platformEvents?.onFeedUpdate?.(() => {
      loadPublicFeed()
    })

    return () => {
      clearInterval(interval)
      if (typeof unsub === 'function') unsub()
    }
  }, [ready, platformEvents, loadPublicFeed, refreshFeed])

  // Refresh discovery when app returns to foreground (mobile)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && appState.current !== 'active' && ready) {
        refreshFeed()
        if (feedVideos.length > 0) {
          fetchThumbnailsForVideos(feedVideos)
        }
      }
      appState.current = state
    })
    return () => sub.remove()
  }, [ready, refreshFeed, feedVideos, fetchThumbnailsForVideos])

  // Load public feed from backend
  const loadPublicFeed = useCallback(async () => {
    if (!rpc) return
    try {
      setFeedLoading(true)
      // Add timeout to prevent infinite spinner if RPC hangs
      const feedPromise = rpc.getPublicFeed({})
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000))
      const result = await Promise.race([feedPromise, timeoutPromise])

      if (result?.entries) {
        setFeedEntries(result.entries)
        for (const entry of result.entries) {
          // Schema returns channelKey, not driveKey
          if (entry.channelKey && !channelMeta[entry.channelKey]) {
            loadChannelMeta(entry.channelKey)
          }
        }
      }
      if (result?.stats) {
        setPeerCount(result.stats.peerCount || 0)
      }
      setLastFeedRefresh(Date.now())
      try {
        const statusPromise = rpc.getSwarmStatus()
        const status = await Promise.race([statusPromise, new Promise((r) => setTimeout(() => r(null), 3000))])
        if (status) {
          setSwarmStatus({
            peers: (status as any).peerCount || (status as any).swarmConnections || 0,
            feedConnections: (status as any).feedConnections,
            drives: (status as any).drivesLoaded,
          })
        }
      } catch {}
    } catch (err) {
      console.error('[Home] Failed to load public feed:', err)
    } finally {
      setFeedLoading(false)
    }
  }, [rpc, channelMeta])

  const runSearch = useCallback(async () => {
    if (!rpc || !identity?.driveKey) return
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults([])
      return
    }

    setSearching(true)
    try {
      const res = await (rpc as any).searchVideos?.({ channelKey: identity.driveKey, query: q, topK: 10, federated: true })
      const results = res?.results || []
      const vids = await Promise.all(
        results.map(async (r: any) => {
          try {
            const vd = await rpc.getVideoData({ channelKey: identity.driveKey, videoId: r.id })
            if (vd?.video) {
              return { ...vd.video, channelKey: identity.driveKey } as VideoData
            }
          } catch {}
          return null
        })
      )
      setSearchResults(vids.filter(Boolean) as VideoData[])
    } catch (err) {
      console.error('[Home] searchVideos failed:', err)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [rpc, identity?.driveKey, searchQuery])

  const loadChannelMeta = useCallback(async (driveKey: string) => {
    if (!rpc) return
    try {
      const result = await rpc.getChannelMeta({ channelKey: driveKey })
      if (result) {
        setChannelMeta(prev => ({ ...prev, [driveKey]: result }))
      }
    } catch (err) {
      console.error('[Home] Failed to load channel meta:', err)
    }
  }, [rpc])

  const refreshFeed = useCallback(async () => {
    if (!rpc) return
    try {
      await rpc.refreshFeed({})
      setTimeout(() => loadPublicFeed(), 1000)
    } catch (err) {
      console.error('[Home] Failed to refresh feed:', err)
    }
  }, [rpc, loadPublicFeed])

  const hideChannel = useCallback(async (driveKey: string) => {
    if (!rpc) return
    try {
      await rpc.hideChannel({ channelKey: driveKey })
      setFeedEntries(prev => prev.filter(e => e.driveKey !== driveKey && e.channelKey !== driveKey))
      // Also remove videos from that channel
      setFeedVideos(prev => prev.filter(v => v.channelKey !== driveKey))
    } catch (err) {
      console.error('[Home] Failed to hide channel:', err)
    }
  }, [rpc])

  // Load videos from all discovered channels
  const loadFeedVideos = useCallback(async () => {
    if (!rpc || feedEntries.length === 0) return

    setLoadingFeedVideos(true)

    // Helper: wrap a promise with a timeout so one hung channel doesn't block the whole feed
    const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
      ])

    // Fetch videos from channels IN PARALLEL with per-channel timeout (8s each)
    const PER_CHANNEL_TIMEOUT = 8000
    const channelPromises = feedEntries.slice(0, 15).map(async (entry) => {
      const channelKey = entry.channelKey || entry.driveKey
      if (!channelKey) return []

      try {
        // Join + list with combined timeout
        await withTimeout(rpc.joinChannel({ channelKey }), PER_CHANNEL_TIMEOUT, { success: false })
        const result = await withTimeout(rpc.listVideos({ channelKey }), PER_CHANNEL_TIMEOUT, { videos: [] })
        return (result?.videos || []).map((v: any) => ({
          ...v,
          channelKey,
          channel: { name: channelMeta[channelKey]?.name || 'Unknown' }
        }))
      } catch (err: any) {
        // Continue with other channels - this is expected for channels that haven't synced yet
        console.log('[Home] Failed to load videos from channel:', channelKey, '-', err?.message || err)
        return []
      }
    })

    const results = await Promise.all(channelPromises)
    const allVideos: VideoData[] = results.flat()

    // Sort by uploadedAt descending, limit to 50 videos
    const sorted = allVideos
      .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
      .slice(0, 50)

    setFeedVideos(sorted)
    setLoadingFeedVideos(false)

    // Fetch thumbnails for feed videos
    fetchThumbnailsForVideos(sorted)
  }, [rpc, feedEntries, channelMeta, fetchThumbnailsForVideos])

  // Load feed videos when feed entries change
  useEffect(() => {
    if (feedEntries.length > 0) {
      loadFeedVideos()
    }
  }, [feedEntries])

  // View a channel's videos
  const viewChannel = useCallback(async (driveKey: string) => {
    if (!rpc) return
    setViewingChannel(driveKey)
    setLoadingChannel(true)
    setChannelVideos([])

    try {
      // Join/get the channel first
      await rpc.joinChannel({ channelKey: driveKey })
      const result = await rpc.listVideos({ channelKey: driveKey })
      const videoList = result?.videos || []
      if (Array.isArray(videoList)) {
        const videosWithChannel = videoList.map((v: any) => ({
          ...v,
          channelKey: driveKey,
          channel: channelMeta[driveKey] ? { name: channelMeta[driveKey].name } : undefined
        }))
        setChannelVideos(videosWithChannel)
        // Fetch thumbnails for channel videos
        fetchThumbnailsForVideos(videosWithChannel)
      }
    } catch (err) {
      console.error('[Home] Failed to load channel videos:', err)
    } finally {
      setLoadingChannel(false)
    }
  }, [rpc, channelMeta, fetchThumbnailsForVideos])

  const closeChannelView = useCallback(() => {
    setViewingChannel(null)
    setChannelVideos([])
  }, [])

  // Play video - load into the global VideoPlayerOverlay (single player path on mobile + desktop)
  const playVideo = useCallback(async (video: VideoData) => {
    if (!rpc) return
    try {
      // Always close channel view when playing video
      setViewingChannel(null)
      setChannelVideos([])

      // Prefer stable identifier for RPC calls:
      // - Legacy channels expect a path
      // - Multi-writer/public-feed channels can resolve from id as well
      const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
        ? video.path
        : video.id

      const result = await rpc.getVideoUrl({
        channelKey: video.channelKey,
        videoId: videoRef
      })

      if (result?.url) {
        loadAndPlayVideo(video, result.url)
      }
    } catch (err) {
      console.error('[Home] Failed to play video:', err)
    }
  }, [rpc, loadAndPlayVideo])

  // Legacy: Play video in overlay only (used by mini player expansion)
  const playVideoInOverlay = useCallback(async (video: VideoData) => {
    if (!rpc) return
    try {
      // For overlay-only playback (no comments)
      setViewingChannel(null)
      setChannelVideos([])

      // Prefer stable identifier for RPC calls:
      // - Legacy channels expect a path
      // - Multi-writer/public-feed channels can resolve from id as well
      const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
        ? video.path
        : video.id

      // Get video URL from backend
      const result = await rpc.getVideoUrl({
        channelKey: video.channelKey,
        videoId: videoRef
      })

      if (result?.url) {
        // Load video into the overlay player (animates from mini to fullscreen)
        loadAndPlayVideo(video, result.url)
      }
    } catch (err) {
      console.error('[Home] Failed to play video:', err)
    }
  }, [rpc, loadAndPlayVideo])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    // Keep pull-to-refresh focused on Discover/public feed.
    await refreshFeed()
    setRefreshing(false)
  }, [identity, loadVideos, refreshFeed])

  const refreshMyVideos = useCallback(async () => {
    if (!identity?.driveKey) return
    setRefreshingMyVideos(true)
    try {
      await loadVideos(identity.driveKey)
    } finally {
      setRefreshingMyVideos(false)
    }
  }, [identity?.driveKey, loadVideos])

  // Convert videos to VideoData format with channel info and thumbnails
  const myVideosWithMeta: VideoData[] = videos.map(v => {
    const cacheKey = identity?.driveKey ? `${identity.driveKey}:${v.id}` : ''
    const thumbnailUrl = thumbnailCache[cacheKey] || v.thumbnail || null
    return {
      ...v,
      channelKey: identity?.driveKey || '',
      channel: identity ? { name: identity.name } : undefined,
      thumbnailUrl
    }
  })

  // Add thumbnails to channel videos from cache
  const channelVideosWithThumbs: VideoData[] = channelVideos.map(v => {
    const cacheKey = `${v.channelKey}:${v.id}`
    return {
      ...v,
      thumbnailUrl: thumbnailCache[cacheKey] || v.thumbnailUrl || v.thumbnail || null
    }
  })

  // Add thumbnails to feed videos from cache
  const feedVideosWithThumbs: VideoData[] = feedVideos.map(v => {
    const cacheKey = `${v.channelKey}:${v.id}`
    return {
      ...v,
      thumbnailUrl: thumbnailCache[cacheKey] || v.thumbnailUrl || v.thumbnail || null
    }
  })

  if (!ready || loading) {
    return (
      <View className="flex-1 bg-pear-bg justify-center items-center">
        <ActivityIndicator size="large" color={colors.primary} />
        <Text className="text-pear-text-muted mt-4 text-label">
          {!ready ? 'Starting P2P network...' : 'Loading...'}
        </Text>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-pear-bg">
      {/* Header - only show on mobile */}
      {!isDesktop && (
        <View className="bg-pear-bg border-b border-pear-border" style={{ paddingTop: insets.top }}>
          <View className="flex-row px-5 py-4 items-center justify-between">
            <Text className="text-title text-pear-text">PearTube</Text>
            {identity && (
              <View className="bg-pear-bg-card px-3 py-1.5 rounded-full">
                <Text className="text-caption text-pear-text-secondary">{identity.name}</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Channel View Modal */}
      {viewingChannel && (
        <View className="flex-1">
          <View className="flex-row items-center py-4 bg-pear-bg-elevated border-b border-pear-border" style={{ paddingHorizontal: isDesktop ? 24 : 20 }}>
            <Pressable onPress={closeChannelView} className="mr-3 p-1"><X color={colors.text} size={24} /></Pressable>
            <View className="flex-1">
              <Text className="text-headline text-pear-text">{channelMeta[viewingChannel]?.name || 'Channel'}</Text>
              <Text className="text-caption text-pear-text-muted">{viewingChannel.slice(0, 16)}...</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 20, paddingHorizontal: isDesktop ? 24 : 0 }}>
            {loadingChannel ? (
              <View className="py-12 items-center">
                <ActivityIndicator color={colors.primary} size="large" />
                <Text className="text-label text-pear-text-muted mt-4">Loading videos...</Text>
              </View>
            ) : channelVideos.length === 0 ? (
              <View className="py-12 items-center bg-pear-bg-elevated rounded-xl" style={{ marginHorizontal: isDesktop ? 0 : 20 }}>
                <Text className="text-label text-pear-text mt-2">No videos yet</Text>
              </View>
            ) : (
              <View style={isDesktop ? { paddingTop: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 24 } : { paddingTop: 8 }}>
                {channelVideosWithThumbs.map((video) => (
                  <View
                    key={video.id}
                    style={isDesktop ? {
                      width: `calc(${100 / gridColumns}% - ${(gridColumns - 1) * 24 / gridColumns}px)`,
                    } as any : undefined}
                  >
                    <VideoCard
                      video={video}
                      onPress={() => playVideo(video)}
                      showChannelInfo={false}
                    />
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      )}

      {/* Main Feed */}
      {!viewingChannel && (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 16, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* Discover Section */}
          <View style={{ paddingHorizontal: isDesktop ? 24 : 20, paddingTop: isDesktop ? 24 : 16 }}>
            <View className="flex-row items-center justify-between mb-3">
              <View className="flex-row items-center">
                <Globe color={colors.primary} size={18} />
                <Text className="text-headline text-pear-text ml-2">Discover</Text>
                {peerCount > 0 && (
                  <View className="flex-row items-center ml-2 bg-pear-bg-card px-2 py-0.5 rounded-full">
                    <Users color={colors.textMuted} size={12} />
                    <Text className="text-caption text-pear-text-muted ml-1">{peerCount}</Text>
                  </View>
                )}
              </View>
              <Pressable onPress={refreshFeed} className="p-2 active:opacity-60" disabled={feedLoading}>
                <RefreshCw color={feedLoading ? colors.textMuted : colors.primary} size={18} />
              </Pressable>
            </View>

            {/* Search (your channel) */}
            {identity?.driveKey && (
              <View style={{ marginBottom: 12 }}>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 6 }}>Search your channel</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search videos…"
                    placeholderTextColor={colors.textMuted}
                    style={{
                      flex: 1,
                      color: colors.text,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.bgSecondary,
                      borderRadius: 10,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      fontSize: 14,
                    }}
                    autoCapitalize="none"
                    returnKeyType="search"
                    onSubmitEditing={runSearch}
                  />
                  <Pressable
                    onPress={runSearch}
                    disabled={searching || !searchQuery.trim()}
                    style={{
                      paddingHorizontal: 14,
                      justifyContent: 'center',
                      borderRadius: 10,
                      backgroundColor: colors.primary,
                      opacity: (searching || !searchQuery.trim()) ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: 'white', fontWeight: '600' }}>{searching ? '…' : 'Search'}</Text>
                  </Pressable>
                </View>

                {searchResults.length > 0 && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 6 }}>Results</Text>
                    <View style={{ gap: 12 }}>
                      {searchResults.map((video) => (
                        <VideoCard
                          key={`search-${video.id}`}
                          video={video}
                          onPress={() => playVideo(video)}
                          showChannelInfo={false}
                        />
                      ))}
                    </View>
                  </View>
                )}
              </View>
            )}

            {/* P2P status pills */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 8, marginBottom: 6 }}>
                <Text style={{ color: colors.text, fontSize: 12 }}>Peers: {swarmStatus?.peers ?? peerCount}</Text>
                {swarmStatus?.feedConnections !== undefined && (
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 6 }}>Feed: {swarmStatus.feedConnections}</Text>
                )}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 8, marginBottom: 6 }}>
                <Text style={{ color: colors.text, fontSize: 12 }}>Channels: {feedEntries.length}</Text>
                {swarmStatus?.drives !== undefined && (
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 6 }}>Drives: {swarmStatus.drives}</Text>
                )}
              </View>
              {lastFeedRefresh && (
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 8, marginBottom: 6 }}>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                    Updated {formatTimeAgo(lastFeedRefresh)}
                  </Text>
                </View>
              )}
            </View>

            {/* Category Filter Chips */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 12 }}
              contentContainerStyle={{ gap: 8 }}
            >
              {categories.map((cat) => (
                <Pressable
                  key={cat}
                  onPress={() => setActiveCategory(cat)}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: activeCategory === cat ? colors.text : colors.bgCard,
                  }}
                >
                  <Text style={{
                    fontSize: 14,
                    fontWeight: '500',
                    color: activeCategory === cat ? colors.bg : colors.text,
                  }}>
                    {cat}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {(feedLoading || loadingFeedVideos) && feedVideos.length === 0 ? (
              <View className="py-8 items-center">
                <ActivityIndicator color={colors.primary} />
                <Text className="text-caption text-pear-text-muted mt-2">Discovering videos...</Text>
              </View>
            ) : feedVideos.length === 0 ? (
              <View className="py-8 items-center bg-pear-bg-elevated rounded-xl">
                <Globe color={colors.textMuted} size={32} />
                <Text className="text-label text-pear-text mt-2">No videos discovered yet</Text>
                <Text className="text-caption text-pear-text-muted mt-1">Click refresh or wait for peers to connect</Text>
              </View>
            ) : (
              <View style={isDesktop ? {
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 24,
              } : { gap: 12 }}>
                {feedVideosWithThumbs
                  .filter(v => activeCategory === 'All' || (v as any).category === activeCategory)
                  .map((video) => (
                  <View
                    key={`${video.channelKey}-${video.id}`}
                    style={isDesktop ? {
                      width: `calc(${100 / gridColumns}% - ${(gridColumns - 1) * 24 / gridColumns}px)`,
                    } as any : { marginBottom: 12 }}
                  >
                    <VideoCard
                      video={video}
                      onPress={() => playVideo(video)}
                      showChannelInfo={true}
                    />
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Your Videos - Responsive Grid on Desktop, List on Mobile */}
          <View style={{ paddingTop: 24, paddingHorizontal: isDesktop ? 24 : 0 }}>
            <View className="flex-row items-center justify-between mb-3" style={{ paddingHorizontal: isDesktop ? 0 : 20 }}>
              <Text className="text-headline text-pear-text">Your Videos</Text>
              <Pressable
                onPress={refreshMyVideos}
                className="p-2 active:opacity-60"
                disabled={refreshingMyVideos || !identity?.driveKey}
              >
                <RefreshCw color={refreshingMyVideos ? colors.textMuted : colors.primary} size={18} />
              </Pressable>
            </View>
            {console.log('[Home] Rendering Your Videos section, count:', myVideosWithMeta.length, 'viewingChannel:', viewingChannel)}
            {myVideosWithMeta.length === 0 ? (
              <View className="py-12 items-center bg-pear-bg-elevated rounded-xl" style={{ marginHorizontal: isDesktop ? 0 : 20 }}>
                <Text className="text-display mb-4">📺</Text>
                <Text className="text-label text-pear-text mb-2">No videos yet</Text>
                <Text className="text-caption text-pear-text-muted text-center px-8">
                  Upload your first video from the Studio tab
                </Text>
              </View>
            ) : (
              <View style={isDesktop ? {
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 24,
              } : { gap: 12 }}>
                {myVideosWithMeta.map((video) => (
                  <View
                    key={video.id}
                    style={isDesktop ? {
                      width: `calc(${100 / gridColumns}% - ${(gridColumns - 1) * 24 / gridColumns}px)`,
                    } as any : { marginBottom: 12 }}
                  >
                    <VideoCard
                      video={video}
                      onPress={() => playVideo(video)}
                      showChannelInfo={true}
                    />
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  )
}
