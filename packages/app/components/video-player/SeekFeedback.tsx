/**
 * SeekFeedback - Visual feedback for seek gestures
 *
 * Shows a ±10s indicator when the user double-taps to seek.
 */

import { memo } from 'react'
import { View, Text } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { styles } from './styles'
import { SEEK_STEP_SECONDS } from './constants'

interface SeekFeedbackProps {
  direction: 'left' | 'right' | null
}

export const SeekFeedback = memo(function SeekFeedback({ direction }: SeekFeedbackProps) {
  if (!direction) return null

  return (
    <View
      style={[
        styles.seekFeedback,
        direction === 'left' ? styles.seekFeedbackLeft : styles.seekFeedbackRight,
      ]}
    >
      {direction === 'left' ? (
        <Feather name="rotate-ccw" color="#fff" size={32} />
      ) : (
        <Feather name="rotate-cw" color="#fff" size={32} />
      )}
      <Text style={styles.seekFeedbackText}>{`${SEEK_STEP_SECONDS}s`}</Text>
    </View>
  )
})
