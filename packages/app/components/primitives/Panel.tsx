import { ReactNode, useCallback } from 'react'
import { Pressable, StyleSheet, View, ViewStyle, StyleProp } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { springs } from '@/lib/motion'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export type PanelTone = 'default' | 'accent' | 'muted' | 'danger'

interface PanelProps {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  /** Border colour. `accent` is lime, `danger` is red, `muted` is a hairline. */
  tone?: PanelTone
  /** Makes the panel pressable with the shared press spring. */
  onPress?: () => void
  onLongPress?: () => void
  padded?: boolean
  accessibilityLabel?: string
  testID?: string
}

/**
 * Opaque bordered surface — the base building block of every screen.
 * One step above the black base, 2px rule, hard 4px corners, no shadow.
 */
export function Panel({
  children,
  style,
  tone = 'default',
  onPress,
  onLongPress,
  padded = true,
  accessibilityLabel,
  testID,
}: PanelProps) {
  const scale = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.985, springs.press)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springs.press)
  }, [scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const toneStyle = TONE_STYLES[tone]

  if (onPress || onLongPress) {
    return (
      <AnimatedPressable
        style={[styles.panel, toneStyle, padded && styles.padded, animatedStyle, style]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {children}
      </AnimatedPressable>
    )
  }

  return (
    <View style={[styles.panel, toneStyle, padded && styles.padded, style]} testID={testID}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  padded: {
    padding: spacing.lg,
  },
})

const TONE_STYLES: Record<PanelTone, ViewStyle> = {
  default: {},
  accent: { borderColor: colors.primary },
  danger: { borderColor: colors.error },
  muted: { borderWidth: borderWidth.hairline, borderColor: colors.borderSubtle },
}
