import React, { useMemo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import type { SeedingStatus, StorageStats, SwarmStatus } from './types'

interface DiagnosticsPanelProps {
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  loading?: boolean
  onRefresh?: () => void
}

function boolLabel(value?: boolean | null) {
  if (value === null || value === undefined) return '—'
  return value ? 'On' : 'Off'
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{String(value)}</Text>
    </View>
  )
}

export default function DiagnosticsPanel({
  swarmStatus,
  storageStats,
  seedingStatus,
  loading,
  onRefresh,
}: DiagnosticsPanelProps) {
  // Meter the real on-disk footprint (what actually fills storage and what the
  // quota bounds), not just the tracked seed sum which under-counts untracked
  // and partially-cached bytes. Fall back to the tracked sum when the backend
  // couldn't measure the disk.
  const realUsedBytes = storageStats?.totalStorageBytes ?? storageStats?.usedBytes ?? 0
  const realUsedGB = storageStats?.totalStorageGB ?? storageStats?.usedGB
  const cacheRatio = useMemo(() => {
    if (!storageStats?.maxBytes) return 0
    return Math.max(0, Math.min(1, realUsedBytes / storageStats.maxBytes))
  }, [storageStats, realUsedBytes])

  // Over HRPC the doctor/network detail arrives JSON-encoded (the wire
  // schema has no nested object fields), so fall back to parsing it.
  const network = useMemo(() => {
    if (swarmStatus?.network) return swarmStatus.network
    for (const raw of [swarmStatus?.doctorJson, swarmStatus?.networkJson]) {
      if (typeof raw === 'string' && raw) {
        try { return JSON.parse(raw) } catch { /* fall through to next source */ }
      }
    }
    return null
  }, [swarmStatus])

  const p2pLabel = swarmStatus?.swarmOffline
    ? 'Network paused'
    : swarmStatus?.connected
      ? 'Connected to peers'
      : 'Searching for peers'

  const boundary = network?.recommendedBoundary ?? swarmStatus?.recommendedBoundary
  const discoveryPeers = network?.discovery?.discoveredPeers ?? swarmStatus?.peerCount ?? 0
  const feedConnections = network?.feed?.feedConnections ?? swarmStatus?.feedConnections ?? 0
  const dht = network?.dht
  const lastHaveFeed = network?.feed?.lastHaveFeed
  const lastPlayback = network?.playback?.lastPreparePlayback

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Network diagnostics</Text>
          <Text style={styles.sectionSubtitle}>P2P status, cache meters, and network info.</Text>
        </View>
        {onRefresh ? (
          <Pressable onPress={onRefresh} disabled={loading} style={styles.refreshButton} accessibilityRole="button" accessibilityLabel="Refresh diagnostics">
            {loading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={styles.refreshText}>Refresh</Text>
            )}
          </Pressable>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>P2P status</Text>
        <Text style={styles.statusText}>{p2pLabel}</Text>
        <View style={styles.metricRow}>
          <Metric label="Connections" value={swarmStatus?.swarmConnections ?? swarmStatus?.peerCount ?? 0} />
          <Metric label="Feed links" value={feedConnections} />
          <Metric label="Discovered peers" value={discoveryPeers} />
        </View>
        <Text style={styles.detailText}>
          {swarmStatus?.swarmListenResolved ? 'Listening socket resolved' : 'Listening socket pending'}
          {swarmStatus?.peerPoolJoined ? ' • peer pool joined' : ''}
          {swarmStatus?.publicFeedDiscoveryJoined ? ' • public feed joined' : ''}
        </Text>
        {swarmStatus?.swarmOfflineReason ? (
          <Text style={styles.detailText}>Pause reason: {swarmStatus.swarmOfflineReason}</Text>
        ) : null}
        {boundary ? <Text style={styles.boundaryText}>Boundary: {boundary}</Text> : null}
        {lastHaveFeed ? (
          <Text style={styles.detailText}>
            Last gossip: {lastHaveFeed.received ?? 0} received • {lastHaveFeed.accepted ?? 0} accepted • {lastHaveFeed.rejected ?? 0} rejected
            {lastHaveFeed.lastRejectReason ? ` (${lastHaveFeed.lastRejectReason})` : ''}
          </Text>
        ) : (
          <Text style={styles.detailText}>No gossip received yet this session.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cache meter</Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(cacheRatio * 100)}%` }]} />
        </View>
        <Text style={styles.detailText}>
          {storageStats ? `${realUsedGB} GB used of ${storageStats.maxGB} GB` : 'Loading cache stats…'}
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

      {lastPlayback ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Playback timing</Text>
          <Text style={styles.statusText}>
            {lastPlayback.videoId || 'unknown video'}
            {lastPlayback.readyForPlayback === true ? ' • ready' : lastPlayback.readyForPlayback === false ? ' • not ready' : ''}
          </Text>
          <View style={styles.metricRow}>
            <Metric label="Total" value={`${lastPlayback.stages?.totalMs ?? '—'} ms`} />
            <Metric label="URL" value={`${lastPlayback.stages?.urlResolvedMs ?? '—'} ms`} />
            <Metric label="Head block" value={`${lastPlayback.stages?.headBlockMs ?? '—'} ms`} />
          </View>
          <Text style={styles.detailText}>
            Hints: {lastPlayback.stages?.hintsMs ?? '—'} ms • Core ready: {lastPlayback.stages?.blobCoreReadyMs ?? '—'} ms
            {' '}• Peers retained: {lastPlayback.stages?.peersRetainedMs ?? '—'} ms
          </Text>
          <Text style={styles.detailText}>
            First blob peer: {lastPlayback.stages?.firstBlobPeerMs ?? '—'} ms • Warmup done: {lastPlayback.stages?.warmupDoneMs ?? '—'} ms
            {' '}• Blob peers: {lastPlayback.peerCount ?? '—'}
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Network info</Text>
        <View style={styles.metricRow}>
          <Metric label="DHT online" value={boolLabel(dht?.online)} />
          <Metric label="Bootstrapped" value={boolLabel(dht?.bootstrapped)} />
          <Metric label="Firewalled" value={boolLabel(dht?.firewalled)} />
        </View>
        <Text style={styles.detailText}>Feed topic {swarmStatus?.feedTopicHex || 'unavailable'}</Text>
        <Text style={styles.detailText}>
          Feed entries: {swarmStatus?.feedEntries ?? 0} • Channels loaded: {swarmStatus?.channelsLoaded ?? 0}
        </Text>
        <Text style={styles.detailText}>
          Discovery peers: {discoveryPeers} • Peer pool: {boolLabel(swarmStatus?.peerPoolJoined)}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    padding: 16,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  sectionSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: colors.textMuted,
  },
  refreshButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    minWidth: 72,
    alignItems: 'center',
  },
  refreshText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  card: {
    backgroundColor: colors.bg,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    gap: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  metricRow: {
    flexDirection: 'row',
    gap: 12,
  },
  metric: {
    flex: 1,
    minWidth: 0,
  },
  metricLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  metricValue: {
    marginTop: 2,
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  detailText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  boundaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
  },
  track: {
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.glass,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.swarm,
  },
})
