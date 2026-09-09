/**
 * Playlist detail — items in a playlist, synced via the private personal store.
 */
import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { Divider, EmptyState, IconButton, Panel, ScreenHeader } from '@/components/primitives'
import { fonts } from '@/lib/typography'
import { radius, spacing, borderWidth } from '@/lib/colors'

type Item = { playlistId: string; videoKey: string; channelKey?: string; videoId?: string; addedAt?: number }

export default function PlaylistDetailScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { rpc } = useApp()
  const params = useLocalSearchParams<{ id: string; name?: string }>()
  const playlistId = params.id

  const [items, setItems] = useState<Item[]>([])

  const load = useCallback(async () => {
    if (!rpc || !playlistId) return
    try {
      const res = await rpc.getPlaylistItems({ playlistId })
      setItems(res?.items || [])
    } catch (err) {
      console.error('[Playlist] load failed:', err)
    }
  }, [rpc, playlistId])

  useFocusEffect(useCallback(() => { load() }, [load]))

  const removeItem = useCallback(async (videoKey: string) => {
    try {
      await rpc.removeFromPlaylist({ playlistId, videoKey })
      await load()
    } catch (err) {
      console.error('[Playlist] remove failed:', err)
    }
  }, [rpc, playlistId, load])

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenHeader
        title={params.name || 'Playlist'}
        eyebrow="PLAYLIST"
        onBack={() => router.back()}
      />

      <View style={styles.body}>
        {items.length === 0 ? (
          <EmptyState
            icon="film"
            title="Empty playlist"
            body="Add videos to this playlist from any video's menu."
          />
        ) : (
          <Panel padded={false} style={[styles.listPanel, { marginBottom: insets.bottom + 24 }]}>
            <FlatList
              data={items}
              keyExtractor={(item) => item.videoKey}
              ItemSeparatorComponent={() => <Divider />}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                  onPress={() => {
                    if (!item.channelKey || !item.videoId) return
                    router.push({ pathname: '/channel/[key]', params: { key: item.channelKey } })
                  }}
                >
                  <View style={styles.rowIcon}>
                    <Feather name="film" color={colors.primary} size={18} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{item.videoId || item.videoKey}</Text>
                    {!!item.channelKey && <Text style={styles.rowSubtitle} numberOfLines={1}>{item.channelKey.slice(0, 16)}…</Text>}
                  </View>
                  <IconButton
                    icon="x"
                    onPress={() => removeItem(item.videoKey)}
                    accessibilityLabel="Remove from playlist"
                    variant="plain"
                    size={36}
                  />
                </Pressable>
              )}
            />
          </Panel>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  listPanel: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  rowSubtitle: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    marginTop: 2,
  },
})
