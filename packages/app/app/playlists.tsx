/**
 * Playlists — user-curated, synced across the user's own devices via the
 * private personal store (encrypted at rest). Also surfaces "Continue watching"
 * from synced resume positions.
 */
import { useCallback, useState } from 'react'
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import { useApp, colors } from './_layout'
import { EmptyState } from '@/components/primitives'
import { fonts } from '@/lib/typography'

type Playlist = { id: string; name?: string; description?: string; createdAt?: number; updatedAt?: number }
type ResumeEntry = { videoKey: string; channelKey?: string; videoId?: string; position?: number; duration?: number }

export default function PlaylistsScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { rpc } = useApp()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [resume, setResume] = useState<ResumeEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    if (!rpc) return
    try {
      const res = await rpc.getPlaylists()
      setPlaylists(res?.playlists || [])
    } catch (err) {
      console.error('[Playlists] load failed:', err)
    }
    try {
      const res = await rpc.listResumePositions()
      setResume((res?.entries || []).filter((e: ResumeEntry) => (e.position || 0) > 0))
    } catch {
      // resume is supplementary — ignore
    }
  }, [rpc])

  useFocusEffect(useCallback(() => { load() }, [load]))

  const createPlaylist = useCallback(async () => {
    const name = newName.trim()
    if (!name || !rpc) return
    try {
      await rpc.createPlaylist({ name })
      setNewName('')
      setCreating(false)
      await load()
    } catch (err: any) {
      Alert.alert('Could not create playlist', err?.message || 'Please try again.')
    }
  }, [newName, rpc, load])

  const deletePlaylist = useCallback((pl: Playlist) => {
    const doDelete = async () => {
      try {
        await rpc.deletePlaylist(pl.id)
        await load()
      } catch (err: any) {
        Alert.alert('Could not delete playlist', err?.message || 'Please try again.')
      }
    }
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Delete "${pl.name || 'playlist'}"?`)) doDelete()
      return
    }
    Alert.alert('Delete playlist', `Delete "${pl.name || 'playlist'}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: doDelete },
    ])
  }, [rpc, load])

  return (
    <View style={[styles.container, { paddingTop: insets.top ? insets.top + 8 : 16 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.headerButton} accessibilityLabel="Back">
          <Feather name="chevron-left" color={colors.text} size={22} />
        </Pressable>
        <Text style={styles.headerTitle}>Playlists</Text>
        <Pressable onPress={() => setCreating((v) => !v)} hitSlop={8} style={styles.headerButton} accessibilityLabel="New playlist">
          <Feather name={creating ? 'x' : 'plus'} color={colors.text} size={22} />
        </Pressable>
      </View>

      {creating && (
        <View style={styles.createRow}>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Playlist name"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={createPlaylist}
          />
          <Pressable onPress={createPlaylist} style={styles.createButton} accessibilityLabel="Create">
            <Text style={styles.createButtonText}>Create</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        data={playlists}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        ListHeaderComponent={
          resume.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Continue watching</Text>
              <Text style={styles.sectionHint}>{resume.length} in progress · synced across your devices</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon="list"
            title="No playlists yet"
            body="Tap + to create your first playlist. Playlists sync privately across your devices."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: item.id, name: item.name || 'Playlist' } })}
          >
            <View style={styles.rowIcon}>
              <Feather name="list" color={colors.primary} size={18} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.name || 'Untitled playlist'}</Text>
              {!!item.description && <Text style={styles.rowSubtitle} numberOfLines={1}>{item.description}</Text>}
            </View>
            <Pressable onPress={() => deletePlaylist(item)} hitSlop={8} style={styles.rowAction} accessibilityLabel="Delete playlist">
              <Feather name="trash-2" color={colors.textMuted} size={18} />
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
  headerButton: { padding: 6, borderRadius: 999 },
  headerTitle: { color: colors.text, fontSize: 20, fontFamily: fonts.heading },
  createRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  input: { flex: 1, backgroundColor: colors.surface, color: colors.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  createButton: { backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center' },
  createButtonText: { color: colors.bg, fontFamily: fonts.heading },
  section: { paddingVertical: 12 },
  sectionTitle: { color: colors.text, fontSize: 16, fontFamily: fonts.heading },
  sectionHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: colors.text, fontSize: 15, fontFamily: fonts.headingMedium },
  rowSubtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  rowAction: { padding: 6 },
})
