/**
 * Home Tab - YouTube-style Video Feed with P2P Public Feed Discovery
 */
import { useCallback, useState, useEffect } from 'react'
import { View, Text, RefreshControl, Pressable, ActivityIndicator, Platform, ScrollView, useWindowDimensions } from 'react-native'
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

  // Public feed state
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [channelMeta, setChannelMeta] = useState<Record<string, ChannelMeta>>({})
  const [feedLoading, setFeedLoading] = useState(false)
  const [peerCount, setPeerCount] = useState(0)

  // Channel viewing state
  const [viewingChannel, setViewingChannel] = useState<string | null>(null)
  const [channelVideos, setChannelVideos] = useState<VideoData[]>([])
  const [loadingChannel, setLoadingChannel] = useState(false)

  // Thumbnail cache: key = `${driveKey}:${videoId}` -> url
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})

  // Fetch thumbnail for a video (non-blocking)
  const fetchThumbnail = useCallback(async (driveKey: string, videoId: string) => {
    if (isPear || !rpc) return // Desktop handles thumbnails differently
    const cacheKey = `${driveKey}:${videoId}`
    if (thumbnailCache[cacheKey]) return // Already cached

    try {
      const result = await rpc.getVideoThumbnail({ channelKey: driveKey, videoId })
      if (result?.exists && result?.url) {
        setThumbnailCache(prev => ({ ...prev, [cacheKey]: result.url }))
      }
    } catch (err) {
      // Silently fail - thumbnails are optional
      console.log('[Home] Thumbnail fetch failed:', videoId)
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
  }, [ready])

  // Load public feed from backend
  const loadPublicFeed = useCallback(async () => {
    if (!rpc) return
    try {
      setFeedLoading(true)
      const result = await rpc.getPublicFeed({})
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
    } catch (err) {
      console.error('[Home] Failed to load public feed:', err)
    } finally {
      setFeedLoading(false)
    }
  }, [rpc, channelMeta])

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
      setFeedEntries(prev => prev.filter(e => e.driveKey !== driveKey))
    } catch (err) {
      console.error('[Home] Failed to hide channel:', err)
    }
  }, [rpc])

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

  // Play video - load into animated overlay player
  const playVideo = useCallback(async (video: VideoData) => {
    if (!rpc) return
    try {
      // Always close channel view when playing video
      // On desktop: video overlay takes over the main content area
      // On mobile: video overlay animates over everything anyway
      setViewingChannel(null)
      setChannelVideos([])

      // Get video URL from backend
      const result = await rpc.getVideoUrl({
        channelKey: video.channelKey,
        videoId: video.path
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
    await Promise.all([
      refreshFeed(),
      identity?.driveKey ? loadVideos(identity.driveKey) : Promise.resolve()
    ])
    setRefreshing(false)
  }, [identity, loadVideos, refreshFeed])

  // Convert videos to VideoData format with channel info and thumbnails
  const myVideosWithMeta: VideoData[] = videos.map(v => {
    const cacheKey = identity?.driveKey ? `${identity.driveKey}:${v.id}` : ''
    return {
      ...v,
      channelKey: identity?.driveKey || '',
      channel: identity ? { name: identity.name } : undefined,
      thumbnailUrl: thumbnailCache[cacheKey] || null
    }
  })

  // Add thumbnails to channel videos from cache
  const channelVideosWithThumbs: VideoData[] = channelVideos.map(v => {
    const cacheKey = `${v.channelKey}:${v.id}`
    return {
      ...v,
      thumbnailUrl: thumbnailCache[cacheKey] || v.thumbnailUrl || null
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

            {feedLoading && feedEntries.length === 0 ? (
              <View className="py-8 items-center">
                <ActivityIndicator color={colors.primary} />
                <Text className="text-caption text-pear-text-muted mt-2">Discovering channels...</Text>
              </View>
            ) : feedEntries.length === 0 ? (
              <View className="py-8 items-center bg-pear-bg-elevated rounded-xl">
                <Globe color={colors.textMuted} size={32} />
                <Text className="text-label text-pear-text mt-2">No channels discovered yet</Text>
                <Text className="text-caption text-pear-text-muted mt-1">Click refresh or wait for peers to connect</Text>
              </View>
            ) : (
              <ScrollView horizontal={!isDesktop} showsHorizontalScrollIndicator={false} contentContainerStyle={isDesktop ? { flexDirection: 'row', flexWrap: 'wrap', gap: 16 } : { gap: 12 }}>
                {feedEntries.map((entry) => {
                  const meta = channelMeta[entry.channelKey]
                  return (
                    <View key={entry.channelKey} className="bg-pear-bg-elevated rounded-xl p-4" style={{ width: isDesktop ? 220 : 200 }}>
                      <View className="w-12 h-12 rounded-full bg-pear-bg-card items-center justify-center mb-2">
                        <Text className="text-headline text-pear-primary">{(meta?.name || '?')[0].toUpperCase()}</Text>
                      </View>
                      <Text className="text-label text-pear-text mb-1" numberOfLines={1}>{meta?.name || 'Loading...'}</Text>
                      <Text className="text-caption text-pear-text-muted" numberOfLines={1}>
                        {meta?.videoCount !== undefined ? `${meta.videoCount} videos` : '...'}
                      </Text>
                      <Text className="text-caption text-pear-text-muted mt-1">
                        {formatTimeAgo(entry.lastSeen)} · {entry.peerCount || 0} peers
                      </Text>
                      <View className="flex-row mt-3 gap-2">
                        <Pressable onPress={() => viewChannel(entry.channelKey)} className="flex-1 bg-pear-primary py-2 rounded-lg items-center">
                          <Text className="text-caption text-white font-semibold">View</Text>
                        </Pressable>
                        <Pressable onPress={() => hideChannel(entry.channelKey)} className="p-2 bg-pear-bg-card rounded-lg">
                          <EyeOff color={colors.textMuted} size={16} />
                        </Pressable>
                      </View>
                    </View>
                  )
                })}
              </ScrollView>
            )}
          </View>

          {/* Your Videos - Responsive Grid on Desktop, List on Mobile */}
          <View style={{ paddingTop: 24, paddingHorizontal: isDesktop ? 24 : 0 }}>
            <Text className="text-headline text-pear-text mb-3" style={{ paddingHorizontal: isDesktop ? 0 : 20 }}>Your Videos</Text>

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
              } : undefined}>
                {myVideosWithMeta.map((video) => (
                  <View
                    key={video.id}
                    style={isDesktop ? {
                      width: `calc(${100 / gridColumns}% - ${(gridColumns - 1) * 24 / gridColumns}px)`,
                    } as any : undefined}
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
