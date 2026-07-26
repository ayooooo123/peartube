import { useState, useEffect } from 'react'
import { Tabs, Slot } from 'expo-router'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePlatform } from '@/lib/PlatformProvider'
import { DesktopLayout } from '@/components/desktop/DesktopLayout'
import { PillTabBar } from '@/components/PillTabBar'
import { colors } from '../_layout'

export default function TabLayout() {
  const { isDesktop: platformIsDesktop } = usePlatform()
  const safeInsets = useSafeAreaInsets()

  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    setIsDesktop(platformIsDesktop)
  }, [platformIsDesktop])

  if (isDesktop) {
    return (
      <DesktopLayout>
        <Slot />
      </DesktopLayout>
    )
  }

  return (
    <View style={{ flex: 1, paddingTop: safeInsets.top }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: 'none' },
          sceneStyle: { backgroundColor: colors.bg },
        }}
        tabBar={() => <PillTabBar />}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="discover" />
        {/* Registered for deep links, but intentionally absent from consumer navigation. */}
        <Tabs.Screen name="studio" options={{ href: null }} />
        <Tabs.Screen name="library" />
        {/* Legacy routes kept as redirects so deep links survive */}
        <Tabs.Screen name="subscriptions" />
        <Tabs.Screen name="downloads" />
        <Tabs.Screen name="settings" />
      </Tabs>
    </View>
  )
}
