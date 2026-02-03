/**
 * MiniPlayerProgressBar - Progress bar for mobile mini player
 *
 * A thin progress bar shown at the bottom of the mini player.
 */

import { memo } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { styles } from './styles'

interface MiniPlayerProgressBarProps {
  progress: number // 0-1
  animatedStyle?: any
}

export const MiniPlayerProgressBar = memo(function MiniPlayerProgressBar({
  progress,
  animatedStyle,
}: MiniPlayerProgressBarProps) {
  return (
    <Animated.View style={[styles.miniPipProgressBar, animatedStyle]} pointerEvents="none">
      <View style={[styles.miniPipProgressFill, { width: `${progress * 100}%` }]} />
    </Animated.View>
  )
})
