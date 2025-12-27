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
import { usePathname } from 'expo-router'
import { useApp, colors } from '../_layout'
import { useDownloads } from '../../lib/DownloadsContext'
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

function ReplyIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  )
}

function TrashIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function DownloadIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function CheckIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function SpinnerIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
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
function formatTimeAgo(timestamp: number | string | null | undefined): string {
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
  return `${days}d ago`
}

function formatBytes(bytes: number | string | null | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function toCountMap(countsData: any): Record<string, number> {
  const counts: Record<string, number> = {}
  if (Array.isArray(countsData)) {
    for (const c of countsData) {
      if (c?.reactionType) counts[c.reactionType] = c.count || 0
    }
  } else if (countsData && typeof countsData === 'object') {
    for (const [key, value] of Object.entries(countsData)) {
      counts[key] = typeof value === 'number' ? value : 0
    }
  }
  return counts
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
  const { identity } = useApp()
  const { downloads, addDownload } = useDownloads()
  const sidebarWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<ChannelMeta | null>(null)
  const [videoStats, setVideoStats] = useState<any>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Ensure the HTML video element is fully stopped when this view unmounts.
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        videoRef.current.pause()
        videoRef.current.removeAttribute('src')
        videoRef.current.load?.()
      }
    }
  }, [])

  // Social state
  const [comments, setComments] = useState<any[]>([])
  const [pendingComments, setPendingComments] = useState<any[]>([])
  const [commentText, setCommentText] = useState('')
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [postingComment, setPostingComment] = useState(false)
  const [replyToComment, setReplyToComment] = useState<any>(null)
  const [commentsPage, setCommentsPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(false)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  const [refreshingComments, setRefreshingComments] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const COMMENTS_PER_PAGE = 25

  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({})
  const [userReaction, setUserReaction] = useState<string | null>(null)
  const publicBeeKey = (video as any)?.publicBeeKey || undefined

  // Download state
  const downloadId = video ? `${channelKey}:${video.id || video.path}` : null
  const currentDownload = downloadId ? downloads.find(d => d.id === downloadId) : null
  const isDownloading = currentDownload?.status === 'downloading' || currentDownload?.status === 'queued' || currentDownload?.status === 'saving'
  const isDownloaded = currentDownload?.status === 'complete'

  const handleDownload = useCallback(async () => {
    if (!video || !rpc || isDownloading || isDownloaded) return
    const videoData = {
      ...video,
      channelKey,
      id: video.id || video.path,
      description: video.description || '',
      publicBeeKey: publicBeeKey || (video as any).publicBeeKey,
    }
    console.log('[WatchPage] handleDownload:', videoData.id, 'publicBeeKey:', videoData.publicBeeKey?.slice(0, 16))
    await addDownload(videoData as any, rpc)
  }, [video, rpc, channelKey, publicBeeKey, isDownloading, isDownloaded, addDownload])

  const displayComments = useMemo(() => {
    if (pendingComments.length === 0) return comments
    const merged = new Map<string, any>()
    for (const c of comments) merged.set(c.commentId, c)
    for (const p of pendingComments) {
      const id = p.commentId || p.localId
      if (!id) continue
      if (!merged.has(id)) merged.set(id, p)
    }
    return Array.from(merged.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  }, [comments, pendingComments])

  // Load video URL
  useEffect(() => {
    if (!video || !rpc) return
    const currentVideo = video  // Capture for async closure

    let cancelled = false
    setIsLoading(true)
    setError(null)

    async function loadVideo() {
      try {
        const videoRef = (currentVideo.path && typeof currentVideo.path === 'string' && currentVideo.path.startsWith('/'))
          ? currentVideo.path
          : currentVideo.id
        // Get video URL from backend
        const result = await rpc.getVideoUrl({
          channelKey: channelKey,
          videoId: videoRef,
          publicBeeKey: (currentVideo as any).publicBeeKey || undefined,
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
  }, [channelKey, video?.path, video?.id, publicBeeKey, rpc])

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
    if (!video || !channelKey || !rpc) return

    let cancelled = false
    let interval: NodeJS.Timeout | null = null

    const videoRef = (video.path && typeof video.path === 'string' && video.path.startsWith('/'))
      ? video.path
      : video.id

    // Start prefetch first
    rpc.prefetchVideo({
      channelKey: channelKey,
      videoId: videoRef,
      publicBeeKey,
    }).catch((err: any) => console.log('[WatchPage] Prefetch already running or failed:', err))

    async function pollStats() {
      try {
        const result = await rpc.getVideoStats({
          channelKey: channelKey,
          videoId: videoRef,
        })
        const stats = result?.stats
        if (!cancelled && stats) {
          setVideoStats(stats)
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
  }, [channelKey, video?.path, video?.id, rpc])

  // Load comments/reactions (best-effort)
  const loadSocialData = useCallback(async (page = 0, append = false) => {
    if (!rpc || !video) return
    if (!append) setCommentsLoading(true)
    try {
      const [cRes, rRes] = await Promise.all([
        rpc.listComments?.({ channelKey, videoId: video.id, publicBeeKey, page, limit: COMMENTS_PER_PAGE }).catch(() => null),
        !append ? rpc.getReactions?.({ channelKey, videoId: video.id, publicBeeKey }).catch(() => null) : Promise.resolve(null),
      ])

      const primaryOk = Boolean(cRes?.success && Array.isArray(cRes.comments))
      const primaryComments = primaryOk ? cRes.comments : []
      console.log('[WatchPage] listComments response:', { success: cRes?.success, count: primaryComments.length })
      if (primaryComments.length > 0) {
        console.log('[WatchPage] First comment isAdmin:', primaryComments[0]?.isAdmin, 'authorKeyHex:', primaryComments[0]?.authorKeyHex?.slice(0, 16))
        console.log('[WatchPage] Comments with isAdmin=true:', primaryComments.filter((c: any) => c.isAdmin).length)
      }

      if (append) {
        if (primaryComments.length > 0) setComments(prev => [...prev, ...primaryComments])
        setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
        setCommentsPage(page)
        if (primaryComments.length > 0) {
          const newIds = new Set(primaryComments.map((c: any) => c.commentId))
          setPendingComments(prev => prev.filter((p) => !p.commentId || !newIds.has(p.commentId)))
        }
      } else {
        if (primaryComments.length > 0) {
          setComments(primaryComments)
          setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
          setCommentsPage(page)
          const knownIds = new Set(primaryComments.map((c: any) => c.commentId))
          setPendingComments(prev => prev.filter((p) => !p.commentId || !knownIds.has(p.commentId)))
        } else {
          setComments([])
          setHasMoreComments(false)
        }
      }

      if (rRes?.success) {
        setReactionCounts(toCountMap(rRes.counts || {}))
        setUserReaction(rRes.userReaction || null)
      } else if (!append) {
        setReactionCounts({})
        setUserReaction(null)
      }
    } finally {
      setCommentsLoading(false)
      setLoadingMoreComments(false)
    }
  }, [rpc, channelKey, video?.id, publicBeeKey])

  useEffect(() => {
    if (!rpc || !video) return
    loadSocialData(0, false)
    // Best-effort index vectors (enables semantic search)
    rpc.indexVideoVectors?.({ channelKey, videoId: video.id }).catch(() => {})
  }, [rpc, channelKey, video?.id, loadSocialData])

  const refreshComments = useCallback(async () => {
    if (refreshingComments) return
    setRefreshingComments(true)
    try {
      await loadSocialData(0, false)
    } finally {
      setRefreshingComments(false)
    }
  }, [loadSocialData, refreshingComments])

  const loadMoreComments = useCallback(async () => {
    if (loadingMoreComments || !hasMoreComments) return
    setLoadingMoreComments(true)
    await loadSocialData(commentsPage + 1, true)
  }, [loadingMoreComments, hasMoreComments, commentsPage, loadSocialData])

  const deleteComment = async (commentId: string) => {
    if (!rpc || !video) return
    if (pendingComments.some((p) => p.commentId === commentId || p.localId === commentId)) {
      setPendingComments(prev => prev.filter(p => p.commentId !== commentId && p.localId !== commentId))
      return
    }
    if (!window.confirm('Are you sure you want to delete this comment?')) return
    setDeletingCommentId(commentId)
    try {
      const res = await rpc.removeComment?.({ channelKey, videoId: video.id, publicBeeKey, commentId })
      if (res?.success) {
        setComments(prev => prev.filter(c => c.commentId !== commentId))
      }
    } catch (err) {
      console.error('[WatchPage] Delete comment failed:', err)
      alert('Failed to delete comment')
    } finally {
      setDeletingCommentId(null)
    }
  }

  async function toggleReaction(type: string) {
    if (!rpc || !video) return
    try {
      if (userReaction === type) {
        await rpc.removeReaction?.({ channelKey, videoId: video.id, publicBeeKey })
      } else {
        await rpc.removeReaction?.({ channelKey, videoId: video.id, publicBeeKey })
        await rpc.addReaction?.({ channelKey, videoId: video.id, publicBeeKey, reactionType: type })
      }
      // refresh
      const rRes = await rpc.getReactions?.({ channelKey, videoId: video.id, publicBeeKey })
      if (rRes?.success) {
        setReactionCounts(toCountMap(rRes.counts || {}))
        setUserReaction(rRes.userReaction || null)
      }
    } catch {}
  }

  async function postComment() {
    if (!rpc || !video) return
    const text = commentText.trim()
    if (!text) return
    const parentId = replyToComment?.commentId || null
    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const authorKeyHex = identity?.driveKey || 'local'
    setPendingComments(prev => [{
      commentId: localId,
      localId,
      text,
      authorKeyHex,
      timestamp: Date.now(),
      parentId,
      pendingState: 'sending',
    }, ...prev])
    setCommentText('')
    setReplyToComment(null)
    setPostingComment(true)
    console.log('[Frontend] postComment called, channelKey:', channelKey, 'videoId:', video.id)
    try {
      console.log('[Frontend] Calling rpc.addComment with:', { channelKey, videoId: video.id, text: text.slice(0, 20) + '...' })
      if (!rpc.addComment) {
        console.log('[Frontend] ERROR: rpc.addComment is undefined!')
        return
      }
      const res = await rpc.addComment({
        channelKey,
        videoId: video.id,
        publicBeeKey,
        text,
        parentId
      })
      console.log('[Frontend] addComment result:', res)
      if (res?.success) {
        setPendingComments(prev => prev.map((p) => {
          if (p.localId !== localId) return p
          return {
            ...p,
            commentId: res.commentId || p.commentId,
            pendingState: res.queued ? 'queued' : 'pending',
          }
        }))
        await loadSocialData(0, false)
      } else {
        setPendingComments(prev => prev.map((p) => (
          p.localId === localId ? { ...p, pendingState: 'failed' } : p
        )))
      }
    } catch (err: any) {
      console.log('[Frontend] addComment error:', err?.message)
      setPendingComments(prev => prev.map((p) => (
        p.localId === localId ? { ...p, pendingState: 'failed' } : p
      )))
    } finally {
      setPostingComment(false)
    }
  }

  const cancelReply = () => {
    setReplyToComment(null)
    setCommentText('')
  }

  // Organize comments into threads (top-level + replies)
  const organizedComments = displayComments.reduce((acc, c) => {
    if (!c.parentId) {
      acc.push({ ...c, replies: displayComments.filter((r: any) => r.parentId === c.commentId) })
    }
    return acc
  }, [] as any[])

  // Check if user owns a comment (using channel's local writer key)
  const isOwnComment = (comment: any) => {
    // For web, we'd need to get the local writer key from the channel
    // For now, this is a simplified check - the backend also validates
    return false // Will be updated when we have user context
  }

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
  const downloadSpeedValue = Number(videoStats?.speedMBps ?? 0)
  const uploadSpeedValue = Number(videoStats?.uploadSpeedMBps ?? 0)
  const downloadSpeedText = Number.isFinite(downloadSpeedValue) ? downloadSpeedValue.toFixed(2) : '0.00'
  const uploadSpeedText = Number.isFinite(uploadSpeedValue) ? uploadSpeedValue.toFixed(2) : '0.00'

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
                key={`${channelKey}:${video.id || videoId}`}
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
                  <span style={{ color: '#3b82f6', fontSize: 12 }}>↓ {downloadSpeedText} MB/s</span>
                  <span style={{ color: '#4ade80', fontSize: 12 }}>↑ {uploadSpeedText} MB/s</span>
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
                <div style={watchStyles.statsRow2}>
                  <span style={watchStyles.statsDetail}>
                    {formatBytes(videoStats.downloadedBytes)} / {formatBytes(videoStats.totalBytes)}
                  </span>
                  <span style={watchStyles.statsDetail}>
                    {videoStats.downloadedBlocks || 0} / {videoStats.totalBlocks || 0} blocks
                  </span>
                  {!videoStats.isComplete && videoStats.elapsed > 0 && (
                    <span style={watchStyles.statsDetail}>{videoStats.elapsed}s</span>
                  )}
                  <span style={{
                    ...watchStyles.statsProgress,
                    ...(videoStats.isComplete ? watchStyles.statsProgressComplete : {})
                  }}>
                    {videoStats.progress || 0}%
                  </span>
                </div>
              </div>
            )}

            {/* Meta info */}
            <div style={watchStyles.meta}>
              <span>{formatTimeAgo(video.uploadedAt)}</span>
              <span style={{ color: colors.textMuted }}>•</span>
              <span>{formatBytes(video.size)}</span>
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

            {/* Reactions */}
            <div style={watchStyles.actionsRow}>
              <button
                style={{ ...watchStyles.actionButton, ...(userReaction === 'like' ? watchStyles.actionButtonActive : {}) }}
                onClick={() => toggleReaction('like')}
              >
                Like{reactionCounts.like ? ` (${reactionCounts.like})` : ''}
              </button>
              <button
                style={{ ...watchStyles.actionButton, ...(userReaction === 'dislike' ? watchStyles.actionButtonActive : {}) }}
                onClick={() => toggleReaction('dislike')}
              >
                Dislike{reactionCounts.dislike ? ` (${reactionCounts.dislike})` : ''}
              </button>
              <button
                style={{
                  ...watchStyles.actionButton,
                  ...(isDownloaded ? watchStyles.actionButtonActive : {}),
                  cursor: isDownloaded ? 'default' : 'pointer',
                }}
                onClick={handleDownload}
                disabled={isDownloading || isDownloaded}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isDownloading ? (
                    <SpinnerIcon color={colors.primary} size={16} />
                  ) : isDownloaded ? (
                    <CheckIcon color="white" size={16} />
                  ) : (
                    <DownloadIcon color={colors.text} size={16} />
                  )}
                  {isDownloaded ? 'Saved' : 'Download'}
                </span>
              </button>
            </div>

            {/* Description */}
            {video.description && (
              <div style={watchStyles.description}>
                <p style={watchStyles.descriptionText}>{video.description}</p>
              </div>
            )}

            {/* Comments */}
            <div style={watchStyles.commentsSection}>
              <div style={watchStyles.commentsHeader}>
                <h3 style={watchStyles.commentsTitle}>
                  {displayComments.length > 0 ? `${displayComments.length} Comment${displayComments.length !== 1 ? 's' : ''}` : 'Comments'}
                </h3>
                <button
                  onClick={refreshComments}
                  disabled={refreshingComments}
                  style={{ ...watchStyles.commentRefreshButton, opacity: refreshingComments ? 0.6 : 1 }}
                  title="Reconnect comments"
                >
                  {refreshingComments ? 'Refreshing…' : <RefreshIcon color={colors.textMuted} size={14} />}
                </button>
              </div>

              {/* Reply indicator */}
              {replyToComment && (
                <div style={watchStyles.replyIndicator}>
                  <span style={watchStyles.replyIndicatorText}>
                    Replying to {(replyToComment.authorKeyHex || '').slice(0, 8)}…
                  </span>
                  <button onClick={cancelReply} style={watchStyles.cancelReplyButton}>
                    <CloseIcon color={colors.textMuted} size={14} />
                  </button>
                </div>
              )}

              <div style={watchStyles.commentComposer}>
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder={replyToComment ? 'Write a reply…' : 'Add a comment…'}
                  style={watchStyles.commentInput}
                />
                <button
                  onClick={postComment}
                  disabled={postingComment || !commentText.trim()}
                  style={{ ...watchStyles.commentButton, opacity: (postingComment || !commentText.trim()) ? 0.5 : 1 }}
                >
                  {postingComment ? 'Posting…' : 'Post'}
                </button>
              </div>
              {commentsLoading && displayComments.length === 0 ? (
                <p style={{ color: colors.textMuted, fontSize: 13, margin: 0 }}>Loading…</p>
              ) : displayComments.length === 0 ? (
                <p style={{ color: colors.textMuted, fontSize: 13, margin: 0 }}>No comments yet. Be the first to comment!</p>
              ) : (
                <div style={watchStyles.commentList}>
                  {organizedComments.map((c: any) => (
                    <div key={c.commentId}>
                      {/* Main comment */}
                      <div style={watchStyles.commentItem}>
                        <div style={watchStyles.commentHeader}>
                          <span style={watchStyles.commentAuthor}>
                            {(c.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(c.timestamp || Date.now())}
                          </span>
                          {c.isAdmin && (
                            <span style={watchStyles.adminBadge}>Admin</span>
                          )}
                          {c.pendingState && (
                            <span style={watchStyles.pendingBadge}>
                              {c.pendingState === 'failed' ? 'Failed' : 'Pending'}
                            </span>
                          )}
                          <div style={watchStyles.commentActions}>
                            <button
                              onClick={() => setReplyToComment(c)}
                              style={watchStyles.commentActionButton}
                              title="Reply"
                            >
                              <ReplyIcon color={colors.textMuted} size={14} />
                            </button>
                            <button
                              onClick={() => deleteComment(c.commentId)}
                              disabled={deletingCommentId === c.commentId}
                              style={watchStyles.commentActionButton}
                              title="Delete"
                            >
                              {deletingCommentId === c.commentId ? (
                                <ActivityIndicator size="small" color={colors.textMuted} />
                              ) : (
                                <TrashIcon color="#f87171" size={14} />
                              )}
                            </button>
                          </div>
                        </div>
                        <div style={c.pendingState ? watchStyles.commentBodyPending : watchStyles.commentBody}>{c.text}</div>
                      </div>

                      {/* Replies */}
                      {c.replies && c.replies.length > 0 && (
                        <div style={watchStyles.repliesContainer}>
                          {c.replies.map((reply: any) => (
                            <div key={reply.commentId} style={watchStyles.replyItem}>
                              <div style={watchStyles.commentHeader}>
                                <span style={watchStyles.commentAuthor}>
                                  {(reply.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(reply.timestamp || Date.now())}
                                </span>
                                {reply.isAdmin && (
                                  <span style={watchStyles.adminBadge}>Admin</span>
                                )}
                                {reply.pendingState && (
                                  <span style={watchStyles.pendingBadge}>
                                    {reply.pendingState === 'failed' ? 'Failed' : 'Pending'}
                                  </span>
                                )}
                                <button
                                  onClick={() => deleteComment(reply.commentId)}
                                  disabled={deletingCommentId === reply.commentId}
                                  style={watchStyles.commentActionButton}
                                  title="Delete"
                                >
                                  {deletingCommentId === reply.commentId ? (
                                    <ActivityIndicator size="small" color={colors.textMuted} />
                                  ) : (
                                    <TrashIcon color="#f87171" size={14} />
                                  )}
                                </button>
                              </div>
                              <div style={reply.pendingState ? watchStyles.commentBodyPending : watchStyles.commentBody}>{reply.text}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Load more button */}
                  {hasMoreComments && (
                    <button
                      onClick={loadMoreComments}
                      disabled={loadingMoreComments}
                      style={watchStyles.loadMoreButton}
                    >
                      {loadingMoreComments ? 'Loading…' : 'Load more comments'}
                    </button>
                  )}
                </div>
              )}
            </div>
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
  statsRow2: {
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
  statsDetail: {
    fontSize: 12,
    color: colors.textMuted,
  },
  statsProgress: {
    fontSize: 12,
    fontWeight: 500,
    color: colors.textSecondary,
  },
  statsProgressComplete: {
    color: '#4ade80',
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
  actionsRow: {
    display: 'flex',
    gap: 10,
    marginTop: 12,
    marginBottom: 8,
  },
  actionButton: {
    backgroundColor: colors.bgSecondary,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    padding: '8px 12px',
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  actionButtonActive: {
    backgroundColor: colors.primary,
    border: `1px solid ${colors.primary}`,
    color: 'white',
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
  commentsSection: {
    marginTop: 16,
  },
  commentsHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  commentsTitle: {
    margin: 0,
    color: colors.text,
    fontSize: 16,
    fontWeight: 600,
  },
  commentRefreshButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px 8px',
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.bgSecondary,
    color: colors.textMuted,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  commentComposer: {
    backgroundColor: colors.bgSecondary,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  commentInput: {
    width: '100%',
    minHeight: 70,
    resize: 'vertical',
    borderRadius: 10,
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.bg,
    color: colors.text,
    padding: 10,
    fontSize: 13,
    fontFamily: 'inherit',
  },
  commentButton: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
    border: 'none',
    color: 'white',
    padding: '8px 12px',
    borderRadius: 10,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  commentList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    paddingBottom: 16,
  },
  commentItem: {
    backgroundColor: colors.bgSecondary,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 10,
  },
  commentHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  commentAuthor: {
    color: colors.textMuted,
    fontSize: 12,
    flex: 1,
  },
  adminBadge: {
    fontSize: 11,
    color: colors.primary,
    border: `1px solid ${colors.primary}`,
    borderRadius: 999,
    padding: '2px 6px',
    marginRight: 8,
    fontWeight: 600,
  },
  pendingBadge: {
    fontSize: 11,
    color: colors.textMuted,
    border: `1px solid ${colors.border}`,
    borderRadius: 999,
    padding: '2px 6px',
    marginRight: 8,
  },
  commentActions: {
    display: 'flex',
    gap: 8,
  },
  commentActionButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.7,
    transition: 'opacity 0.2s',
  },
  commentBody: {
    color: colors.text,
    fontSize: 14,
    lineHeight: '20px',
    whiteSpace: 'pre-wrap',
  },
  commentBodyPending: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: '20px',
    whiteSpace: 'pre-wrap',
  },
  repliesContainer: {
    marginLeft: 20,
    marginTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    borderLeft: `2px solid ${colors.border}`,
    paddingLeft: 12,
  },
  replyItem: {
    backgroundColor: colors.bgSecondary,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    padding: 8,
  },
  replyIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primary + '20',
    padding: '8px 12px',
    borderRadius: 8,
    marginBottom: 8,
  },
  replyIndicatorText: {
    color: colors.primary,
    fontSize: 13,
  },
  cancelReplyButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
  },
  loadMoreButton: {
    width: '100%',
    padding: 12,
    backgroundColor: colors.bgSecondary,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    color: colors.primary,
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'center',
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
  const { ready, identity, videos, loading, loadVideos, rpc } = useApp()
  const pathname = usePathname()

  // Hash-based routing state (for Pear desktop)
  const [currentRoute, setCurrentRoute] = useState<Route>({ type: 'home' })
  const [watchVideo, setWatchVideo] = useState<VideoData | null>(null)

  // UI state
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingMyVideos, setRefreshingMyVideos] = useState(false)

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

  // Load video info when navigating directly to a watch URL
  const loadVideoInfo = useCallback(async (driveKey: string, videoId: string) => {
    if (!rpc) return
    try {
      // First, list videos from the channel to find the one we want
      const feedEntry = feedEntries.find((entry: any) => (entry.channelKey || entry.driveKey) === driveKey)
      const publicBeeKey = (feedEntry as any)?.publicBeeKey
      const result = await rpc.listVideos({ channelKey: driveKey, publicBeeKey })
      const videoList = result?.videos || []
      if (Array.isArray(videoList)) {
        const found = videoList.find((v: any) => v.id === videoId)
        if (found) {
          setWatchVideo({ ...found, channelKey: driveKey, publicBeeKey: (found as any).publicBeeKey || publicBeeKey })
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
  }, [rpc, feedEntries])

  // Hash routing effect - listen for hash changes
  useEffect(() => {
    if (!isPear) return

    function handleHashChange() {
      const route = parseHash(window.location.hash)
      setCurrentRoute(route)

      if (route.type === 'watch') {
        // Try to find the video in local state first (include feedVideos!)
        const allVideos = [...videos, ...channelVideos, ...feedVideos]
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
  }, [videos, channelVideos, feedVideos, loadVideoInfo])

  // If a path navigation happens to "/", but hash is still on watch, reset hash/state to home
  useEffect(() => {
    if (!isPear) return
    if (pathname === '/' && window.location.hash.startsWith('#/watch')) {
      window.location.hash = ''
      setCurrentRoute({ type: 'home' })
      setWatchVideo(null)
    }
  }, [pathname])

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

    // Helper: wrap a promise with a timeout so one hung channel doesn't block the whole feed
    const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
      ])

    // Fetch videos from channels IN PARALLEL with per-channel timeout (8s each)
    const PER_CHANNEL_TIMEOUT = 8000
    const channelPromises = feedEntries.slice(0, 15).map(async (entry) => {
      const channelKey = (entry as any).channelKey || entry.driveKey
      const publicBeeKey = (entry as any).publicBeeKey
      if (!channelKey) return []

      try {
        // Pass publicBeeKey for fast viewer access via auto-replicating Hyperbee
        const result = await withTimeout(rpc.listVideos({ channelKey, publicBeeKey }), PER_CHANNEL_TIMEOUT, { videos: [] })
        const videoList = result?.videos || []
        if (Array.isArray(videoList)) {
          return videoList.map((v: any) => {
            console.log('[Home.web] Feed video:', v.id, 'thumbnail:', v.thumbnail)
            return {
              ...v,
              channelKey,
              publicBeeKey,  // Attach publicBeeKey for fast path when playing
              channel: { name: channelMeta[channelKey]?.name || 'Unknown' },
              channelName: channelMeta[channelKey]?.name || 'Unknown',
              thumbnailUrl: v.thumbnail || v.thumbnailUrl || null,
            }
          })
        }
        return []
      } catch (err) {
        // Silently skip failed channels
        console.log('[Home] Could not fetch videos from channel:', channelKey)
        return []
      }
    })

    const results = await Promise.all(channelPromises)
    const allVideos: VideoData[] = results.flat()

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

    // Look up publicBeeKey from feed entries for fast path
    const feedEntry = feedEntries.find((e: any) => (e.channelKey || e.driveKey) === driveKey)
    const publicBeeKey = (feedEntry as any)?.publicBeeKey

    try {
      await rpc.joinChannel({ channelKey: driveKey })
      const result = await rpc.listVideos({ channelKey: driveKey, publicBeeKey })
      const videoList = result?.videos || []
      if (Array.isArray(videoList)) {
        const videosWithChannel = videoList.map((v: any) => ({
          ...v,
          channelKey: driveKey,
          publicBeeKey,  // Attach publicBeeKey for fast path when playing
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
    // Keep refresh focused on Discover/public feed.
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
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Your Videos</h2>
              <button
                onClick={refreshMyVideos}
                style={styles.refreshButton}
                disabled={refreshingMyVideos || !identity?.driveKey}
                aria-label="Refresh your videos"
              >
                <RefreshIcon color={refreshingMyVideos ? colors.textMuted : colors.primary} size={18} />
              </button>
            </div>

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
