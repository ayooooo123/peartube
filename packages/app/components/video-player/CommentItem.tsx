/**
 * CommentItem - Single comment display
 *
 * Displays a comment with author, timestamp, admin badge, and actions.
 */

import { memo } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { styles } from './styles'
import { formatTimeAgo } from './formatters'

interface Comment {
  commentId: string
  text: string
  authorKeyHex: string
  timestamp: number
  isAdmin?: boolean
  pendingState?: 'sending' | 'queued' | 'pending' | 'failed'
}

interface CommentItemProps {
  comment: Comment
  isOwnComment: boolean
  deletingCommentId: string | null
  onReply: () => void
  onDelete: () => void
  /** Channel-owner moderation — hides the comment for everyone. */
  onHide?: () => void
}

export const CommentItem = memo(function CommentItem({
  comment,
  isOwnComment,
  deletingCommentId,
  onReply,
  onDelete,
  onHide,
}: CommentItemProps) {
  const isDeleting = deletingCommentId === comment.commentId

  return (
    <View style={styles.commentItem}>
      <View style={styles.commentHeader}>
        <Text style={styles.commentAuthor}>
          {(comment.authorKeyHex || '').slice(0, 12)}… · {formatTimeAgo(comment.timestamp || Date.now())}
        </Text>
        {comment.isAdmin && (
          <Text style={styles.adminBadge}>Admin</Text>
        )}
        {comment.pendingState && (
          <Text style={styles.pendingBadge}>
            {comment.pendingState === 'failed' ? 'Failed' : 'Pending'}
          </Text>
        )}
        <View style={styles.commentActions}>
          <Pressable
            onPress={onReply}
            style={styles.commentActionButton}
            accessibilityRole="button"
            accessibilityLabel="Reply to comment"
          >
            <Feather name="corner-up-left" color={colors.textMuted} size={14} />
          </Pressable>
          {(isOwnComment || comment.pendingState) && (
            <Pressable
              onPress={onDelete}
              disabled={isDeleting}
              style={styles.commentActionButton}
              accessibilityRole="button"
              accessibilityLabel="Delete comment"
              accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <Feather name="trash-2" color="#f87171" size={14} />
              )}
            </Pressable>
          )}
          {onHide && !isOwnComment && !comment.pendingState && (
            <Pressable
              onPress={onHide}
              disabled={isDeleting}
              style={styles.commentActionButton}
              accessibilityRole="button"
              accessibilityLabel="Hide comment"
              accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" color={colors.textMuted} />
              ) : (
                <Feather name="eye-off" color={colors.textMuted} size={14} />
              )}
            </Pressable>
          )}
        </View>
      </View>
      <Text style={comment.pendingState ? styles.commentTextPending : styles.commentText}>
        {comment.text}
      </Text>
    </View>
  )
})
