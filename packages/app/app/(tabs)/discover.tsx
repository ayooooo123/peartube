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
import {
  getVerticalFeedPreviewVideos,
  hasRichVerticalFeedSnapshot,
  mapHydratedVerticalFeedVideos,
  mergeUniqueFeedVideos,
  mergeVerticalFeedEntries,
  warmNextPlaybackUrls,
  withFeedTimeout,
} from '@/lib/discover-feed-controller'
import { getCachedVideoUrl, makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'
import { readDiscoverFeedCache, writeDiscoverFeedCache } from '@/lib/discover-feed-cache'
import { formatTimeAgo } from '@/lib/formatters'
import { VerticalShortsPlayer } from '@/components/discovery/VerticalShortsPlayer'
import { ShortsCommentsSheet } from '@/components/discovery/ShortsCommentsSheet'
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
function getFeedEntrySignature(entry: FeedEntry) {
  const previewSignature = (entry.previewVideos || []).map((video) => [
    video.id,
    video.uploadedAt || 0,
    video.duration || 0,
    video.blobId || '',
    video.blobsCoreKey || '',
    video.availability || '',
    video.thumbnailBlobId || '',
    video.thumbnailBlobsCoreKey || '',
  ].join(':')).join(',')
  return [
    entry.channelKey || entry.driveKey,
    entry.publicBeeKey || '',
    entry.channelName || '',
    previewSignature,
  ].join('|')
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
  const { ready, identity, rpc, blobServerPort, backendError, startupStatus, platformEvents } = useApp()
  const {
    currentVideo,
    playerMode,
    pauseVideo,
    closeVideo,
    setAmbientVideoContext,
  } = useVideoPlayerContext()

  const bottomChromePadding = Math.max(insets.bottom + 86, 104)
  const metaBottomPadding = bottomChromePadding + 72
  const progressBottomOffset = bottomChromePadding + 26
  const pageHeight = Math.max(1, screenHeight - insets.top)
  const cachedDiscoverFeed = useMemo(() => readDiscoverFeedCache(), [])
  const [refreshing, setRefreshing] = useState(false)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>(() => (cachedDiscoverFeed?.feedEntries || []) as FeedEntry[])
  const [videos, setVideos] = useState<VideoData[]>(() => (cachedDiscoverFeed?.videos || []) as VideoData[])
  const [cacheRestoredOnly, setCacheRestoredOnly] = useState(() => Boolean(cachedDiscoverFeed?.videos?.length || cachedDiscoverFeed?.feedEntries?.length))
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedTimedOut, setFeedTimedOut] = useState(false)
  const [lastSuccessfulFeedAt, setLastSuccessfulFeedAt] = useState<number | null>(null)
  const [usingCachedSnapshot, setUsingCachedSnapshot] = useState(() => Boolean(cachedDiscoverFeed?.videos?.length || cachedDiscoverFeed?.feedEntries?.length))
  const [hydrationErrors, setHydrationErrors] = useState<Record<string, { error: string; lastAttempt: number }>>({})
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})
  const thumbnailCacheRef = useRef<Record<string, string>>({})
  thumbnailCacheRef.current = thumbnailCache
  const [activeIndex, setActiveIndex] = useState(0)
  const [shortsVideoUrl, setShortsVideoUrl] = useState<string | null>(null)
  const [shortsPlaybackSession, setShortsPlaybackSession] = useState(0)
  const [shortsLoading, setShortsLoading] = useState(false)
  const [shortsChromeVisible, setShortsChromeVisible] = useState(true)
  const [commentsSheetVisible, setCommentsSheetVisible] = useState(false)
  const shortsPlayerRef = useRef<any>(null)
  const pendingPlayKeyRef = useRef<string | null>(null)
  const playbackRequestSeqRef = useRef(0)
  const hydratedChannelsRef = useRef<Set<string>>(new Set())
  const feedLoadInFlightRef = useRef(false)
  const inflightPlaybackWarmups = useRef<Set<string>>(new Set())

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
      if (thumbnailCacheRef.current[cacheKey]) continue
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
  }, [blobServerPort, rpc])

  const seedFromFeedEntries = useCallback((entries: FeedEntry[]) => {
    const renderable = getVerticalFeedPreviewVideos(entries as any, {
      identityDriveKey: identity?.driveKey || undefined,
      channelMeta: {},
      limit: 40,
    }) as VideoData[]

    if (renderable.length > 0) {
      setVideos((prev) => mergeUniqueFeedVideos(prev, renderable, 80))
      if (renderable.length > 0) setCacheRestoredOnly(false)
      void fetchThumbnailsForVideos(renderable)
    }
  }, [fetchThumbnailsForVideos, identity?.driveKey])

  useEffect(() => {
    if (cachedDiscoverFeed?.videos?.length) {
      void fetchThumbnailsForVideos(cachedDiscoverFeed.videos as VideoData[])
    }
  }, [cachedDiscoverFeed, fetchThumbnailsForVideos])

  useEffect(() => {
    if (cacheRestoredOnly || (videos.length === 0 && feedEntries.length === 0)) return
    if (!hasRichVerticalFeedSnapshot(feedEntries, videos)) return
    writeDiscoverFeedCache({ feedEntries, videos })
  }, [cacheRestoredOnly, feedEntries, videos])

  const hydrateChannelVideos = useCallback(async (entry: FeedEntry) => {
    if (!rpc) return
    const channelKey = entry.channelKey || entry.driveKey
    if (!channelKey || hydratedChannelsRef.current.has(channelKey)) return

    try {
      const timeoutToken = Symbol('vertical-channel-timeout')
      const result = await withFeedTimeout(
        rpc.listVideos({ channelKey, publicBeeKey: entry.publicBeeKey || undefined }),
        3500,
        timeoutToken as any,
      )
      if (result === timeoutToken) {
        setHydrationErrors((prev) => ({ ...prev, [channelKey]: { error: 'Channel refresh timed out; showing cached previews.', lastAttempt: Date.now() } }))
        return
      }
      if ((result as any)?.success === false || (result as any)?.error) {
        setHydrationErrors((prev) => ({ ...prev, [channelKey]: { error: (result as any)?.error || 'Channel refresh failed; showing cached previews.', lastAttempt: Date.now() } }))
        return
      }
      hydratedChannelsRef.current.add(channelKey)
      const channelVideos = Array.isArray((result as any)?.videos) ? (result as any).videos : []
      const mapped = mapHydratedVerticalFeedVideos(entry, channelVideos, {
        identityDriveKey: identity?.driveKey || undefined,
      }) as VideoData[]

      if (mapped.length > 0) {
        setVideos((prev) => mergeUniqueFeedVideos(prev, mapped, 80))
        if (mapped.length > 0) setCacheRestoredOnly(false)
        setHydrationErrors((prev) => {
          if (!prev[channelKey]) return prev
          const next = { ...prev }
          delete next[channelKey]
          return next
        })
        void fetchThumbnailsForVideos(mapped)
      }
    } catch (err) {
      setHydrationErrors((prev) => ({ ...prev, [channelKey]: { error: (err as any)?.message || String(err), lastAttempt: Date.now() } }))
      console.log('[VerticalDiscovery] Channel hydration failed:', (err as any)?.message || err)
    }
  }, [fetchThumbnailsForVideos, identity?.driveKey, rpc])

  const loadFeed = useCallback(async () => {
    if (!rpc || feedLoadInFlightRef.current) return
    feedLoadInFlightRef.current = true
    setFeedLoading(true)
    try {
      const timeoutToken = Symbol('vertical-feed-timeout')
      const result = await withFeedTimeout(rpc.getPublicFeed({}), 4000, timeoutToken as any)
      if (result === timeoutToken) {
        setFeedTimedOut(true)
        setFeedError('Feed refresh timed out; showing cached snapshot.')
        setUsingCachedSnapshot(hasRichVerticalFeedSnapshot(feedEntries, videos))
        return
      }
      if ((result as any)?.success === false || (result as any)?.error) {
        setFeedTimedOut(false)
        setFeedError((result as any)?.error || 'Feed refresh failed; showing cached snapshot.')
        setUsingCachedSnapshot(hasRichVerticalFeedSnapshot(feedEntries, videos))
        return
      }
      const entries = Array.isArray((result as any)?.entries) ? (result as any).entries : []
      setFeedTimedOut(false)
      setFeedError(null)
      setLastSuccessfulFeedAt(Date.now())
      setUsingCachedSnapshot(false)
      if (entries.length > 0 && hasRichVerticalFeedSnapshot(entries, [])) setCacheRestoredOnly(false)
      let mergedEntries = entries
      setFeedEntries((prev) => {
        mergedEntries = mergeVerticalFeedEntries(prev, entries) as FeedEntry[]
        const prevSignature = prev.map(getFeedEntrySignature).join('\n')
        const nextSignature = mergedEntries.map(getFeedEntrySignature).join('\n')
        return prevSignature === nextSignature ? prev : mergedEntries
      })
      seedFromFeedEntries(mergedEntries)
      for (const entry of mergedEntries.slice(0, 24)) {
        void hydrateChannelVideos(entry)
      }
    } catch (err) {
      setFeedTimedOut(false)
      setFeedError((err as any)?.message || String(err))
      setUsingCachedSnapshot(hasRichVerticalFeedSnapshot(feedEntries, videos))
      console.log('[VerticalDiscovery] Feed load failed:', (err as any)?.message || err)
    } finally {
      feedLoadInFlightRef.current = false
      setFeedLoading(false)
    }
  }, [feedEntries, hydrateChannelVideos, rpc, seedFromFeedEntries, videos])

  useEffect(() => {
    if (!ready || !rpc) return
    loadFeed()
  }, [loadFeed, ready, rpc])

  useEffect(() => {
    if (!ready || !rpc) return
    const unsubscribe = (platformEvents as any)?.onFeedUpdate?.(() => {
      void loadFeed()
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [loadFeed, platformEvents, ready, rpc])

  const stopShortsPlayback = useCallback(() => {
    void shortsPlayerRef.current?.exitPictureInPicture?.()
    void shortsPlayerRef.current?.stop?.()
    void shortsPlayerRef.current?.pause?.()
    void shortsPlayerRef.current?.destroy?.()
    pendingPlayKeyRef.current = null
    playbackRequestSeqRef.current += 1
    setAmbientVideoContext(null, null)
    setShortsVideoUrl(null)
    setCommentsSheetVisible(false)
    setShortsLoading(false)
  }, [setAmbientVideoContext])

  useFocusEffect(
    useCallback(() => {
      return stopShortsPlayback
    }, [stopShortsPlayback])
  )

  const handoffToShorts = useCallback(() => {
    if (!currentVideo || playerMode === 'hidden') return
    pauseVideo()
    closeVideo()
    setAmbientVideoContext(null, null)
  }, [closeVideo, currentVideo, pauseVideo, playerMode, setAmbientVideoContext])

  const playVideo = useCallback(async (video: VideoData) => {
    if (!rpc) return
    const { cacheKey, playbackRequest } = makePlaybackRequest(video)
    const playKey = `${video.channelKey}:${video.id}`
    if (pendingPlayKeyRef.current === playKey) return
    pendingPlayKeyRef.current = playKey
    const requestSeq = ++playbackRequestSeqRef.current
    const isStalePlaybackRequest = () => pendingPlayKeyRef.current !== playKey || playbackRequestSeqRef.current !== requestSeq

    try {
      handoffToShorts()
      const cachedUrl = cacheKey ? getCachedVideoUrl(cacheKey) : null
      if (cachedUrl) {
        void rpc.preparePlayback(playbackRequest).catch(() => undefined)
        if (isStalePlaybackRequest()) return
        setAmbientVideoContext(video, cachedUrl, { keepHidden: true })
        setShortsVideoUrl(cachedUrl)
        setShortsPlaybackSession((prev) => prev + 1)
        setShortsLoading(false)
        return
      }
      setShortsLoading(true)
      const result = await rpc.preparePlayback(playbackRequest)
      if (isStalePlaybackRequest()) return
      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
        setAmbientVideoContext(video, result.url, { keepHidden: true })
        setShortsVideoUrl(result.url)
        setShortsPlaybackSession((prev) => prev + 1)
      }
    } catch (err) {
      if (!isStalePlaybackRequest()) {
        console.log('[VerticalDiscovery] Playback failed:', (err as any)?.message || err)
      }
    } finally {
      if (!isStalePlaybackRequest()) {
        pendingPlayKeyRef.current = null
        setShortsLoading(false)
      }
    }
  }, [handoffToShorts, makePlaybackRequest, rpc, setAmbientVideoContext])

  useEffect(() => {
    if (!activeVideo || !ready) return
    setShortsChromeVisible(true)
    void playVideo(activeVideo)
  }, [activeVideo, playVideo, ready])

  useEffect(() => {
    if (!rpc) return
    void warmNextPlaybackUrls({
      videos,
      activeIndex,
      makePlaybackRequest,
      getCachedVideoUrl,
      setCachedVideoUrl,
      preparePlayback: rpc.preparePlayback?.bind(rpc),
      inflightPlaybackWarmups,
    })
  }, [activeIndex, makePlaybackRequest, rpc, videos])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
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

  const openComments = useCallback((video: VideoData) => {
    setAmbientVideoContext(video, activeVideoKey === `${video.channelKey}:${video.id}` ? shortsVideoUrl : null, { keepHidden: true })
    setShortsChromeVisible(true)
    setCommentsSheetVisible(true)
  }, [activeVideoKey, setAmbientVideoContext, shortsVideoUrl])

  const verticalVideos = useMemo(() => videos.map((video) => {
    const cacheKey = `${video.channelKey}:${video.id}`
    return {
      ...video,
      thumbnailUrl: thumbnailCache[cacheKey] || video.thumbnailUrl || (video as any).thumbnail || null,
    }
  }), [thumbnailCache, videos])
  const hydrationErrorCount = Object.keys(hydrationErrors).length
  const degradedCopy = feedTimedOut
    ? 'Feed refresh timed out — showing cached previews.'
    : feedError
      ? feedError
      : hydrationErrorCount > 0
        ? `${hydrationErrorCount} channel${hydrationErrorCount === 1 ? '' : 's'} could not refresh; cached previews remain visible.`
        : usingCachedSnapshot && verticalVideos.length > 0
          ? 'Showing cached Discover snapshot while peers refresh.'
          : null

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
              <Text style={styles.feedPillText}>{feedEntries.length} feeds</Text>
            </View>
          ) : null}
          {degradedCopy ? (
            <View style={styles.feedPill}>
              <Feather name="alert-circle" color={colors.primary} size={12} />
              <Text style={styles.feedPillText}>Cached</Text>
            </View>
          ) : null}
          <Pressable onPress={onRefresh} style={styles.roundButton} disabled={refreshing || feedLoading}>
            <Feather name="refresh-cw" color={colors.text} size={18} />
          </Pressable>
        </View>
      </View>

      {shortsChromeVisible ? (
        <View pointerEvents="none" style={[styles.topChromeFade, { height: Math.max(insets.top + 112, 136) }]} />
      ) : null}

      {verticalVideos.length === 0 ? (
        <View style={styles.centerState}>
          {feedLoading || !ready ? <ActivityIndicator color={colors.primary} size="large" /> : null}
          <Text style={styles.centerTitle}>
            {backendError ? 'Backend error' : ready ? (feedTimedOut || feedError || usingCachedSnapshot ? 'Showing cached Discover' : 'No videos discovered yet') : (startupStatus || 'Connecting to P2P network…')}
          </Text>
          <Text style={styles.centerBody}>
            {backendError || degradedCopy || 'Pull down to refresh, or wait for peers to announce channels.'}
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
                    progressBottomOffset={progressBottomOffset}
                    onControlsVisibleChange={setShortsChromeVisible}
                    onReplay={() => playVideo(video)}
                  />
                </View>
                {shortsChromeVisible ? (
                  <View style={[styles.bottomMeta, { paddingBottom: metaBottomPadding }]}>
                    <Pressable onPress={() => openDetails(video)} style={styles.metaTextBlock}>
                      <Text style={styles.videoTitle} numberOfLines={2}>{video.title || 'Untitled'}</Text>
                      <Text style={styles.videoMeta} numberOfLines={1}>
                        {video.channel?.name || 'Channel'} · {formatTimeAgo(video.uploadedAt || Date.now())}
                      </Text>
                      {video.description && !/^\s*source\s*:/i.test(video.description) ? (
                        <Text style={styles.videoDescription} numberOfLines={1}>{video.description}</Text>
                      ) : null}
                    </Pressable>
                    <View style={styles.sideRail}>
                      <Pressable onPress={() => openChannel(video)} style={styles.sideButton}>
                        <Feather name="user" color="#fff" size={24} />
                        <Text style={styles.sideLabel} numberOfLines={1}>Channel</Text>
                      </Pressable>
                      <Pressable onPress={() => openComments(video)} style={styles.sideButton}>
                        <Feather name="message-circle" color="#fff" size={24} />
                        <Text style={styles.sideLabel} numberOfLines={1}>Chat</Text>
                      </Pressable>
                      <Pressable onPress={() => playVideo(video)} style={styles.sideButton}>
                        <Feather name="rotate-cw" color="#fff" size={24} />
                        <Text style={styles.sideLabel} numberOfLines={1}>Replay</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </ImageBackground>
            </View>
          )}
        />
      )}
      <ShortsCommentsSheet visible={commentsSheetVisible} onClose={() => setCommentsSheetVisible(false)} />
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
  topChromeFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9,
    backgroundColor: 'rgba(0,0,0,0.36)',
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
    right: 14,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  metaTextBlock: {
    flex: 1,
    minWidth: 0,
    paddingRight: 2,
  },
  videoTitle: {
    color: '#fff',
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  videoMeta: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
  },
  videoDescription: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 5,
  },
  sideRail: {
    width: 62,
    alignItems: 'center',
    gap: 16,
  },
  sideButton: {
    alignItems: 'center',
    gap: 4,
    minHeight: 48,
  },
  sideLabel: {
    width: 62,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    textAlign: 'center',
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
