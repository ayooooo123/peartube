import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'

type NetworkStatusTone = 'live' | 'ready' | 'offline' | 'neutral'

export interface NetworkStatusPillProps {
  peers?: number | null
  label?: string
  tone?: NetworkStatusTone
}

function getStatusLabel(peers?: number | null, label?: string, tone: NetworkStatusTone = 'live'): string {
  if (label) return label
  if (typeof peers === 'number' && peers > 0) return `${peers} peers`
  if (tone === 'ready') return 'ready to play'
  if (tone === 'offline') return 'offline ready'
  return 'live from swarm'
}

function getToneStyle(tone: NetworkStatusTone) {
  if (tone === 'ready') return styles.ready
  if (tone === 'offline') return styles.offline
  if (tone === 'neutral') return styles.neutral
  return styles.live
}

function NetworkStatusPillComponent({ peers, label, tone = 'live' }: NetworkStatusPillProps) {
  const statusLabel = getStatusLabel(peers, label, tone)

  return (
    <View style={[styles.pill, getToneStyle(tone)]} accessibilityLabel={statusLabel}>
      <Ionicons name={tone === 'offline' ? 'cloud-offline' : 'radio'} size={12} color={tone === 'offline' ? colors.textMuted : colors.swarm} />
      <Text style={styles.text} numberOfLines={1}>{statusLabel}</Text>
    </View>
  )
}

export const NetworkStatusPill = memo(NetworkStatusPillComponent)

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  live: {
    backgroundColor: colors.swarmDim,
    borderColor: 'rgba(45, 212, 191, 0.24)',
  },
  ready: {
    backgroundColor: colors.primaryLight,
    borderColor: 'rgba(123, 91, 245, 0.24)',
  },
  offline: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceBorder,
  },
  neutral: {
    backgroundColor: colors.glass,
    borderColor: colors.glassBorder,
  },
  text: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
})
