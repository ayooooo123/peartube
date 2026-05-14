import { memo } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VideoData } from '@peartube/core'
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
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
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
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    maxHeight: '78%',
    minHeight: '45%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: '#0b0d10',
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  handle: {
    width: 42,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.32)',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 2,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
  },
})
