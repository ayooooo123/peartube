/**
 * Home Tab - YouTube-style Video Feed with P2P Public Feed Discovery
 */
import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { View, Text, RefreshControl, Pressable, ActivityIndicator, Platform, ScrollView, FlatList, useWindowDimensions, AppState, AppStateStatus, type ListRenderItemInfo } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { VideoCard } from '../../components/video'
import type { VideoData } from '@peartube/core'
import { CastHeaderButton } from '@/components/cast'
import { useVideoPlayerActions } from '@/lib/VideoPlayerContext'
import { usePlatform } from '@/lib/PlatformProvider'
import { fetchThumbnailUrlWithRetry } from '@/lib/thumbnail'
import { formatTimeAgo } from '@/lib/formatters'
import { getCachedVideoUrl, makeVideoUrlCacheKey, setCachedVideoUrl } from '@/lib/video-url-cache'
import { getDesktopVideoGridColumns } from '@/lib/video-layout'
import { chunkHomeFeedRows, getVirtualizedHomeFeedRows } from '@/lib/home-feed-virtualization'
import {
  getFeedPreviewVideos,
  getFeedVideoHydrationMode,
  getFeedVideoLoadEntries,
  getMissingChannelMetaRequests,
  getVisibleSeededFeedEntries,
  isConfirmedFeedHydrationResult,
  mergeHydratedFeedVideos,
  mergePreviewFeedVideos,
  shouldKeepFeedVideoForVisibleEntries,
  shouldRenderFeedVideo,
} from '@/lib/feed-hydration'
import {
  createFeedSnapshot,
  getSnapshotChannelKeys,
  restoreFeedSnapshot,
} from '@/lib/feed-snapshot'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import {
  readFeedSnapshotFromDisk,
  writeFeedSnapshotToDisk,
} from '@/lib/feed-snapshot-storage'
import { classifyFeedDiscoveryState } from '@/lib/android-discovery-diagnostics'
// Public feed types
interface FeedEntry {
  driveKey: string
  channelKey?: string  // Alias for driveKey from RPC
  publicBeeKey?: string  // Fast path key for viewers (auto-replicating Hyperbee)
  addedAt: number
  source: 'peer' | 'local' | 'relay-cache'
  relayRole?: string | null
  relayServing?: boolean
  peerCount?: number
  channelName?: string | null
  videoCount?: number
  lastSeen?: number
  manifestUpdatedAt?: number
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

interface ChannelMeta {
  driveKey: string
  name?: string
  description?: string
  videoCount?: number
}

type HomeFeedListItem =
  | { type: 'discover-header' }
  | { type: 'discover-loading' }
  | { type: 'discover-empty' }
  | { type: 'discover-row'; videos: VideoData[]; rowIndex: number }
  | { type: 'my-videos-header' }
  | { type: 'my-videos-empty' }
  | { type: 'my-videos-row'; videos: VideoData[]; rowIndex: number }

type ChannelListItem =
  | { type: 'loading' }
  | { type: 'empty' }
  | { type: 'row'; videos: VideoData[]; rowIndex: number }

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

function nowMs() {
  return Date.now()
}

function logTiming(label: string, startMs: number, details: Record<string, any> = {}) {
  console.log(`[HomeTiming] ${label}`, {
    ms: Date.now() - startMs,
    ...details,
  })
}

// Detect Pear desktop vs mobile
const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).PearWorkerClient || !!(window as any).bridge)

