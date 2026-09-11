/**
 * P2PStatsBar - Ambient P2P status for the watch page.
 *
 * Collapsed: a SwarmIndicator pulse plus one human sentence
 * ("Streaming from 6 peers"). Tapping expands the real numbers
 * (speeds, bytes, blocks) for the curious.
 */

import { memo, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Feather } from '@expo/vector-icons'
import type { VideoStats } from '@/lib/VideoPlayerContext'
import { SwarmIndicator } from '@/components/primitives'
import { colors } from '@/lib/colors'
import { styles } from './styles'
import { formatSizeCompact } from './formatters'

interface P2PStatsBarProps {
  stats: VideoStats | null
  /**
   * Whether the player is decoding frames right now. P2P stats only exist for
   * channel-drive playback, so a publication plays with `stats` null forever;
   * without the player's own state this bar claimed it was still starting over
   * a title that was several seconds in.
   */
  playing?: boolean
  /**
   * A playback failure the player will not retry out of. It arrives with no
   * stats at all for publication playback, so without it the bar would fall
   * through to "Starting player…" over a title that has stopped for good.
   */
  failed?: boolean
  /**
   * The player has advanced past the start of the title, so whatever it is
   * doing now it is not starting up.
   */
  started?: boolean
}

function computeIsCached(
  stats: VideoStats | null,
  totalBlocks: number,
  downloadedBlocks: number,
  totalBytes: number,
  downloadedBytes: number,
): boolean {
  if (!stats) return false
  if (stats.isComplete || stats.status === 'complete') return true
  if (Number(stats.progress ?? 0) >= 100) return true
  if (totalBlocks > 0 && downloadedBlocks >= totalBlocks) return true
  if (totalBytes > 0 && downloadedBytes >= totalBytes) return true
  return false
}

interface StatusLineContext {
  isCached: boolean
  failed: boolean
  stats: VideoStats | null
  peerCount: number
  downloadSpeed: number
  hasPlayableProgress: boolean
  playing: boolean
  started: boolean
}

function computeStatusLine(ctx: StatusLineContext): string {
  const { isCached, failed, stats, peerCount, downloadSpeed, hasPlayableProgress, playing, started } = ctx
  if (isCached) return 'Saved on this device'
  if (failed || stats?.status === 'error') return 'Playback hit a snag'
  const peerSuffix = peerCount === 1 ? 'peer' : 'peers'
  if (peerCount > 0 && (downloadSpeed > 0 || stats?.status === 'downloading')) {
    return `Streaming from ${peerCount} ${peerSuffix}`
  }
  if (hasPlayableProgress) {
    return peerCount > 0 ? `Streaming from ${peerCount} ${peerSuffix}` : 'Streaming'
  }
  if (playing) return 'Playing'
  if (started) return 'Paused'
  if (!stats) return 'Starting player…'
  if (stats.status === 'connecting' || peerCount === 0) return 'Reaching out to peers…'
  return 'Preparing video…'
}

function getStatIcon(isCached: boolean, isError: boolean, peerCount: number) {
  if (isCached) return <Feather name="check-circle" size={12} color={colors.primary} />
  if (isError) return <Feather name="alert-circle" size={12} color={colors.error} />
  return <SwarmIndicator peers={peerCount} size={6} />
}

function getStatColor(isCached: boolean, isError: boolean): string {
  if (isError) return colors.error
  if (isCached) return colors.primary
  return colors.swarm
}

interface P2PStatsModel {
  peerCount: number
  downloadSpeed: number
  uploadSpeed: number
  downloadedBytes: number
  totalBytes: number
  downloadedBlocks: number
  totalBlocks: number
  hasBytes: boolean
  hasBlocks: boolean
  isCached: boolean
  hasProgressDetails: boolean
  statusLine: string
  isError: boolean
  showProgressBar: boolean
  progressPercent: number
}

function readP2PCounters(stats: VideoStats | null) {
  const peerCount = stats?.peerCount ?? 0
  const downloadSpeed = Number(stats?.speedMBps ?? 0)
  const uploadSpeed = Number(stats?.uploadSpeedMBps ?? 0)
  const downloadedBytes = Number(stats?.downloadedBytes ?? 0)
  const totalBytes = Number(stats?.totalBytes ?? 0)
  const downloadedBlocks = Number(stats?.downloadedBlocks ?? 0)
  const totalBlocks = Number(stats?.totalBlocks ?? 0)
  return {
    peerCount,
    downloadSpeed,
    uploadSpeed,
    downloadedBytes,
    totalBytes,
    downloadedBlocks,
    totalBlocks,
    hasBytes: totalBytes > 0,
    hasBlocks: totalBlocks > 0,
  }
}

