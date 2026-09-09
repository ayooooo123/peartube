import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { ArchiveOperatorStatus } from '@/lib/storage-operability.js'
import ArchiveOperatorDiagnostics from './ArchiveOperatorDiagnostics'
import type { SeedingStatus, StorageStats, SwarmStatus } from './types'

interface DiagnosticsPanelProps {
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  operatorStatus: ArchiveOperatorStatus | null
  loading?: boolean
  onRefresh?: () => void
}

export default function DiagnosticsPanel({
  swarmStatus,
  storageStats,
  seedingStatus,
  operatorStatus,
}: DiagnosticsPanelProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Native diagnostics</Text>
      <Text style={styles.text}>P2P: {swarmStatus?.swarmConnections ?? swarmStatus?.peerCount ?? 0} connections</Text>
      <Text style={styles.text}>
        Cache: {storageStats ? `${storageStats.usedGB} GB used of ${storageStats.maxGB} GB` : 'loading...'}
      </Text>
      <Text style={styles.text}>
        Seeding: {seedingStatus?.status?.enabled ? 'enabled' : 'disabled'}
      </Text>
      <ArchiveOperatorDiagnostics operatorStatus={operatorStatus} />
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  title: {
    ...fonts.title.md,
    fontSize: 14,
    lineHeight: 18,
    color: colors.text,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  text: {
    ...fonts.meta.sm,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
})
