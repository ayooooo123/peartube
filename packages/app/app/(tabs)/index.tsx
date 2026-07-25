import { useCallback } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { MediaCatalogView } from '@/components/media/MediaCatalogView'
import { useMediaCatalog } from '@/hooks/useMediaCatalog'
import { useTabBarMetrics } from '@/lib/tabBarHeight'
import { colors } from '@/lib/colors'
import { useApp } from '../_layout'

export default function HomeScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const tabBar = useTabBarMetrics()
  const { ready, rpc, platformEvents, backendError, startupStatus } = useApp()
  const catalog = useMediaCatalog({
    ready,
    rpc,
    events: platformEvents,
    diagnostics: { backendError, startupStatus },
  })
  const openEntity = useCallback((entityId: string) => {
    router.push({ pathname: '/media/[id]', params: { id: entityId } })
  }, [router])

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MediaCatalogView
        title="Home"
        subtitle="Resolved media from publishers you are authorized to discover"
        state={catalog}
        diagnostic={catalog.diagnostic}
        onRefresh={() => { void catalog.refresh() }}
        onLoadNext={() => { void catalog.loadNext() }}
        onEntityPress={openEntity}
        contentBottomInset={Math.max(tabBar.height + 28, insets.bottom + 28)}
      />
    </View>
  )
}
