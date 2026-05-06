/**
 * Vertical Discovery - Twitter-style full-screen video doomscroll mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  ImageBackground,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewToken,
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import type { VideoData } from '@peartube/core'
import { useApp } from '../_layout'
import { usePlatform } from '@/lib/PlatformProvider'
import { colors } from '@/lib/colors'
import { fetchThumbnailUrlWithRetry } from '@/lib/thumbnail'
import { getFeedPreviewVideos, getVisibleSeededFeedEntries, shouldRenderFeedVideo } from '@/lib/feed-hydration'
import { getCachedVideoUrl, makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'
import { formatTimeAgo } from '@/lib/formatters'
import { VerticalShortsPlayer } from '@/components/discovery/VerticalShortsPlayer'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'

interface FeedEntry {
  driveKey: string
  channelKey?: string
  publicBeeKey?: string
  channelName?: string | null
  previewVideos?: Array<{
    id: string
    title?: string
    uploadedAt?: number
    duration?: number
    thumbnail?: string | null
    blobId?: string | null
    blobsCoreKey?: string | null
    mimeType?: string | null
    availability?: 'playable' | 'unavailable' | 'unknown'
    thumbnailBlobId?: string | null
    thumbnailBlobsCoreKey?: string | null
    thumbnailMimeType?: string | null
  }>
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

function getVideoRef(video: VideoData) {
  return video.path && typeof video.path === 'string' && video.path.startsWith('/')
    ? video.path
    : video.id
}

function makeRouteVideoData(video: VideoData) {
  return JSON.stringify({
    id: video.id,
    title: video.title,
    description: video.description,
    channelKey: video.channelKey,
    publicBeeKey: (video as any).publicBeeKey || undefined,
    path: video.path,
    size: video.size,
    duration: video.duration,
    uploadedAt: video.uploadedAt,
    thumbnail: (video as any).thumbnail,
    thumbnailUrl: video.thumbnailUrl,
    blobId: (video as any).blobId || undefined,
    blobsCoreKey: (video as any).blobsCoreKey || undefined,
    mimeType: (video as any).mimeType || undefined,
    channel: video.channel,
  })
}

export default function VerticalDiscoveryScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { height: screenHeight, width: screenWidth } = useWindowDimensions()
  const { isDesktop } = usePlatform()
  const { ready, identity, rpc, blobServerPort, backendError, startupStatus } = useApp()
  const {
    currentVideo,
    playerMode,
    pauseVideo,
    closeVideo,
  } = useVideoPlayerContext()

  const pageHeight = Math.max(1, screenHeight - insets.top)
  const [refreshing, setRefreshing] = useState(false)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [videos, setVideos] = useState<VideoData[]>([])
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [shortsVideoUrl, setShortsVideoUrl] = useState<string | null>(null)
  const [shortsPlaybackSession, setShortsPlaybackSession] = useState(0)
  const [shortsLoading, setShortsLoading] = useState(false)
  const [shortsChromeVisible, setShortsChromeVisible] = useState(true)
  const shortsPlayerRef = useRef<any>(null)
  const pendingPlayKeyRef = useRef<string | null>(null)
  const hydratedChannelsRef = useRef<Set<string>>(new Set())

  const activeVideo = videos[activeIndex]
  const activeVideoKey = activeVideo ? `${activeVideo.channelKey}:${activeVideo.id}` : null

  const makePlaybackRequest = useCallback((video: VideoData) => {
    const videoRef = getVideoRef(video)
    const videoAny = video as any
    const cacheKey = makeVideoUrlCacheKey(
      video.channelKey,
      videoRef,
      videoAny.blobId || undefined,
      videoAny.blobsCoreKey || undefined,
    )
    const playbackRequest = {
      channelKey: video.channelKey,
      videoId: videoRef,
      publicBeeKey: videoAny.publicBeeKey || undefined,
      blobId: videoAny.blobId || undefined,
      blobsCoreKey: videoAny.blobsCoreKey || undefined,
      mimeType: videoAny.mimeType || undefined,
    }

    return { cacheKey, playbackRequest }
  }, [])

  const fetchThumbnailsForVideos = useCallback(async (items: VideoData[]) => {
    if (!rpc || !blobServerPort) return
    const targets = items.slice(0, 12)
    for (const video of targets) {
      const cacheKey = `${video.channelKey}:${video.id}`
      if (thumbnailCache[cacheKey]) continue
      try {
        const url = await fetchThumbnailUrlWithRetry({
          rpc,
          channelKey: video.channelKey,
          videoId: video.id,
          expectedPort: blobServerPort,
        })
        if (url) {
          setThumbnailCache((prev) => ({ ...prev, [cacheKey]: url }))
        }
      } catch (err) {
        console.log('[VerticalDiscovery] Thumbnail resolve failed:', (err as any)?.message || err)
      }
    }
  }, [blobServerPort, rpc, thumbnailCache])

  const seedFromFeedEntries = useCallback((entries: FeedEntry[]) => {
    const visibleEntries = getVisibleSeededFeedEntries(entries as any)
    const previewVideos = getFeedPreviewVideos(visibleEntries as any, {
      identityDriveKey: identity?.driveKey || undefined,
      channelMeta: {},
    }) as VideoData[]

    const renderable = previewVideos
      .filter((video) => shouldRenderFeedVideo({
        video,
        identityDriveKey: identity?.driveKey || undefined,
      }))
      .slice(0, 40)

    if (renderable.length > 0) {
      setVideos((prev) => {
        const seen = new Set<string>()
        const merged = [...prev, ...renderable].filter((video) => {
          const key = `${video.channelKey}:${video.id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        return merged
      })
      void fetchThumbnailsForVideos(renderable)
    }
  }, [fetchThumbnailsForVideos, identity?.driveKey])

  const hydrateChannelVideos = useCallback(async (entry: FeedEntry) => {
    if (!rpc) return
    const channelKey = entry.channelKey || entry.driveKey
    if (!channelKey || hydratedChannelsRef.current.has(channelKey)) return

    try {
      const timeoutToken = Symbol('vertical-channel-timeout')
      const result = await withTimeout(
        rpc.listVideos({ channelKey, publicBeeKey: entry.publicBeeKey || undefined }),
        3500,
        timeoutToken as any,
      )
      if (result === timeoutToken) return
      hydratedChannelsRef.current.add(channelKey)
      const channelVideos = Array.isArray((result as any)?.videos) ? (result as any).videos : []
      const mapped = channelVideos
        .filter((video: any) => shouldRenderFeedVideo({
          video: { ...video, channelKey },
          identityDriveKey: identity?.driveKey || undefined,
        }))
        .map((video: any) => ({
          ...video,
          channelKey,
          publicBeeKey: entry.publicBeeKey || undefined,
          channel: { name: entry.channelName || 'Channel' },
        }))

      if (mapped.length > 0) {
        setVideos((prev) => {
          const byKey = new Map<string, VideoData>()
          for (const video of [...prev, ...mapped]) byKey.set(`${video.channelKey}:${video.id}`, video)
          return Array.from(byKey.values()).slice(0, 80)
        })
        void fetchThumbnailsForVideos(mapped)
      }
    } catch (err) {
      console.log('[VerticalDiscovery] Channel hydration failed:', (err as any)?.message || err)
    }
  }, [fetchThumbnailsForVideos, identity?.driveKey, rpc])

  const loadFeed = useCallback(async () => {
    if (!rpc) return
    setFeedLoading(true)
    try {
      const result = await withTimeout(rpc.getPublicFeed({}), 4000, { entries: [] } as any)
      const entries = Array.isArray((result as any)?.entries) ? (result as any).entries : []
      setFeedEntries(entries)
      seedFromFeedEntries(entries)
      for (const entry of entries.slice(0, 24)) {
        void hydrateChannelVideos(entry)
      }
    } catch (err) {
      console.log('[VerticalDiscovery] Feed load failed:', (err as any)?.message || err)
    } finally {
      setFeedLoading(false)
    }
  }, [hydrateChannelVideos, rpc, seedFromFeedEntries])

  useEffect(() => {
    if (!ready || !rpc) return
    loadFeed()
  }, [loadFeed, ready, rpc])

  const stopShortsPlayback = useCallback(() => {
    void shortsPlayerRef.current?.stop?.()
    void shortsPlayerRef.current?.pause?.()
    pendingPlayKeyRef.current = null
    setShortsVideoUrl(null)
    setShortsLoading(false)
  }, [])

  useFocusEffect(
    useCallback(() => {
      return stopShortsPlayback
    }, [stopShortsPlayback])
  )

  const handoffToShorts = useCallback(() => {
    if (!currentVideo || playerMode === 'hidden') return
    pauseVideo()
    closeVideo()
  }, [closeVideo, currentVideo, pauseVideo, playerMode])

  const playVideo = useCallback(async (video: VideoData) => {
    if (!rpc) return
    const { cacheKey, playbackRequest } = makePlaybackRequest(video)
    const playKey = `${video.channelKey}:${video.id}`
    if (pendingPlayKeyRef.current === playKey) return
    pendingPlayKeyRef.current = playKey

    try {
      handoffToShorts()
      const cachedUrl = cacheKey ? getCachedVideoUrl(cacheKey) : null
      if (cachedUrl) {
        void rpc.preparePlayback(playbackRequest).catch(() => undefined)
        setShortsVideoUrl(cachedUrl)
        setShortsPlaybackSession((prev) => prev + 1)
        setShortsLoading(false)
        return
      }
      setShortsLoading(true)
      const result = await rpc.preparePlayback(playbackRequest)
      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
        setShortsVideoUrl(result.url)
        setShortsPlaybackSession((prev) => prev + 1)
      }
    } catch (err) {
      console.log('[VerticalDiscovery] Playback failed:', (err as any)?.message || err)
    } finally {
      pendingPlayKeyRef.current = null
      setShortsLoading(false)
    }
  }, [handoffToShorts, makePlaybackRequest, rpc])

  useEffect(() => {
    if (!activeVideo || !ready) return
    setShortsChromeVisible(true)
    void playVideo(activeVideo)
  }, [activeVideo, playVideo, ready])

  useEffect(() => {
    const warmPlaybackUrl = async (video: VideoData) => {
      const { cacheKey, playbackRequest } = makePlaybackRequest(video)
      if (cacheKey && getCachedVideoUrl(cacheKey)) return
      const result = await rpc?.preparePlayback?.(playbackRequest)
      if (result?.url && cacheKey) setCachedVideoUrl(cacheKey, result.url)
    }

    const nextVideos = videos.slice(activeIndex + 1, activeIndex + 5)
    for (const video of nextVideos) {
      void warmPlaybackUrl(video).catch(() => undefined)
    }
  }, [activeIndex, makePlaybackRequest, rpc, videos])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    hydratedChannelsRef.current.clear()
    try {
      await rpc?.refreshFeed?.({})
      await loadFeed()
    } finally {
      setRefreshing(false)
    }
  }, [loadFeed, rpc])

  const onMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextIndex = Math.max(0, Math.round(event.nativeEvent.contentOffset.y / pageHeight))
    setActiveIndex(nextIndex)
  }, [pageHeight])

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVisible = viewableItems.find((item) => item.index !== null)
    if (typeof firstVisible?.index === 'number') {
      setActiveIndex(firstVisible.index)
    }
  }).current

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 70,
    minimumViewTime: 120,
  }).current

  const openChannel = useCallback((video: VideoData) => {
    if (!video.channelKey) return
    router.push({
      pathname: '/channel/[key]',
      params: { key: video.channelKey, publicBeeKey: (video as any).publicBeeKey || undefined },
    })
  }, [router])

  const openDetails = useCallback((video: VideoData) => {
    router.push({
      pathname: '/video/[id]',
      params: {
        id: video.id,
        channel: video.channelKey,
        publicBeeKey: (video as any).publicBeeKey || undefined,
        videoData: makeRouteVideoData(video),
      },
    })
  }, [router])

  const verticalVideos = useMemo(() => videos.map((video) => {
    const cacheKey = `${video.channelKey}:${video.id}`
    return {
      ...video,
      thumbnailUrl: thumbnailCache[cacheKey] || video.thumbnailUrl || (video as any).thumbnail || null,
    }
  }), [thumbnailCache, videos])

  if (isDesktop) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.centerTitle}>Vertical discovery is mobile-first.</Text>
        <Text style={styles.centerBody}>Use Home on desktop for the grid feed.</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={[styles.topChrome, { paddingTop: Math.max(insets.top, 10) }]}> 
        <View>
          <Text style={styles.eyebrow}>PearTube</Text>
          <Text style={styles.title}>Discover</Text>
        </View>
        <View style={styles.topActions}>
          {feedEntries.length > 0 ? (
            <View style={styles.feedPill}>
              <Feather name="radio" color={colors.primary} size={12} />
              <Text style={styles.feedPillText}>{feedEntries.length}</Text>
            </View>
          ) : null}
          <Pressable onPress={onRefresh} style={styles.roundButton} disabled={refreshing || feedLoading}>
            <Feather name="refresh-cw" color={colors.text} size={18} />
          </Pressable>
        </View>
      </View>

      {verticalVideos.length === 0 ? (
        <View style={styles.centerState}>
          {feedLoading || !ready ? <ActivityIndicator color={colors.primary} size="large" /> : null}
          <Text style={styles.centerTitle}>
            {backendError ? 'Backend error' : ready ? 'No videos discovered yet' : (startupStatus || 'Connecting to P2P network…')}
          </Text>
          <Text style={styles.centerBody}>
            {backendError || 'Pull down to refresh, or wait for peers to announce channels.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={verticalVideos}
          keyExtractor={(item) => `${item.channelKey}:${item.id}`}
          pagingEnabled
          snapToInterval={pageHeight}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumScrollEnd}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          getItemLayout={(_, index) => ({ length: pageHeight, offset: pageHeight * index, index })}
          renderItem={({ item: video, index }) => (
            <View style={[styles.page, { height: pageHeight, width: screenWidth }]} testID={index === 0 ? 'vertical-discovery-first-video' : undefined}>
              <ImageBackground
                source={video.thumbnailUrl ? { uri: video.thumbnailUrl } : undefined}
                style={styles.backdrop}
                imageStyle={styles.backdropImage}
              >
                <View style={styles.scrim} />
                <View style={styles.videoStage}>
                  <VerticalShortsPlayer
                    testID="vertical-discovery-inline-player"
                    playerRef={shortsPlayerRef}
                    videoUrl={activeVideoKey === `${video.channelKey}:${video.id}` ? shortsVideoUrl : null}
                    video={video}
                    playbackSession={shortsPlaybackSession}
                    isActive={activeVideoKey === `${video.channelKey}:${video.id}`}
                    isLoading={shortsLoading && activeVideoKey === `${video.channelKey}:${video.id}`}
                    thumbnailUrl={video.thumbnailUrl || null}
                    controlsVisible={shortsChromeVisible}
                    onControlsVisibleChange={setShortsChromeVisible}
                    onReplay={() => playVideo(video)}
                  />
                </View>
                {shortsChromeVisible ? (
                  <View style={[styles.bottomMeta, { paddingBottom: Math.max(insets.bottom + 116, 134) }]}>
                    <Pressable onPress={() => openDetails(video)} style={styles.metaTextBlock}>
                      <Text style={styles.videoTitle} numberOfLines={2}>{video.title || 'Untitled'}</Text>
                      <Text style={styles.videoMeta} numberOfLines={1}>
                        {video.channel?.name || 'Channel'} · {formatTimeAgo(video.uploadedAt || Date.now())}
                      </Text>
                      {video.description ? (
                        <Text style={styles.videoDescription} numberOfLines={2}>{video.description}</Text>
                      ) : null}
                    </Pressable>
                    <View style={styles.sideRail}>
                      <Pressable onPress={() => openChannel(video)} style={styles.sideButton}>
                        <Feather name="user" color="#fff" size={24} />
                        <Text style={styles.sideLabel}>Channel</Text>
                      </Pressable>
                      <Pressable onPress={() => openDetails(video)} style={styles.sideButton}>
                        <Feather name="message-circle" color="#fff" size={24} />
                        <Text style={styles.sideLabel}>Details</Text>
                      </Pressable>
                      <Pressable onPress={() => playVideo(video)} style={styles.sideButton}>
                        <Feather name="rotate-cw" color="#fff" size={24} />
                        <Text style={styles.sideLabel}>Replay</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </ImageBackground>
            </View>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050607',
  },
  topChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  feedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  feedPillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  roundButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  page: {
    backgroundColor: '#050607',
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
  },
  backdropImage: {
    opacity: 0.48,
    resizeMode: 'cover',
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  videoStage: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  bottomMeta: {
    position: 'absolute',
    left: 18,
    right: 16,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 14,
  },
  metaTextBlock: {
    flex: 1,
    paddingRight: 4,
  },
  videoTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  videoMeta: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  videoDescription: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 14,
    lineHeight: 19,
    marginTop: 8,
  },
  sideRail: {
    width: 72,
    alignItems: 'center',
    gap: 20,
  },
  sideButton: {
    alignItems: 'center',
    gap: 6,
  },
  sideLabel: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 11,
    fontWeight: '700',
  },
  centerState: {
    flex: 1,
    backgroundColor: '#050607',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  centerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 14,
    textAlign: 'center',
  },
  centerBody: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    textAlign: 'center',
  },
})
