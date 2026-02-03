/**
 * P2PStatsBar - P2P network status display
 *
 * Displays download/upload speeds, peer count, and progress.
 * Memoized to prevent re-renders when parent VideoPlayerOverlay updates frequently.
 */

import { memo, useEffect, useState } from 'react'
import { View, Text } from 'react-native'
import { useApp } from '@/lib/AppContext'
import type { VideoStats } from '@/lib/VideoPlayerContext'
import { styles } from './styles'
import { formatSizeCompact } from './formatters'

interface P2PStatsBarProps {
  stats: VideoStats | null
}

export const P2PStatsBar = memo(function P2PStatsBar({ stats }: P2PStatsBarProps) {
  const { rpc: appRpc } = useApp()
  const [globalPeers, setGlobalPeers] = useState(0)

  useEffect(() => {
    let mounted = true
    let intervalId: NodeJS.Timeout | null = null

    const fetchGlobalStatus = async () => {
      try {
        const swarmStatus = await appRpc?.getSwarmStatus?.()
        const peerCount = swarmStatus?.peerCount ?? swarmStatus?.swarmConnections ?? swarmStatus?.swarmPeers
        if (mounted && peerCount !== undefined) {
          setGlobalPeers(peerCount)
        }
      } catch (e) {}
    }

    if (!stats && appRpc) {
      fetchGlobalStatus()
      intervalId = setInterval(fetchGlobalStatus, 2000)
    }

    return () => {
      mounted = false
      if (intervalId) clearInterval(intervalId)
    }
  }, [stats, appRpc])

  const peerCount = stats?.peerCount ?? globalPeers
  const downloadSpeed = Number(stats?.speedMBps ?? 0)
  const uploadSpeed = Number(stats?.uploadSpeedMBps ?? 0)

  const getStatusInfo = () => {
    if (!stats) {
      if (globalPeers > 0) return { color: '#4ade80', label: 'Connected' }
      return { color: '#6b7280', label: 'Connecting' }
    }
    if (stats.isComplete) return { color: '#4ade80', label: 'Cached' }
    if (stats.status === 'downloading') return { color: '#fbbf24', label: 'Downloading' }
    if (stats.status === 'connecting' || stats.status === 'resolving') return { color: '#60a5fa', label: 'Connecting' }
    return { color: '#6b7280', label: 'Waiting' }
  }

  const { color, label } = getStatusInfo()

  return (
    <View style={styles.statsBar}>
      {/* Main stats row */}
      <View style={styles.statsRow}>
        {/* Status with dot */}
        <View style={styles.statItem}>
          <View style={[styles.statusDot, { backgroundColor: color }]} />
          <Text style={[styles.statLabel, { color }]}>{label}</Text>
        </View>

        {/* Peers */}
        <Text style={styles.statText}>{peerCount} {peerCount === 1 ? 'peer' : 'peers'}</Text>

        {/* Download speed */}
        <Text style={styles.statSpeed}>↓ {downloadSpeed.toFixed(2)} MB/s</Text>

        {/* Upload speed */}
        <Text style={styles.statSpeedUp}>↑ {uploadSpeed.toFixed(2)} MB/s</Text>
      </View>

      {/* Progress bar */}
      {stats && !stats.isComplete && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${stats.progress || 0}%` }]} />
        </View>
      )}

      {/* Details row */}
      {stats && (
        <View style={styles.statsRowSecondary}>
          <Text style={styles.statDetail}>
            {formatSizeCompact(stats.downloadedBytes || 0)} / {formatSizeCompact(stats.totalBytes || 0)}
          </Text>
          <Text style={styles.statDetail}>
            {stats.downloadedBlocks || 0} / {stats.totalBlocks || 0} blocks
          </Text>
          <Text style={[styles.statProgress, stats.isComplete && styles.statProgressComplete]}>
            {stats.progress || 0}%
          </Text>
        </View>
      )}
    </View>
  )
})
