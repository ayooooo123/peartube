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
  Platform,
} from 'react-native'
import { Feather, Ionicons } from '@expo/vector-icons'
import { colors } from '@/lib/colors'
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
  const useAndroidTextIcons = Platform.OS === 'android'
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

  useEffect(() => {
    if (!visible) {
      setPendingSeekTime(null)
      return
    }
  }, [visible])

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
              <Text style={styles.title}>Casting</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {deviceName} · {statusLabel}
              </Text>
            </View>

            <Pressable style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close cast remote">
              {useAndroidTextIcons ? <Text style={styles.androidIcon}>X</Text> : <Feather name="x" size={22} color={colors.text} />}
            </Pressable>
          </View>

          {videoTitle ? (
            <View style={styles.nowPlaying}>
              <Text style={styles.nowPlayingLabel}>Now playing</Text>
              <Text style={styles.nowPlayingTitle} numberOfLines={2}>{videoTitle}</Text>
            </View>
          ) : null}

          {transcodeLabel ? (
            <View style={styles.transcodeRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.transcodeText}>{transcodeLabel}</Text>
            </View>
          ) : null}

          <View style={styles.controlsRow}>
            <Pressable
              style={[styles.primaryButton, !isConnected && styles.disabled]}
              onPress={handlePlayPause}
              disabled={!isConnected}
              accessibilityRole="button"
              accessibilityLabel={playback.state === 'playing' ? 'Pause' : 'Play'}
            >
              {useAndroidTextIcons ? (
                <Text style={styles.androidPrimaryIcon}>{(playback.state === 'playing' || playback.state === 'buffering') ? '||' : '>'}</Text>
              ) : (
                <Ionicons
                  name={(playback.state === 'playing' || playback.state === 'buffering') ? 'pause' : 'play'}
                  size={22}
                  color="#fff"
                />
              )}
              <Text style={styles.primaryButtonText}>
                {(playback.state === 'playing' || playback.state === 'buffering') ? 'Pause' : 'Play'}
              </Text>
            </Pressable>

            <Pressable
              style={styles.secondaryButton}
              onPress={onSwitchDevice}
              accessibilityRole="button"
              accessibilityLabel="Switch cast device"
            >
              {useAndroidTextIcons ? <Text style={styles.androidIcon}>TV</Text> : <Feather name="tv" size={18} color={colors.text} />}
              <Text style={styles.secondaryButtonText}>Switch</Text>
            </Pressable>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Playback</Text>
              <Text style={styles.sectionMeta}>
                {formatDuration(currentTime)} / {formatDuration(duration)}
              </Text>
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
              <Text style={styles.hintText}>Seeking is unavailable for this stream.</Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Volume</Text>
              <Text style={styles.sectionMeta}>{Math.round(playback.volume || 0)}%</Text>
            </View>
            <View style={styles.volumeRow}>
              <Pressable
                style={[styles.volumeStep, !isConnected && styles.disabled]}
                onPress={() => handleVolStep(-5)}
                disabled={!isConnected}
                accessibilityRole="button"
                accessibilityLabel="Volume down"
              >
                {useAndroidTextIcons ? <Text style={styles.androidIcon}>-</Text> : <Feather name="minus" size={18} color={colors.text} />}
              </Pressable>
              <View style={styles.volumeBarOuter}>
                <View style={[styles.volumeBarInner, { width: `${Math.max(0, Math.min(100, playback.volume || 0))}%` }]} />
              </View>
              <Pressable
                style={[styles.volumeStep, !isConnected && styles.disabled]}
                onPress={() => handleVolStep(5)}
                disabled={!isConnected}
                accessibilityRole="button"
                accessibilityLabel="Volume up"
              >
                {useAndroidTextIcons ? <Text style={styles.androidIcon}>+</Text> : <Feather name="plus" size={18} color={colors.text} />}
              </Pressable>
            </View>
          </View>

          <View style={styles.footerRow}>
            <Pressable
              style={[styles.dangerButton, !isConnected && styles.disabled]}
              onPress={() => cast.disconnect()}
              disabled={!isConnected}
              accessibilityRole="button"
              accessibilityLabel="Disconnect casting"
            >
              {useAndroidTextIcons ? <Text style={styles.androidDangerIcon}>X</Text> : <Feather name="x-circle" size={18} color="#fff" />}
              <Text style={styles.dangerButtonText}>Disconnect</Text>
            </Pressable>

            <Pressable
              style={[styles.secondaryButton, !isConnected && styles.disabled]}
              onPress={() => cast.stop()}
              disabled={!isConnected}
              accessibilityRole="button"
              accessibilityLabel="Stop playback"
            >
              {useAndroidTextIcons ? <Text style={styles.androidIcon}>[]</Text> : <Feather name="square" size={18} color={colors.text} />}
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bgCard,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    color: colors.textMuted,
  },
  closeButton: {
    padding: 6,
  },
  nowPlaying: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  nowPlayingLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  nowPlayingTitle: {
    marginTop: 6,
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  transcodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
    marginBottom: 4,
    paddingHorizontal: 16,
  },
  transcodeText: {
    flex: 1,
    fontSize: 13,
    color: colors.textMuted,
  },
  controlsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 14,
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
  },
  sectionMeta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  scrubberContainer: {
    paddingVertical: 8,
  },
  hintText: {
    marginTop: 8,
    fontSize: 13,
    color: colors.textMuted,
    opacity: 0.9,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  volumeStep: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  volumeBarOuter: {
    flex: 1,
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.bg,
    borderWidth: 1,
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
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  dangerButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#ef4444',
  },
  dangerButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  disabled: {
    opacity: 0.5,
  },
  androidIcon: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    minWidth: 16,
    textAlign: 'center',
  },
  androidPrimaryIcon: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    minWidth: 16,
    textAlign: 'center',
  },
  androidDangerIcon: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    minWidth: 16,
    textAlign: 'center',
  },
})

export default CastRemoteModal
