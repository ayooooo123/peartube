/**
 * SeekBar - Progress bar with seek functionality
 *
 * Displays playback progress and allows seeking.
 * Uses the VideoProgressContext for high-frequency progress updates.
 */

import { memo, useRef } from 'react'
import { View, Text } from 'react-native'
import Animated from 'react-native-reanimated'
import { colors } from '@/lib/colors'
import { styles } from './styles'
import { formatDuration } from './formatters'

interface SeekBarProps {
  // Progress state
  effectiveDuration: number
  effectiveProgress: number

  // Seek state
  isSeeking: boolean
  seekPosition: number

  // Callbacks
  onSeekStart: (locationX: number, barWidth: number) => void
  onSeekMove: (locationX: number, barWidth: number) => void
  onSeekEnd: () => void

  // Animated style from parent
  progressBarStyle?: any

  // Casting mode
  isCasting?: boolean
}

export const SeekBar = memo(function SeekBar({
  effectiveDuration,
  effectiveProgress,
  isSeeking,
  seekPosition,
  onSeekStart,
  onSeekMove,
  onSeekEnd,
  progressBarStyle,
  isCasting,
}: SeekBarProps) {
  const progressBarRef = useRef<View>(null)
  const progressBarWidth = useRef(0)

  const handleTouchStart = (e: any) => {
    const locationX = e.nativeEvent.locationX
    onSeekStart(locationX, progressBarWidth.current)
  }

  const handleTouchMove = (e: any) => {
    if (isSeeking) {
      const locationX = e.nativeEvent.locationX
      onSeekMove(locationX, progressBarWidth.current)
    }
  }

  const handleTouchEnd = () => {
    if (isSeeking) {
      onSeekEnd()
    }
  }

  const handleLayout = (e: any) => {
    progressBarWidth.current = e.nativeEvent.layout.width
  }

  // Calculate progress percentage
  const progressPercent = isSeeking
    ? (seekPosition / (effectiveDuration || 1)) * 100
    : effectiveProgress * 100

  return (
    <Animated.View
      style={progressBarStyle}
      ref={progressBarRef}
      onLayout={handleLayout}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Seek time preview */}
      {isSeeking && (
        <View style={[styles.seekTimePreview, { left: `${(seekPosition / (effectiveDuration || 1)) * 100}%` }]}>
          <Text style={styles.seekTimeText}>{formatDuration(seekPosition)}</Text>
        </View>
      )}

      {/* Progress track */}
      <View style={[styles.thinProgressBg, isSeeking && styles.thinProgressBgActive]}>
        <View
          style={[
            styles.thinProgressFill,
            isSeeking && styles.thinProgressFillActive,
            { width: `${progressPercent}%` }
          ]}
        />
      </View>

      {/* Scrubber handle (only visible when seeking) */}
      {isSeeking && (
        <View
          style={[
            styles.scrubberHandle,
            { left: `${(seekPosition / (effectiveDuration || 1)) * 100}%` }
          ]}
        />
      )}
    </Animated.View>
  )
})
