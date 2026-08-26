import { useCallback, useEffect, useState } from 'react'
import { View, Pressable, StyleSheet, Platform, Keyboard, KeyboardEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname, useRouter } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated'
import { useVideoPlayerSession } from '@/lib/VideoPlayerContext'
import { setTabBarMetrics } from '@/lib/tabBarHeight'
import { usePlatform } from '@/lib/PlatformProvider'
import { colors, spacing, radius } from '@/lib/colors'
import * as haptics from '@/lib/haptics'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface TabItem {
  name: string
  path: string
  icon: keyof typeof Feather.glyphMap
  label: string
}

const TABS: TabItem[] = [
  { name: 'index', path: '/', icon: 'home', label: 'Home' },
  { name: 'discover', path: '/discover', icon: 'zap', label: 'Discover' },
  { name: 'library', path: '/library', icon: 'layers', label: 'Library' },
]

/** Bar height before safe-area padding, matching the reference dock. */
const BASE_TAB_HEIGHT = 52
/** Breathing room above/below the tab row inside the dock. */
const DOCK_PADDING = spacing.xs
const DOCK_HEIGHT = BASE_TAB_HEIGHT + DOCK_PADDING * 2
const DOCK_HORIZONTAL_INSET = spacing.sm
/** The shared scale tops out at 16; the dock wants the softer 24 of the reference. */
const DOCK_BORDER_RADIUS = 24
const ICON_SIZE = 20
/** Glyph box plus symmetric padding — sized so the active indicator fits it exactly. */
const TAB_CONTENT_SIZE = 24 + spacing.sm * 2
const ACTIVE_INDICATOR_WIDTH = 48
const ACTIVE_INDICATOR_HEIGHT = TAB_CONTENT_SIZE
/** How long an optimistic selection may lead the router before it snaps back. */
const OPTIMISTIC_TAB_TIMEOUT_MS = 3000

function isTabActive(pathname: string, tabPath: string): boolean {
  if (tabPath === '/') {
    return pathname === '/' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
  }

  return pathname === tabPath || pathname === `/(tabs)${tabPath}`
}

export function PillTabBar() {
  const insets = useSafeAreaInsets()
  const pathname = usePathname()
  const router = useRouter()
  const { isDesktop } = usePlatform()
  const { playerMode, isInPipMode } = useVideoPlayerSession()
  const isAndroidWatchPathActive = Platform.OS === 'android' && pathname.startsWith('/video/')

  const barVisible = useSharedValue(1)
  const keyboardVisible = useSharedValue(0)
  const bottomPadding = Math.max(insets.bottom, spacing.sm)
  const hiddenOffset = DOCK_HEIGHT + bottomPadding + spacing.xl

  // The indicator follows the finger, not the router: navigation commits a frame
  // or two later and a lagging highlight reads as a dropped tap.
  const [pendingTab, setPendingTab] = useState<string | null>(null)
  const routedTab = TABS.find((tab) => isTabActive(pathname, tab.path))?.name ?? null
  const currentTab = pendingTab ?? routedTab

  useEffect(() => {
    if (isDesktop) {
      setTabBarMetrics(0, 0)
    }
  }, [isDesktop])

  useEffect(() => {
    if (!pendingTab) return
    if (pendingTab === routedTab) {
      setPendingTab(null)
      return
    }
    const timeoutId = setTimeout(() => {
      setPendingTab((tab) => (tab === pendingTab ? null : tab))
    }, OPTIMISTIC_TAB_TIMEOUT_MS)
    return () => clearTimeout(timeoutId)
  }, [pendingTab, routedTab])

  useEffect(() => {
    const shouldHide =
      playerMode === 'fullscreen' &&
      !isInPipMode &&
      (Platform.OS !== 'android' || isAndroidWatchPathActive)
    barVisible.value = withTiming(shouldHide ? 0 : 1, { duration: 200 })
  }, [isAndroidWatchPathActive, playerMode, isInPipMode, barVisible])

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (_e: KeyboardEvent) => {
        keyboardVisible.value = withTiming(1, { duration: 200 })
      }
    )
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        keyboardVisible.value = withTiming(0, { duration: 200 })
      }
    )
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [keyboardVisible])

  useEffect(() => {
    if (isDesktop) return
    // Scrollable screens reserve this much bottom space; the dock floats out of flow.
    setTabBarMetrics(DOCK_PADDING + DOCK_HEIGHT + bottomPadding, insets.bottom)
  }, [bottomPadding, insets.bottom, isDesktop])

  const containerStyle = useAnimatedStyle(() => {
    const translateY = interpolate(barVisible.value, [0, 1], [hiddenOffset, 0], Extrapolation.CLAMP)
    const keyboardTranslate = interpolate(
      keyboardVisible.value,
      [0, 1],
      [0, hiddenOffset],
      Extrapolation.CLAMP
    )
    return {
      transform: [{ translateY: translateY + keyboardTranslate }],
      opacity: interpolate(barVisible.value, [0, 1], [0, 1], Extrapolation.CLAMP),
    }
  })

  if (isDesktop) {
    return null
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.shell, { paddingBottom: bottomPadding }, containerStyle]}
    >
      <View style={styles.dock}>
        {/* No blur: expo-blur is not a dependency, so the glass is faked with a
            translucent scrim plus a top-down sheen that fades out entirely. */}
        <LinearGradient
          pointerEvents="none"
          colors={[colors.glass, 'transparent']}
          locations={[0, 0.6]}
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" style={styles.topHighlight} />

        <View accessibilityRole="tablist" style={styles.tabsContainer}>
          {TABS.map((tab) => {
            const isActive = currentTab === tab.name

            return (
              <TabButton
                key={tab.name}
                tab={tab}
                isActive={isActive}
                onPress={() => {
                  if (isTabActive(pathname, tab.path)) {
                    setPendingTab(null)
                    return
                  }
                  haptics.tabSwitch()
                  setPendingTab(tab.name)
                  router.replace(tab.path as any)
                }}
              />
            )
          })}
        </View>
      </View>
    </Animated.View>
  )
}

