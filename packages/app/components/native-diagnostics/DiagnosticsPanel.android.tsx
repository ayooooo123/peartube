import React, { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import {
  Button,
  Column,
  Host,
  LinearProgressIndicator,
  Row,
  Text,
} from '@expo/ui/jetpack-compose'
import type { SeedingStatus, StorageStats, SwarmStatus } from './types'

interface DiagnosticsPanelProps {
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  loading?: boolean
  onRefresh?: () => void
}

function boolLabel(value?: boolean | null) {
  return value ? 'On' : 'Off'
}

export default function DiagnosticsPanel({
  swarmStatus,
  storageStats,
  seedingStatus,
  loading,
  onRefresh,
}: DiagnosticsPanelProps) {
  const cacheUsedBytes = storageStats?.totalStorageBytes ?? storageStats?.usedBytes ?? 0
  const cacheUsedGB = storageStats?.totalStorageGB ?? storageStats?.usedGB
  const trackedCacheGB = storageStats?.usedGB ?? '0.00'
  const cacheRatio = useMemo(() => {
    if (!storageStats?.maxBytes) return 0
    return Math.max(0, Math.min(1, cacheUsedBytes / storageStats.maxBytes))
  }, [cacheUsedBytes, storageStats])

  const p2pLabel = swarmStatus?.swarmOffline
    ? 'Network paused'
    : (Boolean(swarmStatus?.connected) || Number(swarmStatus?.swarmConnections ?? swarmStatus?.peerCount ?? 0) > 0)
      ? 'Connected to peers'
      : 'Searching for peers'

  const boundary = swarmStatus?.network?.recommendedBoundary
  const discoveryPeers = swarmStatus?.network?.discovery?.discoveredPeers ?? swarmStatus?.peerCount ?? 0
  const feedConnections = swarmStatus?.network?.feed?.feedConnections ?? swarmStatus?.feedConnections ?? 0
  const dht = swarmStatus?.network?.dht

  return (
    <Host style={styles.host}>
      <Column spacing={14} style={styles.root}>
        <Row alignment="center" spacing={12} style={styles.headerRow}>
          <Column spacing={4} style={styles.headerCopy}>
            <Text style={styles.sectionTitle}>Native diagnostics</Text>
            <Text style={styles.sectionSubtitle}>
              P2P status, cache meters, and network info built with Expo UI.
            </Text>
          </Column>
          {onRefresh ? (
            <Button onClick={onRefresh}>
              <Text style={styles.refreshText}>{loading ? 'Refreshing…' : 'Refresh'}</Text>
            </Button>
          ) : null}
        </Row>

        <Column spacing={10} style={styles.card}>
          <Text style={styles.cardTitle}>P2P status</Text>
          <Text style={styles.statusText}>{p2pLabel}</Text>
          <Row spacing={12} style={styles.metricRow}>
            <Column spacing={4} style={styles.metric}>
              <Text style={styles.metricLabel}>Connections</Text>
              <Text style={styles.metricValue}>{swarmStatus?.swarmConnections ?? swarmStatus?.peerCount ?? 0}</Text>
            </Column>
            <Column spacing={4} style={styles.metric}>
              <Text style={styles.metricLabel}>Feed links</Text>
              <Text style={styles.metricValue}>{feedConnections}</Text>
            </Column>
            <Column spacing={4} style={styles.metric}>
              <Text style={styles.metricLabel}>Discovered peers</Text>
              <Text style={styles.metricValue}>{discoveryPeers}</Text>
            </Column>
          </Row>
          <Text style={styles.detailText}>
            {swarmStatus?.swarmListenResolved ? 'Listening socket resolved' : 'Listening socket pending'}
            {swarmStatus?.peerPoolJoined ? ' • peer pool joined' : ''}
            {swarmStatus?.publicFeedDiscoveryJoined ? ' • public feed joined' : ''}
          </Text>
          {swarmStatus?.swarmOfflineReason ? (
            <Text style={styles.detailText}>Pause reason: {swarmStatus.swarmOfflineReason}</Text>
          ) : null}
          {boundary ? <Text style={styles.detailText}>Boundary: {boundary}</Text> : null}
        </Column>

        <Column spacing={10} style={styles.card}>
          <Text style={styles.cardTitle}>Cache meter</Text>
          <LinearProgressIndicator
            progress={cacheRatio}
            color="#60a5fa"
            trackColor="#243041"
            strokeCap="round"
          />
          <Text style={styles.detailText}>
            {storageStats ? `${cacheUsedGB} GB used of ${storageStats.maxGB} GB` : 'Loading cache stats…'}
          </Text>
          {storageStats?.totalStorageGB ? (
            <Text style={styles.detailText}>
              {trackedCacheGB} GB tracked cache • {storageStats.untrackedStorageGB ?? '0.00'} GB other app/P2P data
            </Text>
          ) : null}
          <Text style={styles.detailText}>
            {storageStats ? `${storageStats.seedCount} cached videos • ${storageStats.pinnedCount} pinned channels` : 'Loading cache stats…'}
          </Text>
          {seedingStatus?.status ? (
            <Text style={styles.detailText}>
              Seeding: {seedingStatus.status.enabled ? 'enabled' : 'disabled'} • {seedingStatus.status.seedingCount ?? 0} active seeds
            </Text>
          ) : null}
        </Column>

        <Column spacing={10} style={styles.card}>
          <Text style={styles.cardTitle}>Network info</Text>
          <Row spacing={12} style={styles.metricRow}>
            <Column spacing={4} style={styles.metric}>
              <Text style={styles.metricLabel}>DHT online</Text>
              <Text style={styles.metricValue}>{boolLabel(dht?.online)}</Text>
            </Column>
            <Column spacing={4} style={styles.metric}>
              <Text style={styles.metricLabel}>Bootstrapped</Text>
              <Text style={styles.metricValue}>{boolLabel(dht?.bootstrapped)}</Text>
            </Column>
            <Column spacing={4} style={styles.metric}>
              <Text style={styles.metricLabel}>Firewalled</Text>
              <Text style={styles.metricValue}>{boolLabel(dht?.firewalled)}</Text>
            </Column>
          </Row>
          <Text style={styles.detailText}>
            Feed topic {swarmStatus?.feedTopicHex || 'unavailable'}
          </Text>
          <Text style={styles.detailText}>
            Feed entries: {swarmStatus?.feedEntries ?? 0} • Channels loaded: {swarmStatus?.channelsLoaded ?? 0}
          </Text>
          <Text style={styles.detailText}>
            Discovery peers: {discoveryPeers} • Peer pool: {boolLabel(swarmStatus?.peerPoolJoined)}
          </Text>
        </Column>
      </Column>
    </Host>
  )
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
    marginBottom: 16,
  },
  root: {
    width: '100%',
  },
  headerRow: {
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerCopy: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f8fafc',
  },
  sectionSubtitle: {
    fontSize: 13,
    color: '#cbd5e1',
  },
  refreshText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  card: {
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#243041',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
  },
  statusText: {
    fontSize: 15,
    color: '#e2e8f0',
    fontWeight: '700',
  },
  metricRow: {
    justifyContent: 'space-between',
  },
  metric: {
    flex: 1,
    minWidth: 0,
  },
  metricLabel: {
    fontSize: 12,
    color: '#94a3b8',
  },
  metricValue: {
    fontSize: 18,
    color: '#f8fafc',
    fontWeight: '700',
  },
  detailText: {
    fontSize: 13,
    color: '#cbd5e1',
  },
})
