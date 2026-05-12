/**
 * CommentsSection - Comments container with all comment functionality
 *
 * Uses the useCommentsPolling hook for state management.
 */

import { memo } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { styles } from './styles'
import { formatTimeAgo } from './formatters'
import { CommentItem } from './CommentItem'
import { CommentComposer } from './CommentComposer'

interface Comment {
  commentId: string
  text: string
  authorKeyHex: string
  timestamp: number
  isAdmin?: boolean
  pendingState?: 'sending' | 'queued' | 'pending' | 'failed'
  replies?: Comment[]
}

interface CommentsSectionProps {
  // Comments state
  organizedComments: Comment[]
  displayCommentsCount: number
  commentsLoading: boolean
  hasMoreComments: boolean
  loadingMoreComments: boolean
  refreshingComments: boolean

  // Composer state
  commentText: string
  replyToComment: Comment | null
  postingComment: boolean
  deletingCommentId: string | null

  // Actions
  onChangeCommentText: (text: string) => void
  onSetReplyToComment: (comment: Comment | null) => void
  onRefreshComments: () => void
  onLoadMoreComments: () => void
  onPostComment: () => void
  onDeleteComment: (commentId: string) => void
  isOwnComment: (comment: Comment) => boolean
}

export const CommentsSection = memo(function CommentsSection({
  organizedComments,
  displayCommentsCount,
  commentsLoading,
  hasMoreComments,
  loadingMoreComments,
  refreshingComments,
  commentText,
  replyToComment,
  postingComment,
  deletingCommentId,
  onChangeCommentText,
  onSetReplyToComment,
  onRefreshComments,
  onLoadMoreComments,
  onPostComment,
  onDeleteComment,
  isOwnComment,
}: CommentsSectionProps) {
  return (
    <View style={styles.commentsSection}>
      {/* Header */}
      <View style={styles.commentsHeader}>
        <Text style={styles.commentsTitle}>
          {displayCommentsCount > 0
            ? `${displayCommentsCount} Comment${displayCommentsCount !== 1 ? 's' : ''}`
            : 'Comments'}
        </Text>
        <Pressable
          onPress={onRefreshComments}
          disabled={refreshingComments}
          style={[styles.refreshButton, refreshingComments && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel="Refresh comments"
          accessibilityState={{ disabled: refreshingComments, busy: refreshingComments }}
        >
          {refreshingComments ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="rotate-ccw" color={colors.primary} size={16} />
          )}
          <Text style={styles.refreshButtonText}>Refresh</Text>
        </Pressable>
      </View>

      {/* Composer */}
      <CommentComposer
        commentText={commentText}
        onChangeText={onChangeCommentText}
        replyToComment={replyToComment}
        onCancelReply={() => {
          onSetReplyToComment(null)
          onChangeCommentText('')
        }}
        onPost={onPostComment}
        isPosting={postingComment}
      />

      {/* Comments list */}
      {commentsLoading && displayCommentsCount === 0 ? (
        <View style={{ paddingVertical: 12 }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : displayCommentsCount === 0 ? (
        <Text style={styles.commentsEmpty}>No comments yet. Be the first to comment!</Text>
      ) : (
        <View style={{ gap: 12, paddingBottom: 24 }}>
          {organizedComments.map((c) => (
            <View key={c.commentId}>
              <CommentItem
                comment={c}
                isOwnComment={isOwnComment(c)}
                deletingCommentId={deletingCommentId}
                onReply={() => onSetReplyToComment(c)}
                onDelete={() => onDeleteComment(c.commentId)}
              />

              {/* Replies */}
              {c.replies && c.replies.length > 0 && (
                <View style={styles.repliesContainer}>
                  {c.replies.map((reply) => (
                    <View key={reply.commentId} style={styles.replyItem}>
                      <View style={styles.commentHeader}>
                        <Text style={styles.commentAuthor}>
                          {(reply.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(reply.timestamp || Date.now())}
                        </Text>
                        {reply.isAdmin && (
                          <Text style={styles.adminBadge}>Admin</Text>
                        )}
                        {reply.pendingState && (
                          <Text style={styles.pendingBadge}>
                            {reply.pendingState === 'failed' ? 'Failed' : 'Pending'}
                          </Text>
                        )}
                        {(isOwnComment(reply) || reply.pendingState) && (
                          <Pressable
                            onPress={() => onDeleteComment(reply.commentId)}
                            disabled={deletingCommentId === reply.commentId}
                            style={styles.commentActionButton}
                          >
                            {deletingCommentId === reply.commentId ? (
                              <ActivityIndicator size="small" color={colors.textMuted} />
                            ) : (
                              <Feather name="trash-2" color="#f87171" size={14} />
                            )}
                          </Pressable>
                        )}
                      </View>
                      <Text style={reply.pendingState ? styles.commentTextPending : styles.commentText}>
                        {reply.text}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}

          {/* Load more */}
          {hasMoreComments && (
            <Pressable
              onPress={onLoadMoreComments}
              disabled={loadingMoreComments}
              style={styles.loadMoreButton}
            >
              {loadingMoreComments ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={styles.loadMoreText}>Load more comments</Text>
              )}
            </Pressable>
          )}
        </View>
      )}
    </View>
  )
})
