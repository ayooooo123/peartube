/**
 * Playlist detail — items in a playlist, synced via the private personal store.
 */
import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from '../_layout'
import { EmptyState } from '@/components/primitives'
import { fonts } from '@/lib/typography'

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
    <View style={[styles.container, { paddingTop: insets.top ? insets.top + 8 : 16 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.headerButton} accessibilityLabel="Back">
          <Feather name="chevron-left" color={colors.text} size={22} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{params.name || 'Playlist'}</Text>
        <View style={styles.headerButton} />
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.videoKey}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        ListEmptyComponent={
          <EmptyState
            icon="film"
            title="Empty playlist"
            body="Add videos to this playlist from any video's menu."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
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
            <Pressable onPress={() => removeItem(item.videoKey)} hitSlop={8} style={styles.rowAction} accessibilityLabel="Remove from playlist">
              <Feather name="x" color={colors.textMuted} size={18} />
            </Pressable>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 12 },
  headerButton: { padding: 6, borderRadius: 999, minWidth: 34 },
  headerTitle: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 18, fontFamily: fonts.heading },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: colors.text, fontSize: 15, fontFamily: fonts.headingMedium },
  rowSubtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  rowAction: { padding: 6 },
})
