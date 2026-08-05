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

export const P2PStatsBar = memo(function P2PStatsBar({ stats, playing = false, failed = false, started = false }: P2PStatsBarProps) {
  const [expanded, setExpanded] = useState(false)

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
  const hasPlayableProgress = downloadSpeed > 0
  const hasProgressDetails = hasBytes || hasBlocks || isCached

  const getStatusLine = (): string => {
    if (isCached) return 'Saved on this device'
    if (failed || stats?.status === 'error') return 'Playback hit a snag'
    if (peerCount > 0 && (downloadSpeed > 0 || stats?.status === 'downloading')) {
      return `Streaming from ${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}`
    }
    if (hasPlayableProgress) {
      return peerCount > 0
        ? `Streaming from ${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}`
        : 'Streaming'
    }
    // Frames are on screen. Whatever the swarm reports, the player is past
    // starting and past reaching out.
    if (playing) return 'Playing'
    // A player that has advanced past zero has started, whatever the swarm
    // reports. Claiming it is still starting - which it did for the whole of
    // a paused or finished title - is the one thing that is definitely false.
    if (started) return 'Paused'
    if (!stats) return 'Starting player…'
    if (stats.status === 'connecting' || peerCount === 0) return 'Reaching out to peers…'
    return 'Preparing video…'
  }

  const statusLine = getStatusLine()
  const isError = (failed || stats?.status === 'error') && !isCached

  return (
    <Pressable
      style={styles.statsBar}
      onPress={() => setExpanded((v) => !v)}
      accessibilityRole="button"
      accessibilityLabel={`${statusLine}. Tap for network details`}
      accessibilityState={{ expanded }}
    >
      {/* Ambient row */}
      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          {isCached ? (
            <Feather name="check-circle" size={12} color={colors.primary} />
          ) : isError ? (
            <Feather name="alert-circle" size={12} color={colors.error} />
          ) : (
            <SwarmIndicator peers={peerCount} size={6} />
          )}
          <Text style={[styles.statLabel, { color: isError ? colors.error : isCached ? colors.primary : colors.swarm }]}>
            {statusLine}
          </Text>
        </View>
        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
      </View>

      {/* Progress bar while fetching */}
      {stats && !isCached && hasProgressDetails && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${stats.progress || 0}%` }]} />
        </View>
      )}

      {/* Detail rows (expanded) */}
      {expanded && stats && (
        <>
          <View style={styles.statsRowSecondary}>
            <Text style={styles.statText}>{peerCount} {peerCount === 1 ? 'peer' : 'peers'}</Text>
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
      )}
    </Pressable>
  )
})
