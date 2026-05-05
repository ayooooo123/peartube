import { useCallback, useEffect } from 'react'
import { View, Pressable, StyleSheet, Platform, Keyboard, KeyboardEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePathname, useRouter } from 'expo-router'
import { Feather } from '@expo/vector-icons'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated'
import { useVideoPlayerContext } from '@/lib/VideoPlayerContext'
import { setTabBarMetrics } from '@/lib/tabBarHeight'
import { usePlatform } from '@/lib/PlatformProvider'
import { colors } from '@/lib/colors'

let BlurView: any = null
try {
  BlurView = require('expo-blur').BlurView
} catch {
  // Optional dependency - falls back to solid background
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface TabItem {
  name: string
  path: string
  icon: keyof typeof Feather.glyphMap
  label: string
  emphasized?: boolean
}

const TABS: TabItem[] = [
  { name: 'index', path: '/', icon: 'home', label: 'Home' },
  { name: 'discover', path: '/discover', icon: 'zap', label: 'Discover' },
  { name: 'subscriptions', path: '/subscriptions', icon: 'users', label: 'Subs' },
  { name: 'studio', path: '/studio', icon: 'plus-circle', label: 'Studio', emphasized: true },
  { name: 'downloads', path: '/downloads', icon: 'download', label: 'Downloads' },
  { name: 'settings', path: '/settings', icon: 'settings', label: 'Settings' },
]

const PILL_HEIGHT = 56
const PILL_HORIZONTAL_MARGIN = 16
const PILL_BOTTOM_OFFSET = 8
const PILL_BORDER_RADIUS = 28
const ICON_SIZE = 22
const EMPHASIZED_ICON_SIZE = 28

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
  const { playerMode, isInPipMode, androidSplitPlayerEnabled } = useVideoPlayerContext()
  const isAndroidWatchPathActive = Platform.OS === 'android' && pathname.startsWith('/video/')
  
  const barVisible = useSharedValue(1)
  const keyboardVisible = useSharedValue(0)
  const bottomPosition = PILL_BOTTOM_OFFSET + Math.max(insets.bottom, 8)

  useEffect(() => {
    if (isDesktop) {
      setTabBarMetrics(0, 0)
    }
  }, [isDesktop])

  useEffect(() => {
    const shouldHide =
      playerMode === 'fullscreen' &&
      !isInPipMode &&
      (Platform.OS !== 'android' || androidSplitPlayerEnabled || isAndroidWatchPathActive)
    barVisible.value = withTiming(shouldHide ? 0 : 1, { duration: 200 })
  }, [androidSplitPlayerEnabled, isAndroidWatchPathActive, playerMode, isInPipMode, barVisible])

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e: KeyboardEvent) => {
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
    const totalHeight = PILL_HEIGHT + bottomPosition + PILL_BOTTOM_OFFSET
    setTabBarMetrics(totalHeight, insets.bottom)
  }, [bottomPosition, insets.bottom, isDesktop])

  const containerStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      barVisible.value,
      [0, 1],
      [PILL_HEIGHT + bottomPosition + 20, 0],
      Extrapolation.CLAMP
    )
    const keyboardTranslate = interpolate(
      keyboardVisible.value,
      [0, 1],
      [0, PILL_HEIGHT + bottomPosition + 20],
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
      style={[
        styles.container,
        { bottom: bottomPosition },
        containerStyle,
      ]}
    >
      {Platform.OS === 'ios' && BlurView ? (
        <BlurView
          intensity={80}
          tint="dark"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      
      <View style={styles.backgroundOverlay} />
      <View style={styles.topHighlight} />
      
      <View style={styles.tabsContainer}>
        {TABS.map((tab) => {
          const isActive = isTabActive(pathname, tab.path)
          
          return (
            <TabButton
              key={tab.name}
              tab={tab}
              isActive={isActive}
              onPress={() => {
                if (isActive) return
                router.replace(tab.path as any)
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
  const opacity = useSharedValue(1)

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 })
    opacity.value = withTiming(0.7, { duration: 100 })
  }, [opacity, scale])

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 })
    opacity.value = withTiming(1, { duration: 100 })
  }, [opacity, scale])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }))

  const iconSize = tab.emphasized ? EMPHASIZED_ICON_SIZE : ICON_SIZE
  const iconColor = isActive ? colors.primary : colors.textMuted

  return (
    <AnimatedPressable
      style={[
        styles.tabButton,
        tab.emphasized && styles.tabButtonEmphasized,
        animatedStyle,
      ]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      {tab.emphasized ? (
        <View style={[styles.emphasizedIconBg, isActive && styles.emphasizedIconBgActive]}>
          <Feather name={tab.icon} size={iconSize} color={isActive ? '#fff' : colors.textMuted} />
        </View>
      ) : (
        <Feather name={tab.icon} size={iconSize} color={iconColor} />
      )}
    </AnimatedPressable>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: PILL_HORIZONTAL_MARGIN,
    right: PILL_HORIZONTAL_MARGIN,
    height: PILL_HEIGHT,
    borderRadius: PILL_BORDER_RADIUS,
    overflow: 'hidden',
    ...Platform.select({
      android: {
        elevation: 8,
        backgroundColor: colors.bgElevated,
      },
      ios: {
        backgroundColor: 'transparent',
      },
    }),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  backgroundOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Platform.OS === 'ios' 
      ? 'rgba(24, 24, 27, 0.75)'
      : colors.bgElevated,
  },
  topHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  tabsContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  tabButtonEmphasized: {
    flex: 1.2,
  },
  emphasizedIconBg: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emphasizedIconBgActive: {
    backgroundColor: colors.primary,
  },
})
