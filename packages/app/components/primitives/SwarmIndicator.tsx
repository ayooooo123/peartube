import { useEffect, useMemo } from 'react'
import { StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { colors, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'

type SwarmLevel = 'offline' | 'connected' | 'strong'

interface SwarmIndicatorProps {
  /** Number of connected peers; drives pulse intensity and the auto label. */
  peers: number
  /**
   * 'auto' renders the level label, 'count' renders `N PEERS`, a string
   * renders as-is, and omitting it renders the square alone.
   */
  label?: 'auto' | 'count' | string
  size?: number
  style?: StyleProp<ViewStyle>
}

function levelFor(peers: number): SwarmLevel {
  if (peers <= 0) return 'offline'
  if (peers < 5) return 'connected'
  return 'strong'
}

const AUTO_LABELS: Record<SwarmLevel, string> = {
  offline: 'CONNECTING',
  connected: 'SWARM OK',
  strong: 'SWARM STRONG',
}

/**
 * Ambient peer-presence indicator — PearTube's signature element.
 *
 * A small cyan square with a looping pulse whose intensity follows the swarm:
 * grey and still while connecting, a slow pulse with a few peers, and a
 * brighter, faster pulse on a strong swarm. Labels are mono uppercase.
 */
export function SwarmIndicator({ peers, label, size = 8, style }: SwarmIndicatorProps) {
  const level = levelFor(peers)
  const pulse = useSharedValue(0)

  useEffect(() => {
    if (level === 'offline') {
      cancelAnimation(pulse)
      pulse.value = 0
      return
    }
    const duration = level === 'strong' ? 1100 : 1800
    pulse.value = 0
    pulse.value = withRepeat(
      withTiming(1, { duration, easing: Easing.out(Easing.ease) }),
      -1,
      false
    )
    return () => cancelAnimation(pulse)
  }, [level, pulse])

  const maxScale = level === 'strong' ? 2.6 : 2.0
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * (maxScale - 1) }],
    opacity: (1 - pulse.value) * (level === 'strong' ? 0.9 : 0.6),
  }), [level, maxScale])

  const dotColor = level === 'offline' ? colors.textDisabled : colors.swarm
  const resolvedLabel = useMemo(() => {
    if (label === 'auto') return AUTO_LABELS[level]
    if (label === 'count') return `${peers} ${peers === 1 ? 'PEER' : 'PEERS'}`
    return label
  }, [label, level, peers])

  return (
    <View style={[styles.row, style]} accessibilityLabel={resolvedLabel ?? AUTO_LABELS[level]}>
      <View style={{ width: size * 3, height: size * 3, alignItems: 'center', justifyContent: 'center' }}>
        {level !== 'offline' && (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                width: size,
                height: size,
                backgroundColor: level === 'strong' ? colors.swarmGlow : colors.swarmDim,
              },
              ringStyle,
            ]}
          />
        )}
        <View style={{ width: size, height: size, backgroundColor: dotColor }} />
      </View>
      {resolvedLabel ? (
        <Text style={[styles.label, level !== 'offline' && { color: colors.swarm }]}>{resolvedLabel}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    ...fonts.caption.sm,
    color: colors.textMuted,
    marginLeft: spacing.xs,
  },
})
