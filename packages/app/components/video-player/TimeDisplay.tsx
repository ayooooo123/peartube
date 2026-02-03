/**
 * TimeDisplay - Current time / duration display
 *
 * Shows the current playback position and total duration.
 * Optimized to only re-render when time values change.
 */

import { memo } from 'react'
import { Text } from 'react-native'
import { formatDuration } from './formatters'
import { styles } from './styles'

interface TimeDisplayProps {
  currentTime: number
  duration: number
  isSeeking?: boolean
  seekPosition?: number
}

export const TimeDisplay = memo(function TimeDisplay({
  currentTime,
  duration,
  isSeeking,
  seekPosition,
}: TimeDisplayProps) {
  const displayTime = isSeeking && seekPosition !== undefined ? seekPosition : currentTime

  return (
    <Text style={styles.timeText}>
      {formatDuration(displayTime)} / {formatDuration(duration)}
    </Text>
  )
})
