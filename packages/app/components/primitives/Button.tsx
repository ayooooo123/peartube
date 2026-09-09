import { useCallback } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native'
import { Feather } from '@expo/vector-icons'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { springs } from '@/lib/motion'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps {
  label: string
  onPress?: () => void
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: keyof typeof Feather.glyphMap
  /** Icon on the trailing edge instead of leading. */
  iconAfter?: boolean
  disabled?: boolean
  loading?: boolean
  /** Stretch to the container width. */
  block?: boolean
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
  testID?: string
}

/**
 * Rectangular action. Primary is a lime slab with black uppercase label;
 * secondary is an outlined slab; ghost is text-only; danger is red-outlined.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconAfter = false,
  disabled = false,
  loading = false,
  block = false,
  style,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const scale = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97, springs.press)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springs.press)
  }, [scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const palette = VARIANTS[variant]
  const metrics = SIZES[size]
  const inactive = disabled || loading
  const iconSize = size === 'sm' ? 13 : size === 'lg' ? 18 : 15

  const iconNode = icon ? (
    <Feather name={icon} size={iconSize} color={palette.fg} />
  ) : null

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive }}
      testID={testID}
      style={[
        styles.base,
        { backgroundColor: palette.bg, borderColor: palette.border },
        metrics.shell,
        block && styles.block,
        inactive && styles.disabled,
        animatedStyle,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        <View style={styles.row}>
          {!iconAfter && iconNode}
          <Text
            style={[styles.label, metrics.label, { color: palette.fg }, icon ? (iconAfter ? styles.labelBeforeIcon : styles.labelAfterIcon) : null]}
            numberOfLines={1}
          >
            {label}
          </Text>
          {iconAfter && iconNode}
        </View>
      )}
    </AnimatedPressable>
  )
}

const VARIANTS: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
  secondary: { bg: 'transparent', fg: colors.text, border: colors.borderLight },
  ghost: { bg: 'transparent', fg: colors.textSecondary, border: 'transparent' },
  danger: { bg: 'transparent', fg: colors.error, border: colors.error },
}

const SIZES: Record<ButtonSize, { shell: ViewStyle; label: { fontSize: number; lineHeight: number } }> = {
  sm: { shell: { paddingHorizontal: spacing.md, minHeight: 32 }, label: { fontSize: 11, lineHeight: 14 } },
  md: { shell: { paddingHorizontal: spacing.lg, minHeight: 44 }, label: { fontSize: 13, lineHeight: 16 } },
  lg: { shell: { paddingHorizontal: spacing.xl, minHeight: 52 }, label: { fontSize: 15, lineHeight: 18 } },
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.rule,
    borderRadius: radius.md,
    alignSelf: 'flex-start',
  },
  block: {
    alignSelf: 'stretch',
  },
  disabled: {
    opacity: 0.4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontFamily: fonts.heading,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  labelAfterIcon: {
    marginLeft: spacing.sm,
  },
  labelBeforeIcon: {
    marginRight: spacing.sm,
  },
})
