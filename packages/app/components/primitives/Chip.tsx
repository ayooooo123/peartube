import { useCallback } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { Feather } from '@expo/vector-icons'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { springs } from '@/lib/motion'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface ChipProps {
  label: string
  selected?: boolean
  onPress: () => void
  icon?: keyof typeof Feather.glyphMap
  /** Optional mono count rendered after the label, e.g. `12`. */
  count?: number | string
  testID?: string
}

/** Filter / segment control. Rectangular, 2px rule, mono uppercase label. */
export function Chip({ label, selected = false, onPress, icon, count, testID }: ChipProps) {
  const scale = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.96, springs.press)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springs.press)
  }, [scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const fg = selected ? colors.onPrimary : colors.textSecondary

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={testID}
      style={[styles.chip, selected && styles.chipSelected, animatedStyle]}
    >
      {icon ? (
        <Feather name={icon} size={12} color={fg} style={styles.icon} />
      ) : null}
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
      {count !== undefined ? (
        <Text style={[styles.count, { color: selected ? colors.onPrimary : colors.textMuted }]}>{count}</Text>
      ) : null}
    </AnimatedPressable>
  )
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    height: 32,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  icon: {
    marginRight: spacing.sm - 2,
  },
  label: {
    ...fonts.caption.sm,
  },
  count: {
    ...fonts.meta.sm,
    marginLeft: spacing.sm,
  },
})