function deriveP2PStatsModel(
  stats: VideoStats | null,
  playing: boolean,
  failed: boolean,
  started: boolean,
): P2PStatsModel {
  const counters = readP2PCounters(stats)
  const {
    peerCount,
    downloadSpeed,
    uploadSpeed,
    downloadedBytes,
    totalBytes,
    downloadedBlocks,
    totalBlocks,
    hasBytes,
    hasBlocks,
  } = counters
  const isCached = computeIsCached(stats, totalBlocks, downloadedBlocks, totalBytes, downloadedBytes)
  const hasPlayableProgress = downloadSpeed > 0
  const hasProgressDetails = hasBytes || hasBlocks || isCached
  const statusLine = computeStatusLine({
    isCached,
    failed,
    stats,
    peerCount,
    downloadSpeed,
    hasPlayableProgress,
    playing,
    started,
  })
  const isError = (failed || stats?.status === 'error') && !isCached

  return {
    peerCount,
    downloadSpeed,
    uploadSpeed,
    downloadedBytes,
    totalBytes,
    downloadedBlocks,
    totalBlocks,
    hasBytes,
    hasBlocks,
    isCached,
    hasProgressDetails,
    statusLine,
    isError,
    showProgressBar: Boolean(stats && !isCached && hasProgressDetails),
    progressPercent: Number(stats?.progress ?? 0),
  }
}

interface P2PStatsDetailsProps {
  stats: VideoStats
  peerCount: number
  downloadSpeed: number
  uploadSpeed: number
  hasProgressDetails: boolean
  hasBytes: boolean
  hasBlocks: boolean
  downloadedBytes: number
  totalBytes: number
  downloadedBlocks: number
  totalBlocks: number
  isCached: boolean
}

function P2PStatsDetails({
  stats,
  peerCount,
  downloadSpeed,
  uploadSpeed,
  hasProgressDetails,
  hasBytes,
  hasBlocks,
  downloadedBytes,
  totalBytes,
  downloadedBlocks,
  totalBlocks,
  isCached,
}: P2PStatsDetailsProps) {
  const peerLabel = peerCount === 1 ? 'peer' : 'peers'
  return (
    <>
      <View style={styles.statsRowSecondary}>
        <Text style={styles.statText}>{peerCount} {peerLabel}</Text>
        <Text style={styles.statSpeed}>↓ {downloadSpeed.toFixed(2)} MB/s</Text>
        <Text style={styles.statSpeedUp}>↑ {uploadSpeed.toFixed(2)} MB/s</Text>
      </View>
      {hasProgressDetails && (
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
    </>
  )
}

export const P2PStatsBar = memo(function P2PStatsBar({ stats, playing = false, failed = false, started = false }: P2PStatsBarProps) {
  const [expanded, setExpanded] = useState(false)
  const model = deriveP2PStatsModel(stats, playing, failed, started)

  return (
    <Pressable
      style={styles.statsBar}
      onPress={() => setExpanded((v) => !v)}
      accessibilityRole="button"
      accessibilityLabel={`${model.statusLine}. Tap for network details`}
      accessibilityState={{ expanded }}
    >
      {/* Ambient row */}
      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          {getStatIcon(model.isCached, model.isError, model.peerCount)}
          <Text style={[styles.statLabel, { color: getStatColor(model.isCached, model.isError) }]}>
            {model.statusLine}
          </Text>
        </View>
        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
      </View>

      {/* Progress bar while fetching */}
      {model.showProgressBar && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${model.progressPercent}%` }]} />
        </View>
      )}

      {/* Detail rows (expanded) */}
      {expanded && stats && (
        <P2PStatsDetails
          stats={stats}
          peerCount={model.peerCount}
          downloadSpeed={model.downloadSpeed}
          uploadSpeed={model.uploadSpeed}
          hasProgressDetails={model.hasProgressDetails}
          hasBytes={model.hasBytes}
          hasBlocks={model.hasBlocks}
          downloadedBytes={model.downloadedBytes}
          totalBytes={model.totalBytes}
          downloadedBlocks={model.downloadedBlocks}
          totalBlocks={model.totalBlocks}
          isCached={model.isCached}
        />
      )}
    </Pressable>
  )
})
