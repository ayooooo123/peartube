/**
 * Home Tab - Desktop Web Version
 *
 * Uses VideoGrid for desktop layout while sharing logic with mobile.
 * Uses pure HTML/CSS for desktop instead of React Native components.
 */
import { useCallback, useState, useEffect, useMemo } from 'react'
import { ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useApp, colors } from '../_layout'
import { VideoData } from '../../components/video'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { VideoGrid } from '@/components/video/VideoGrid.web'
import { VideoCardProps } from '@/components/video/VideoCard.web'

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

// Desktop (Pear) command IDs
const PearCommands = {
  LIST_VIDEOS: 5,
  GET_VIDEO_URL: 6,
  GET_CHANNEL: 11,
  GET_PUBLIC_FEED: 14,
  REFRESH_FEED: 15,
  SUBMIT_TO_FEED: 16,
  HIDE_CHANNEL: 17,
  GET_CHANNEL_META: 18,
}

export default function HomeScreen() {
  const router = useRouter()
  const { ready, identity, videos, loading, loadVideos, rpcCall } = useApp()
  const { loadAndPlayVideo } = useVideoPlayerContext()

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

  // Convert videos to VideoData format - defined early to avoid reference issues
  const myVideosWithMeta: VideoData[] = useMemo(() => videos.map(v => ({
    ...v,
    channelKey: identity?.driveKey || '',
    channel: identity ? { name: identity.name } : undefined,
    thumbnailUrl: null
  })), [videos, identity])

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
    try {
      setFeedLoading(true)
      const result = await rpcCall(PearCommands.GET_PUBLIC_FEED, {})
      if (result?.entries) {
        setFeedEntries(result.entries)
        for (const entry of result.entries) {
          if (!channelMeta[entry.driveKey]) {
            loadChannelMeta(entry.driveKey)
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
  }, [rpcCall, channelMeta])

  const loadChannelMeta = useCallback(async (driveKey: string) => {
    try {
      const meta = await rpcCall(PearCommands.GET_CHANNEL_META, { driveKey })
      if (meta) {
        setChannelMeta(prev => ({ ...prev, [driveKey]: meta }))
      }
    } catch (err) {
      console.error('[Home] Failed to load channel meta:', err)
    }
  }, [rpcCall])

  const refreshFeed = useCallback(async () => {
    try {
      await rpcCall(PearCommands.REFRESH_FEED, {})
      setTimeout(() => loadPublicFeed(), 1000)
    } catch (err) {
      console.error('[Home] Failed to refresh feed:', err)
    }
  }, [rpcCall, loadPublicFeed])

  const hideChannel = useCallback(async (driveKey: string) => {
    try {
      await rpcCall(PearCommands.HIDE_CHANNEL, { driveKey })
      setFeedEntries(prev => prev.filter(e => e.driveKey !== driveKey))
    } catch (err) {
      console.error('[Home] Failed to hide channel:', err)
    }
  }, [rpcCall])

  // View a channel's videos
  const viewChannel = useCallback(async (driveKey: string) => {
    setViewingChannel(driveKey)
    setLoadingChannel(true)
    setChannelVideos([])

    try {
      await rpcCall(PearCommands.GET_CHANNEL, { driveKey })
      const result = await rpcCall(PearCommands.LIST_VIDEOS, { driveKey })
      if (Array.isArray(result)) {
        const videosWithChannel = result.map((v: any) => ({
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
  }, [rpcCall, channelMeta])

  const closeChannelView = useCallback(() => {
    setViewingChannel(null)
    setChannelVideos([])
  }, [])

  // Play video - load into animated overlay player
  const playVideo = useCallback(async (video: VideoData) => {
    try {
      // Close channel view - video overlay takes over the main content area
      setViewingChannel(null)
      setChannelVideos([])

      const result = await rpcCall(PearCommands.GET_VIDEO_URL, {
        driveKey: video.channelKey,
        videoPath: video.path
      })

      if (result?.url) {
        loadAndPlayVideo(video, result.url)
      }
    } catch (err) {
      console.error('[Home] Failed to play video:', err)
    }
  }, [rpcCall, loadAndPlayVideo])

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

            {feedLoading && feedEntries.length === 0 ? (
              <div style={styles.loadingSection}>
                <ActivityIndicator color={colors.primary} />
                <p style={styles.loadingText}>Discovering channels...</p>
              </div>
            ) : feedEntries.length === 0 ? (
              <div style={styles.emptyDiscover}>
                <GlobeIcon color={colors.textMuted} size={32} />
                <p style={styles.emptyTitle}>No channels discovered yet</p>
                <p style={styles.emptySubtitle}>
                  Click refresh or wait for peers to connect
                </p>
              </div>
            ) : (
              <div style={styles.channelGrid}>
                {feedEntries.map((entry) => {
                  const meta = channelMeta[entry.driveKey]
                  return (
                    <div key={entry.driveKey} style={styles.channelCard}>
                      <div style={styles.channelAvatar}>
                        <span style={styles.channelInitial}>
                          {(meta?.name || '?')[0].toUpperCase()}
                        </span>
                      </div>
                      <h3 style={styles.channelName}>{meta?.name || 'Loading...'}</h3>
                      <p style={styles.channelVideos}>
                        {meta?.videoCount !== undefined ? `${meta.videoCount} videos` : '...'}
                      </p>
                      <p style={styles.channelMeta}>
                        {formatTimeAgo(entry.addedAt)} · {entry.source === 'local' ? 'you' : 'peer'}
                      </p>
                      <div style={styles.channelActions}>
                        <button
                          onClick={() => viewChannel(entry.driveKey)}
                          style={styles.viewButton}
                        >
                          View
                        </button>
                        <button
                          onClick={() => hideChannel(entry.driveKey)}
                          style={styles.hideButton}
                        >
                          <EyeOffIcon color={colors.textMuted} size={16} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
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
