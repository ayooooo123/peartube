/**
 * MiniPlayerControls - Mobile mini player overlay controls
 *
 * Displays the overlay controls (close, maximize, play/pause, skip) for the mobile mini player.
 */

import { memo } from 'react'
import { View, Pressable } from 'react-native'
import Animated from 'react-native-reanimated'
import { Feather, Ionicons } from '@expo/vector-icons'
import { styles } from './styles'

interface MiniPlayerControlsProps {
  isPlaying: boolean
  onClose: () => void
  onMaximize: () => void
  onPlayPause: () => void
  onSeekBackward: () => void
  onSeekForward: () => void
  animatedStyle?: any
}

export const MiniPlayerControls = memo(function MiniPlayerControls({
  isPlaying,
  onClose,
  onMaximize,
  onPlayPause,
  onSeekBackward,
  onSeekForward,
  animatedStyle,
}: MiniPlayerControlsProps) {
  return (
    <Animated.View style={[styles.miniPipOverlay, animatedStyle]} pointerEvents="box-none">
      {/* Top row: close and maximize */}
      <View style={styles.miniPipTopRow} pointerEvents="box-none">
        <Pressable style={styles.miniPipSmallButton} onPress={onClose}>
          <Feather name="x" size={18} color="#fff" />
        </Pressable>
        <Pressable style={styles.miniPipSmallButton} onPress={onMaximize}>
          <Feather name="maximize-2" size={18} color="#fff" />
        </Pressable>
      </View>

      {/* Center row: skip backward, play/pause, skip forward */}
      <View style={styles.miniPipControlsRow}>
        <Pressable style={styles.miniPipSkipButton} onPress={onSeekBackward}>
          <Feather name="rotate-ccw" size={18} color="#fff" />
        </Pressable>
        <Pressable style={styles.miniPipPlayButton} onPress={onPlayPause}>
          <Ionicons name={isPlaying ? 'pause' : 'play'} size={28} color="#fff" />
        </Pressable>
        <Pressable style={styles.miniPipSkipButton} onPress={onSeekForward}>
          <Feather name="rotate-cw" size={18} color="#fff" />
        </Pressable>
      </View>
    </Animated.View>
  )
})
