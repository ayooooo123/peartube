import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import { colors, spacing, borderWidth } from '@/lib/colors'
import { Meta } from '@/components/primitives'

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

function getToneMeta(tone: NetworkStatusTone = 'live'): 'default' | 'accent' | 'swarm' | 'muted' {
  if (tone === 'ready') return 'accent'
  if (tone === 'offline') return 'muted'
  if (tone === 'neutral') return 'muted'
  return 'swarm'
}

function NetworkStatusPillComponent({ peers, label, tone = 'live' }: NetworkStatusPillProps) {
  const statusLabel = getStatusLabel(peers, label, tone)
  const metaTone = getToneMeta(tone)

  return (
    <View style={[styles.pill, getToneStyle(tone)]} accessibilityLabel={statusLabel}>
      <Meta tone={metaTone}>{statusLabel}</Meta>
    </View>
  )
}

export const NetworkStatusPill = memo(NetworkStatusPillComponent)

function getToneStyle(tone: NetworkStatusTone) {
  const toneStyles: Record<NetworkStatusTone, any> = {
    live: { borderColor: colors.swarm, backgroundColor: colors.surface },
    ready: { borderColor: colors.primary, backgroundColor: colors.surface },
    offline: { borderColor: colors.borderSubtle, backgroundColor: colors.surface },
    neutral: { borderColor: colors.borderSubtle, backgroundColor: colors.surface },
  }
  return toneStyles[tone]
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 0,
    borderWidth: borderWidth.hairline,
  },
})
