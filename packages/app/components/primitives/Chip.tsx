import { useCallback } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { Feather } from '@expo/vector-icons'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { colors } from '@/lib/colors'
import { springs } from '@/lib/motion'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface ChipProps {
  label: string
  selected?: boolean
  onPress: () => void
  icon?: keyof typeof Feather.glyphMap
}

/** Filter / segment pill with the shared press spring. */
export function Chip({ label, selected = false, onPress, icon }: ChipProps) {
  const scale = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.94, springs.press)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springs.press)
  }, [scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, selected && styles.chipSelected, animatedStyle]}
    >
      {icon ? (
        <Feather
          name={icon}
          size={13}
          color={selected ? colors.onPrimary : colors.textSecondary}
          style={{ marginRight: 5 }}
        />
      ) : null}
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
    </AnimatedPressable>
  )
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  labelSelected: {
    color: colors.onPrimary,
  },
})
