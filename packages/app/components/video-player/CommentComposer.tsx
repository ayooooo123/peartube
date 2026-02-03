/**
 * CommentComposer - Comment input and post button
 *
 * Displays the comment text input with reply indicator and post button.
 */

import { memo } from 'react'
import { View, Text, TextInput, Pressable } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
import { styles } from './styles'

interface CommentComposerProps {
  commentText: string
  onChangeText: (text: string) => void
  replyToComment: { authorKeyHex: string } | null
  onCancelReply: () => void
  onPost: () => void
  isPosting: boolean
}

export const CommentComposer = memo(function CommentComposer({
  commentText,
  onChangeText,
  replyToComment,
  onCancelReply,
  onPost,
  isPosting,
}: CommentComposerProps) {
  const canPost = !isPosting && commentText.trim().length > 0

  return (
    <>
      {/* Reply indicator */}
      {replyToComment && (
        <View style={styles.replyIndicator}>
          <Text style={styles.replyIndicatorText}>
            Replying to {(replyToComment.authorKeyHex || '').slice(0, 8)}…
          </Text>
          <Pressable onPress={onCancelReply} style={styles.cancelReplyButton}>
            <Feather name="x" color={colors.textMuted} size={16} />
          </Pressable>
        </View>
      )}

      {/* Input */}
      <View style={styles.commentComposer}>
        <TextInput
          value={commentText}
          onChangeText={onChangeText}
          placeholder={replyToComment ? 'Write a reply…' : 'Add a comment…'}
          placeholderTextColor={colors.textMuted}
          style={styles.commentInput}
          multiline
        />
        <Pressable
          onPress={onPost}
          disabled={!canPost}
          style={[styles.commentButton, !canPost && { opacity: 0.5 }]}
        >
          <Text style={styles.commentButtonText}>
            {isPosting ? 'Posting…' : 'Post'}
          </Text>
        </Pressable>
      </View>
    </>
  )
})
