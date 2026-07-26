import { useCallback } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ConsumerHomeView } from '@/components/media/ConsumerHomeView'
import { encodeMediaEntityRouteParam, getMediaEntityRouteId } from '@/components/media/MediaEntityDetailScreen'
import type { MediaEntitySummary } from '@peartube/core'
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
  const openEntity = useCallback((_entityId: string, item: MediaEntitySummary) => {
    const pathname = item.entityKind === 'collection'
      ? '/collection/[id]'
      : item.entityKind === 'agent'
        ? '/creator/[id]'
        : '/media/[id]'
    router.push({
      pathname,
      params: {
        id: encodeURIComponent(getMediaEntityRouteId(item as any)),
        item: encodeMediaEntityRouteParam(item as any),
      },
    })
  }, [router])

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ConsumerHomeView
        state={catalog}
        diagnostic={catalog.diagnostic}
        onRefresh={() => { void catalog.refresh() }}
        onOpenEntity={openEntity}
        contentBottomInset={Math.max(tabBar.height + 28, insets.bottom + 28)}
      />
    </View>
  )
}
