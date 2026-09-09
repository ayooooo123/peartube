/**
 * Playlists — user-curated, synced across the user's own devices via the
 * private personal store (encrypted at rest). Also surfaces "Continue watching"
 * from synced resume positions.
 */
import { useCallback, useState } from 'react'
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, colors } from './_layout'
import { Button, Divider, EmptyState, IconButton, Panel, ScreenHeader, SectionHeader } from '@/components/primitives'
import { fonts } from '@/lib/typography'
import { radius, spacing, borderWidth } from '@/lib/colors'

type Playlist = { id: string; name?: string; description?: string; createdAt?: number; updatedAt?: number; itemCount: number }
type ResumeEntry = { videoKey: string; channelKey?: string; videoId?: string; position?: number; duration?: number }

export default function PlaylistsScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { rpc } = useApp()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [resume, setResume] = useState<ResumeEntry[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [nameFocused, setNameFocused] = useState(false)

  const load = useCallback(async () => {
    if (!rpc) return
    try {
      const res = await rpc.getPlaylists()
      const base = (res?.playlists || []) as Array<Omit<Playlist, 'itemCount'> & { itemCount?: number }>
      const withCounts = await Promise.all(
        base.map(async (pl) => {
          try {
            const itemsRes = await rpc.getPlaylistItems({ playlistId: pl.id })
            const count = Array.isArray(itemsRes?.items) ? itemsRes.items.length : 0
            return { ...pl, itemCount: count }
          } catch {
            return { ...pl, itemCount: 0 }
          }
        }),
      )
      setPlaylists(withCounts)
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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Playlists"
        eyebrow="PERSONAL / SYNCED"
        onBack={() => router.back()}
        right={
          <IconButton
            icon={creating ? 'x' : 'plus'}
            onPress={() => setCreating((v) => !v)}
            accessibilityLabel="New playlist"
            variant="plain"
            size={36}
          />
        }
      />

      {creating && (
        <View style={styles.createRow}>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Playlist name"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, nameFocused && styles.inputFocused]}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={createPlaylist}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
          />
          <Button label="Create" onPress={createPlaylist} size="md" accessibilityLabel="Create" />
        </View>
      )}

      <View style={styles.body}>
        {resume.length > 0 ? (
          <SectionHeader
            title="Continue watching"
            subtitle={`${resume.length} in progress · synced across your devices`}
          />
        ) : null}

        {playlists.length === 0 ? (
          <EmptyState
            icon="list"
            title="No playlists yet"
            body="Tap + to create your first playlist. Playlists sync privately across your devices."
          />
        ) : (
          <Panel padded={false} style={[styles.listPanel, { marginBottom: insets.bottom + 24 }]}>
            <FlatList
              data={playlists}
              keyExtractor={(item) => item.id}
              ItemSeparatorComponent={() => <Divider />}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                  onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: item.id, name: item.name || 'Playlist' } })}
                >
                  <View style={styles.stackGlyph}>
                    <View style={[styles.stackSquare, styles.stackBack]} />
                    <View style={[styles.stackSquare, styles.stackFront]} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{item.name || 'Untitled playlist'}</Text>
                    <Text style={styles.rowSubtitle} numberOfLines={1}>
                      {`${item.itemCount} ITEMS`}
                    </Text>
                  </View>
                  <IconButton
                    icon="trash-2"
                    onPress={() => deletePlaylist(item)}
                    accessibilityLabel="Delete playlist"
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
  createRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    ...fonts.meta.sm,
  },
  inputFocused: {
    borderColor: colors.borderFocus,
  },
  listPanel: {
    flex: 1,
    marginHorizontal: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  stackGlyph: {
    width: 40,
    height: 40,
    position: 'relative',
  },
  stackSquare: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.bgActive,
  },
  stackBack: {
    top: 2,
    left: 8,
    borderColor: colors.borderLight,
  },
  stackFront: {
    top: 10,
    left: 2,
    backgroundColor: colors.surface,
    borderColor: colors.primary,
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
