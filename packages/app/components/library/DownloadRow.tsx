import { Image, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { IconButton } from '@/components/primitives'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { formatBytes } from '@/lib/formatters'
import type { DownloadItem, DownloadStatus } from '@/lib/DownloadsContext'

function statusIcon(status: DownloadStatus): { name: keyof typeof Feather.glyphMap; color: string } {
  switch (status) {
    case 'complete': return { name: 'check-circle', color: colors.success }
    case 'error': return { name: 'alert-circle', color: colors.error }
    case 'cancelled': return { name: 'x', color: colors.textMuted }
    case 'queued': return { name: 'clock', color: colors.textMuted }
    default: return { name: 'download', color: colors.swarm }
  }
}

function statusText(item: DownloadItem): string {
  switch (item.status) {
    case 'downloading': {
      const received = formatBytes(Math.round((item.progress / 100) * (item.totalBytes || 0)))
      const total = formatBytes(item.totalBytes || 0)
      if (item.totalBytes > 0) return `${item.progress}% · ${received} / ${total}`
      return `${item.progress}% · ${item.speed}`
    }
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
          <Feather name={icon.name} size={12} color={icon.color} />
          <Text style={styles.status} numberOfLines={1}>{statusText(item)}</Text>
        </View>
        {isActive && (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.min(100, item.progress)}%` }]} />
          </View>
        )}
      </View>
      <IconButton
        icon={isActive ? 'x' : isError ? 'refresh-cw' : 'trash-2'}
        onPress={isActive ? onCancel : isError ? onRetry : onRemove}
        accessibilityLabel={isActive ? 'Cancel download' : isError ? 'Retry download' : 'Remove download'}
        variant="plain"
        size={36}
        active={isError}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 3,
  },
  status: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    flexShrink: 1,
  },
  track: {
    height: borderWidth.rule,
    backgroundColor: colors.bgActive,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  fill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
})
