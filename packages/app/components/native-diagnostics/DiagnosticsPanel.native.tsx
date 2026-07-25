import React, { useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import type { ArchiveOperatorStatus } from '@/lib/storage-operability.js'
import ArchiveOperatorDiagnostics from './ArchiveOperatorDiagnostics'
import type {
  ScopedNetworkDiagnostics,
  ScopedNetworkSession,
  ScopedNetworkTopic,
  SeedingStatus,
  StorageStats,
  SwarmStatus,
} from './types'

interface DiagnosticsPanelProps {
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  operatorStatus: ArchiveOperatorStatus | null
  loading?: boolean
  onRefresh?: () => void
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{String(value)}</Text>
    </View>
  )
}

function isScopedTopic(value: unknown): value is ScopedNetworkTopic {
  return Boolean(
    value
    && typeof value === 'object'
    && 'purpose' in value
    && typeof value.purpose === 'string'
    && 'topicHex' in value
    && typeof value.topicHex === 'string'
    && 'scopeId' in value
    && typeof value.scopeId === 'string'
    && 'modes' in value
    && Array.isArray(value.modes)
    && 'sessions' in value
    && typeof value.sessions === 'number',
  )
}

function isScopedSession(value: unknown): value is ScopedNetworkSession {
  return Boolean(
    value
    && typeof value === 'object'
    && 'peerId' in value
    && typeof value.peerId === 'string'
    && 'purpose' in value
    && typeof value.purpose === 'string'
    && 'topicHex' in value
    && typeof value.topicHex === 'string'
    && 'state' in value
    && typeof value.state === 'string',
  )
}

function parseScopedDiagnostics(raw: string | null | undefined): ScopedNetworkDiagnostics | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const topics = 'topics' in value && Array.isArray(value.topics) ? value.topics.filter(isScopedTopic) : []
    const sessions = 'sessions' in value && Array.isArray(value.sessions) ? value.sessions.filter(isScopedSession) : []
    return {
      status: 'status' in value && typeof value.status === 'string' ? value.status : undefined,
      protocolMajor: 'protocolMajor' in value && typeof value.protocolMajor === 'number' ? value.protocolMajor : undefined,
      networkId: 'networkId' in value && typeof value.networkId === 'string' ? value.networkId : undefined,
      topics,
      sessions,
    }
  } catch {
    return null
  }
}

export default function DiagnosticsPanel({
  swarmStatus,
  storageStats,
  seedingStatus,
  operatorStatus,
  loading,
  onRefresh,
}: DiagnosticsPanelProps) {
  const cacheRatio = useMemo(() => {
    if (!storageStats?.maxBytes) return 0
    return Math.max(0, Math.min(1, storageStats.usedBytes / storageStats.maxBytes))
  }, [storageStats])
  const network = useMemo(
    () => swarmStatus?.network || parseScopedDiagnostics(swarmStatus?.networkJson),
    [swarmStatus],
  )
  const topics = network?.topics || []
  const sessions = network?.sessions || []
  const p2pLabel = swarmStatus?.swarmOffline
    ? 'Network paused'
    : swarmStatus?.connected
      ? 'Connected to peers'
      : 'Searching for peers'

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Network diagnostics</Text>
          <Text style={styles.sectionSubtitle}>Scoped P2P sessions, cache meters, and archive state.</Text>
        </View>
        {onRefresh ? (
          <Pressable onPress={onRefresh} disabled={loading} style={styles.refreshButton} accessibilityRole="button" accessibilityLabel="Refresh diagnostics">
            {loading ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.refreshText}>Refresh</Text>}
          </Pressable>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>P2P status</Text>
        <Text style={styles.statusText}>{p2pLabel}</Text>
        <View style={styles.metricRow}>
          <Metric label="Connections" value={swarmStatus?.swarmConnections ?? swarmStatus?.peerCount ?? 0} />
          <Metric label="Scoped topics" value={topics.length} />
          <Metric label="Scoped sessions" value={sessions.length} />
        </View>
        <Text style={styles.detailText}>
          {swarmStatus?.swarmListenResolved ? 'Listening socket resolved' : 'Listening socket pending'}
          {swarmStatus?.peerPoolJoined ? ' • peer pool joined' : ''}
        </Text>
        {swarmStatus?.swarmOfflineReason ? <Text style={styles.detailText}>Pause reason: {swarmStatus.swarmOfflineReason}</Text> : null}
        {swarmStatus?.recommendedBoundary ? <Text style={styles.boundaryText}>Boundary: {swarmStatus.recommendedBoundary}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cache meter</Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(cacheRatio * 100)}%` }]} />
        </View>
        <Text style={styles.detailText}>
          {storageStats ? `${storageStats.usedGB} GB used of ${storageStats.maxGB} GB` : 'Loading cache stats…'}
        </Text>
        <Text style={styles.detailText}>
          {storageStats ? `${storageStats.seedCount} cached videos • ${storageStats.pinnedCount} pinned channels` : 'Loading cache stats…'}
        </Text>
        {seedingStatus?.status ? (
          <Text style={styles.detailText}>
            Seeding: {seedingStatus.status.enabled ? 'enabled' : 'disabled'} • {seedingStatus.status.seedingCount ?? 0} active seeds
          </Text>
        ) : null}
      </View>

      <ArchiveOperatorDiagnostics operatorStatus={operatorStatus} />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Scoped network</Text>
        <View style={styles.metricRow}>
          <Metric label="Status" value={network?.status || 'starting'} />
          <Metric label="Protocol" value={network?.protocolMajor ?? '—'} />
          <Metric label="Peers" value={swarmStatus?.swarmPeers ?? 0} />
        </View>
        <Text style={styles.detailText}>Network: {network?.networkId || 'default'}</Text>
        <Text style={styles.detailText}>
          Active purposes: {topics.length > 0 ? [...new Set(topics.map((topic) => topic.purpose))].sort().join(', ') : 'none'}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  sectionSubtitle: { marginTop: 2, fontSize: 12, color: colors.textMuted },
  refreshButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, minWidth: 72, alignItems: 'center' },
  refreshText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  card: { backgroundColor: colors.bg, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.glassBorder, gap: 8 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  statusText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  metricRow: { flexDirection: 'row', gap: 12 },
  metric: { flex: 1, minWidth: 0 },
  metricLabel: { fontSize: 11, color: colors.textMuted },
  metricValue: { marginTop: 2, fontSize: 16, fontWeight: '700', color: colors.text },
  detailText: { fontSize: 12, color: colors.textMuted },
  boundaryText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  track: { height: 8, borderRadius: 999, backgroundColor: colors.glass, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 999, backgroundColor: colors.swarm },
})
