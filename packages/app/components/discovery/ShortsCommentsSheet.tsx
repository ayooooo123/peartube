import { memo } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ABSOLUTE_FILL } from '@/lib/absolute-fill'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VideoData } from '@peartube/core'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { useShortsSocial } from '@/lib/shorts-social'
import { CommentsSection } from '@/components/video-player'

type ShortsCommentsSheetProps = {
  video: VideoData | null
  visible: boolean
  onClose: () => void
}

export const ShortsCommentsSheet = memo(function ShortsCommentsSheet({ video, visible, onClose }: ShortsCommentsSheetProps) {
  const insets = useSafeAreaInsets()
  const {
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
  } = useShortsSocial(video)

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close Shorts comments" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.handle} />
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <CommentsSection
              organizedComments={organizedComments}
              displayCommentsCount={displayComments.length}
              commentsLoading={commentsLoading}
              hasMoreComments={hasMoreComments}
              loadingMoreComments={loadingMoreComments}
              refreshingComments={refreshingComments}
              commentText={commentText}
              replyToComment={replyToComment}
              postingComment={postingComment}
              deletingCommentId={deletingCommentId}
              onChangeCommentText={setCommentText}
              onSetReplyToComment={setReplyToComment}
              onRefreshComments={refreshComments}
              onLoadMoreComments={loadMoreComments}
              onPostComment={postComment}
              onDeleteComment={deleteComment}
              isOwnComment={() => false}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
})

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...ABSOLUTE_FILL,
    backgroundColor: colors.scrim,
  },
  sheet: {
    maxHeight: '78%',
    minHeight: '45%',
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    backgroundColor: colors.bg,
    borderTopWidth: borderWidth.rule,
    borderLeftWidth: borderWidth.rule,
    borderRightWidth: borderWidth.rule,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  handle: {
    width: 48,
    height: borderWidth.rule,
    borderRadius: radius.sm,
    backgroundColor: colors.borderLight,
    alignSelf: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
})
