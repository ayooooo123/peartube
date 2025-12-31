/**
 * CastButton - Button to open cast device picker
 *
 * Shows a cast icon that opens a modal to select FCast/Chromecast devices.
 * When connected, the icon is highlighted.
 */

import { Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { colors } from '@/lib/colors'

interface CastButtonProps {
  available: boolean
  isConnected: boolean
  isConnecting?: boolean
  onPress: () => void
  size?: number
  color?: string
  activeColor?: string
}

export function CastButton({
  available,
  isConnected,
  isConnecting = false,
  onPress,
  size = 22,
  color = colors.text,
  activeColor = colors.primary,
}: CastButtonProps) {
  if (!available && Platform.OS === 'web') {
    // Don't show cast button on web when not available (desktop Pear only)
    return null
  }

  if (!available) {
    return null
  }

  return (
    <Pressable
      style={styles.button}
      onPress={onPress}
      disabled={isConnecting}
      accessibilityLabel={isConnected ? 'Stop casting' : 'Cast to device'}
      accessibilityRole="button"
    >
      {isConnecting ? (
        <ActivityIndicator size={size} color={activeColor} />
      ) : (
        <Feather
          name="cast"
          size={size}
          color={isConnected ? activeColor : color}
        />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
})

export default CastButton
