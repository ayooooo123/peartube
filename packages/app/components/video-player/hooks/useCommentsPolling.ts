/**
 * useCommentsPolling - Custom hook for comments state and polling
 *
 * Manages comments state including loading, pagination, and 5-second polling.
 * Extracted from VideoPlayerOverlay to isolate comments-related state.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Alert } from 'react-native'
import { rpc } from '@peartube/platform/rpc'
import { COMMENTS_PER_PAGE } from '../constants'

interface Comment {
  commentId: string
  text: string
  authorKeyHex: string
  timestamp: number
  parentId?: string | null
  isAdmin?: boolean
  pendingState?: 'sending' | 'queued' | 'pending' | 'failed'
  localId?: string
  replies?: Comment[]
}

interface CommentsState {
  comments: Comment[]
  pendingComments: Comment[]
  displayComments: Comment[]
  organizedComments: Comment[]
  commentsLoading: boolean
  hasMoreComments: boolean
  loadingMoreComments: boolean
  refreshingComments: boolean
  commentText: string
  replyToComment: Comment | null
  postingComment: boolean
  deletingCommentId: string | null
  commentsPage: number
}

interface CommentsActions {
  setCommentText: (text: string) => void
  setReplyToComment: (comment: Comment | null) => void
  loadSocial: (page?: number, append?: boolean, forceRefresh?: boolean) => Promise<void>
  refreshComments: () => Promise<void>
  loadMoreComments: () => Promise<void>
  postComment: () => Promise<void>
  deleteComment: (commentId: string) => void
  isOwnComment: (comment: Comment) => boolean
}

interface UseCommentsPollingProps {
  channelKey?: string
  videoId?: string
  publicBeeKey?: string
  identityDriveKey?: string
  enabled: boolean
}

export function useCommentsPolling({
  channelKey,
  videoId,
  publicBeeKey,
  identityDriveKey,
  enabled,
}: UseCommentsPollingProps): CommentsState & CommentsActions {
  // State
  const [comments, setComments] = useState<Comment[]>([])
  const [pendingComments, setPendingComments] = useState<Comment[]>([])
  const [commentText, setCommentText] = useState('')
  const [replyToComment, setReplyToComment] = useState<Comment | null>(null)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [postingComment, setPostingComment] = useState(false)
  const [commentsPage, setCommentsPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(false)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  const [refreshingComments, setRefreshingComments] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({})
  const [userReaction, setUserReaction] = useState<string | null>(null)

  // Current video key for tracking changes
  const currentVideoKey = useMemo(() => {
    if (!channelKey || !videoId) return null
    return `${channelKey}:${videoId}`
  }, [channelKey, videoId])

  // Reset state during render when the video changes so the previous
  // video's comments never paint against the new one
  const [prevVideoKey, setPrevVideoKey] = useState(currentVideoKey)
  if (prevVideoKey !== currentVideoKey) {
    setPrevVideoKey(currentVideoKey)
    if (currentVideoKey) {
      setComments([])
      setCommentText('')
      setReplyToComment(null)
      setCommentsPage(0)
      setHasMoreComments(false)
      setReactionCounts({})
      setUserReaction(null)
    }
  }

  // Merge pending and confirmed comments
  const displayComments = useMemo(() => {
    if (pendingComments.length === 0) return comments
    const merged = new Map<string, Comment>()
    for (const c of comments) merged.set(c.commentId, c)
    for (const p of pendingComments) {
      const id = p.commentId || p.localId
      if (!id) continue
      if (!merged.has(id)) merged.set(id, p)
    }
    return Array.from(merged.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  }, [comments, pendingComments])

  // Organize comments into threads (parent + replies)
  const organizedComments = useMemo(() => {
    const byParent = new Map<string, Comment[]>()
    for (const c of displayComments) {
      const parentId = c?.parentId || ''
      if (!parentId) continue
      if (!byParent.has(parentId)) byParent.set(parentId, [])
      byParent.get(parentId)!.push(c)
    }
    const out: Comment[] = []
    for (const c of displayComments) {
      const parentId = c?.parentId || ''
      if (parentId) continue
      out.push({ ...c, replies: byParent.get(c.commentId) || [] })
    }
    return out
  }, [displayComments])

  // Check if a comment belongs to current user
  const isOwnComment = useCallback((c: Comment) => {
    if (!identityDriveKey) return false
    return c?.authorKeyHex === identityDriveKey
  }, [identityDriveKey])

  // Load comments and reactions from backend
  const loadSocial = useCallback(async (page = 0, append = false, forceRefresh = false) => {
    if (!channelKey || !videoId) return
    if (!rpc?.listComments || !rpc?.getReactions) return

    const isInitialLoad = comments.length === 0
    if (!append && (isInitialLoad || forceRefresh)) {
      setCommentsLoading(true)
    }

    try {
      const [commentsRes, reactionsRes] = await Promise.all([
        rpc.listComments?.({
          channelKey,
          videoId,
          publicBeeKey,
          page,
          limit: COMMENTS_PER_PAGE,
        }).catch(() => null),
        !append
          ? rpc.getReactions?.({ channelKey, videoId, publicBeeKey }).catch(() => null)
          : Promise.resolve(null),
      ])

      const primaryOk = Boolean(commentsRes?.success && Array.isArray(commentsRes.comments))
      const primaryComments = primaryOk ? commentsRes.comments : []

      if (append) {
        if (primaryComments.length > 0) setComments(prev => [...prev, ...primaryComments])
        setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
        setCommentsPage(page)
        if (primaryComments.length > 0) {
          const newIds = new Set(primaryComments.map((c: Comment) => c.commentId))
          setPendingComments(prev => prev.filter(p => !p.commentId || !newIds.has(p.commentId)))
        }
      } else {
        if (primaryComments.length > 0) {
          setComments(primaryComments)
          setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
          setCommentsPage(page)
          const knownIds = new Set(primaryComments.map((c: Comment) => c.commentId))
          setPendingComments(prev => prev.filter(p => !p.commentId || !knownIds.has(p.commentId)))
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
  }, [channelKey, videoId, publicBeeKey, comments.length])

  // Refresh comments
  const refreshComments = useCallback(async () => {
    setRefreshingComments(true)
    await loadSocial(0, false, true)
  }, [loadSocial])

  // Load more comments (pagination)
  const loadMoreComments = useCallback(async () => {
    if (loadingMoreComments || !hasMoreComments) return
    setLoadingMoreComments(true)
    await loadSocial(commentsPage + 1, true, false)
  }, [loadingMoreComments, hasMoreComments, commentsPage, loadSocial])

  // Post a new comment
  const postComment = useCallback(async () => {
    if (!channelKey || !videoId) return
    const text = commentText.trim()
    if (!text) return

    const parentId = replyToComment?.commentId || null
    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const authorKeyHex = identityDriveKey || 'local'

    // Add to pending immediately
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
        channelKey,
        videoId,
        publicBeeKey,
        text,
        parentId,
      })

      if (res?.success) {
        setPendingComments(prev => prev.map(p => {
          if (p.localId !== localId) return p
          return {
            ...p,
            commentId: res.commentId || p.commentId,
            pendingState: res.queued ? 'queued' : 'pending',
          }
        }))
        await loadSocial(0, false, true)
      } else {
        setPendingComments(prev => prev.map(p =>
          p.localId === localId ? { ...p, pendingState: 'failed' } : p
        ))
      }
    } catch {
      setPendingComments(prev => prev.map(p =>
        p.localId === localId ? { ...p, pendingState: 'failed' } : p
      ))
    } finally {
      setPostingComment(false)
    }
  }, [channelKey, videoId, publicBeeKey, commentText, replyToComment, identityDriveKey, loadSocial])

  // Delete a comment
  const deleteComment = useCallback((commentId: string) => {
    if (!channelKey || !videoId) return

    // Remove from pending if it's a local comment
    if (pendingComments.some(p => p.commentId === commentId || p.localId === commentId)) {
      setPendingComments(prev => prev.filter(p => p.commentId !== commentId && p.localId !== commentId))
      return
    }

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
              const res = await rpc.removeComment?.({
                channelKey,
                videoId,
                publicBeeKey,
                commentId,
              })
              if (res?.success) {
                setComments(prev => prev.filter(c => c.commentId !== commentId))
              }
            } finally {
              setDeletingCommentId(null)
            }
          },
        },
      ]
    )
  }, [channelKey, videoId, publicBeeKey, pendingComments])

  // Load social data when video changes (state reset happens during render above)
  useEffect(() => {
    if (!currentVideoKey) return
    // Initial load
    loadSocial(0, false, true).catch(() => {})
    // Index vectors for semantic search
    rpc?.indexVideoVectors?.({ channelKey: channelKey!, videoId: videoId! }).catch(() => {})
  }, [currentVideoKey])

  // Poll for updates every 5 seconds
  useEffect(() => {
    if (!currentVideoKey || !enabled) return
    const interval = setInterval(() => {
      loadSocial(0, false, false).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [currentVideoKey, enabled, loadSocial])

  return {
    // State
    comments,
    pendingComments,
    displayComments,
    organizedComments,
    commentsLoading,
    hasMoreComments,
    loadingMoreComments,
    refreshingComments,
    commentText,
    replyToComment,
    postingComment,
    deletingCommentId,
    commentsPage,

    // Actions
    setCommentText,
    setReplyToComment,
    loadSocial,
    refreshComments,
    loadMoreComments,
    postComment,
    deleteComment,
    isOwnComment,
  }
}
