import { Tabs, Slot } from 'expo-router'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePlatform } from '@/lib/PlatformProvider'
import { DesktopLayout } from '@/components/desktop/DesktopLayout'
import { PillTabBar } from '@/components/PillTabBar'
import { colors } from '../_layout'

export default function TabLayout() {
  const { isDesktop } = usePlatform()
  const safeInsets = useSafeAreaInsets()

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
        <Tabs.Screen name="subscriptions" />
        <Tabs.Screen name="studio" />
        <Tabs.Screen name="downloads" />
        <Tabs.Screen name="search" />
        <Tabs.Screen name="settings" />
      </Tabs>
    </View>
  )
}