export default function HomeScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { ready, identity, videos, loading, loadVideos, rpc, backendError, startupStatus, retryBackend, platformEvents, blobServerPort, androidDiscoveryPermissionStatus } = useApp()
  const { loadAndPlayVideo } = useVideoPlayerActions()
  const { isDesktop } = usePlatform()
  const { width: screenWidth } = useWindowDimensions()
  const tabBarMetrics = useTabBarMetrics()
  const bottomPadding = Math.max(tabBarMetrics.height + 16, insets.bottom + 16)
  const feedBottomPadding = Math.max(bottomPadding, tabBarMetrics.height + 40, insets.bottom + 40)

  const gridColumns = getDesktopVideoGridColumns(isDesktop, screenWidth)

  // UI state
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingMyVideos, setRefreshingMyVideos] = useState(false)

  // Public feed state
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [channelMeta, setChannelMeta] = useState<Record<string, ChannelMeta>>({})
  const [feedLoading, setFeedLoading] = useState(false)
  const [peerCount, setPeerCount] = useState(0)
  const [lastFeedRefresh, setLastFeedRefresh] = useState<number | null>(null)
  const [swarmStatus, setSwarmStatus] = useState<{
    peers: number
    swarmPeers?: number
    swarmConnections?: number
    feedConnections?: number
    feedEntries?: number
    channels?: number
  } | null>(null)
  const channelMetaRef = useRef(channelMeta)
  channelMetaRef.current = channelMeta
  const inflightChannelMetaLoads = useRef<Set<string>>(new Set())

  // Channel viewing state
  const [viewingChannel, setViewingChannel] = useState<string | null>(null)
  const [channelVideos, setChannelVideos] = useState<VideoData[]>([])
  const [loadingChannel, setLoadingChannel] = useState(false)

  // Aggregated feed videos from all discovered channels
  const [feedVideos, setFeedVideos] = useState<VideoData[]>([])
  const [loadingFeedVideos, setLoadingFeedVideos] = useState(false)
  const [snapshotChannelKeys, setSnapshotChannelKeys] = useState<Set<string>>(new Set())
  const [snapshotRestoredOnly, setSnapshotRestoredOnly] = useState(false)
  const feedLoadRunIdRef = useRef(0)
  const feedSnapshotRestoredRef = useRef(false)
  const feedSnapshotWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Category filter state
  const categories = ['All', 'Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']
  const [activeCategory, setActiveCategory] = useState('All')

  // Thumbnail cache: key = `${driveKey}:${videoId}` -> url
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>({})
  const thumbnailCacheRef = useRef(thumbnailCache)
  thumbnailCacheRef.current = thumbnailCache
  const inflightThumbnailFetches = useRef<Set<string>>(new Set())
  const inflightPlaybackWarmups = useRef<Set<string>>(new Set())
  const appState = useRef<AppStateStatus>(AppState.currentState)

  // Fetch thumbnail for a video (non-blocking)
  const fetchThumbnail = useCallback(async (driveKey: string, videoId: string) => {
    if (isPear || !rpc) return // Desktop handles thumbnails differently
    const cacheKey = `${driveKey}:${videoId}`
    if (thumbnailCacheRef.current[cacheKey]) return // Already cached
    if (inflightThumbnailFetches.current.has(cacheKey)) return

    inflightThumbnailFetches.current.add(cacheKey)

    try {
      const url = await fetchThumbnailUrlWithRetry({
        rpc,
        channelKey: driveKey,
        videoId,
        expectedPort: blobServerPort,
      })

      if (url) {
        setThumbnailCache(prev => {
          if (prev[cacheKey] === url) return prev
          return { ...prev, [cacheKey]: url }
        })
      }
    } catch {
      // Silently fail - thumbnails are optional
    } finally {
      inflightThumbnailFetches.current.delete(cacheKey)
    }
  }, [rpc, blobServerPort])

  // Fetch thumbnails for a list of videos
  const fetchThumbnailsForVideos = useCallback((vids: VideoData[]) => {
    if (isPear) return
    for (const video of vids) {
      if (video.channelKey && video.id) {
        fetchThumbnail(video.channelKey, video.id)
      }
    }
  }, [fetchThumbnail])

  const warmPlaybackUrl = useCallback(async (video: VideoData) => {
    if (!rpc || !video?.channelKey) return
    const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
      ? video.path
      : video.id
    const videoAny = video as any
    const cacheKey = makeVideoUrlCacheKey(
      video.channelKey,
      videoRef,
      videoAny.blobId || undefined,
      videoAny.blobsCoreKey || undefined,
    )
    if (!cacheKey || getCachedVideoUrl(cacheKey) || inflightPlaybackWarmups.current.has(cacheKey)) return
    inflightPlaybackWarmups.current.add(cacheKey)
    try {
      const result = await rpc.preparePlayback({
        channelKey: video.channelKey,
        videoId: videoRef,
        publicBeeKey: videoAny.publicBeeKey || undefined,
        blobId: videoAny.blobId || undefined,
        blobsCoreKey: videoAny.blobsCoreKey || undefined,
        mimeType: videoAny.mimeType || undefined,
      })
      if (result?.url) setCachedVideoUrl(cacheKey, result.url)
    } catch {
      // Best-effort URL warming; playback still resolves on tap.
    } finally {
      inflightPlaybackWarmups.current.delete(cacheKey)
    }
  }, [rpc])

  // Effects that depend on loadPublicFeed/refreshFeed are declared below those callbacks.

  const loadChannelMeta = useCallback(async (driveKey: string, publicBeeKey?: string) => {
    if (!rpc || channelMetaRef.current[driveKey] || inflightChannelMetaLoads.current.has(driveKey)) return
    inflightChannelMetaLoads.current.add(driveKey)
    try {
      const result = await rpc.getChannelMeta({ channelKey: driveKey, publicBeeKey: publicBeeKey || undefined })
      if (result) {
        setChannelMeta(prev => {
          if (prev[driveKey]) return prev
          return { ...prev, [driveKey]: result }
        })
      }
    } catch (err) {
      console.error('[Home] Failed to load channel meta:', err)
    } finally {
      inflightChannelMetaLoads.current.delete(driveKey)
    }
  }, [rpc])

  // Load public feed from backend
  const loadPublicFeed = useCallback(async () => {
    if (!rpc) return
    const startedAt = nowMs()
    try {
      setFeedLoading(true)
      // Add timeout to prevent infinite spinner if RPC hangs
      const feedPromise = (typeof rpc.getCanonicalFeed === 'function'
        ? rpc.getCanonicalFeed({})
        : rpc.getPublicFeed({}))
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000))
      const result = await Promise.race([feedPromise, timeoutPromise])

      if (result?.entries) {
        const mergedEntries = (Array.isArray(result.entries) ? result.entries : []).filter((entry, index, all) => {
          const key = entry?.channelKey || entry?.driveKey
          return key && all.findIndex((candidate) => (candidate?.channelKey || candidate?.driveKey) === key) === index
        }) as FeedEntry[]
        console.log('[Home] getCanonicalFeed entries:', mergedEntries.map((e: any) => ({
          channelKey: e.channelKey || e.driveKey,
          source: e.source,
          peerCount: e.peerCount,
          hasBee: !!e.publicBeeKey,
        })))
        setFeedEntries(mergedEntries)
        if (result?.channelMetaByKey) {
          setChannelMeta((prev) => ({ ...result.channelMetaByKey, ...prev }))
        }
        const CONCURRENT_META_LOADS = 3
        const metaRequests = getMissingChannelMetaRequests(mergedEntries, channelMetaRef.current, 6)
        for (const request of metaRequests.slice(0, CONCURRENT_META_LOADS)) {
          loadChannelMeta(request.channelKey, request.publicBeeKey)
        }
      }
      if (result?.stats) {
        const feedStats = result.stats as any
        setPeerCount(feedStats.peerCount || feedStats.feedConnections || 0)
        setSwarmStatus((prev) => ({
          peers: feedStats.swarmConnections ?? prev?.peers ?? (feedStats.peerCount || 0),
          swarmPeers: feedStats.swarmPeers ?? prev?.swarmPeers,
          swarmConnections: feedStats.swarmConnections ?? prev?.swarmConnections,
          feedConnections: feedStats.feedConnections ?? prev?.feedConnections,
          feedEntries: feedStats.feedEntries ?? feedStats.totalEntries ?? result?.entries?.length ?? prev?.feedEntries,
          channels: feedStats.channelsLoaded ?? prev?.channels,
        }))
      }
      logTiming('canonicalFeed', startedAt, {
        entries: result?.entries?.length || 0,
        timedOut: !result,
      })
      setLastFeedRefresh(Date.now())
      try {
        const statusPromise = rpc.getSwarmStatus()
        const status = await Promise.race([statusPromise, new Promise((r) => setTimeout(() => r(null), 3000))])
        if (status) {
          const statusAny = status as any
          setSwarmStatus({
            peers: statusAny.swarmConnections ?? statusAny.peerCount ?? 0,
            swarmPeers: statusAny.swarmPeers ?? statusAny.peerCount,
            swarmConnections: statusAny.swarmConnections,
            feedConnections: statusAny.feedConnections,
            feedEntries: statusAny.feedEntries,
            channels: statusAny.channelsLoaded,
          })
        }
      } catch (err) {
        console.log('[Home] Failed to load swarm status:', (err as any)?.message || err)
      }
    } catch (err) {
      console.error('[Home] Failed to load public feed:', err)
    } finally {
      setFeedLoading(false)
    }
  }, [rpc, loadChannelMeta])

  const refreshFeed = useCallback(async () => {
    if (!rpc) return
    try {
      await rpc.refreshFeed({})
      setTimeout(() => loadPublicFeed(), 1000)
    } catch (err) {
      console.error('[Home] Failed to refresh feed:', err)
    }
  }, [rpc, loadPublicFeed])

  // Fetch thumbnails when own videos change
  useEffect(() => {
    if (videos.length > 0 && identity?.driveKey) {
      const vidsWithKey = videos.map(v => ({ ...v, channelKey: identity.driveKey }))
      fetchThumbnailsForVideos(vidsWithKey as VideoData[])
    }
  }, [videos, identity?.driveKey, fetchThumbnailsForVideos])

  // Restore the last renderable Discover cards before P2P/feed hydration finishes.
  useEffect(() => {
    if (!ready || feedSnapshotRestoredRef.current) return
    let cancelled = false
    void (async () => {
      const snapshotStartedAt = nowMs()
      const snapshot = await readFeedSnapshotFromDisk()
      const restored = restoreFeedSnapshot(snapshot) as VideoData[]
      logTiming('feedSnapshotRestore', snapshotStartedAt, { videos: restored.length })
      if (cancelled || restored.length === 0) return
      feedSnapshotRestoredRef.current = true

      const restoredChannelKeys = getSnapshotChannelKeys(restored)
      console.log('[Home] restored feed snapshot', {
        videos: restored.length,
        channels: restoredChannelKeys.length,
      })
      setSnapshotChannelKeys(new Set(restoredChannelKeys))
      setFeedVideos((prev) => {
        if (prev.length > 0) return prev
        setSnapshotRestoredOnly(true)
        return restored
      })
      fetchThumbnailsForVideos(restored)
    })()
    return () => {
      cancelled = true
    }
  }, [ready, fetchThumbnailsForVideos])

  // Persist the last known good renderable feed so the next launch can paint instantly.
  useEffect(() => {
    if (!ready || feedVideos.length === 0 || snapshotRestoredOnly) return
    if (feedSnapshotWriteTimerRef.current) {
      clearTimeout(feedSnapshotWriteTimerRef.current)
    }

    feedSnapshotWriteTimerRef.current = setTimeout(() => {
      const snapshot = createFeedSnapshot({
        videos: feedVideos,
        channelMeta,
        identityDriveKey: identity?.driveKey || undefined,
        limit: 50,
      })
      if (snapshot.videos.length > 0) {
        void writeFeedSnapshotToDisk(snapshot)
      }
    }, 1000)

    return () => {
      if (feedSnapshotWriteTimerRef.current) {
        clearTimeout(feedSnapshotWriteTimerRef.current)
        feedSnapshotWriteTimerRef.current = null
      }
    }
  }, [ready, feedVideos, channelMeta, identity?.driveKey, snapshotRestoredOnly])

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

  // Load videos from discovered channels progressively so the first feed card appears fast.
  const loadFeedVideos = useCallback(async () => {
    const hydrationMode = getFeedVideoHydrationMode({ feedEntries, swarmStatus })
    if (!rpc || hydrationMode === 'off') return

    const runId = feedLoadRunIdRef.current + 1
    const startedAt = nowMs()
    feedLoadRunIdRef.current = runId
    setLoadingFeedVideos(true)
    // Keep existing Discover cards visible during background refresh/hydration.
    // Only merge in fresher results; do not blank the whole feed on every cycle.

    // Smaller initial tranche for fast first paint, then background-fill more.
    const PER_CHANNEL_TIMEOUT = hydrationMode === 'network' ? 2500 : 1200
    const FIRST_PASS_ATTEMPT_TIMEOUT = hydrationMode === 'network' ? 1000 : 800
    const LATER_PASS_ATTEMPT_TIMEOUT = hydrationMode === 'network' ? 1200 : 900
    const FIRST_PASS_ATTEMPTS = 1
    const LATER_PASS_ATTEMPTS = 1
    const LIST_RETRY_DELAY_MS = 250
    const entries = getFeedVideoLoadEntries(feedEntries, 8)
    const initialEntries = entries.slice(0, 3)
    const laterEntries = entries.slice(3)

    const mergeVideos = (incoming: VideoData[], refreshedChannelKeys: string[] = []) => {
      if (feedLoadRunIdRef.current !== runId) return
      setFeedVideos((prev) => mergeHydratedFeedVideos({
        previousVideos: prev,
        incomingVideos: incoming,
        refreshedChannelKeys,
        feedEntries,
        identityDriveKey: identity?.driveKey || undefined,
        limit: 50,
      }))
      if (incoming.length > 0) {
        fetchThumbnailsForVideos(incoming)
      }
    }

    const loadEntry = async (entry: any, { attemptTimeout, attempts }: { attemptTimeout: number, attempts: number }) => {
      const channelKey = entry.channelKey || entry.driveKey
      const publicBeeKey = entry.publicBeeKey || undefined
      if (!channelKey) return { channelKey: null, videos: [] as VideoData[], confirmed: false }

      console.log('[Home] loadEntry start', {
        channelKey,
        source: entry?.source,
        peerCount: entry?.peerCount,
        hasBee: !!publicBeeKey,
        identityDriveKey: identity?.driveKey,
        localVideos: videos?.length || 0,
      })

      // Fast path for the local published channel: reuse already-loaded local videos
      // instead of waiting on public-bee/channel hydration APIs.
      // Do not rely on `source` here — persisted/restored feed entries can lose or
      // rewrite that classification, but channelKey matching the active identity is
      // enough to know we already own the videos locally.
      if (identity?.driveKey && channelKey === identity.driveKey) {
        console.log('[Home] loadEntry using local fast path', { channelKey, localVideos: videos?.length || 0 })
        return {
          channelKey,
          confirmed: !loading,
          videos: (videos || []).map((v: any) => ({
            ...v,
            channelKey,
            publicBeeKey: publicBeeKey || undefined,
            channel: { name: channelMetaRef.current[channelKey]?.name || 'Your channel' }
          })),
        }
      }

      try {
        if (hydrationMode === 'network') {
          await withTimeout(rpc.joinChannel({ channelKey }), PER_CHANNEL_TIMEOUT, { success: false })
        }

        let loadedVideos: any[] = []
        let resolved = false
        for (let attempt = 0; attempt < attempts; attempt++) {
          const timeoutToken = Symbol('listVideosTimeout')
          const result = await Promise.race([
            rpc.listVideos({ channelKey, publicBeeKey }),
            new Promise((resolve) => setTimeout(() => resolve(timeoutToken), attemptTimeout)),
          ])
          const previewFallback = getFeedPreviewVideos([entry], channelMetaRef.current, identity?.driveKey || undefined, 50) as VideoData[]
          if (result !== timeoutToken) {
            resolved = true
            loadedVideos = (result as any)?.videos || []
          } else {
            loadedVideos = previewFallback
          }
          if (Array.isArray(loadedVideos) && loadedVideos.length > 0) break
          if (hydrationMode === 'network' && attempt < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, LIST_RETRY_DELAY_MS))
          }
        }

        const filteredVideos = (loadedVideos || [])
          .filter((v: any) => shouldRenderFeedVideo({
            video: { ...v, channelKey },
            identityDriveKey: identity?.driveKey || undefined,
          }))
          .map((v: any) => ({
            ...v,
            channelKey,
            publicBeeKey: publicBeeKey || undefined,
            channel: { name: channelMetaRef.current[channelKey]?.name || 'Unknown' }
          }))

        return {
          channelKey,
          videos: filteredVideos,
          confirmed: isConfirmedFeedHydrationResult({
            entry,
            resolved,
            videos: loadedVideos,
          }),
        }
      } catch (err: any) {
        console.log('[Home] Failed to load videos from channel:', channelKey, '-', err?.message || err)
        return { channelKey, videos: [] as VideoData[], confirmed: false }
      }
    }

    try {
      const firstPassResults = await Promise.all(initialEntries.map((entry) => loadEntry(entry, {
        attemptTimeout: FIRST_PASS_ATTEMPT_TIMEOUT,
        attempts: FIRST_PASS_ATTEMPTS,
      })))
      const firstPassVideos = firstPassResults.flatMap((result) => result.videos)
      if (firstPassVideos.length > 0) {
        setSnapshotRestoredOnly(false)
      }
      if (feedLoadRunIdRef.current === runId) {
        logTiming('feedHydrationFirstPass', startedAt, {
          mode: hydrationMode,
          entries: initialEntries.length,
          videos: firstPassVideos.length,
        })
        mergeVideos(
          firstPassVideos,
          firstPassResults.filter((result) => result.confirmed).map((result) => result.channelKey).filter(Boolean)
        )
      }

      // Background-fill the remaining channels without blocking first paint.
      void (async () => {
        for (const entry of laterEntries) {
          if (feedLoadRunIdRef.current !== runId) break
          const result = await loadEntry(entry, {
            attemptTimeout: LATER_PASS_ATTEMPT_TIMEOUT,
            attempts: LATER_PASS_ATTEMPTS,
          })
          mergeVideos(result.videos, result.confirmed ? [result.channelKey].filter(Boolean) : [])
        }
        if (feedLoadRunIdRef.current === runId) setLoadingFeedVideos(false)
      })()

      if (laterEntries.length === 0) {
        setLoadingFeedVideos(false)
      }
    } catch {
      if (feedLoadRunIdRef.current === runId) setLoadingFeedVideos(false)
    }
  }, [rpc, feedEntries, swarmStatus, fetchThumbnailsForVideos, videos, loading, identity?.driveKey])

  // Seed Discover immediately from local videos when the active identity's
  // channel appears in the feed. This avoids an empty Discover section while
  // remote/public-bee hydration is still catching up.
  useEffect(() => {
    const identityDriveKey = identity?.driveKey
    if (!identityDriveKey) return
    if (!Array.isArray(videos) || videos.length === 0) return
    const hasOwnFeedEntry = feedEntries.some((e) => (e.channelKey || e.driveKey) === identityDriveKey)
    if (!hasOwnFeedEntry) return

    setFeedVideos((prev) => {
      if (prev.length > 0) return prev
      setSnapshotRestoredOnly(false)
      return videos.map((v: any) => ({
        ...v,
        channelKey: identityDriveKey,
        channel: { name: channelMetaRef.current[identityDriveKey]?.name || 'Your channel' },
      }))
    })
  }, [feedEntries, videos, identity?.driveKey])

  // Seed Discover immediately from live manifest previews so the first render
  // can show provably playable remote cards before per-channel hydration finishes.
  useEffect(() => {
    const previewVideos = getFeedPreviewVideos(
      feedEntries,
      channelMeta,
      identity?.driveKey || undefined,
      18
    ) as VideoData[]
    const previewManifestResolved = feedEntries.some((entry) => (
      Number(entry?.manifestUpdatedAt || 0) > 0 ||
      (Array.isArray(entry?.previewVideos) && entry.previewVideos.length > 0)
    ))

    if (previewVideos.length > 0 || previewManifestResolved) {
      setSnapshotRestoredOnly(false)
      setFeedVideos((prev) => mergePreviewFeedVideos({
        previousVideos: prev,
        previewVideos,
        limit: 50,
      }))
    }

    if (previewVideos.length > 0) {
      fetchThumbnailsForVideos(previewVideos)
    }
  }, [feedEntries, channelMeta, identity?.driveKey, fetchThumbnailsForVideos])

  // Load feed videos when feed entries change
  useEffect(() => {
    if (getFeedVideoHydrationMode({ feedEntries, swarmStatus }) !== 'off') {
      loadFeedVideos()
    }
  }, [feedEntries, swarmStatus, loadFeedVideos])

  // View a channel's videos
  const viewChannel = useCallback(async (driveKey: string) => {
    if (!rpc) return
    setViewingChannel(driveKey)
    setLoadingChannel(true)
    setChannelVideos([])

    // Look up publicBeeKey from feed entries for fast access
    const entry = feedEntries.find(e => (e.channelKey || e.driveKey) === driveKey)
    const publicBeeKey = entry?.publicBeeKey || undefined

    try {
      // Join/get the channel first
      await rpc.joinChannel({ channelKey: driveKey })
      // Similar retry logic: channel can be discovered before any metadata is replicated.
      const attempts = 5
      const delayMs = 1000
      let videoList: any[] = []
      for (let attempt = 0; attempt < attempts; attempt++) {
        // Pass publicBeeKey for fast viewer access
        const result = await withTimeout(rpc.listVideos({ channelKey: driveKey, publicBeeKey }), 3000, { videos: [] } as any)
        videoList = (result as any)?.videos || []
        if (Array.isArray(videoList) && videoList.length > 0) break
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
        if (Array.isArray(videoList)) {
          const videosWithChannel = videoList
            .filter((v: any) => shouldRenderFeedVideo({
              video: { ...v, channelKey: driveKey },
              identityDriveKey: identity?.driveKey || undefined,
            }))
            .map((v: any) => ({
            ...v,
            channelKey: driveKey,
            publicBeeKey: publicBeeKey || undefined,
            channel: channelMeta[driveKey]
              ? { name: channelMeta[driveKey].name || 'Channel' }
              : undefined
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
  }, [rpc, channelMeta, fetchThumbnailsForVideos, feedEntries, identity?.driveKey])

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

      // INSTANT PATH: Pass blobId and blobsCoreKey directly if available
      // This skips metadata fetch entirely for instant playback
      const videoAny = video as any
      const cacheKey = makeVideoUrlCacheKey(
        video.channelKey,
        videoRef,
        videoAny.blobId || undefined,
        videoAny.blobsCoreKey || undefined,
      )
      const cachedUrl = cacheKey ? getCachedVideoUrl(cacheKey) : null
      const playbackRequest = {
        channelKey: video.channelKey,
        videoId: videoRef,
        publicBeeKey: videoAny.publicBeeKey || undefined,
        blobId: videoAny.blobId || undefined,
        blobsCoreKey: videoAny.blobsCoreKey || undefined,
        mimeType: videoAny.mimeType || undefined,
      }
      if (cachedUrl) {
        void rpc.preparePlayback(playbackRequest).catch(() => {})
        loadAndPlayVideo(video, cachedUrl)
        return
      }
      const result = await rpc.preparePlayback(playbackRequest)

      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
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

      // Get video URL from backend - use instant path if we have blob info
      const videoAny = video as any
      const cacheKey = makeVideoUrlCacheKey(
        video.channelKey,
        videoRef,
        videoAny.blobId || undefined,
        videoAny.blobsCoreKey || undefined,
      )
      const cachedUrl = cacheKey ? getCachedVideoUrl(cacheKey) : null
      const playbackRequest = {
        channelKey: video.channelKey,
        videoId: videoRef,
        publicBeeKey: videoAny.publicBeeKey || undefined,
        blobId: videoAny.blobId || undefined,
        blobsCoreKey: videoAny.blobsCoreKey || undefined,
        mimeType: videoAny.mimeType || undefined,
      }
      if (cachedUrl) {
        void rpc.preparePlayback(playbackRequest).catch(() => {})
        loadAndPlayVideo(video, cachedUrl)
        return
      }
      const result = await rpc.preparePlayback(playbackRequest)

      if (result?.url) {
        if (cacheKey) setCachedVideoUrl(cacheKey, result.url)
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
  }, [refreshFeed])

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
      channel: identity ? { name: identity.name || 'You' } : undefined,
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
  const visibleSeededFeedEntries = getVisibleSeededFeedEntries(feedEntries)
  const seededFeedChannelKeys = new Set(visibleSeededFeedEntries.map((entry) => entry.channelKey || entry.driveKey).filter(Boolean))

  const feedVideosWithThumbs: VideoData[] = feedVideos
    .filter(v => shouldKeepFeedVideoForVisibleEntries({
      video: v,
      seededFeedChannelKeys,
      snapshotChannelKeys,
    }))
    .filter(v => shouldRenderFeedVideo({
      video: v,
      identityDriveKey: identity?.driveKey || undefined,
    }))
    .map(v => {
      const cacheKey = `${v.channelKey}:${v.id}`
      return {
        ...v,
        channel: {
          name: channelMeta[v.channelKey]?.name || v.channel?.name || 'Unknown'
        },
        thumbnailUrl: thumbnailCache[cacheKey] || v.thumbnailUrl || v.thumbnail || null
      }
    })

  useEffect(() => {
    const nextVideos = feedVideosWithThumbs.slice(0, 4)
    for (const video of nextVideos) {
      void warmPlaybackUrl(video)
    }
  }, [feedVideosWithThumbs, warmPlaybackUrl])

  const backendConnecting = !ready
  const backendLoading = Boolean(loading)
  const feedDiscoveryState = useMemo(() => classifyFeedDiscoveryState({
    ready,
    entries: feedEntries,
    videos: feedVideosWithThumbs,
    peerCount,
    swarmStatus,
    permissionStatus: androidDiscoveryPermissionStatus,
    hasCachedSnapshot: snapshotRestoredOnly || snapshotChannelKeys.size > 0,
  }), [
    androidDiscoveryPermissionStatus,
    feedEntries,
    feedVideosWithThumbs,
    peerCount,
    ready,
    snapshotChannelKeys,
    snapshotRestoredOnly,
    swarmStatus,
  ])
  const displayPeers = swarmStatus?.swarmConnections ?? swarmStatus?.peers ?? peerCount
  const displayFeedEntries = Math.max(
    swarmStatus?.feedEntries ?? 0,
    feedEntries.length,
  )
  const displayChannels = Math.max(
    feedEntries.length,
    swarmStatus?.channels ?? 0,
  )
  const videoGridItemStyle = useMemo(() => isDesktop ? {
    width: `calc(${100 / gridColumns}% - ${(gridColumns - 1) * 24 / gridColumns}px)`,
  } as any : undefined, [isDesktop, gridColumns])

  const discoverRows = useMemo(() => getVirtualizedHomeFeedRows({
    videos: feedVideosWithThumbs,
    activeCategory,
    columns: gridColumns,
  }) as VideoData[][], [feedVideosWithThumbs, activeCategory, gridColumns])

  const myVideoRows = useMemo(
    () => chunkHomeFeedRows(myVideosWithMeta, gridColumns) as VideoData[][],
    [myVideosWithMeta, gridColumns]
  )

  const channelRows = useMemo(
    () => chunkHomeFeedRows(channelVideosWithThumbs, gridColumns) as VideoData[][],
    [channelVideosWithThumbs, gridColumns]
  )

  const homeFeedItems = useMemo<HomeFeedListItem[]>(() => {
    const items: HomeFeedListItem[] = [{ type: 'discover-header' }]
    if ((feedLoading || loadingFeedVideos) && feedVideos.length === 0) {
      items.push({ type: 'discover-loading' })
    } else if (discoverRows.length === 0) {
      items.push({ type: 'discover-empty' })
    } else {
      discoverRows.forEach((row, rowIndex) => items.push({ type: 'discover-row', videos: row, rowIndex }))
    }

    items.push({ type: 'my-videos-header' })
    if (myVideoRows.length === 0) {
      items.push({ type: 'my-videos-empty' })
    } else {
      myVideoRows.forEach((row, rowIndex) => items.push({ type: 'my-videos-row', videos: row, rowIndex }))
    }
    return items
  }, [discoverRows, feedLoading, loadingFeedVideos, feedVideos.length, myVideoRows])

  const channelItems = useMemo<ChannelListItem[]>(() => {
    if (loadingChannel) return [{ type: 'loading' }]
    if (channelRows.length === 0) return [{ type: 'empty' }]
    return channelRows.map((row, rowIndex) => ({ type: 'row', videos: row, rowIndex }))
  }, [loadingChannel, channelRows])

  const renderVideoRow = useCallback((
    rowVideos: VideoData[],
    {
      showChannelInfo,
      firstRowTestId,
    }: { showChannelInfo: boolean; firstRowTestId?: boolean }
  ) => (
    <View style={isDesktop ? {
      paddingHorizontal: 0,
      flexDirection: 'row',
      gap: 24,
      marginBottom: 24,
    } : { marginBottom: 12 }}>
      {rowVideos.map((video, index) => (
        <View
          key={`${video.channelKey || 'local'}-${video.id}`}
          style={videoGridItemStyle}
        >
          <VideoCard
            video={video}
            onPress={() => playVideo(video)}
            showChannelInfo={showChannelInfo}
            onChannelPress={showChannelInfo && video.channelKey ? () => router.push({ pathname: '/channel/[key]', params: { key: video.channelKey, publicBeeKey: video.publicBeeKey || undefined } }) : undefined}
            testID={firstRowTestId && index === 0 ? 'discover-feed-first-video' : undefined}
          />
        </View>
      ))}
    </View>
  ), [isDesktop, playVideo, router, videoGridItemStyle])

  const renderChannelItem = useCallback(({ item }: ListRenderItemInfo<ChannelListItem>) => {
    if (item.type === 'loading') {
      return (
        <View className="py-12 items-center">
          <ActivityIndicator color={colors.primary} size="large" />
          <Text className="text-label text-pear-text-muted mt-4">Loading videos...</Text>
        </View>
      )
    }
    if (item.type === 'empty') {
      return (
        <View className="py-12 items-center bg-pear-bg-elevated rounded-xl" style={{ marginHorizontal: isDesktop ? 0 : 20 }}>
          <Text className="text-label text-pear-text mt-2">No videos yet</Text>
        </View>
      )
    }
    return renderVideoRow(item.videos, { showChannelInfo: false })
  }, [isDesktop, renderVideoRow])

  const renderHomeFeedItem = useCallback(({ item }: ListRenderItemInfo<HomeFeedListItem>) => {
    if (item.type === 'discover-header') {
      return (
        <View style={{ paddingHorizontal: isDesktop ? 24 : 20, paddingTop: isDesktop ? 24 : 16 }}>
          <View className="flex-row items-center justify-between mb-3">
            <View className="flex-row items-center">
              <Feather name="globe" color={colors.primary} size={18} />
              <Text className="text-headline text-pear-text ml-2">Discover</Text>
              {peerCount > 0 && (
                <View className="flex-row items-center ml-2 bg-pear-bg-card px-2 py-0.5 rounded-full">
                  <Feather name="users" color={colors.textMuted} size={12} />
                  <Text className="text-caption text-pear-text-muted ml-1">{peerCount}</Text>
                </View>
              )}
            </View>
            <Pressable
              onPress={refreshFeed}
              className="p-2 active:opacity-60"
              disabled={feedLoading || backendConnecting || !rpc}
              accessibilityRole="button"
              accessibilityLabel="Refresh discover feed"
              accessibilityState={{ disabled: feedLoading || backendConnecting || !rpc, busy: feedLoading }}
            >
              <Feather
                name="refresh-cw"
                color={(feedLoading || backendConnecting || !rpc) ? colors.textMuted : colors.primary}
                size={18}
              />
            </Pressable>
          </View>

          {(backendConnecting || backendLoading || backendError) && (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.bgSecondary,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                marginBottom: 12,
              }}
            >
              {backendError ? (
                <>
                  <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
                    Backend error
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                    {backendError}
                  </Text>
                  {retryBackend ? (
                    <Pressable
                      onPress={retryBackend}
                      style={{
                        marginTop: 10,
                        alignSelf: 'flex-start',
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderRadius: 999,
                        backgroundColor: colors.primary,
                      }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Retry backend</Text>
                    </Pressable>
                  ) : null}
                </>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
                      {backendConnecting
                        ? (startupStatus || 'Connecting to P2P network...')
                        : 'Loading...'}
                    </Text>
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                      {backendConnecting
                        ? 'You can browse the UI while the backend starts.'
                        : 'Fetching identities and videos in the background.'}
                    </Text>
                  </View>
                </View>
              )}
            </View>
          )}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 8, marginBottom: 6 }}>
              <Text style={{ color: colors.text, fontSize: 12 }}>Peers: {displayPeers}</Text>
              {swarmStatus?.feedConnections !== undefined && (
                <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 6 }}>Live: {swarmStatus.feedConnections}</Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 8, marginBottom: 6 }}>
              <Text style={{ color: colors.text, fontSize: 12 }}>Feed: {displayFeedEntries}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 8, marginBottom: 6 }}>
              <Text style={{ color: colors.text, fontSize: 12 }}>Channels: {displayChannels}</Text>
              {swarmStatus?.channels !== undefined && swarmStatus.channels !== displayChannels && (
                <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 6 }}>Live: {swarmStatus.channels}</Text>
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
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${cat}`}
                accessibilityState={{ selected: activeCategory === cat }}
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
        </View>
      )
    }

    if (item.type === 'discover-loading') {
      return (
        <View className="py-8 items-center" style={{ paddingHorizontal: isDesktop ? 24 : 20 }}>
          <ActivityIndicator color={colors.primary} />
          <Text className="text-caption text-pear-text-muted mt-2">Discovering videos...</Text>
        </View>
      )
    }

    if (item.type === 'discover-empty') {
      const state = feedDiscoveryState?.state || 'discovery-waiting'
      const reason = feedDiscoveryState?.reason
      const title = state === 'permission-degraded'
        ? 'Local peer discovery needs Nearby Wi-Fi'
        : state === 'network-degraded'
          ? 'Peer discovery is degraded'
          : state === 'cached-fallback'
            ? 'Using cached discovery data'
            : state === 'hydrating'
              ? 'Loading playable previews'
              : 'Looking for PearTube peers'
      const detail = state === 'permission-degraded'
        ? 'Grant Nearby devices/Wi-Fi permission, then refresh discovery.'
        : state === 'network-degraded'
          ? `Network boundary: ${reason || 'unknown'}. Refresh will retry the feed path.`
          : state === 'cached-fallback'
            ? 'No live peers are connected yet; cached videos will stay visible when available.'
            : state === 'hydrating'
              ? `${displayFeedEntries || feedEntries.length} feed entries detected; resolving playable video previews.`
              : 'No live peers have announced channels yet. Keep the app open or tap refresh.'

      return (
        <View style={{ paddingHorizontal: isDesktop ? 24 : 20 }}>
          <View className="py-8 items-center bg-pear-bg-elevated rounded-xl">
            <Feather name="radio" color={colors.textMuted} size={32} />
            <Text className="text-label text-pear-text mt-2 text-center">{title}</Text>
            <Text className="text-caption text-pear-text-muted mt-1 text-center px-6">{detail}</Text>
            <Pressable
              onPress={refreshFeed}
              disabled={feedLoading || backendConnecting || !rpc}
              className="mt-4 px-4 py-2 rounded-lg bg-pear-primary active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel="Retry peer discovery"
            >
              <Text className="text-label text-white">Retry discovery</Text>
            </Pressable>
          </View>
        </View>
      )
    }

    if (item.type === 'discover-row') {
      return (
        <View style={{ paddingHorizontal: isDesktop ? 24 : 20 }}>
          {renderVideoRow(item.videos, { showChannelInfo: true, firstRowTestId: item.rowIndex === 0 })}
        </View>
      )
    }

    if (item.type === 'my-videos-header') {
      return (
        <View style={{ paddingTop: 12, paddingHorizontal: isDesktop ? 24 : 20 }}>
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-headline text-pear-text">Your Videos</Text>
            <Pressable
              onPress={refreshMyVideos}
              className="p-2 active:opacity-60"
              disabled={refreshingMyVideos || !identity?.driveKey}
            >
              <Feather name="refresh-cw" color={refreshingMyVideos ? colors.textMuted : colors.primary} size={18} />
            </Pressable>
          </View>
        </View>
      )
    }

    if (item.type === 'my-videos-empty') {
      return (
        <View style={{ paddingHorizontal: isDesktop ? 24 : 20 }}>
          <View className="py-12 items-center bg-pear-bg-elevated rounded-xl">
            <Text className="text-display mb-4">📺</Text>
            <Text className="text-label text-pear-text mb-2">No videos yet</Text>
            <Text className="text-caption text-pear-text-muted text-center px-8">
              Upload your first video from the Studio tab
            </Text>
          </View>
        </View>
      )
    }

    return (
      <View style={{ paddingHorizontal: isDesktop ? 24 : 0 }}>
        {renderVideoRow(item.videos, { showChannelInfo: true })}
      </View>
    )
  }, [
    activeCategory,
    backendConnecting,
    backendError,
    backendLoading,
    categories,
    feedDiscoveryState,
    feedEntries.length,
    feedLoading,
    identity?.driveKey,
    isDesktop,
    lastFeedRefresh,
    loadingFeedVideos,
    peerCount,
    refreshFeed,
    refreshMyVideos,
    refreshingMyVideos,
    renderVideoRow,
    retryBackend,
    rpc,
    startupStatus,
    swarmStatus,
  ])

  return (
    <View className="flex-1 bg-pear-bg">
      {/* Header - only show on mobile */}
      {!isDesktop && (
        <View className="bg-pear-bg border-b border-pear-border" style={{ paddingTop: insets.top }}>
          <View className="flex-row px-5 py-4 items-center justify-between">
            <Text className="text-title text-pear-text">PearTube</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <CastHeaderButton size={18} />
              <Pressable
                onPress={() => router.push('/search')}
                className="p-2"
                accessibilityRole="button"
                accessibilityLabel="Search"
              >
                <Feather name="search" color={colors.text} size={18} />
              </Pressable>
              {identity && (
                <View className="bg-pear-bg-card px-3 py-1.5 rounded-full">
                  <Text className="text-caption text-pear-text-secondary">{identity.name}</Text>
                </View>
              )}
            </View>
          </View>
        </View>
      )}

      {/* Channel View Modal */}
      {viewingChannel && (
        <View className="flex-1">
          <View className="flex-row items-center py-4 bg-pear-bg-elevated border-b border-pear-border" style={{ paddingHorizontal: isDesktop ? 24 : 20 }}>
            <Pressable onPress={closeChannelView} className="mr-3 p-1"><Feather name="x" color={colors.text} size={24} /></Pressable>
            <View className="flex-1">
              <Text className="text-headline text-pear-text">{channelMeta[viewingChannel]?.name || 'Channel'}</Text>
              <Text className="text-caption text-pear-text-muted">{viewingChannel.slice(0, 16)}...</Text>
            </View>
          </View>

          <FlatList
            data={channelItems}
            keyExtractor={(item) => item.type === 'row' ? `channel-row-${item.rowIndex}` : item.type}
            renderItem={renderChannelItem}
            contentContainerStyle={{ paddingBottom: bottomPadding, paddingHorizontal: isDesktop ? 24 : 0, paddingTop: isDesktop ? 16 : 8, flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true}
            maxToRenderPerBatch={5}
            windowSize={10}
            initialNumToRender={4}
          />
        </View>
      )}

      {/* Main Feed */}
      {!viewingChannel && (
        <FlatList
          data={homeFeedItems}
          keyExtractor={(item) => (
            item.type === 'discover-row' || item.type === 'my-videos-row'
              ? `${item.type}-${item.rowIndex}`
              : item.type
          )}
          renderItem={renderHomeFeedItem}
          contentContainerStyle={{ paddingBottom: feedBottomPadding, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={5}
          windowSize={10}
          initialNumToRender={4}
        />
      )}
    </View>
  )
}
