/**
 * Tab Navigation Layout
 *
 * Platform-specific navigation:
 * - Desktop (Pear): DesktopLayout with header, collapsible sidebar, and content area
 * - Mobile (iOS/Android): Bottom tab bar
 */
import { useState, useEffect, useCallback } from 'react'
import { Tabs, Slot } from 'expo-router'
import { Home, Film, Users, Settings } from 'lucide-react-native'
import { View, Platform } from 'react-native'
import { BottomTabBar, type BottomTabBarProps } from '@react-navigation/bottom-tabs'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePlatform } from '@/lib/PlatformProvider'
import { DesktopLayout } from '@/components/desktop/DesktopLayout'
import { setTabBarMetrics } from '@/lib/tabBarHeight'
import { colors } from '../_layout'

export default function TabLayout() {
  const { isDesktop: platformIsDesktop } = usePlatform()
  const safeInsets = useSafeAreaInsets()
  const TAB_BAR_HEIGHT = 42

  // Use state to avoid hydration mismatch - SSR always renders mobile,
  // then client updates to desktop if needed
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    setIsDesktop(platformIsDesktop)
  }, [platformIsDesktop])

  // Custom tab bar that measures its rendered height and stores it for the mini player
  const MeasuredTabBar = (props: BottomTabBarProps) => {
    const onLayout = useCallback((e: any) => {
      const height = e?.nativeEvent?.layout?.height
      const paddingBottom = props.safeAreaInsets?.bottom ?? 0
      setTabBarMetrics(height, paddingBottom)
    }, [props.safeAreaInsets?.bottom])

    return (
      <View onLayout={onLayout}>
        <BottomTabBar {...props} />
      </View>
    )
  }

  // Desktop: Full desktop layout with header, sidebar, and content
  if (isDesktop) {
    return (
      <DesktopLayout>
        <Slot />
      </DesktopLayout>
    )
  }

  // Mobile: Bottom tab bar (also rendered during SSR)
  return (
    <View style={{ flex: 1, paddingTop: safeInsets.top }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.bgSecondary,
            borderTopColor: colors.border,
            borderTopWidth: 0,
            height: TAB_BAR_HEIGHT + safeInsets.bottom,
            paddingBottom: safeInsets.bottom,
            paddingTop: 0,
          },
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '500',
          },
          tabBarIconStyle: {
            marginBottom: 2,
          },
          sceneContainerStyle: {
            backgroundColor: colors.bg,
          },
        }}
        tabBar={(props) => <MeasuredTabBar {...props} />}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => <Home color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="subscriptions"
          options={{
            title: 'Subs',
            tabBarIcon: ({ color }) => <Users color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="studio"
          options={{
            title: 'Studio',
            tabBarIcon: ({ color }) => <Film color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color }) => <Settings color={color} size={22} />,
          }}
        />
      </Tabs>
    </View>
  )
}