interface TabButtonProps {
  tab: TabItem
  isActive: boolean
  onPress: () => void
}

function TabButton({ tab, isActive, onPress }: TabButtonProps) {
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.96, { damping: 15, stiffness: 400 })
    opacity.value = withTiming(0.72, { duration: 100 })
  }, [opacity, scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 })
    opacity.value = withTiming(1, { duration: 100 })
  }, [opacity, scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }))

  const iconSize = ICON_SIZE
  const iconColor = isActive ? colors.onPrimary : colors.textSecondary

  return (
    <AnimatedPressable
      style={[styles.tabButton, animatedStyle]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="tab"
      accessibilityLabel={tab.label}
      accessibilityState={{ selected: isActive }}
    >
      <View style={styles.tabContent}>
        {isActive ? <View pointerEvents="none" style={styles.activeIndicator} /> : null}
        {/* Unselected glyphs sit on an unpredictable backdrop, so a soft drop shadow
            keeps them legible. The selected glyph rides the accent pill instead. */}
        <Feather name={tab.icon} size={iconSize} color={iconColor} style={isActive ? undefined : styles.inactiveIcon} />
      </View>
    </AnimatedPressable>
  )
}

const styles = StyleSheet.create({
  shell: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    paddingTop: DOCK_PADDING,
    paddingHorizontal: DOCK_HORIZONTAL_INSET,
    backgroundColor: 'transparent',
  },
  dock: {
    minHeight: DOCK_HEIGHT,
    borderRadius: DOCK_BORDER_RADIUS,
    overflow: 'hidden',
    backgroundColor: colors.scrim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    shadowColor: colors.contrast,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.34,
    shadowRadius: 22,
    elevation: 14,
  },
  topHighlight: {
    position: 'absolute',
    top: 0,
    left: spacing.lg,
    right: spacing.lg,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.glassBorder,
  },
  tabsContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: DOCK_PADDING,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  tabContent: {
    position: 'relative',
    width: TAB_CONTENT_SIZE,
    height: TAB_CONTENT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeIndicator: {
    position: 'absolute',
    top: 0,
    left: (TAB_CONTENT_SIZE - ACTIVE_INDICATOR_WIDTH) / 2,
    width: ACTIVE_INDICATOR_WIDTH,
    height: ACTIVE_INDICATOR_HEIGHT,
    borderRadius: ACTIVE_INDICATOR_HEIGHT / 2,
    backgroundColor: colors.primary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
  },
  inactiveIcon: {
    textShadowColor: colors.contrast,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 5,
  },
})
