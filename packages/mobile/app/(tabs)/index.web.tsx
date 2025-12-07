/**
 * Home Tab - Desktop Web Version
 *
 * Uses VideoGrid for desktop layout while sharing logic with mobile.
 * Uses pure HTML/CSS for desktop instead of React Native components.
 * Includes hash-based routing for /watch/{channelKey}/{videoId} on Pear desktop.
 */
import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useApp, colors } from '../_layout'
import { VideoData } from '../../components/video'
// We navigate to the dedicated video route on web instead of overlay playback
import { VideoGrid } from '@/components/video/VideoGrid.web'
import { VideoCardProps } from '@/components/video/VideoCard.web'
import { useSidebar, SIDEBAR_WIDTH, SIDEBAR_COLLAPSED_WIDTH } from '@/components/desktop/constants'

// Check if running on Pear desktop
const isPear = typeof window !== 'undefined' && !!(window as any).Pear

// Icons as simple SVG components
function GlobeIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function RefreshIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

function UsersIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function EyeOffIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

function CloseIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

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

// Now using HRPC methods directly - no command IDs needed

// Route parsing for hash-based routing
interface WatchRoute {
  type: 'watch'
  channelKey: string
  videoId: string
}

interface HomeRoute {
  type: 'home'
}

type Route = WatchRoute | HomeRoute

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '') || ''
  const parts = path.split('/').filter(Boolean)

  if (parts[0] === 'watch' && parts[1] && parts[2]) {
    return { type: 'watch', channelKey: parts[1], videoId: parts[2] }
  }
  return { type: 'home' }
}

// WatchPageView - YouTube-style video playback page
interface WatchPageViewProps {
  channelKey: string
  videoId: string
  video: VideoData | null
  onBack: () => void
  onVideoClick: (video: VideoData) => void
  rpc: any  // HRPC instance
  relatedVideos: VideoData[]
  channelMeta: Record<string, ChannelMeta>
}

