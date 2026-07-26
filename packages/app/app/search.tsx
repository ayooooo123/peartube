import { useCallback, useMemo, useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { MediaEntitySummary } from '@peartube/core'

import { MediaCatalogView } from '@/components/media/MediaCatalogView'
import {
  encodeMediaEntityRouteParam,
  getMediaEntityRouteId,
} from '@/components/media/MediaEntityDetailScreen'
import { useMediaCatalog } from '@/hooks/useMediaCatalog'
import { colors } from '@/lib/colors'
import { searchMediaCatalog } from '@/lib/media-catalog-controller.mjs'
import { usePlatform } from '@/lib/PlatformProvider'
import { useApp } from './_layout'

function MobileSearchBar({
  initialQuery,
  searching,
  onSubmit,
}: {
  initialQuery: string
  searching: boolean
  onSubmit(query: string): void
}) {
  const [queryInput, setQueryInput] = useState(initialQuery)
  const handleSubmit = useCallback(() => {
    const nextQuery = queryInput.trim()
    if (nextQuery) onSubmit(nextQuery)
  }, [onSubmit, queryInput])

  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
    }}>
      <View style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgSecondary,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: Platform.OS === 'web' ? 8 : 10,
      }}>
        <Feather name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={queryInput}
          onChangeText={setQueryInput}
          placeholder="Search the media catalog"
          placeholderTextColor={colors.textMuted}
          style={{ flex: 1, color: colors.text, marginLeft: 8 }}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={handleSubmit}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search media catalog"
        onPress={handleSubmit}
        disabled={!queryInput.trim() || searching}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 12,
          backgroundColor: colors.primary,
          opacity: (!queryInput.trim() || searching) ? 0.5 : 1,
        }}
      >
        <Text style={{ color: colors.onPrimary, fontWeight: '700' }}>
          {searching ? 'Searching…' : 'Search'}
        </Text>
      </Pressable>
    </View>
  )
}

export default function SearchScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ q?: string }>()
  const { isDesktop, insets } = usePlatform()
  const { ready, rpc, platformEvents, backendError, startupStatus } = useApp()
  const query = typeof params.q === 'string' ? params.q.trim() : ''

  const searchRpc = useMemo(() => {
    if (!rpc || typeof rpc.getMediaCatalog !== 'function' || !query) return null
    return {
      getMediaCatalog: (request: { cursor?: string; limit?: number }) => searchMediaCatalog({
        getMediaCatalog: (catalogRequest) => rpc.getMediaCatalog(catalogRequest),
        query,
        cursor: request.cursor,
        limit: request.limit,
      }),
    }
  }, [query, rpc])

  const catalog = useMediaCatalog({
    ready: ready && Boolean(query),
    rpc: searchRpc,
    events: platformEvents,
    diagnostics: { backendError, startupStatus },
  })

  const submitSearch = useCallback((nextQuery: string) => {
    router.replace({ pathname: '/search', params: { q: nextQuery } })
  }, [router])

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
    <View style={{
      flex: 1,
      backgroundColor: colors.bg,
      paddingTop: isDesktop ? 0 : insets.top,
    }}>
      {!isDesktop ? (
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
            <Feather name="arrow-left" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginLeft: 16 }}>
            Search
          </Text>
        </View>
      ) : null}

      {!isDesktop ? (
        <MobileSearchBar
          key={query}
          initialQuery={query}
          searching={catalog.status === 'loading' || catalog.refreshing}
          onSubmit={submitSearch}
        />
      ) : null}

      {query ? (
        <MediaCatalogView
          title={`Search results for “${query}”`}
          subtitle="Results from the locally projected, moderated media catalog"
          state={catalog}
          diagnostic={catalog.diagnostic}
          onRefresh={() => { void catalog.refresh() }}
          onLoadNext={() => { void catalog.loadNext() }}
          onEntityPress={openEntity}
          contentBottomInset={Math.max(insets.bottom + 24, 24)}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
          <Feather name="search" size={42} color={colors.textMuted} />
          <Text style={{ color: colors.text, fontSize: 19, fontWeight: '700' }}>Search your media catalog</Text>
          <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
            Search only includes entities currently visible under your local moderation profile.
          </Text>
        </View>
      )}
    </View>
  )
}
