import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { IconButton } from '@/components/primitives'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { WatchHistoryEntry } from '@/lib/watch-history'

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

interface HistoryRowProps {
  entry: WatchHistoryEntry
  onOpen: () => void
  onRemove: () => void
}

export function HistoryRow({ entry, onOpen, onRemove }: HistoryRowProps) {
  const ratio = entry.durationSec > 0 ? Math.min(1, entry.positionSec / entry.durationSec) : 0
  const meta = entry.completed
    ? 'WATCHED'
    : `RESUME ${formatClock(entry.positionSec)}`

  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Resume ${entry.title}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
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
          {entry.channelName ? `${entry.channelName} · ` : ''}{meta}
        </Text>
      </View>
      <IconButton
        icon="x"
        onPress={onRemove}
        accessibilityLabel="Remove from history"
        variant="plain"
        size={36}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  thumb: {
    width: 96,
    height: 54,
    borderRadius: radius.md,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: borderWidth.rule,
    backgroundColor: colors.scrim,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  info: {
    flex: 1,
  },
  title: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  meta: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    marginTop: 3,
  },
})