function WatchPageView({
  channelKey,
  videoId,
  video,
  onBack,
  onVideoClick,
  rpc,
  relatedVideos,
  channelMeta,
}: WatchPageViewProps) {
  const { isCollapsed } = useSidebar()
  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<ChannelMeta | null>(null)
  const [videoStats, setVideoStats] = useState<any>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Load video URL
  useEffect(() => {
    if (!video?.path || !rpc) return

    let cancelled = false
    setIsLoading(true)
    setError(null)

    async function loadVideo() {
      try {
        // Get video URL from backend
        const result = await rpc.getVideoUrl({
          channelKey: channelKey,
          videoId: video!.path,
        })

        if (cancelled) return

        if (result?.url) {
          setVideoUrl(result.url)
        } else {
          setError('Failed to get video URL')
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load video')
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    loadVideo()
    return () => { cancelled = true }
  }, [channelKey, video?.path, rpc])

  // Load channel info
  useEffect(() => {
    if (!rpc) return
    if (channelMeta[channelKey]) {
      setChannel(channelMeta[channelKey])
      return
    }

    rpc.getChannelMeta({ channelKey: channelKey })
      .then((result: any) => setChannel(result))
      .catch((err: any) => console.error('Failed to load channel:', err))
  }, [channelKey, channelMeta, rpc])

  // Start prefetch and poll for video stats
  useEffect(() => {
    if (!video?.path || !channelKey || !rpc) return

    let cancelled = false
    let interval: NodeJS.Timeout | null = null

    // Start prefetch first
    rpc.prefetchVideo({
      channelKey: channelKey,
      videoId: video.path,
    }).catch((err: any) => console.log('[WatchPage] Prefetch already running or failed:', err))

    async function pollStats() {
      try {
        const result = await rpc.getVideoStats({
          channelKey: channelKey,
          videoId: video!.path,
        })
        const stats = result?.stats
        if (!cancelled && stats) {
          setVideoStats(stats)
          // Stop polling if complete
          if (stats.isComplete && interval) {
            clearInterval(interval)
            interval = null
          }
        }
      } catch (err) {
        // Ignore polling errors
      }
    }

    // Start polling
    pollStats()
    interval = setInterval(pollStats, 1000)

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [channelKey, video?.path, rpc])

  if (!video) {
    return (
      <div style={{ ...watchStyles.container, left: sidebarWidth }}>
        <div style={watchStyles.loadingState}>
          <ActivityIndicator size="large" color={colors.primary} />
          <p style={{ color: colors.textMuted, marginTop: 16 }}>Loading video...</p>
        </div>
      </div>
    )
  }

  const channelName = channel?.name || 'Loading...'
  const channelInitial = channelName.charAt(0).toUpperCase()

  return (
    <div style={{ ...watchStyles.container, left: sidebarWidth, transition: 'left 0.2s ease' }}>
      <div style={watchStyles.content}>
        {/* Main column - video + info */}
        <div style={watchStyles.mainColumn}>
          {/* Video player */}
          <div style={watchStyles.videoWrapper}>
            {error ? (
              <div style={watchStyles.errorState}>
                <p style={{ color: colors.textMuted }}>{error}</p>
                <button onClick={onBack} style={watchStyles.backButton}>Go Back</button>
              </div>
            ) : isLoading ? (
              <div style={watchStyles.loadingOverlay}>
                <ActivityIndicator size="large" color="#fff" />
                <p style={{ color: '#fff', marginTop: 12 }}>Connecting to P2P network...</p>
              </div>
            ) : (
              <video
                ref={videoRef}
                src={videoUrl || undefined}
                controls
                autoPlay
                style={watchStyles.video}
              />
            )}
          </div>

          {/* Video info */}
          <div style={watchStyles.videoInfo}>
            <h1 style={watchStyles.title}>{video.title}</h1>

            {/* P2P Stats bar */}
            {videoStats && (
              <div style={watchStyles.statsBar}>
                <div style={watchStyles.statsRow}>
                  <div style={watchStyles.statusIndicator}>
                    <div style={{
                      ...watchStyles.statusDot,
                      backgroundColor: videoStats.isComplete ? '#4ade80' :
                        videoStats.status === 'downloading' ? '#3b82f6' : colors.textMuted
                    }} />
                    <span style={{ color: videoStats.isComplete ? '#4ade80' : colors.textSecondary, fontSize: 13 }}>
                      {videoStats.isComplete ? 'Cached' : videoStats.status === 'downloading' ? 'Downloading' : 'Loading...'}
                    </span>
                  </div>
                  <span style={{ color: colors.textMuted, fontSize: 12 }}>
                    {videoStats.peerCount || 0} peers
                  </span>
                  {!videoStats.isComplete && parseFloat(videoStats.speedMBps) > 0 && (
                    <span style={{ color: '#3b82f6', fontSize: 12 }}>↓ {videoStats.speedMBps} MB/s</span>
                  )}
                  {videoStats.uploadSpeedMBps && parseFloat(videoStats.uploadSpeedMBps) > 0 && (
                    <span style={{ color: '#4ade80', fontSize: 12 }}>↑ {videoStats.uploadSpeedMBps} MB/s</span>
                  )}
                  {!videoStats.isComplete && videoStats.progress > 0 && (
                    <span style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 500 }}>
                      {videoStats.progress}%
                    </span>
                  )}
                </div>
                {!videoStats.isComplete && (
                  <div style={watchStyles.progressBar}>
                    <div style={{ ...watchStyles.progressFill, width: `${videoStats.progress || 0}%` }} />
                  </div>
                )}
              </div>
            )}

            {/* Meta info */}
            <div style={watchStyles.meta}>
              <span>{formatTimeAgo(video.uploadedAt)}</span>
              <span style={{ color: colors.textMuted }}>•</span>
              <span>{video.size < 1024 * 1024 * 1024
                ? `${(video.size / (1024 * 1024)).toFixed(1)} MB`
                : `${(video.size / (1024 * 1024 * 1024)).toFixed(2)} GB`}</span>
            </div>

            {/* Channel info */}
            <div style={watchStyles.channelRow}>
              <div style={watchStyles.avatar}>
                <span style={watchStyles.avatarText}>{channelInitial}</span>
              </div>
              <div style={watchStyles.channelInfo}>
                <span style={watchStyles.channelName}>{channelName}</span>
                <span style={watchStyles.channelKey}>{channelKey.slice(0, 16)}...</span>
              </div>
            </div>

            {/* Description */}
            {video.description && (
              <div style={watchStyles.description}>
                <p style={watchStyles.descriptionText}>{video.description}</p>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar - related videos */}
        <div style={watchStyles.sidebar}>
          <h3 style={watchStyles.sidebarTitle}>Related Videos</h3>
          {relatedVideos.length === 0 ? (
            <p style={{ color: colors.textMuted, fontSize: 14 }}>No related videos</p>
          ) : (
            <div style={watchStyles.relatedList}>
              {relatedVideos.map((v) => (
                <div
                  key={v.id}
                  style={watchStyles.relatedCard}
                  onClick={() => onVideoClick(v)}
                >
                  <div style={watchStyles.relatedThumb}>
                    <span style={watchStyles.relatedThumbText}>{v.title.charAt(0).toUpperCase()}</span>
                  </div>
                  <div style={watchStyles.relatedInfo}>
                    <span style={watchStyles.relatedTitle}>{v.title}</span>
                    <span style={watchStyles.relatedMeta}>
                      {channelMeta[v.channelKey]?.name || 'Channel'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Back button */}
        <button onClick={onBack} style={watchStyles.closeButton} aria-label="Back to Home">
          <CloseIcon color={colors.text} size={24} />
        </button>
      </div>
    </div>
  )
}

// WatchPageView styles
const watchStyles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    top: 108, // PEAR_BAR_HEIGHT (52) + HEADER_HEIGHT (56)
    left: SIDEBAR_WIDTH,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    zIndex: 1000,
    overflow: 'auto',
  },
  content: {
    display: 'flex',
    flexDirection: 'row',
    padding: 24,
    gap: 24,
    maxWidth: 1600,
    position: 'relative',
  },
  mainColumn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minWidth: 0,
  },
  videoWrapper: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16/9',
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
  },
  video: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
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
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  loadingState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  errorState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
  },
  backButton: {
    padding: '8px 16px',
    backgroundColor: colors.primary,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
  },
  videoInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    color: colors.text,
    margin: 0,
    lineHeight: 1.3,
  },
  statsBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 16px',
    backgroundColor: colors.bgSecondary,
    borderRadius: 8,
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap',
  },
  statusIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  progressBar: {
    width: '100%',
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    transition: 'width 0.3s ease',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
    color: colors.textMuted,
  },
  channelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    paddingTop: 16,
    borderTop: `1px solid ${colors.border}`,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 600,
  },
  channelInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  channelName: {
    fontSize: 15,
    fontWeight: 500,
    color: colors.text,
  },
  channelKey: {
    fontSize: 12,
    color: colors.textMuted,
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
    whiteSpace: 'pre-wrap',
  },
  sidebar: {
    width: 360,
    flexShrink: 0,
  },
  sidebarTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: colors.text,
    margin: '0 0 16px 0',
  },
  relatedList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  relatedCard: {
    display: 'flex',
    gap: 12,
    padding: 8,
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  relatedThumb: {
    width: 160,
    height: 90,
    borderRadius: 8,
    backgroundColor: colors.bgSecondary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  relatedThumbText: {
    fontSize: 24,
    color: colors.primary,
    fontWeight: 600,
  },
  relatedInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  relatedTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: colors.text,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  relatedMeta: {
    fontSize: 12,
    color: colors.textMuted,
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

export default function HomeScreen() {
  const router = useRouter()
  const { ready, identity, videos, loading, loadVideos, rpc } = useApp()

  // Hash-based routing state (for Pear desktop)
  const [currentRoute, setCurrentRoute] = useState<Route>({ type: 'home' })
  const [watchVideo, setWatchVideo] = useState<VideoData | null>(null)

  // UI state
  const [refreshing, setRefreshing] = useState(false)

  // Public feed state
  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [channelMeta, setChannelMeta] = useState<Record<string, ChannelMeta>>({})
  const [feedLoading, setFeedLoading] = useState(false)
  const [peerCount, setPeerCount] = useState(0)

  // Aggregated feed videos from discovered channels
  const [feedVideos, setFeedVideos] = useState<VideoData[]>([])
  const [feedVideosLoading, setFeedVideosLoading] = useState(false)

  // Category filter state
  const categories = ['All', 'Music', 'Gaming', 'Tech', 'Education', 'Entertainment', 'Vlog', 'Other']
  const [activeCategory, setActiveCategory] = useState('All')

  // Channel viewing state
  const [viewingChannel, setViewingChannel] = useState<string | null>(null)
  const [channelVideos, setChannelVideos] = useState<VideoData[]>([])
  const [loadingChannel, setLoadingChannel] = useState(false)

  // Hash routing effect - listen for hash changes
  useEffect(() => {
    if (!isPear) return

    function handleHashChange() {
      const route = parseHash(window.location.hash)
      setCurrentRoute(route)

      if (route.type === 'watch') {
        // Try to find the video in local state first
        const allVideos = [...videos, ...channelVideos]
        const foundVideo = allVideos.find(
          v => v.id === route.videoId && (v.channelKey === route.channelKey || !v.channelKey)
        )
        if (foundVideo) {
          setWatchVideo({ ...foundVideo, channelKey: route.channelKey })
        } else {
          // Need to load video info from backend
          loadVideoInfo(route.channelKey, route.videoId)
        }
      } else {
        setWatchVideo(null)
      }
    }

    // Check initial hash
    handleHashChange()

    // Listen for hash changes
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [videos, channelVideos])

  // Load video info when navigating directly to a watch URL
  const loadVideoInfo = useCallback(async (driveKey: string, videoId: string) => {
    if (!rpc) return
    try {
      // First, list videos from the channel to find the one we want
      const result = await rpc.listVideos({ channelKey: driveKey })
      const videoList = result?.videos || []
      if (Array.isArray(videoList)) {
        const found = videoList.find((v: any) => v.id === videoId)
        if (found) {
          setWatchVideo({ ...found, channelKey: driveKey })
          return
        }
      }
      // If video not found, create a placeholder
      setWatchVideo({
        id: videoId,
        title: 'Loading...',
        description: '',
        path: '',
        mimeType: 'video/mp4',
        size: 0,
        uploadedAt: Date.now(),
        channelKey: driveKey,
        thumbnailUrl: null
      })
    } catch (err) {
      console.error('[Home] Failed to load video info:', err)
    }
  }, [rpc])

  // Convert videos to VideoData format - defined early to avoid reference issues
  const myVideosWithMeta: VideoData[] = useMemo(() => videos.map(v => {
    console.log('[Home.web] Video:', v.id, 'thumbnail from backend:', v.thumbnail)
    return {
      ...v,
      channelKey: identity?.driveKey || '',
      channel: identity?.name ? { name: identity.name } : undefined,
      thumbnailUrl: v.thumbnail || null  // Use thumbnail URL from backend
    }
  }), [videos, identity])

  // Convert to VideoCardProps for the grid
  const gridVideos: VideoCardProps[] = useMemo(() => myVideosWithMeta.map(v => ({
    id: v.id,
    title: v.title || 'Untitled',
    thumbnailUrl: v.thumbnailUrl || undefined,
    channelName: v.channel?.name || 'Unknown',
    duration: v.duration,
    uploadedAt: v.uploadedAt ? new Date(v.uploadedAt).toISOString() : undefined,
  })), [myVideosWithMeta])

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

  // Load videos from all discovered channels
  const loadFeedVideos = useCallback(async () => {
    if (!rpc || feedEntries.length === 0) return
    setFeedVideosLoading(true)
    const allVideos: VideoData[] = []

    // Fetch videos from up to 15 channels
    for (const entry of feedEntries.slice(0, 15)) {
      const channelKey = (entry as any).channelKey || entry.driveKey
      if (!channelKey) continue

      try {
        const result = await rpc.listVideos({ channelKey })
        const videoList = result?.videos || []
        if (Array.isArray(videoList)) {
          const videos = videoList.map((v: any) => {
            console.log('[Home.web] Feed video:', v.id, 'thumbnail:', v.thumbnail)
            return {
              ...v,
              channelKey,
              channel: { name: channelMeta[channelKey]?.name || 'Unknown' },
              channelName: channelMeta[channelKey]?.name || 'Unknown',
              thumbnailUrl: v.thumbnail || v.thumbnailUrl || null,  // Map backend thumbnail to thumbnailUrl
            }
          })
          allVideos.push(...videos)
        }
      } catch (err) {
        // Silently skip failed channels
        console.log('[Home] Could not fetch videos from channel:', channelKey)
      }
    }

    // Sort by upload time and take top 50
    const sortedVideos = allVideos
      .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
      .slice(0, 50)

    setFeedVideos(sortedVideos)
    setFeedVideosLoading(false)
  }, [rpc, feedEntries, channelMeta])

  // Load feed videos when feedEntries change
  useEffect(() => {
    if (feedEntries.length > 0 && ready) {
      loadFeedVideos()
    }
  }, [feedEntries, ready, loadFeedVideos])

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
      }
    } catch (err) {
      console.error('[Home] Failed to load channel videos:', err)
    } finally {
      setLoadingChannel(false)
    }
  }, [rpc, channelMeta])

  const closeChannelView = useCallback(() => {
    setViewingChannel(null)
    setChannelVideos([])
  }, [])

  // Play video - navigate to watch page via hash routing (Pear) or URL (web fallback)
  const playVideo = useCallback((video: VideoData) => {
    const channelKey = video.channelKey || identity?.driveKey || (video as any).driveKey || ''

    // Desktop (Pear): use hash routing which triggers the hashchange handler
    if (isPear) {
      setViewingChannel(null)
      setChannelVideos([])
      // Set watchVideo immediately for smooth transition
      setWatchVideo({ ...video, channelKey })
      // Navigate via hash - this triggers the hashchange event listener
      window.location.hash = `/watch/${channelKey}/${video.id}`
      return
    }

    // Web/static fallback (Expo web export): navigate to the video page with encoded data
    setViewingChannel(null)
    setChannelVideos([])
    const base = window.location.href.split('#')[0].replace(/index\.html$/, '')
    const videoData = encodeURIComponent(JSON.stringify({ ...video, channelKey }))
    const target = `${base}video/${video.id}.html?videoData=${videoData}`
    window.location.href = target
  }, [identity?.driveKey])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([
      refreshFeed(),
      identity?.driveKey ? loadVideos(identity.driveKey) : Promise.resolve()
    ])
    setRefreshing(false)
  }, [identity, loadVideos, refreshFeed])

  // Handle video press from grid
  const handleVideoPress = useCallback((videoId: string) => {
    const video = [...myVideosWithMeta, ...channelVideos].find(v => v.id === videoId)
    if (video) {
      playVideo(video)
    }
  }, [myVideosWithMeta, channelVideos, playVideo])

  if (!ready || loading) {
    return (
      <div style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <p style={styles.loadingText}>
          {!ready ? 'Starting P2P network...' : 'Loading...'}
        </p>
      </div>
    )
  }

  // On Pear desktop with watch route, render the WatchPageView
  if (isPear && currentRoute.type === 'watch') {
    // Get related videos (other videos from same channel + your videos)
    const relatedVideos = [
      ...channelVideos.filter(v => v.id !== currentRoute.videoId),
      ...myVideosWithMeta.filter(v => v.id !== currentRoute.videoId),
    ].slice(0, 10)

    return (
      <div style={styles.container}>
        <WatchPageView
          channelKey={currentRoute.channelKey}
          videoId={currentRoute.videoId}
          video={watchVideo}
          onBack={() => {
            window.location.hash = ''
            setCurrentRoute({ type: 'home' })
            setWatchVideo(null)
          }}
          onVideoClick={playVideo}
          rpc={rpc}
          relatedVideos={relatedVideos}
          channelMeta={channelMeta}
        />
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Channel View Modal */}
      {viewingChannel && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <button onClick={closeChannelView} style={styles.closeButton}>
                <CloseIcon color={colors.text} size={24} />
              </button>
              <div style={styles.modalTitle}>
                <h2 style={styles.modalTitleText}>
                  {channelMeta[viewingChannel]?.name || 'Channel'}
                </h2>
                <p style={styles.modalSubtitle}>
                  {viewingChannel.slice(0, 16)}...
                </p>
              </div>
            </div>

            <div style={styles.modalContent}>
              {loadingChannel ? (
                <div style={styles.loadingContainer}>
                  <ActivityIndicator color={colors.primary} size="large" />
                  <p style={styles.loadingText}>Loading videos...</p>
                </div>
              ) : channelVideos.length === 0 ? (
                <div style={styles.emptyState}>
                  <p style={styles.emptyText}>No videos yet</p>
                </div>
              ) : (
                <VideoGrid
                  videos={channelVideos.map(v => ({
                    id: v.id,
                    title: v.title || 'Untitled',
                    thumbnailUrl: v.thumbnailUrl || undefined,
                    channelName: channelMeta[viewingChannel]?.name || 'Unknown',
                    duration: v.duration,
                    uploadedAt: v.uploadedAt ? new Date(v.uploadedAt).toISOString() : undefined,
                  }))}
                  onVideoPress={(videoId) => {
                    const video = channelVideos.find(v => v.id === videoId)
                    if (video) playVideo(video)
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Feed */}
      {!viewingChannel && (
        <div style={styles.mainContent}>
          {/* Discover Section */}
          <div style={styles.discoverSection}>
            <div style={styles.sectionHeader}>
              <div style={styles.sectionTitleGroup}>
                <GlobeIcon color={colors.primary} size={20} />
                <h2 style={styles.sectionTitle}>Discover</h2>
                {peerCount > 0 && (
                  <span style={styles.peerBadge}>
                    <UsersIcon color={colors.textMuted} size={14} />
                    <span style={styles.peerCount}>{peerCount}</span>
                  </span>
                )}
              </div>
              <button
                onClick={refreshFeed}
                style={styles.refreshButton}
                disabled={feedLoading}
              >
                <RefreshIcon
                  color={feedLoading ? colors.textMuted : colors.primary}
                  size={18}
                />
              </button>
            </div>

            {/* Category Filter Chips */}
            <div style={styles.categoryRow}>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  style={activeCategory === cat ? styles.categoryChipActive : styles.categoryChip}
                >
                  {cat}
                </button>
              ))}
            </div>

            {(feedLoading || feedVideosLoading) && feedVideos.length === 0 ? (
              <div style={styles.loadingSection}>
                <ActivityIndicator color={colors.primary} />
                <p style={styles.loadingText}>Discovering videos...</p>
              </div>
            ) : feedVideos.length === 0 && feedEntries.length === 0 ? (
              <div style={styles.emptyDiscover}>
                <GlobeIcon color={colors.textMuted} size={32} />
                <p style={styles.emptyTitle}>No videos discovered yet</p>
                <p style={styles.emptySubtitle}>
                  {peerCount === 0 ? 'Waiting for peers to connect...' : 'Click refresh to discover videos'}
                </p>
              </div>
            ) : (
              <VideoGrid
                videos={feedVideos
                  .filter(v => activeCategory === 'All' || (v as any).category === activeCategory)
                  .map(v => ({
                    id: v.id,
                    title: v.title || 'Untitled',
                    thumbnailUrl: v.thumbnailUrl || undefined,
                    channelName: (v as any).channelName || channelMeta[v.channelKey || '']?.name || 'Unknown',
                    duration: v.duration,
                    uploadedAt: v.uploadedAt ? new Date(v.uploadedAt).toISOString() : undefined,
                  }))}
                onVideoPress={(videoId) => {
                  const video = feedVideos.find(v => v.id === videoId)
                  if (video) playVideo(video)
                }}
              />
            )}
          </div>

          {/* Your Videos Section */}
          <div style={styles.videosSection}>
            <h2 style={styles.sectionTitle}>Your Videos</h2>

            {gridVideos.length === 0 ? (
              <div style={styles.emptyVideos}>
                <span style={styles.emptyEmoji}>📺</span>
                <p style={styles.emptyTitle}>No videos yet</p>
                <p style={styles.emptySubtitle}>
                  Upload your first video from the Studio tab
                </p>
              </div>
            ) : (
              <VideoGrid
                videos={gridVideos}
                onVideoPress={handleVideoPress}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    height: '100%',
    overflow: 'auto',
  },
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: 14,
    margin: 0,
  },
  mainContent: {
    padding: '24px',
  },
  discoverSection: {
    marginBottom: 32,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sectionTitleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 20,
    fontWeight: 600,
    color: colors.text,
  },
  peerBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bgSecondary,
    padding: '4px 8px',
    borderRadius: 12,
    marginLeft: 8,
  },
  peerCount: {
    fontSize: 12,
    color: colors.textMuted,
  },
  refreshButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 18,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  categoryRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 16,
    overflowX: 'auto',
    paddingBottom: 4,
  },
  categoryChip: {
    padding: '8px 16px',
    borderRadius: 8,
    backgroundColor: colors.bgSecondary,
    color: colors.text,
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    transition: 'background-color 0.2s',
  },
  categoryChipActive: {
    padding: '8px 16px',
    borderRadius: 8,
    backgroundColor: colors.text,
    color: colors.bg,
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  loadingSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyDiscover: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 32,
    backgroundColor: colors.bgSecondary,
    borderRadius: 12,
    gap: 8,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: 500,
    margin: 0,
    marginTop: 8,
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: 13,
    margin: 0,
  },
  channelGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 16,
  },
  channelCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 12,
    padding: 16,
  },
  channelAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.bgHover,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  channelInitial: {
    fontSize: 18,
    fontWeight: 600,
    color: colors.primary,
  },
  channelName: {
    margin: '0 0 4px',
    fontSize: 14,
    fontWeight: 500,
    color: colors.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  channelVideos: {
    margin: 0,
    fontSize: 13,
    color: colors.textMuted,
  },
  channelMeta: {
    margin: '4px 0 0',
    fontSize: 12,
    color: colors.textMuted,
  },
  channelActions: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
  },
  viewButton: {
    flex: 1,
    padding: '8px 0',
    backgroundColor: colors.primary,
    border: 'none',
    borderRadius: 8,
    color: 'white',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  hideButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    backgroundColor: colors.bgHover,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  videosSection: {
    marginTop: 24,
  },
  emptyVideos: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 48,
    backgroundColor: colors.bgSecondary,
    borderRadius: 12,
    gap: 8,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 8,
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
  },
  emptyText: {
    color: colors.text,
    fontSize: 14,
    margin: 0,
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    width: '90%',
    maxWidth: 1200,
    maxHeight: '90%',
    backgroundColor: colors.bg,
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: 16,
    borderBottom: `1px solid ${colors.border}`,
    backgroundColor: colors.bgSecondary,
  },
  closeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    padding: 4,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  modalTitle: {
    flex: 1,
  },
  modalTitleText: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: colors.text,
  },
  modalSubtitle: {
    margin: 0,
    fontSize: 13,
    color: colors.textMuted,
  },
  modalContent: {
    flex: 1,
    overflow: 'auto',
  },
}
