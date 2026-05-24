import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { rpc } from '@peartube/platform/rpc'
import { useApp } from '@/lib/AppContext'
import { useVideoPlayerSession } from '@/lib/VideoPlayerContext'
import { COMMENTS_PER_PAGE } from '@/components/video-player'

const SOCIAL_RPC_TIMEOUT_MS = 8000

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => {
      if (timeout) clearTimeout(timeout)
    }),
    new Promise<T>((resolve) => {
      timeout = setTimeout(() => resolve(fallback), ms)
    }),
  ])
}

interface SocialContextType {
  comments: any[]
  pendingComments: any[]
  commentText: string
  replyToComment: any
  commentsLoading: boolean
  postingComment: boolean
  commentsPage: number
  hasMoreComments: boolean
  loadingMoreComments: boolean
  refreshingComments: boolean
  deletingCommentId: string | null
  reactionCounts: Record<string, number>
  userReaction: string | null

  setCommentText: (text: string) => void
  setReplyToComment: (comment: any) => void

  loadSocial: (page?: number, append?: boolean, forceRefresh?: boolean) => Promise<void>
  refreshComments: () => void
  loadMoreComments: () => void
  postComment: () => Promise<void>
  deleteComment: (commentId: string) => void
  toggleReaction: (reactionType: string) => Promise<void>

  displayComments: any[]
  organizedComments: any[]
}

const SocialContext = createContext<SocialContextType | null>(null)

export function useSocial() {
  const context = useContext(SocialContext)
  if (!context) throw new Error('useSocial must be used within SocialProvider')
  return context
}

