import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { GlassCard } from '@/components/primitives'
import { colors } from '@/lib/colors'
import { formatBytes } from '@/lib/formatters'
import type { DownloadItem, DownloadStatus } from '@/lib/DownloadsContext'

function statusIcon(status: DownloadStatus): { name: keyof typeof Feather.glyphMap; color: string } {
  switch (status) {
    case 'complete': return { name: 'check-circle', color: colors.primary }
    case 'error': return { name: 'alert-circle', color: colors.error }
    case 'cancelled': return { name: 'x', color: colors.textMuted }
    case 'queued': return { name: 'clock', color: colors.textMuted }
    default: return { name: 'download', color: colors.swarm }
  }
}

function statusText(item: DownloadItem): string {
  switch (item.status) {
    case 'downloading': return `${item.progress}% · ${item.speed}`
    case 'queued': return 'Waiting…'
    case 'complete': return `${formatBytes(item.totalBytes)} · Saved`
    case 'error': return item.error || 'Failed'
    case 'cancelled': return 'Cancelled'
    default: return ''
  }
}

interface DownloadRowProps {
  item: DownloadItem
  onCancel: () => void
  onRemove: () => void
  onRetry: () => void
}

export function DownloadRow({ item, onCancel, onRemove, onRetry }: DownloadRowProps) {
  const isActive = item.status === 'downloading' || item.status === 'queued'
  const isError = item.status === 'error'
  const icon = statusIcon(item.status)

  return (
    <GlassCard padded={false} style={styles.card}>
      <View style={styles.row}>
        <View style={styles.thumb}>
          {item.thumbnail ? (
            <Image source={{ uri: item.thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <Feather name="film" size={18} color={colors.textMuted} />
          )}
        </View>
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
          <View style={styles.statusRow}>
            <Feather name={icon.name} size={13} color={icon.color} />
            <Text style={styles.status} numberOfLines={1}>{statusText(item)}</Text>
          </View>
          {isActive && (
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(100, item.progress)}%` }]} />
            </View>
          )}
        </View>
        <Pressable
          onPress={isActive ? onCancel : isError ? onRetry : onRemove}
          hitSlop={8}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel={isActive ? 'Cancel download' : isError ? 'Retry download' : 'Remove download'}
        >
          <Feather
            name={isActive ? 'x' : isError ? 'refresh-cw' : 'trash-2'}
            size={17}
            color={isError ? colors.primary : colors.textMuted}
          />
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
    width: 84,
    height: 47,
    borderRadius: 8,
    backgroundColor: colors.bgActive,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  info: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  status: {
    color: colors.textMuted,
    fontSize: 12,
    flexShrink: 1,
  },
  track: {
    height: 3,
    backgroundColor: colors.surface,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 8,
  },
  fill: {
    height: '100%',
    backgroundColor: colors.swarm,
    borderRadius: 2,
  },
  action: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
})
