/**
 * P2PStatsBar - P2P network status display
 *
 * Displays download/upload speeds, peer count, and progress.
 * Memoized to prevent re-renders when parent VideoPlayerOverlay updates frequently.
 */

import { memo } from 'react'
import { View, Text } from 'react-native'
import type { VideoStats } from '@/lib/VideoPlayerContext'
import { styles } from './styles'
import { formatSizeCompact } from './formatters'

interface P2PStatsBarProps {
  stats: VideoStats | null
}

export const P2PStatsBar = memo(function P2PStatsBar({ stats }: P2PStatsBarProps) {
  const peerCount = stats?.peerCount ?? 0
  const downloadSpeed = Number(stats?.speedMBps ?? 0)
  const uploadSpeed = Number(stats?.uploadSpeedMBps ?? 0)
  const downloadedBytes = Number(stats?.downloadedBytes ?? 0)
  const totalBytes = Number(stats?.totalBytes ?? 0)
  const downloadedBlocks = Number(stats?.downloadedBlocks ?? 0)
  const totalBlocks = Number(stats?.totalBlocks ?? 0)
  const hasBytes = totalBytes > 0
  const hasBlocks = totalBlocks > 0
  const hasDownloadedBytes = downloadedBytes > 0
  const hasDownloadedBlocks = downloadedBlocks > 0
  const isCached = Boolean(
    stats?.isComplete ||
    stats?.status === 'complete' ||
    Number(stats?.progress ?? 0) >= 100 ||
    (totalBlocks > 0 && downloadedBlocks >= totalBlocks) ||
    (totalBytes > 0 && downloadedBytes >= totalBytes)
  )
  const hasPlayableProgress = hasDownloadedBytes || hasDownloadedBlocks || Number(stats?.progress ?? 0) > 0
  const hasProgressDetails = hasBytes || hasBlocks || isCached

  const getStatusInfo = () => {
    if (!stats) return { color: '#6b7280', label: 'Starting player' }
    if (isCached) return { color: '#4ade80', label: 'Cached' }
    if (stats.status === 'downloading') return { color: '#fbbf24', label: 'Downloading' }
    if (downloadSpeed > 0) return { color: '#fbbf24', label: 'Downloading' }
    if (hasPlayableProgress) return { color: '#60a5fa', label: 'Streaming' }
    if (stats.status === 'connecting') return { color: '#60a5fa', label: 'Finding video peers' }
    if (stats.status === 'resolving') return { color: '#a78bfa', label: 'Resolving video' }
    if (stats.status === 'error') return { color: '#f87171', label: 'Playback error' }
    if (peerCount === 0 && !hasProgressDetails) return { color: '#6b7280', label: 'Waiting for video peers' }
    return { color: '#6b7280', label: 'Preparing video' }
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
      {stats && !isCached && hasProgressDetails && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${stats.progress || 0}%` }]} />
        </View>
      )}

      {/* Details row */}
      {stats && hasProgressDetails && (
        <View style={styles.statsRowSecondary}>
          {hasBytes && (
            <Text style={styles.statDetail}>
              {formatSizeCompact(downloadedBytes)} / {formatSizeCompact(totalBytes)}
            </Text>
          )}
          {hasBlocks && (
            <Text style={styles.statDetail}>
              {downloadedBlocks} / {totalBlocks} blocks
            </Text>
          )}
          <Text style={[styles.statProgress, isCached && styles.statProgressComplete]}>
            {stats.progress || 0}%
          </Text>
        </View>
      )}
    </View>
  )
})