export function SocialProvider({ children }: { children: React.ReactNode }) {
  const { identity } = useApp()
  const { currentVideo, playerMode } = useVideoPlayerSession()

  const commentsLengthRef = useRef(0)

  const [comments, setComments] = useState<any[]>([])
  const [pendingComments, setPendingComments] = useState<any[]>([])
  const [commentText, setCommentText] = useState('')
  const [replyToComment, setReplyToComment] = useState<any>(null)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [postingComment, setPostingComment] = useState(false)
  const [commentsPage, setCommentsPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(false)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  const [refreshingComments, setRefreshingComments] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({})
  const [userReaction, setUserReaction] = useState<string | null>(null)

  const currentVideoKey = useMemo(() => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return null
    return `${currentVideo.channelKey}:${currentVideo.id}`
  }, [currentVideo])

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

  const organizedComments = useMemo(() => {
    const byParent = new Map<string, any[]>()
    for (const c of displayComments) {
      const parentId = c?.parentId || ''
      if (!parentId) continue
      if (!byParent.has(parentId)) byParent.set(parentId, [])
      byParent.get(parentId)!.push(c)
    }
    const out: any[] = []
    for (const c of displayComments) {
      const parentId = c?.parentId || ''
      if (parentId) continue
      out.push({ ...c, replies: byParent.get(c.commentId) || [] })
    }
    return out
  }, [displayComments])

  useEffect(() => {
    commentsLengthRef.current = comments.length
  }, [comments.length])

  const loadSocial = useCallback(async (page = 0, append = false, forceRefresh = false) => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    if (!rpc?.listComments || !rpc?.getReactions) return

    const ch = currentVideo.channelKey
    const canonicalVid = currentVideo.id
    const pubBee = currentVideo.publicBeeKey || undefined

    const isInitialLoad = commentsLengthRef.current === 0
    if (!append && (isInitialLoad || forceRefresh)) {
      setCommentsLoading(true)
    }

    try {
      const [commentsRes, reactionsRes] = await Promise.all([
        withTimeout(
          rpc.listComments?.({ channelKey: ch, videoId: canonicalVid, publicBeeKey: pubBee, page, limit: COMMENTS_PER_PAGE }).catch(() => null) ?? Promise.resolve(null),
          SOCIAL_RPC_TIMEOUT_MS,
          null
        ),
        !append ? withTimeout(
          rpc.getReactions?.({ channelKey: ch, videoId: canonicalVid, publicBeeKey: pubBee }).catch(() => null) ?? Promise.resolve(null),
          SOCIAL_RPC_TIMEOUT_MS,
          null
        ) : Promise.resolve(null),
      ])

      const primaryOk = Boolean(commentsRes?.success && Array.isArray(commentsRes.comments))
      const primaryComments = primaryOk ? commentsRes.comments : []

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
        } else if (isInitialLoad) {
          setComments([])
          setHasMoreComments(false)
        }
      }

      if (reactionsRes?.success) {
        const toCountMap = (countsData: any): Record<string, number> => {
          const counts: Record<string, number> = {}
          if (Array.isArray(countsData)) {
            for (const c of countsData) {
              if (c?.reactionType) counts[c.reactionType] = c.count || 0
            }
          } else if (countsData && typeof countsData === 'object') {
            for (const [k, v] of Object.entries(countsData)) {
              counts[k] = typeof v === 'number' ? v : 0
            }
          }
          return counts
        }

        setReactionCounts(toCountMap(reactionsRes.counts || {}))
        setUserReaction(reactionsRes.userReaction || null)
      }
    } finally {
      setCommentsLoading(false)
      setLoadingMoreComments(false)
      setRefreshingComments(false)
    }
  }, [currentVideo])

  useEffect(() => {
    if (!currentVideoKey) return
    setComments([])
    setCommentText('')
    setReplyToComment(null)
    setCommentsPage(0)
    setHasMoreComments(false)
    setReactionCounts({})
    setUserReaction(null)
    loadSocial(0, false, true).catch(() => {})
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    rpc?.indexVideoVectors?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id }).catch(() => {})
  }, [currentVideoKey, currentVideo?.channelKey, currentVideo?.id, loadSocial])

  useEffect(() => {
    if (!currentVideoKey) return
    if (playerMode === 'hidden') return

    const interval = setInterval(() => {
      loadSocial(0, false, false).catch(() => {})
    }, 5000)

    return () => clearInterval(interval)
  }, [currentVideoKey, playerMode, loadSocial])

  const refreshComments = useCallback(() => {
    setRefreshingComments(true)
    loadSocial(0, false, true).catch(() => {})
  }, [loadSocial])

  const loadMoreComments = useCallback(() => {
    if (loadingMoreComments || !hasMoreComments) return
    setLoadingMoreComments(true)
    loadSocial(commentsPage + 1, true, false).catch(() => {})
  }, [loadingMoreComments, hasMoreComments, commentsPage, loadSocial])

  const postComment = useCallback(async () => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
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
    try {
      const res = await rpc.addComment?.({
        channelKey: currentVideo.channelKey,
        videoId: currentVideo.id,
        publicBeeKey: currentVideo.publicBeeKey || undefined,
        text,
        parentId,
      })
      if (res?.success) {
        setPendingComments(prev => prev.map((p) => {
          if (p.localId !== localId) return p
          return {
            ...p,
            commentId: res.commentId || p.commentId,
            pendingState: res.queued ? 'queued' : 'pending',
          }
        }))
        await loadSocial(0, false, true)
      } else {
        setPendingComments(prev => prev.map((p) => (
          p.localId === localId ? { ...p, pendingState: 'failed' } : p
        )))
      }
    } catch {
      setPendingComments(prev => prev.map((p) => (
        p.localId === localId ? { ...p, pendingState: 'failed' } : p
      )))
    } finally {
      setPostingComment(false)
    }
  }, [currentVideo, commentText, replyToComment, loadSocial, identity?.driveKey])

  const deleteComment = useCallback((commentId: string) => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    if (pendingComments.some((p) => p.commentId === commentId || p.localId === commentId)) {
      setPendingComments(prev => prev.filter(p => p.commentId !== commentId && p.localId !== commentId))
      return
    }
    const pubBee = currentVideo.publicBeeKey || undefined
    Alert.alert(
      'Delete Comment',
      'Are you sure you want to delete this comment?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingCommentId(commentId)
            try {
              const res = await rpc.removeComment?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee, commentId })
              if (res?.success) {
                setComments(prev => prev.filter(c => c.commentId !== commentId))
              }
            } finally {
              setDeletingCommentId(null)
            }
          },
        },
      ],
    )
  }, [currentVideo, pendingComments])

  const toggleReaction = useCallback(async (reactionType: string) => {
    if (!currentVideo?.channelKey || !currentVideo?.id) return
    const pubBee = currentVideo.publicBeeKey || undefined
    try {
      if (userReaction === reactionType) {
        await rpc.removeReaction?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee })
      } else {
        await rpc.removeReaction?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee })
        await rpc.addReaction?.({ channelKey: currentVideo.channelKey, videoId: currentVideo.id, publicBeeKey: pubBee, reactionType })
      }
      await loadSocial(0, false, true)
    } catch {
      return
    }
  }, [currentVideo, userReaction, loadSocial])

  const value = useMemo(() => ({
    comments,
    pendingComments,
    commentText,
    replyToComment,
    commentsLoading,
    postingComment,
    commentsPage,
    hasMoreComments,
    loadingMoreComments,
    refreshingComments,
    deletingCommentId,
    reactionCounts,
    userReaction,
    setCommentText,
    setReplyToComment,
    loadSocial,
    refreshComments,
    loadMoreComments,
    postComment,
    deleteComment,
    toggleReaction,
    displayComments,
    organizedComments,
  }), [
    comments,
    pendingComments,
    commentText,
    replyToComment,
    commentsLoading,
    postingComment,
    commentsPage,
    hasMoreComments,
    loadingMoreComments,
    refreshingComments,
    deletingCommentId,
    reactionCounts,
    userReaction,
    loadSocial,
    refreshComments,
    loadMoreComments,
    postComment,
    deleteComment,
    toggleReaction,
    displayComments,
    organizedComments,
  ])

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>
}
