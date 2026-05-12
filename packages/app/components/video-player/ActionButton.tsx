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
  accessibilityLabel?: string
}

export const ActionButton = memo(function ActionButton({
  icon: Icon,
  label,
  onPress,
  active,
  loading,
  accessibilityLabel,
}: ActionButtonProps) {
  return (
    <Pressable
      style={styles.actionButton}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: !onPress || loading, selected: Boolean(active), busy: Boolean(loading) }}
    >
      {loading ? (
        <ActivityIndicator size={20} color={colors.primary} />
      ) : (
        Icon({ color: active ? colors.primary : colors.text, size: 22 })
      )}
      <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
    </Pressable>
  )
})
