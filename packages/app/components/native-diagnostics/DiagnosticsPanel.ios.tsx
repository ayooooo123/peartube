import React, { useMemo } from 'react'
import { Host, VStack, HStack, Text, Button, Gauge } from '@expo/ui/swift-ui'
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
    <Host>
      <VStack spacing={14}>
        <HStack spacing={12} alignment="center">
          <VStack spacing={4}>
            <Text>Native diagnostics</Text>
            <Text>P2P status, cache meters, and network info built with Expo UI.</Text>
          </VStack>
          {onRefresh ? (
            <Button
              label={loading ? 'Refreshing…' : 'Refresh'}
              onPress={onRefresh}
              systemImage="arrow.clockwise"
            />
          ) : null}
        </HStack>

        <VStack spacing={8}>
          <Text>P2P status</Text>
          <Text>{p2pLabel}</Text>
          <HStack spacing={12}>
            <VStack spacing={2}>
              <Text>Connections</Text>
              <Text>{swarmStatus?.swarmConnections ?? swarmStatus?.peerCount ?? 0}</Text>
            </VStack>
            <VStack spacing={2}>
              <Text>Feed links</Text>
              <Text>{feedConnections}</Text>
            </VStack>
            <VStack spacing={2}>
              <Text>Discovered peers</Text>
              <Text>{discoveryPeers}</Text>
            </VStack>
          </HStack>
          <Text>
            {swarmStatus?.swarmListenResolved ? 'Listening socket resolved' : 'Listening socket pending'}
            {swarmStatus?.peerPoolJoined ? ' • peer pool joined' : ''}
            {swarmStatus?.publicFeedDiscoveryJoined ? ' • public feed joined' : ''}
          </Text>
          {swarmStatus?.swarmOfflineReason ? <Text>Pause reason: {swarmStatus.swarmOfflineReason}</Text> : null}
          {boundary ? <Text>Boundary: {boundary}</Text> : null}
        </VStack>

        <VStack spacing={8}>
          <Text>Cache meter</Text>
          <Gauge
            value={cacheRatio}
            min={0}
            max={1}
            currentValueLabel={storageStats ? `${cacheUsedGB} GB used` : 'Loading…'}
            maximumValueLabel={storageStats ? `${storageStats.maxGB} GB budget` : '—'}
          >
            Cached content budget
          </Gauge>
          <Text>
            {storageStats ? `${storageStats.seedCount} cached videos • ${storageStats.pinnedCount} pinned channels` : 'Loading cache stats…'}
          </Text>
          {seedingStatus?.status ? (
            <Text>
              Seeding: {seedingStatus.status.enabled ? 'enabled' : 'disabled'} • {seedingStatus.status.seedingCount ?? 0} active seeds
            </Text>
          ) : null}
        </VStack>

        <VStack spacing={8}>
          <Text>Network info</Text>
          <HStack spacing={12}>
            <VStack spacing={2}>
              <Text>DHT online</Text>
              <Text>{boolLabel(dht?.online)}</Text>
            </VStack>
            <VStack spacing={2}>
              <Text>Bootstrapped</Text>
              <Text>{boolLabel(dht?.bootstrapped)}</Text>
            </VStack>
            <VStack spacing={2}>
              <Text>Firewalled</Text>
              <Text>{boolLabel(dht?.firewalled)}</Text>
            </VStack>
          </HStack>
          <Text>Feed topic {swarmStatus?.feedTopicHex || 'unavailable'}</Text>
          <Text>Feed entries: {swarmStatus?.feedEntries ?? 0} • Channels loaded: {swarmStatus?.channelsLoaded ?? 0}</Text>
          <Text>Discovery peers: {discoveryPeers} • Peer pool: {boolLabel(swarmStatus?.peerPoolJoined)}</Text>
        </VStack>
      </VStack>
    </Host>
  )
}
