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
  Share,
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
import { fonts } from '@/lib/typography'
import { fetchThumbnailUrlWithRetry, getRenderableThumbnailUrl, isLoopbackThumbnailUrl } from '@/lib/thumbnail'
import {
  getVerticalFeedHydrationKey,
  getVerticalFeedPreviewVideos,
  hasRichVerticalFeedSnapshot,
  mapHydratedVerticalFeedVideos,
  mergeUniqueFeedVideos,
  mergeVerticalFeedEntries,
  pruneHydratedFeedChannels,
  withFeedTimeout,
} from '@/lib/discover-feed-controller'
import { makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'
import { readDiscoverFeedCache, writeDiscoverFeedCache } from '@/lib/discover-feed-cache'
import { classifyFeedDiscoveryState } from '@/lib/android-discovery-diagnostics'
import { formatTimeAgo } from '@/lib/formatters'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { VerticalShortsPlayer } from '@/components/discovery/VerticalShortsPlayer'
import { ShortsCommentsSheet } from '@/components/discovery/ShortsCommentsSheet'

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
    byteAvailability?: 'playable' | 'unavailable' | 'unknown' | null
    hasHeadBlock?: boolean
    contiguousBlocks?: number
    readyForPlayback?: boolean
  }>
}

type SwarmStatus = {
  peers: number
  peerCount?: number
  swarmConnections?: number
  feedConnections?: number
  swarmPeers?: number
  channels?: number
  doctor?: { recommendedBoundary?: string | null }
}
function getFeedEntrySignature(entry: FeedEntry) {
  const previewSignature = (entry.previewVideos || []).map((video) => [
    video.id,
    video.uploadedAt || 0,
    video.byteAvailability || '',
    video.hasHeadBlock ? '1' : '0',
    video.contiguousBlocks || 0,
    video.readyForPlayback ? '1' : '0',
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

function formatShortsActionCount(value: unknown) {
  const count = Number(value || 0)
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.floor(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}K`
  return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
}

function getShortsChannelName(video: VideoData) {
  return video.channel?.name || 'Channel'
}

function getShortsHandle(video: VideoData) {
  const raw = video.channel?.name || video.channelKey || 'peartube'
  const handle = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 18)
  return `@${handle || 'peartube'}`
}

function getShortsAvatarLetter(video: VideoData) {
  return getShortsChannelName(video).trim().charAt(0).toUpperCase() || 'P'
}

function getShortsActionMetrics(video: VideoData) {
  const videoAny = video as any
  const views = videoAny.views ?? videoAny.viewCount ?? videoAny.stats?.views ?? videoAny.playbackCount ?? 0
  const comments = videoAny.commentCount ?? videoAny.commentsCount ?? videoAny.stats?.comments ?? 0
  const reposts = videoAny.repostCount ?? videoAny.shareCount ?? videoAny.stats?.reposts ?? 0
  const likes = videoAny.likeCount ?? videoAny.reactionCounts?.like ?? videoAny.reactions?.like ?? 0
  return { comments, reposts, likes, views }
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
    thumbnail: isLoopbackThumbnailUrl((video as any).thumbnail) ? undefined : (video as any).thumbnail,
    thumbnailUrl: isLoopbackThumbnailUrl(video.thumbnailUrl) ? undefined : video.thumbnailUrl,
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
  const { ready, identity, rpc, blobServerPort, backendError, startupStatus, platformEvents, androidDiscoveryPermissionStatus } = useApp()
  const tabBarMetrics = useTabBarMetrics()
  const bottomChromePadding = Math.max(tabBarMetrics.height + 14, insets.bottom + 86, 112)
  const metaBottomPadding = bottomChromePadding
  const progressBottomOffset = metaBottomPadding + 208
  const pageHeight = Math.max(1, screenHeight - insets.top)
  const cachedDiscoverFeed = useMemo(() => readDiscoverFeedCache(), [])
  const [refreshing, setRefreshing] = useState(false)
  const [feedLoading, setFeedLoading] = useState(false)
  const [peerCount, setPeerCount] = useState(0)
  const [swarmStatus, setSwarmStatus] = useState<SwarmStatus | null>(null)
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
  const [shortsPlaybackMessage, setShortsPlaybackMessage] = useState<{ key: string; text: string; isError?: boolean } | null>(null)
  const [shortsChromeVisible, setShortsChromeVisible] = useState(true)
  const [commentsSheetVisible, setCommentsSheetVisible] = useState(false)
  const shortsPlayerRef = useRef<any>(null)
  const pendingPlayKeyRef = useRef<string | null>(null)
  const playbackRequestSeqRef = useRef(0)
  const hydratedChannelsRef = useRef<Set<string>>(new Set())
  const feedLoadInFlightRef = useRef(false)
  const feedEntriesRef = useRef<FeedEntry[]>(feedEntries)
  const videosRef = useRef<VideoData[]>(videos)
  feedEntriesRef.current = feedEntries
  videosRef.current = videos

  const loadSwarmStatus = useCallback(async () => {
    if (!rpc) return
    try {
      const statusPromise = rpc.getSwarmStatus()
      const status = await Promise.race([statusPromise, new Promise((resolve) => setTimeout(() => resolve(null), 3000))])
      if (!status) return
      setSwarmStatus({
        peers: Math.max(
          Number((status as any).peerCount || 0),
          Number((status as any).swarmConnections || 0),
          Number((status as any).feedConnections || 0),
          Number((status as any).swarmPeers || 0),
        ),
        peerCount: (status as any).peerCount,
        swarmConnections: (status as any).swarmConnections,
        feedConnections: (status as any).feedConnections,
        swarmPeers: (status as any).swarmPeers,
        channels: (status as any).channelsLoaded,
        doctor: (status as any).doctor || undefined,
      })
    } catch (err) {
      console.log('[VerticalDiscovery] Failed to load swarm status:', (err as any)?.message || err)
    }
  }, [rpc])

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
          blobRefs: {
            thumbnailBlobId: (video as any).thumbnailBlobId || null,
            thumbnailBlobsCoreKey: (video as any).thumbnailBlobsCoreKey || null,
            thumbnailMimeType: (video as any).thumbnailMimeType || null,
          },
        })
        if (url) {
          setThumbnailCache((prev) => ({ ...prev, [cacheKey]: url }))
        }
      } catch (err) {
        console.log('[VerticalDiscovery] Thumbnail resolve failed:', (err as any)?.message || err)
      }
    }
  }, [blobServerPort, rpc])

  const seedFromFeedEntries = useCallback((entries: FeedEntry[], channelMetaByKey: Record<string, any> = {}) => {
    const renderable = getVerticalFeedPreviewVideos(entries as any, {
      identityDriveKey: identity?.driveKey || undefined,
      channelMeta: channelMetaByKey,
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
    const hydrationKey = getVerticalFeedHydrationKey(entry)
    if (!channelKey || !hydrationKey || hydratedChannelsRef.current.has(hydrationKey)) return

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
      hydratedChannelsRef.current.add(hydrationKey)
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
      const result = await withFeedTimeout(rpc.getCanonicalFeed({}), 4000, timeoutToken as any)
      if (result === timeoutToken) {
        setFeedTimedOut(true)
        setFeedError('Feed refresh timed out; showing cached snapshot.')
        setUsingCachedSnapshot(hasRichVerticalFeedSnapshot(feedEntriesRef.current, videosRef.current))
        return
      }
      if ((result as any)?.success === false || (result as any)?.error) {
        setFeedTimedOut(false)
        setFeedError((result as any)?.error || 'Feed refresh failed; showing cached snapshot.')
        setUsingCachedSnapshot(hasRichVerticalFeedSnapshot(feedEntriesRef.current, videosRef.current))
        return
      }
      const entries = Array.isArray((result as any)?.entries) ? (result as any).entries : []
      const stats = (result as any)?.stats
      const channelMetaByKey = (result as any)?.channelMetaByKey || {}
      setFeedTimedOut(false)
      setFeedError(null)
      setLastSuccessfulFeedAt(Date.now())
      setUsingCachedSnapshot(false)
      if (stats) {
        setPeerCount(stats.peerCount || 0)
      }
      if (entries.length > 0 && hasRichVerticalFeedSnapshot(entries, [])) setCacheRestoredOnly(false)
      let mergedEntries = entries
      setFeedEntries((prev) => {
        mergedEntries = mergeVerticalFeedEntries(prev, entries) as FeedEntry[]
        const prevSignature = prev.map(getFeedEntrySignature).join('\n')
        const nextSignature = mergedEntries.map(getFeedEntrySignature).join('\n')
        return prevSignature === nextSignature ? prev : mergedEntries
      })
      seedFromFeedEntries(mergedEntries, channelMetaByKey)
      pruneHydratedFeedChannels(hydratedChannelsRef, mergedEntries)
      await loadSwarmStatus()
      for (const entry of mergedEntries.slice(0, 24)) {
        void hydrateChannelVideos(entry)
      }
    } catch (err) {
      setFeedTimedOut(false)
      setFeedError((err as any)?.message || String(err))
      setUsingCachedSnapshot(hasRichVerticalFeedSnapshot(feedEntriesRef.current, videosRef.current))
      console.log('[VerticalDiscovery] Feed load failed:', (err as any)?.message || err)
    } finally {
      feedLoadInFlightRef.current = false
      setFeedLoading(false)
    }
  }, [hydrateChannelVideos, loadSwarmStatus, rpc, seedFromFeedEntries])

  useEffect(() => {
    if (!ready || !rpc) return
    loadFeed()
  }, [loadFeed, ready, rpc])

  useEffect(() => {
    if (!ready || !rpc) return
    void loadSwarmStatus()
    const interval = setInterval(() => {
      void loadSwarmStatus()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadSwarmStatus, ready, rpc])

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
    setShortsVideoUrl(null)
    setCommentsSheetVisible(false)
    setShortsLoading(false)
    setShortsPlaybackMessage(null)
  }, [])

  useFocusEffect(
    useCallback(() => {
      return stopShortsPlayback
    }, [stopShortsPlayback])
  )



  const playVideo = useCallback(async (video: VideoData) => {
    if (!rpc) return
    const { cacheKey, playbackRequest } = makePlaybackRequest(video)
    const playKey = `${video.channelKey}:${video.id}`
    if (pendingPlayKeyRef.current === playKey) return
    pendingPlayKeyRef.current = playKey
    setShortsPlaybackMessage(null)
    const requestSeq = ++playbackRequestSeqRef.current
    const isStalePlaybackRequest = () => pendingPlayKeyRef.current !== playKey || playbackRequestSeqRef.current !== requestSeq

    try {
      setShortsLoading(true)
      setShortsPlaybackMessage({ key: playKey, text: 'Fetching video from peers…' })
      // Resolve-and-stream: hand the blob-server URL to the player and let it
      // fetch byte ranges on demand while backend warmup runs in the background.
      const result = await rpc.preparePlayback(playbackRequest)
      if (isStalePlaybackRequest() || !result) return
      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
        setShortsPlaybackMessage(null)
        setShortsVideoUrl(result.url)
        setShortsPlaybackSession((prev) => prev + 1)
      } else {
        setShortsPlaybackMessage({ key: playKey, text: 'Could not prepare playback. Try again shortly.', isError: true })
      }
    } catch (err) {
      if (!isStalePlaybackRequest()) {
        console.log('[VerticalDiscovery] Playback failed:', (err as any)?.message || err)
        setShortsPlaybackMessage({ key: playKey, text: 'Could not prepare playback. Try again shortly.', isError: true })
      }
    } finally {
      if (!isStalePlaybackRequest()) {
        pendingPlayKeyRef.current = null
        setShortsLoading(false)
      }
    }
  }, [makePlaybackRequest, rpc])

  useEffect(() => {
    if (!activeVideo || !ready) return
    setShortsChromeVisible(true)
    void playVideo(activeVideo)
  }, [activeVideo, playVideo, ready])

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

  const openComments = useCallback((_video: VideoData) => {
    setShortsChromeVisible(true)
    setCommentsSheetVisible(true)
  }, [])

  const shareVideo = useCallback(async (video: VideoData) => {
    const channelName = getShortsChannelName(video)
    const title = video.title || 'Untitled'
    try {
      await Share.share({
        title,
        message: `${title}\n${channelName}`,
      })
    } catch (err) {
      console.log('[VerticalDiscovery] Share failed:', (err as any)?.message || err)
    }
  }, [])

  const verticalVideos = useMemo(() => videos.map((video) => {
    const cacheKey = `${video.channelKey}:${video.id}`
    return {
      ...video,
      thumbnailUrl: getRenderableThumbnailUrl(video, thumbnailCache[cacheKey]),
    }
  }), [thumbnailCache, videos])
  const backendPeerSignal = Math.max(
    Number(peerCount || 0),
    Number(swarmStatus?.peers || 0),
    Number(swarmStatus?.peerCount || 0),
    Number(swarmStatus?.swarmConnections || 0),
    Number(swarmStatus?.feedConnections || 0),
    Number(swarmStatus?.swarmPeers || 0),
    feedEntries.length,
    videos.length,
  )
  const discoveryPeerLabel = backendPeerSignal > 0 ? backendPeerSignal : peerCount
  const feedDiscoveryState = useMemo(() => classifyFeedDiscoveryState({
    ready,
    entries: feedEntries,
    videos: verticalVideos,
    peerCount: backendPeerSignal,
    swarmStatus,
    permissionStatus: androidDiscoveryPermissionStatus,
    hasCachedSnapshot: Boolean(cachedDiscoverFeed?.videos?.length || cachedDiscoverFeed?.feedEntries?.length) || usingCachedSnapshot,
  }), [androidDiscoveryPermissionStatus, cachedDiscoverFeed?.feedEntries?.length, cachedDiscoverFeed?.videos?.length, feedEntries, backendPeerSignal, ready, swarmStatus, usingCachedSnapshot, verticalVideos])
  const discoveryState = feedDiscoveryState?.state || 'discovery-waiting'
  const discoveryReason = feedDiscoveryState?.reason
  const discoveryTitle = discoveryState === 'backend-starting'
    ? (startupStatus || 'Connecting to P2P network…')
    : discoveryState === 'permission-degraded'
      ? 'Local peer discovery needs Nearby Wi-Fi'
      : discoveryState === 'network-degraded'
        ? 'Peer discovery is degraded'
        : discoveryState === 'cached-fallback'
          ? 'Using cached Discover data'
          : discoveryState === 'hydrating'
            ? 'Hydrating Discover feed'
            : 'Looking for peers'
  const discoveryDetail = discoveryState === 'backend-starting'
    ? 'Waiting for the backend to report discovery status.'
    : discoveryState === 'permission-degraded'
      ? 'Grant Nearby Wi-Fi permission, then pull to refresh.'
      : discoveryState === 'network-degraded'
        ? `Network boundary: ${discoveryReason || 'unknown'}. Pull to retry the feed path.`
        : discoveryState === 'cached-fallback'
          ? 'No live peers are connected yet; cached videos will stay visible when available.'
          : discoveryState === 'hydrating'
            ? `peerCount: ${discoveryPeerLabel}. Waiting for channel hydration.`
            : `peerCount: ${discoveryPeerLabel}. Keep the app open or pull to refresh.`
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
      {verticalVideos.length > 0 && shortsChromeVisible ? (
        <View pointerEvents="box-none" style={[styles.shortsTopChrome, { paddingTop: Math.max(insets.top + 10, 18) }]}>
          <Pressable
            onPress={() => router.back()}
            style={styles.roundButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="arrow-left" size={22} color="#fff" />
          </Pressable>

          <View style={styles.shortsTopStatus}>
            {feedEntries.length > 0 ? (
              <View style={styles.feedPill}>
                <Feather name="radio" color="#fff" size={12} />
                <Text style={styles.feedPillText}>{feedEntries.length} feeds</Text>
              </View>
            ) : null}
            {degradedCopy ? (
              <View style={styles.feedPill}>
                <Text style={styles.feedPillIcon}>!</Text>
                <Text style={styles.feedPillText}>Cached</Text>
              </View>
            ) : null}
          </View>

          <Pressable
            onPress={onRefresh}
            style={styles.roundButton}
            disabled={refreshing || feedLoading}
            accessibilityRole="button"
            accessibilityLabel="Refresh Shorts feed"
          >
            <Feather name="refresh-cw" size={18} color="#fff" />
          </Pressable>
        </View>
      ) : null}

      {verticalVideos.length > 0 && shortsChromeVisible ? (
        <View pointerEvents="none" style={[styles.topChromeFade, { height: Math.max(insets.top + 98, 124) }]} />
      ) : null}

      {verticalVideos.length === 0 ? (
        <View style={styles.centerState}>
          {feedLoading || !ready ? <ActivityIndicator color={colors.primary} size="large" /> : null}
          <Text style={styles.centerTitle}>
            {backendError ? 'Backend error' : discoveryTitle}
          </Text>
          <Text style={styles.centerBody}>
            {backendError || discoveryDetail || degradedCopy || 'Pull down to refresh, or wait for peers to announce channels.'}
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
          renderItem={({ item: video, index }) => {
            const cardKey = `${video.channelKey}:${video.id}`
            const isActiveShort = activeVideoKey === cardKey
            const actionMetrics = getShortsActionMetrics(video)
            const statusText = shortsPlaybackMessage && shortsPlaybackMessage.key === cardKey
              ? shortsPlaybackMessage.text
              : isActiveShort && degradedCopy
                ? degradedCopy
                : null
            const statusIsError = Boolean(shortsPlaybackMessage?.isError && shortsPlaybackMessage.key === cardKey)
            const xStyleChrome = shortsChromeVisible ? (
              <View style={[styles.bottomMeta, { paddingBottom: metaBottomPadding }]}>
                <View style={styles.shortsAuthorRow}>
                  <Pressable onPress={() => openChannel(video)} style={styles.shortsAuthorAvatar} accessibilityLabel="Open channel">
                    <Text style={styles.shortsAuthorAvatarText}>{getShortsAvatarLetter(video)}</Text>
                  </Pressable>
                  <Pressable onPress={() => openDetails(video)} style={styles.metaTextBlock}>
                    <View style={styles.shortsAuthorLine}>
                      <Text style={styles.videoTitle} numberOfLines={1} ellipsizeMode="tail">{getShortsChannelName(video)}</Text>
                      <View style={styles.shortsVerifiedBadge}>
                        <Feather name="check" color="#061018" size={9} />
                      </View>
                      <Text style={styles.videoMeta} numberOfLines={1}>
                        {getShortsHandle(video)} · {formatTimeAgo(video.uploadedAt || Date.now())}
                      </Text>
                    </View>
                    {video.title ? (
                      <Text style={styles.shortsPostText} numberOfLines={2} ellipsizeMode="tail">{video.title}</Text>
                    ) : null}
                    {video.description && !/^\s*source\s*:/i.test(video.description) ? (
                      <Text style={styles.videoDescription} numberOfLines={2}>{video.description}</Text>
                    ) : null}
                  </Pressable>
                  <Pressable onPress={() => openChannel(video)} style={styles.shortsFollowButton} accessibilityRole="button" accessibilityLabel="Open channel">
                    <Text style={styles.shortsFollowText}>Follow</Text>
                  </Pressable>
                  <Pressable onPress={() => openDetails(video)} style={styles.shortsOverflowButton} accessibilityRole="button" accessibilityLabel="Open video options">
                    <Feather name="more-horizontal" color="#fff" size={21} />
                  </Pressable>
                </View>

                <View style={styles.shortsActionRow}>
                  <Pressable onPress={() => openComments(video)} style={styles.shortsActionCluster} accessibilityLabel="Open Shorts comments">
                    <Feather name="message-circle" color="#f4f7fb" size={20} />
                    <Text style={styles.shortsActionText}>{formatShortsActionCount(actionMetrics.comments)}</Text>
                  </Pressable>
                  <Pressable onPress={() => openDetails(video)} style={styles.shortsActionCluster} accessibilityLabel="Open video details">
                    <Feather name="repeat" color="#f4f7fb" size={20} />
                    <Text style={styles.shortsActionText}>{formatShortsActionCount(actionMetrics.reposts)}</Text>
                  </Pressable>
                  <Pressable onPress={() => openDetails(video)} style={styles.shortsActionCluster} accessibilityLabel="Open reactions">
                    <Feather name="heart" color="#f4f7fb" size={20} />
                    <Text style={styles.shortsActionText}>{formatShortsActionCount(actionMetrics.likes)}</Text>
                  </Pressable>
                  <Pressable onPress={() => openDetails(video)} style={styles.shortsActionCluster} accessibilityLabel="Open video analytics">
                    <Feather name="bar-chart-2" color="#f4f7fb" size={20} />
                    <Text style={styles.shortsActionText}>{formatShortsActionCount(actionMetrics.views)}</Text>
                  </Pressable>
                  <Pressable onPress={() => openDetails(video)} style={styles.shortsIconAction} accessibilityLabel="Bookmark video">
                    <Feather name="bookmark" color="#f4f7fb" size={21} />
                  </Pressable>
                  <Pressable onPress={() => shareVideo(video)} style={styles.shortsIconAction} accessibilityLabel="Share video">
                    <Feather name="share-2" color="#f4f7fb" size={21} />
                  </Pressable>
                </View>
              </View>
            ) : null

            return (
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
                      videoUrl={isActiveShort ? shortsVideoUrl : null}
                      video={video}
                      playbackSession={shortsPlaybackSession}
                      isActive={activeVideoKey === `${video.channelKey}:${video.id}` && !commentsSheetVisible}
                      isLoading={shortsLoading && isActiveShort && !commentsSheetVisible}
                      thumbnailUrl={video.thumbnailUrl || null}
                      controlsVisible={shortsChromeVisible}
                      progressBottomOffset={progressBottomOffset}
                      onControlsVisibleChange={setShortsChromeVisible}
                      onReplay={() => playVideo(video)}
                    />
                    {statusText ? (
                      <View pointerEvents="none" style={[styles.shortsStatusBadge, statusIsError ? styles.playbackMessageError : null]}>
                        <Text style={styles.playbackMessageText} numberOfLines={2}>{statusText}</Text>
                      </View>
                    ) : null}
                  </View>
                  {xStyleChrome}
                </ImageBackground>
              </View>
            )
          }}
        />
      )}
      <ShortsCommentsSheet video={activeVideo || null} visible={commentsSheetVisible} onClose={() => setCommentsSheetVisible(false)} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050607',
  },
  shortsTopChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 12,
    paddingHorizontal: 18,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shortsTopStatus: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  feedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.46)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  feedPillIcon: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 13,
    fontWeight: '900',
  },
  feedPillText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5,8,12,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  page: {
    backgroundColor: '#050607',
  },
  topChromeFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 11,
    backgroundColor: 'rgba(0,0,0,0.38)',
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
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  videoStage: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000',
  },
  shortsStatusBadge: {
    position: 'absolute',
    left: 74,
    right: 74,
    top: 82,
    zIndex: 4,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(5,8,12,0.76)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  playbackMessageError: {
    backgroundColor: 'rgba(127,29,29,0.92)',
    borderColor: 'rgba(248,113,113,0.42)',
  },
  playbackMessageText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  bottomMeta: {
    position: 'absolute',
    left: 22,
    right: 18,
    bottom: 0,
    gap: 12,
    maxHeight: 238,
    overflow: 'hidden',
  },
  shortsAuthorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    minWidth: 0,
  },
  shortsAuthorAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    overflow: 'hidden',
    flexShrink: 0,
  },
  shortsAuthorAvatarText: {
    color: '#fff',
    fontSize: 17,
    lineHeight: 21,
    fontFamily: fonts.headingMedium,
  },
  metaTextBlock: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
  },
  shortsAuthorLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  shortsVerifiedBadge: {
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f6f9fb',
    flexShrink: 0,
  },
  videoTitle: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 18,
    fontFamily: fonts.headingMedium,
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  videoMeta: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
    flexShrink: 1,
  },
  shortsPostText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    marginTop: 5,
    textShadowColor: 'rgba(0,0,0,0.38)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  videoDescription: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 14,
    lineHeight: 19,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.38)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  shortsFollowButton: {
    minWidth: 64,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    backgroundColor: '#f6f9fb',
    flexShrink: 0,
  },
  shortsFollowText: {
    color: '#061018',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '800',
  },
  shortsOverflowButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.2)',
    flexShrink: 0,
  },
  shortsActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexShrink: 0,
  },
  shortsActionCluster: {
    minHeight: 34,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  shortsActionText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  shortsIconAction: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
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
