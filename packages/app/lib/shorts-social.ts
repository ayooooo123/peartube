import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import type { VideoData } from '@peartube/core'
import { rpc } from '@peartube/platform/rpc'
import { useApp } from '@/lib/AppContext'
import { COMMENTS_PER_PAGE } from '@/components/video-player'

const SHORTS_SOCIAL_RPC_TIMEOUT_MS = 8000

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

export function useShortsSocial(video: VideoData | null) {
  const { identity } = useApp()
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

  const videoKey = useMemo(() => {
    if (!video?.channelKey || !video?.id) return null
    return `${video.channelKey}:${video.id}`
  }, [video])

  // Reset state during render when the video changes so the previous
  // video's comments never paint against the new one
  const [prevVideoKey, setPrevVideoKey] = useState(videoKey)
  if (prevVideoKey !== videoKey) {
    setPrevVideoKey(videoKey)
    if (videoKey) {
      setComments([])
      setCommentText('')
      setReplyToComment(null)
      setCommentsPage(0)
      setHasMoreComments(false)
    }
  }

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
    if (!video?.channelKey || !video?.id) return
    if (!rpc?.listComments) return

    const ch = video.channelKey
    const canonicalVid = video.id
    const pubBee = video.publicBeeKey || undefined
    const isInitialLoad = commentsLengthRef.current === 0

    if (!append && (isInitialLoad || forceRefresh)) {
      setCommentsLoading(true)
    }

    try {
      const commentsRes = await withTimeout(
        rpc.listComments?.({ channelKey: ch, videoId: canonicalVid, publicBeeKey: pubBee, page, limit: COMMENTS_PER_PAGE }).catch(() => null) ?? Promise.resolve(null),
        SHORTS_SOCIAL_RPC_TIMEOUT_MS,
        null,
      )
      const primaryOk = Boolean(commentsRes?.success && Array.isArray(commentsRes.comments))
      const primaryComments = primaryOk ? commentsRes.comments : []

      if (append) {
        if (primaryComments.length > 0) setComments((prev) => [...prev, ...primaryComments])
        setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
        setCommentsPage(page)
        if (primaryComments.length > 0) {
          const newIds = new Set(primaryComments.map((c: any) => c.commentId))
          setPendingComments((prev) => prev.filter((p) => !p.commentId || !newIds.has(p.commentId)))
        }
      } else {
        if (primaryComments.length > 0) {
          setComments(primaryComments)
          setHasMoreComments(primaryComments.length >= COMMENTS_PER_PAGE)
          setCommentsPage(page)
          const knownIds = new Set(primaryComments.map((c: any) => c.commentId))
          setPendingComments((prev) => prev.filter((p) => !p.commentId || !knownIds.has(p.commentId)))
        } else if (isInitialLoad) {
          setComments([])
          setHasMoreComments(false)
        }
      }
    } finally {
      setCommentsLoading(false)
      setLoadingMoreComments(false)
      setRefreshingComments(false)
    }
  }, [video])

  // Load social data when video changes (state reset happens during render above)
  useEffect(() => {
    if (!videoKey) return
    loadSocial(0, false, true).catch(() => {})
    if (!video?.channelKey || !video?.id) return
    rpc?.indexVideoVectors?.({ channelKey: video.channelKey, videoId: video.id }).catch(() => {})
  }, [videoKey, video?.channelKey, video?.id, loadSocial])

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
    if (!video?.channelKey || !video?.id) return
    const text = commentText.trim()
    if (!text) return
    const parentId = replyToComment?.commentId || null
    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const authorKeyHex = identity?.driveKey || 'local'

    setPendingComments((prev) => [{
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
        channelKey: video.channelKey,
        videoId: video.id,
        publicBeeKey: video.publicBeeKey || undefined,
        text,
        parentId,
      })
      if (res?.success) {
        setPendingComments((prev) => prev.map((p) => {
          if (p.localId !== localId) return p
          return {
            ...p,
            commentId: res.commentId || p.commentId,
            pendingState: res.queued ? 'queued' : 'pending',
          }
        }))
        await loadSocial(0, false, true)
      } else {
        setPendingComments((prev) => prev.map((p) => (
          p.localId === localId ? { ...p, pendingState: 'failed' } : p
        )))
      }
    } catch {
      setPendingComments((prev) => prev.map((p) => (
        p.localId === localId ? { ...p, pendingState: 'failed' } : p
      )))
    } finally {
      setPostingComment(false)
    }
  }, [video, commentText, replyToComment, loadSocial, identity?.driveKey])

  const deleteComment = useCallback((commentId: string) => {
    if (!video?.channelKey || !video?.id) return
    if (pendingComments.some((p) => p.commentId === commentId || p.localId === commentId)) {
      setPendingComments((prev) => prev.filter((p) => p.commentId !== commentId && p.localId !== commentId))
      return
    }
    const pubBee = video.publicBeeKey || undefined
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
              const res = await rpc.removeComment?.({ channelKey: video.channelKey, videoId: video.id, publicBeeKey: pubBee, commentId })
              if (res?.success) {
                setComments((prev) => prev.filter((c) => c.commentId !== commentId))
              }
            } finally {
              setDeletingCommentId(null)
            }
          },
        },
      ],
    )
  }, [video, pendingComments])

  return {
    commentText,
    setCommentText,
    replyToComment,
    setReplyToComment,
    commentsLoading,
    postingComment,
    hasMoreComments,
    loadingMoreComments,
    refreshingComments,
    deletingCommentId,
    refreshComments,
    loadMoreComments,
    postComment,
    deleteComment,
    displayComments,
    organizedComments,
  }
}
