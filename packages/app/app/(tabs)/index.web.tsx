import { useCallback } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { MediaCatalogView } from '@/components/media/MediaCatalogView'
import { useMediaCatalog } from '@/hooks/useMediaCatalog'
import { colors } from '@/lib/colors'
import { useApp } from '../_layout'

export default function WebHomeScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
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
        contentBottomInset={Math.max(insets.bottom + 32, 48)}
      />
    </View>
  )
}
