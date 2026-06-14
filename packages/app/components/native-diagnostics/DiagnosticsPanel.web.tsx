import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import type { SeedingStatus, StorageStats, SwarmStatus } from './types'

interface DiagnosticsPanelProps {
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  loading?: boolean
  onRefresh?: () => void
}

export default function DiagnosticsPanel({
  swarmStatus,
  storageStats,
  seedingStatus,
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
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 8,
  },
  text: {
    color: '#cbd5e1',
    marginBottom: 4,
  },
})
