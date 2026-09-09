/**
 * Library Tab — Channels you follow, downloads, and watch history.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, FlatList, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { CastHeaderButton } from '@/components/cast'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { useDownloads, type DownloadItem } from '@/lib/DownloadsContext'
import { useVideoPlayerActions } from '@/lib/VideoPlayerContext'
import { Chip, Divider, EmptyState, IconButton, Panel, ScreenHeader } from '@/components/primitives'
import { ChannelRow, DownloadRow, HistoryRow, SubscribeSheet, type SubscriptionItem } from '@/components/library'
import { fonts } from '@/lib/typography'
import { spacing, radius, borderWidth } from '@/lib/colors'
import * as watchHistory from '@/lib/watch-history'
import * as haptics from '@/lib/haptics'
import { resumeWatchEntry } from '@/lib/playback-resume'

type LibraryTab = 'channels' | 'downloads' | 'history'

const TAB_LABELS: Array<{ id: LibraryTab; label: string; icon: 'users' | 'download' | 'clock' }> = [
  { id: 'channels', label: 'Channels', icon: 'users' },
  { id: 'downloads', label: 'Downloads', icon: 'download' },
  { id: 'history', label: 'History', icon: 'clock' },
]

function confirmDestructive(title: string, message: string, confirmLabel: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm()
    return
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ])
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const params = useLocalSearchParams<{ tab?: string }>()
  const { rpc, identity } = useApp()
  const { downloads, activeCount, cancelDownload, removeDownload, clearCompleted } = useDownloads()
  const { loadAndPlayVideo, seekTo } = useVideoPlayerActions()
  const tabBarMetrics = useTabBarMetrics()
  const bottomPadding = Math.max(tabBarMetrics.height + 16, insets.bottom + 16)

  const initialTab: LibraryTab =
    params.tab === 'downloads' ? 'downloads' : params.tab === 'history' ? 'history' : 'channels'
  const [tab, setTab] = useState<LibraryTab>(initialTab)

  const [subscriptions, setSubscriptions] = useState<SubscriptionItem[]>([])
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const [history, setHistory] = useState<watchHistory.WatchHistoryEntry[]>([])

  const loadSubscriptions = useCallback(async () => {
    if (!rpc) return
    try {
      const result = await rpc.getSubscriptions({})
      setSubscriptions(result?.subscriptions || [])
    } catch (err) {
      console.error('[Library] Failed to load subscriptions:', err)
    }
    try {
      const pinned = await rpc.getPinnedChannels?.()
      if (Array.isArray(pinned?.channels)) setPinnedKeys(new Set(pinned.channels))
    } catch {
      // pin status is decorative — ignore
    }
  }, [rpc])

  const loadHistory = useCallback(async () => {
    setHistory(await watchHistory.getHistory())
  }, [])

  useEffect(() => {
    loadSubscriptions()
  }, [loadSubscriptions])

  useFocusEffect(
    useCallback(() => {
      loadHistory()
    }, [loadHistory])
  )

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([loadSubscriptions(), loadHistory()])
    setRefreshing(false)
  }, [loadSubscriptions, loadHistory])

  const unsubscribe = useCallback((key: string) => {
    if (!rpc) return
    confirmDestructive('Unsubscribe', 'Stop following this channel?', 'Unsubscribe', async () => {
      try {
        await rpc.unsubscribeChannel({ channelKey: key })
        await loadSubscriptions()
      } catch (err) {
        console.error('[Library] Unsubscribe failed:', err)
      }
    })
  }, [rpc, loadSubscriptions])

  const togglePin = useCallback(async (key: string) => {
    if (!rpc) return
    const isPinned = pinnedKeys.has(key)
    // Optimistic flip; reload corrects on failure.
    setPinnedKeys((prev) => {
      const next = new Set(prev)
      if (isPinned) next.delete(key)
      else next.add(key)
      return next
    })
    try {
      if (isPinned) await rpc.unpinChannel?.({ channelKey: key })
      else {
        await rpc.pinChannel?.({ channelKey: key })
        haptics.success()
      }
    } catch (err) {
      console.error('[Library] Pin toggle failed:', err)
      await loadSubscriptions()
    }
  }, [rpc, pinnedKeys, loadSubscriptions])

  const retrySync = useCallback(async (key: string) => {
    try {
      await rpc?.retrySyncChannel?.({ channelKey: key })
    } catch (err) {
      console.error('[Library] Retry sync failed:', err)
    }
  }, [rpc])

  const resumeFromHistory = useCallback((entry: watchHistory.WatchHistoryEntry) => {
    void resumeWatchEntry(entry, { rpc, loadAndPlayVideo, seekTo })
  }, [rpc, loadAndPlayVideo, seekTo])

  const removeHistoryEntry = useCallback(async (entry: watchHistory.WatchHistoryEntry) => {
    await watchHistory.removeEntry(entry.channelKey, entry.videoId)
    await loadHistory()
  }, [loadHistory])

  const clearAllHistory = useCallback(() => {
    confirmDestructive('Clear history', 'Remove all watch history? This only affects this device.', 'Clear', async () => {
      await watchHistory.clearHistory()
      await loadHistory()
    })
  }, [loadHistory])

  const tabCount = (id: LibraryTab): number | undefined => {
    if (id === 'channels') return subscriptions.length
    if (id === 'downloads') return activeCount > 0 ? activeCount : (downloads.length || undefined)
    if (id === 'history') return history.length || undefined
    return undefined
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Library"
        eyebrow="LOCAL / PERSONAL"
        right={
          <>
            <CastHeaderButton size={18} />
            <IconButton
              icon="search"
              onPress={() => router.push('/search')}
              accessibilityLabel="Search"
              variant="plain"
              size={36}
            />
            <IconButton
              icon="list"
              onPress={() => router.push('/playlists')}
              accessibilityLabel="Playlists"
              variant="plain"
              size={36}
            />
            <Pressable
              onPress={() => router.push('/profile')}
              hitSlop={8}
              style={styles.avatarButton}
              accessibilityRole="button"
              accessibilityLabel="Profile"
            >
              <Text style={styles.avatarLetter}>{identity?.name?.charAt(0)?.toUpperCase() || '•'}</Text>
            </Pressable>
          </>
        }
      />

      <View style={styles.chips}>
        {TAB_LABELS.map((t) => (
          <Chip
            key={t.id}
            label={t.label}
            icon={t.icon}
            count={tabCount(t.id)}
            selected={tab === t.id}
            onPress={() => {
              if (tab !== t.id) haptics.tabSwitch()
              setTab(t.id)
            }}
          />
        ))}
      </View>

      {tab === 'channels' && (
        <View style={styles.tabBody}>
          <SubscribeSheet rpc={rpc} onSubscribed={loadSubscriptions} />
          <Panel padded={false} style={[styles.listPanel, { marginBottom: bottomPadding }]}>
            <FlatList
              data={subscriptions}
              keyExtractor={(item) => item.channelKey}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
              contentContainerStyle={subscriptions.length === 0 ? styles.emptyGrow : undefined}
              ListEmptyComponent={
                <EmptyState
                  icon="users"
                  title="No channels yet"
                  body="Paste a channel key above, or find creators on the Discover tab."
                />
              }
              ItemSeparatorComponent={() => <Divider />}
              renderItem={({ item }) => (
                <ChannelRow
                  item={item}
                  pinned={pinnedKeys.has(item.channelKey)}
                  onOpen={() =>
                    router.push({
                      pathname: '/channel/[key]',
                      params: { key: item.channelKey, publicBeeKey: item.publicBeeKey || undefined },
                    })
                  }
                  onUnsubscribe={() => unsubscribe(item.channelKey)}
                  onTogglePin={() => togglePin(item.channelKey)}
                  onRetrySync={() => retrySync(item.channelKey)}
                />
              )}
            />
          </Panel>
        </View>
      )}

      {tab === 'downloads' && (
        <DownloadsTab
          downloads={downloads}
          bottomPadding={bottomPadding}
          onCancel={cancelDownload}
          onRemove={removeDownload}
          onClearCompleted={clearCompleted}
        />
      )}

      {tab === 'history' && (
        <View style={[styles.tabBody, { paddingHorizontal: spacing.lg }]}>
          {history.length > 0 ? (
            <Pressable onPress={clearAllHistory} style={({ pressed }) => [styles.clearRow, pressed && { opacity: 0.6 }]}>
              <Feather name="trash-2" size={13} color={colors.textMuted} />
              <Text style={styles.clearLabel}>Clear history</Text>
            </Pressable>
          ) : null}
          <Panel padded={false} style={[styles.listPanelFlush, { marginBottom: bottomPadding }]}>
            <FlatList
              data={history}
              keyExtractor={(item) => `${item.channelKey}:${item.videoId}`}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
              contentContainerStyle={history.length === 0 ? styles.emptyGrow : undefined}
              ListEmptyComponent={
                <EmptyState
                  icon="clock"
                  title="Nothing watched yet"
                  body="Videos you watch show up here so you can pick up where you left off."
                />
              }
              ItemSeparatorComponent={() => <Divider />}
              renderItem={({ item }) => (
                <HistoryRow entry={item} onOpen={() => resumeFromHistory(item)} onRemove={() => removeHistoryEntry(item)} />
              )}
            />
          </Panel>
        </View>
      )}
    </View>
  )
}

interface DownloadsTabProps {
  downloads: DownloadItem[]
  bottomPadding: number
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onClearCompleted: () => void
}

function DownloadsTab({ downloads, bottomPadding, onCancel, onRemove, onClearCompleted }: DownloadsTabProps) {
  const hasFinishedDownloads = downloads.some((d) => d.status === 'complete' || d.status === 'cancelled' || d.status === 'error')
  const activeDownloads = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued')
  const completedDownloads = downloads.filter((d) => d.status === 'complete')
  const failedDownloads = downloads.filter((d) => d.status === 'error' || d.status === 'cancelled')

  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: bottomPadding, flexGrow: 1 }}
    >
      {downloads.length === 0 ? (
        <EmptyState
          icon="download"
          title="No downloads yet"
          body="Videos you save for offline viewing will appear here."
        />
      ) : (
        <>
          {hasFinishedDownloads && (
            <Pressable onPress={onClearCompleted} style={({ pressed }) => [styles.clearRow, pressed && { opacity: 0.6 }]}>
              <Feather name="trash-2" size={13} color={colors.textMuted} />
              <Text style={styles.clearLabel}>Clear finished</Text>
            </Pressable>
          )}
          <Panel padded={false}>
            {activeDownloads.length > 0 && <Text style={styles.sectionLabel}>Active</Text>}
            {activeDownloads.map((item, index) => (
              <View key={item.id}>
                {index > 0 ? <Divider /> : null}
                <DownloadRow item={item} onCancel={() => onCancel(item.id)} onRemove={() => onRemove(item.id)} onRetry={() => {}} />
              </View>
            ))}
            {completedDownloads.length > 0 && (
              <>
                {activeDownloads.length > 0 ? <Divider weight="rule" /> : null}
                <Text style={styles.sectionLabel}>Saved</Text>
              </>
            )}
            {completedDownloads.map((item, index) => (
              <View key={item.id}>
                {index > 0 ? <Divider /> : null}
                <DownloadRow item={item} onCancel={() => onCancel(item.id)} onRemove={() => onRemove(item.id)} onRetry={() => {}} />
              </View>
            ))}
            {failedDownloads.length > 0 && (
              <>
                {(activeDownloads.length > 0 || completedDownloads.length > 0) ? <Divider weight="rule" /> : null}
                <Text style={styles.sectionLabel}>Didn't finish</Text>
              </>
            )}
            {failedDownloads.map((item, index) => (
              <View key={item.id}>
                {index > 0 ? <Divider /> : null}
                <DownloadRow item={item} onCancel={() => onCancel(item.id)} onRemove={() => onRemove(item.id)} onRetry={() => onRemove(item.id)} />
              </View>
            ))}
          </Panel>
        </>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  tabBody: {
    flex: 1,
  },
  emptyGrow: {
    flexGrow: 1,
  },
  avatarButton: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.text,
    fontSize: 13,
    fontFamily: fonts.heading,
  },
  chips: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    marginBottom: spacing.md,
  },
  listPanel: {
    flex: 1,
    marginHorizontal: spacing.lg,
  },
  listPanelFlush: {
    flex: 1,
  },
  sectionLabel: {
    ...fonts.caption.sm,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  clearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm - 2,
    alignSelf: 'flex-end',
    paddingVertical: spacing.sm - 2,
    marginBottom: spacing.xs,
  },
  clearLabel: {
    ...fonts.caption.sm,
    color: colors.textMuted,
  },
})
