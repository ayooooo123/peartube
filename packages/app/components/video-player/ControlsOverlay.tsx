/**
 * ControlsOverlay - Play/pause and skip controls
 *
 * Displays the center controls overlay with play/pause and ±10s skip buttons.
 * Uses the VideoControlContext for playback state.
 */

import { memo } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Feather, Ionicons } from '@expo/vector-icons'
import { styles } from './styles'

interface ControlsOverlayProps {
  visible: boolean
  isPlaying: boolean
  onPlayPause: () => void
  onSeekBackward: () => void
  onSeekForward: () => void
  controlsOverlayStyle?: any
}

export const ControlsOverlay = memo(function ControlsOverlay({
  visible,
  isPlaying,
  onPlayPause,
  onSeekBackward,
  onSeekForward,
  controlsOverlayStyle,
}: ControlsOverlayProps) {
  if (!visible) return null

  return (
    <Animated.View style={[styles.controlsOverlayBase, controlsOverlayStyle]}>
      {/* Seek backward button */}
      <Pressable style={styles.controlButton} onPress={onSeekBackward}>
        <Feather name="rotate-ccw" color="#fff" size={32} />
        <Text style={styles.controlButtonText}>10s</Text>
      </Pressable>

      {/* Play/Pause button */}
      <Pressable style={styles.controlButtonLarge} onPress={onPlayPause}>
        {isPlaying ? (
          <Ionicons name="pause" color="#fff" size={48} />
        ) : (
          <Ionicons name="play" color="#fff" size={48} />
        )}
      </Pressable>

      {/* Seek forward button */}
      <Pressable style={styles.controlButton} onPress={onSeekForward}>
        <Feather name="rotate-cw" color="#fff" size={32} />
        <Text style={styles.controlButtonText}>10s</Text>
      </Pressable>
    </Animated.View>
  )
})
