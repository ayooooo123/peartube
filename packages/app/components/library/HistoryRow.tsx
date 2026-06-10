import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { GlassCard } from '@/components/primitives'
import { colors } from '@/lib/colors'
import type { WatchHistoryEntry } from '@/lib/watch-history'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

interface HistoryRowProps {
  entry: WatchHistoryEntry
  onOpen: () => void
  onRemove: () => void
}

export function HistoryRow({ entry, onOpen, onRemove }: HistoryRowProps) {
  const ratio = entry.durationSec > 0 ? Math.min(1, entry.positionSec / entry.durationSec) : 0

  return (
    <GlassCard padded={false} style={styles.card} onPress={onOpen} accessibilityLabel={`Resume ${entry.title}`}>
      <View style={styles.row}>
        <View style={styles.thumb}>
          {entry.thumbnailUrl ? (
            <Image source={{ uri: entry.thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <Feather name="play" size={18} color={colors.textMuted} />
          )}
          {ratio > 0 && !entry.completed && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
            </View>
          )}
        </View>
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={2}>{entry.title}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {entry.channelName ? `${entry.channelName} · ` : ''}
            {entry.completed ? 'Watched' : `${Math.round(ratio * 100)}% watched`} · {timeAgo(entry.updatedAt)}
          </Text>
        </View>
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel="Remove from history"
        >
          <Feather name="x" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  thumb: {
    width: 96,
    height: 54,
    borderRadius: 8,
    backgroundColor: colors.bgActive,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  info: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 19,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  action: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
})
