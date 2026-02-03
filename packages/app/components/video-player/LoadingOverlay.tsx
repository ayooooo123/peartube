/**
 * LoadingOverlay - Loading indicator for video player
 *
 * Displays a loading spinner with optional label while video is connecting/buffering.
 */

import { memo } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { styles } from './styles'

interface LoadingOverlayProps {
  label?: string
  visible: boolean
}

export const LoadingOverlay = memo(function LoadingOverlay({
  label = 'Connecting to P2P...',
  visible,
}: LoadingOverlayProps) {
  if (!visible) return null

  return (
    <View style={styles.loadingOverlay}>
      <ActivityIndicator color="white" size="large" />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  )
})
