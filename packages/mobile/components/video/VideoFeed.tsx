/**
 * VideoFeed - YouTube-style vertical scrolling video feed
 * Uses FlatList for performance with pull-to-refresh and empty state
 */
import { FlatList, View, Text, RefreshControl, StyleSheet, ActivityIndicator } from 'react-native'
import { VideoCard, VideoData } from './VideoCard'

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
    <View style={emptyStyles.container}>
      <Text style={emptyStyles.emoji}>📺</Text>
      <Text style={emptyStyles.title}>No videos yet</Text>
      <Text style={emptyStyles.message}>{message}</Text>
    </View>
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
            tintColor="#9147ff"
            colors={['#9147ff']}
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
            <ActivityIndicator color="#9147ff" size="small" />
          </View>
        ) : null
      }
    />
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0e0e10',
  },
  contentContainer: {
    paddingBottom: 20,
  },
  footer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
})

const skeletonStyles = StyleSheet.create({
  container: {
    marginBottom: 24,
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#1f1f23',
    borderRadius: 12,
  },
  infoRow: {
    flexDirection: 'row',
    marginTop: 12,
    paddingHorizontal: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1f1f23',
    marginRight: 12,
  },
  textContainer: {
    flex: 1,
  },
  titleLine1: {
    height: 14,
    backgroundColor: '#1f1f23',
    borderRadius: 4,
    marginBottom: 6,
    width: '90%',
  },
  titleLine2: {
    height: 14,
    backgroundColor: '#1f1f23',
    borderRadius: 4,
    marginBottom: 8,
    width: '60%',
  },
  metaLine: {
    height: 12,
    backgroundColor: '#1f1f23',
    borderRadius: 4,
    width: '40%',
  },
})

const emptyStyles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingTop: 60,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    color: '#efeff1',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    color: '#adadb8',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
})

const loadingStyles = StyleSheet.create({
  container: {
    paddingTop: 8,
  },
})

export default VideoFeed
