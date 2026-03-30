/**
 * ControlsPanel - Unified bottom controls panel
 *
 * A single floating panel at the bottom of the video player containing:
 * - Scrubber (progress bar) at top
 * - Time row: current/duration on left, speed + landscape toggle on right
 *
 * Presentational only — parent owns positioning (containerStyle) and visibility logic.
 */

import { memo, useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Feather } from '@expo/vector-icons'
import type { GestureType } from 'react-native-gesture-handler'
import { Scrubber } from './Scrubber'
import { formatDuration } from './formatters'
import { styles } from './styles'

interface ControlsPanelProps {
  // Visibility — parent-controlled, panel animates its own opacity
  visible: boolean

  // Positioning — parent computes per mode (portrait/landscape fullscreen)
  containerStyle: any

  // Scrubber props
  duration: number
  currentTime: number
  progress: number
  bufferProgress: number
  pendingSeekTime: number | null
  scrubberDisabled: boolean
  externalGesture?: GestureType
  onSeekCommit: (time: number) => void

  // Time display
  isSeeking: boolean
  seekPosition: number

  // Speed button
  playbackRate: number
  onCycleSpeed: () => void

  // Landscape toggle
  isLandscape: boolean
  onToggleLandscape: () => void
}

export const ControlsPanel = memo(function ControlsPanel({
  visible,
  containerStyle,
  duration,
  currentTime,
  progress,
  bufferProgress,
  pendingSeekTime,
  scrubberDisabled,
  externalGesture,
  onSeekCommit,
  isSeeking,
  seekPosition,
  playbackRate,
  onCycleSpeed,
  isLandscape,
  onToggleLandscape,
}: ControlsPanelProps) {
  // Animate opacity on visibility change
  const opacitySV = useSharedValue(visible ? 1 : 0)
  useEffect(() => {
    opacitySV.value = withTiming(visible ? 1 : 0, { duration: 200 })
  }, [visible, opacitySV])

  const opacityStyle = useAnimatedStyle(() => ({
    opacity: opacitySV.value,
  }), [])

  const displayedTime = isSeeking ? seekPosition : currentTime

  return (
    <Animated.View
      style={[styles.controlsPanel, containerStyle, opacityStyle]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      {/* Scrubber — full width, panel padding provides margins */}
      <Scrubber
        duration={duration}
        currentTime={currentTime}
        progress={progress}
        bufferProgress={bufferProgress}
        pendingSeekTime={pendingSeekTime}
        disabled={scrubberDisabled}
        externalGesture={externalGesture}
        onSeekCommit={onSeekCommit}
      />

      {/* Time row: time left, buttons right */}
      <View style={styles.controlsPanelTimeRow}>
        <Text style={styles.timeText}>
          <Text style={styles.timeTextCurrent}>
            {formatDuration(displayedTime)}
          </Text>
          <Text style={styles.timeTextMuted}>
            {' / '}
            {formatDuration(duration)}
          </Text>
        </Text>

        <View style={styles.controlsPanelButtonGroup}>
          {/* Speed button */}
          <Pressable onPress={onCycleSpeed} style={styles.controlsPanelButton}>
            <Text style={styles.speedButtonText}>{playbackRate}x</Text>
          </Pressable>

          {/* Landscape toggle */}
          <Pressable onPress={onToggleLandscape} style={styles.controlsPanelButton}>
            <Feather
              name={isLandscape ? 'minimize' : 'maximize'}
              color="#efeff1"
              size={20}
            />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  )
})
