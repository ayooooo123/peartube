import { useCallback, useEffect, useState } from 'react'
import { View, Pressable, StyleSheet, Platform, Keyboard, KeyboardEvent, Text, LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname, useRouter, type Href } from 'expo-router'
import { Feather } from '@expo/vector-icons'
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
import { colors, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { springs } from '@/lib/motion'
import * as haptics from '@/lib/haptics'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)
const AnimatedView = Animated.createAnimatedComponent(View)

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

/** Tab row height, under the 2px top rule. */
const BASE_TAB_HEIGHT = 56
/** Rule plus row: what scrollable screens must reserve above the safe area. */
const BAR_HEIGHT = BASE_TAB_HEIGHT + borderWidth.rule
const ICON_SIZE = 20
/** How long an optimistic selection may lead the router before it snaps back. */
const OPTIMISTIC_TAB_TIMEOUT_MS = 3000

function isTabActive(pathname: string, tabPath: string): boolean {
  if (tabPath === '/') {
    return pathname === '/' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
  }

  return pathname === tabPath || pathname === `/(tabs)${tabPath}`
}

export function TabBar() {
  const insets = useSafeAreaInsets()
  const pathname = usePathname()
  const router = useRouter()
  const { isDesktop } = usePlatform()
  const { playerMode, isInPipMode } = useVideoPlayerSession()
  const isAndroidWatchPathActive = Platform.OS === 'android' && pathname.startsWith('/video/')

  const barVisible = useSharedValue(1)
  const keyboardVisible = useSharedValue(0)
  const bottomPadding = Math.max(insets.bottom, spacing.sm)
  const hiddenOffset = BAR_HEIGHT + bottomPadding + spacing.xl

  // The indicator follows the finger, not the router: navigation commits a frame
  // or two later and a lagging highlight reads as a dropped tap.
  const [pendingTab, setPendingTab] = useState<string | null>(null)
  const routedTab = TABS.find((tab) => isTabActive(pathname, tab.path))?.name ?? null
  const currentTab = pendingTab ?? routedTab
  const currentTabIndex = TABS.findIndex((tab) => tab.name === currentTab)

  const [containerWidth, setContainerWidth] = useState(0)
  const cellWidth = containerWidth / TABS.length

  const indicatorTranslateX = useSharedValue(0)

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
    // Scrollable screens reserve this much bottom space; the bar sits in flow.
    setTabBarMetrics(BAR_HEIGHT + bottomPadding, insets.bottom)
  }, [bottomPadding, insets.bottom, isDesktop])

  // The lime indicator slides along the top rule to the active cell.
  useEffect(() => {
    if (currentTabIndex >= 0 && cellWidth > 0) {
      indicatorTranslateX.value = withSpring(currentTabIndex * cellWidth, springs.snappy)
    }
  }, [currentTabIndex, cellWidth, indicatorTranslateX])

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

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorTranslateX.value }],
  }))

  if (isDesktop) {
    return null
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.shell, { paddingBottom: bottomPadding }, containerStyle]}
    >
      <View pointerEvents="none" style={styles.topRule} />
      <View
        accessibilityRole="tablist"
        style={styles.tabsContainer}
        onLayout={(e: LayoutChangeEvent) => setContainerWidth(e.nativeEvent.layout.width)}
      >
        <AnimatedView pointerEvents="none" style={[styles.activeIndicator, indicatorStyle, { width: cellWidth }]} />
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
                router.replace(tab.path as Href)
              }}
            />
          )
        })}
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

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.96, springs.press)
  }, [scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springs.press)
  }, [scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }))

  const iconColor = isActive ? colors.primary : colors.textMuted
  const labelColor = isActive ? colors.primary : colors.textMuted

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
        <Feather name={tab.icon} size={ICON_SIZE} color={iconColor} />
        <Text style={[styles.label, { color: labelColor }]}>{tab.label}</Text>
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
    backgroundColor: colors.bg,
  },
  topRule: {
    height: borderWidth.rule,
    backgroundColor: colors.border,
  },
  tabsContainer: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-around',
    height: BASE_TAB_HEIGHT,
    backgroundColor: colors.bg,
  },
  activeIndicator: {
    position: 'absolute',
    // Sits on top of the rule so the lime replaces the grey under the active cell.
    top: -borderWidth.rule,
    left: 0,
    height: borderWidth.rule,
    backgroundColor: colors.primary,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  tabContent: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  label: {
    ...fonts.caption.sm,
    textAlign: 'center',
  },
})
