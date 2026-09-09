/**
 * CastRemoteModal - Remote controls while casting.
 *
 * Kept protocol-agnostic: the user is "casting" and this screen is the remote.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { Button, IconButton, Meta, Body } from '@/components/primitives'
import { useCast } from '@/lib/cast'
import { Scrubber, formatDuration } from '@/components/video-player'

type Props = {
  visible: boolean
  onClose: () => void
  onSwitchDevice: () => void
  videoTitle?: string | null
}

function formatCastState(state: string) {
  switch (state) {
    case 'playing':
      return 'Playing'
    case 'paused':
      return 'Paused'
    case 'buffering':
      return 'Buffering'
    case 'idle':
      return 'Idle'
    case 'stopped':
      return 'Stopped'
    default:
      return 'Casting'
  }
}

export function CastRemoteModal({ visible, onClose, onSwitchDevice, videoTitle }: Props) {
  const cast = useCast()
  const deviceName = cast.connectedDevice?.name || 'Cast device'
  const playback = cast.playbackState
  const isConnected = cast.isConnected

  const duration = playback.duration || 0
  const currentTime = playback.currentTime || 0
  const progress = duration > 0 ? currentTime / duration : 0

  const isSeekingDisabled = !isConnected || duration <= 0 || playback.state === 'buffering'
  const [pendingSeekTime, setPendingSeekTime] = useState<number | null>(null)
  const pendingSeekSinceRef = useMemo(() => ({ t: 0 }), [])

  // Clear any pending seek during render when the modal is hidden
  if (!visible && pendingSeekTime !== null) {
    setPendingSeekTime(null)
  }

  useEffect(() => {
    if (pendingSeekTime === null) return
    if (duration <= 0) {
      setPendingSeekTime(null)
      return
    }
    const ageMs = Date.now() - pendingSeekSinceRef.t
    const closeEnough = Math.abs(currentTime - pendingSeekTime) < 0.75
    if (closeEnough || ageMs > 1500) {
      setPendingSeekTime(null)
    }
  }, [pendingSeekTime, currentTime, duration, pendingSeekSinceRef])

  const handlePlayPause = useCallback(async () => {
    if (!isConnected) return
    if (playback.state === 'playing' || playback.state === 'buffering') {
      await cast.pause()
    } else {
      await cast.resume()
    }
  }, [cast, isConnected, playback.state])

  const handleSeekCommit = useCallback(async (t: number) => {
    if (!isConnected || duration <= 0) return
    pendingSeekSinceRef.t = Date.now()
    setPendingSeekTime(t)
    await cast.seek(t)
  }, [cast, isConnected, duration, pendingSeekSinceRef])

  const handleVolStep = useCallback(async (delta: number) => {
    if (!isConnected) return
    const next = Math.max(0, Math.min(100, Math.round((playback.volume || 0) + delta)))
    await cast.setVolume(next)
  }, [cast, isConnected, playback.volume])

  const statusLabel = formatCastState(playback.state)

  const transcodeLabel = useMemo(() => {
    if (!cast.transcodeStatus?.isTranscoding) return null
    const pct = Math.max(0, Math.min(100, Math.round(cast.transcodeStatus.progress || 0)))
    return `Optimizing for Chromecast… ${pct}%`
  }, [cast.transcodeStatus?.isTranscoding, cast.transcodeStatus?.progress])

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>CAST TO</Text>
              <Meta tone="muted" size="sm">
                {deviceName} · {statusLabel}
              </Meta>
            </View>

            <IconButton 
              icon="x" 
              onPress={onClose} 
              accessibilityLabel="Close cast remote"
              variant="plain"
              size={32}
            />
          </View>

          {videoTitle ? (
            <View style={styles.nowPlaying}>
              <Meta tone="muted">NOW PLAYING</Meta>
              <Body size="lg" tone="default" numberOfLines={2}>{videoTitle}</Body>
            </View>
          ) : null}

          {transcodeLabel ? (
            <View style={styles.transcodeRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Meta tone="muted" size="sm">{transcodeLabel}</Meta>
            </View>
          ) : null}

          <View style={styles.controlsRow}>
            <Button
              label={playback.state === 'playing' || playback.state === 'buffering' ? 'Pause' : 'Play'}
              variant="primary"
              size="md"
              block
              icon={playback.state === 'playing' || playback.state === 'buffering' ? 'pause' : 'play'}
              onPress={handlePlayPause}
              disabled={!isConnected}
              accessibilityLabel={playback.state === 'playing' ? 'Pause' : 'Play'}
            />

            <Button
              label="Switch"
              variant="secondary"
              size="md"
              icon="tv"
              onPress={onSwitchDevice}
              accessibilityLabel="Switch cast device"
            />
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>PLAYBACK</Text>
              <Meta tone="muted" size="sm">
                {formatDuration(currentTime)} / {formatDuration(duration)}
              </Meta>
            </View>
            <Scrubber
              duration={duration}
              currentTime={currentTime}
              progress={progress}
              pendingSeekTime={pendingSeekTime}
              disabled={isSeekingDisabled}
              containerStyle={styles.scrubberContainer}
              onSeekCommit={handleSeekCommit}
            />
            {duration <= 0 ? (
              <Meta tone="muted" size="sm" style={styles.hintText}>Seeking is unavailable for this stream.</Meta>
            ) : null}
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>VOLUME</Text>
              <Meta tone="muted" size="sm">{Math.round(playback.volume || 0)}%</Meta>
            </View>
            <View style={styles.volumeRow}>
              <IconButton
                icon="minus"
                onPress={() => handleVolStep(-5)}
                disabled={!isConnected}
                variant="outline"
                size={40}
                accessibilityLabel="Volume down"
              />
              <View style={styles.volumeBarOuter}>
                <View style={[styles.volumeBarInner, { width: `${Math.max(0, Math.min(100, playback.volume || 0))}%` }]} />
              </View>
              <IconButton
                icon="plus"
                onPress={() => handleVolStep(5)}
                disabled={!isConnected}
                variant="outline"
                size={40}
                accessibilityLabel="Volume up"
              />
            </View>
          </View>

          <View style={styles.footerRow}>
            <Button
              label="Disconnect"
              variant="danger"
              size="md"
              block
              icon="x-circle"
              onPress={() => cast.disconnect()}
              disabled={!isConnected}
              accessibilityLabel="Disconnect casting"
            />

            <Button
              label="Stop"
              variant="secondary"
              size="md"
              icon="square"
              onPress={() => cast.stop()}
              disabled={!isConnected}
              accessibilityLabel="Stop playback"
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopWidth: borderWidth.rule,
    borderTopColor: colors.primary,
    paddingBottom: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
  },
  title: {
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
  },
  nowPlaying: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  transcodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  controlsRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...fonts.caption.sm,
    color: colors.text,
  },
  scrubberContainer: {
    paddingVertical: spacing.md,
  },
  hintText: {
    marginTop: spacing.md,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  volumeBarOuter: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.bg,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  volumeBarInner: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
})

export default CastRemoteModal
