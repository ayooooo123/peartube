/**
 * ActionButton - Reusable action button for video player
 *
 * Used for like, share, download, cast, and more actions.
 * Memoized to prevent re-renders during playback.
 */

import { memo } from 'react'
import { Pressable, Text, ActivityIndicator } from 'react-native'
import { colors } from '@/lib/colors'
import { styles } from './styles'

interface ActionButtonProps {
  icon: (props: { color: string; size: number }) => React.ReactNode
  label: string
  onPress?: () => void
  active?: boolean
  loading?: boolean
}

export const ActionButton = memo(function ActionButton({
  icon: Icon,
  label,
  onPress,
  active,
  loading,
}: ActionButtonProps) {
  return (
    <Pressable style={styles.actionButton} onPress={onPress}>
      {loading ? (
        <ActivityIndicator size={20} color={colors.primary} />
      ) : (
        Icon({ color: active ? colors.primary : colors.text, size: 22 })
      )}
      <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
    </Pressable>
  )
})
