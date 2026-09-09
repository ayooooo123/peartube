/**
 * VideoFeed - YouTube-style vertical scrolling video feed
 * Uses FlatList for performance with pull-to-refresh and empty state
 */
import { FlatList, View, RefreshControl, StyleSheet, ActivityIndicator } from 'react-native'
import { VideoCard, VideoData } from './VideoCard'
import { EmptyState as EmptyPlaceholder } from '@/components/primitives'
import { colors, spacing, radius, borderWidth } from '@/lib/colors'

interface VideoFeedProps {
  videos: VideoData[]
  onVideoPress: (video: VideoData) => void
  onRefresh?: () => Promise<void>
  refreshing?: boolean
  loading?: boolean
  emptyMessage?: string
  ListHeaderComponent?: React.ReactElement
  contentContainerStyle?: any
}

// Loading skeleton for video cards
function VideoCardSkeleton() {
  return (
    <View style={skeletonStyles.container}>
      {/* Thumbnail skeleton */}
      <View style={skeletonStyles.thumbnail} />

      {/* Info row skeleton */}
      <View style={skeletonStyles.infoRow}>
        <View style={skeletonStyles.avatar} />
        <View style={skeletonStyles.textContainer}>
          <View style={skeletonStyles.titleLine1} />
          <View style={skeletonStyles.titleLine2} />
          <View style={skeletonStyles.metaLine} />
        </View>
      </View>
    </View>
  )
}

// Empty state component
function EmptyState({ message }: { message: string }) {
  return (
    <EmptyPlaceholder icon="tv" status="0 VIDEOS" title="No videos yet" body={message} />
  )
}

// Loading state with skeletons
function LoadingState() {
  return (
    <View style={loadingStyles.container}>
      <VideoCardSkeleton />
      <VideoCardSkeleton />
      <VideoCardSkeleton />
    </View>
  )
}

export function VideoFeed({
  videos,
  onVideoPress,
  onRefresh,
  refreshing = false,
  loading = false,
  emptyMessage = 'Subscribe to channels or discover new ones to see videos here.',
  ListHeaderComponent,
  contentContainerStyle,
}: VideoFeedProps) {
  // Show loading skeletons on initial load
  if (loading && videos.length === 0) {
    return (
      <View style={styles.container}>
        {ListHeaderComponent}
        <LoadingState />
      </View>
    )
  }

  // Show empty state when no videos
  if (!loading && videos.length === 0) {
    return (
      <View style={styles.container}>
        {ListHeaderComponent}
        <EmptyState message={emptyMessage} />
      </View>
    )
  }

  return (
    <FlatList
      data={videos}
      keyExtractor={(item) => `${item.channelKey}-${item.id}`}
      renderItem={({ item }) => (
        <VideoCard
          video={item}
          onPress={() => onVideoPress(item)}
          showChannelInfo={true}
        />
      )}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        ) : undefined
      }
      ListHeaderComponent={ListHeaderComponent}
      contentContainerStyle={[styles.contentContainer, contentContainerStyle]}
      showsVerticalScrollIndicator={false}
      // Performance optimizations
      removeClippedSubviews={true}
      maxToRenderPerBatch={5}
      windowSize={10}
      initialNumToRender={3}
      // Loading indicator at bottom
      ListFooterComponent={
        loading && videos.length > 0 ? (
          <View style={styles.footer}>
            <ActivityIndicator color={colors.primary} size="small" />
          </View>
        ) : null
      }
    />
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  contentContainer: {
    paddingBottom: spacing.xl,
  },
  footer: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
})

const skeletonStyles = StyleSheet.create({
  container: {
    marginBottom: spacing.xl,
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    borderRadius: radius.card,
  },
  infoRow: {
    flexDirection: 'row',
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    marginRight: spacing.md,
  },
  textContainer: {
    flex: 1,
  },
  titleLine1: {
    height: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    marginBottom: 6,
    width: '90%',
  },
  titleLine2: {
    height: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
    width: '60%',
  },
  metaLine: {
    height: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    width: '40%',
  },
})

const loadingStyles = StyleSheet.create({
  container: {
    paddingTop: 8,
  },
})

export default VideoFeed
