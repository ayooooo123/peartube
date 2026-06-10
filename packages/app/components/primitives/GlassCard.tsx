import { ReactNode, useCallback } from 'react'
import { Pressable, StyleSheet, View, ViewStyle, StyleProp } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { colors } from '@/lib/colors'
import { springs } from '@/lib/motion'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface GlassCardProps {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  /** Renders the subtle pear-tinted highlight line along the top edge. */
  highlight?: boolean
  /** Makes the card pressable with the shared press spring. */
  onPress?: () => void
  onLongPress?: () => void
  padded?: boolean
  accessibilityLabel?: string
}

/**
 * Dark translucent surface card — the base building block of the redesign.
 */
export function GlassCard({
  children,
  style,
  highlight = false,
  onPress,
  onLongPress,
  padded = true,
  accessibilityLabel,
}: GlassCardProps) {
  const scale = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.98, springs.press)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springs.press)
  }, [scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const body = (
    <>
      {highlight && <View style={styles.topHighlight} />}
      {children}
    </>
  )

  if (onPress || onLongPress) {
    return (
      <AnimatedPressable
        style={[styles.card, padded && styles.padded, animatedStyle, style]}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {body}
      </AnimatedPressable>
    )
  }

  return <View style={[styles.card, padded && styles.padded, style]}>{body}</View>
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 16,
    overflow: 'hidden',
  },
  padded: {
    padding: 16,
  },
  topHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.glassHighlight,
  },
})
