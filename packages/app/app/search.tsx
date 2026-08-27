import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { resolveProviderHit, type ProviderHit } from '@/lib/provider-consumer-flow'
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
type ProviderSearchState = {
  status: 'idle' | 'searching' | 'ready' | 'error'
  hits: ProviderHit[]
  openingRef: string | null
}

function isProviderHit(value: unknown): value is ProviderHit {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'resolutionRef' in value &&
    typeof value.resolutionRef === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'published' in value &&
    typeof value.published === 'boolean' &&
    'acquirable' in value &&
    typeof value.acquirable === 'boolean',
  )
}


export default function SearchScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ q?: string }>()
  const { isDesktop, insets } = usePlatform()
  const { ready, rpc, platformEvents, backendError, startupStatus } = useApp()
  const query = typeof params.q === 'string' ? params.q.trim() : ''
  const [providerSearch, setProviderSearch] = useState<ProviderSearchState>({
    status: 'idle',
    hits: [],
    openingRef: null,
  })

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
  useEffect(() => {
    const provider = rpc?.provider
    if (!ready || !query || typeof provider?.search !== 'function') {
      setProviderSearch({ status: 'idle', hits: [], openingRef: null })
      return
    }

    let active = true
    setProviderSearch({ status: 'searching', hits: [], openingRef: null })
    void (async () => {
      try {
        const response: unknown = await provider.search({ query, limit: 20 })
        if (!response || typeof response !== 'object' || !('success' in response) || response.success !== true) {
          throw new Error('Search unavailable')
        }
        const hits = 'hits' in response && Array.isArray(response.hits)
          ? response.hits.filter(isProviderHit)
          : []
        if (active) setProviderSearch({ status: 'ready', hits, openingRef: null })
      } catch {
        if (active) setProviderSearch({ status: 'error', hits: [], openingRef: null })
      }
    })()

    return () => {
      active = false
    }
  }, [query, ready, rpc])

  const openProviderHit = useCallback(async (hit: ProviderHit) => {
    const provider = rpc?.provider
    if (!provider) return
    setProviderSearch(current => ({ ...current, openingRef: hit.resolutionRef }))
    try {
      const result = await resolveProviderHit(provider, hit)
      if (result.kind === 'published') {
        router.push({
          pathname: '/media/[id]',
          params: {
            id: encodeURIComponent(result.entityId),
            autoplay: 'true',
            publicationId: result.publicationId,
          },
        })
        return
      }
      if (result.kind === 'request') {
        const routeId = result.resolution.entityId || `request:${result.resolution.resolutionRef}`
        const item = {
          entityId: routeId,
          localEntityId: routeId,
          entityKind: 'work',
          title: result.resolution.title,
          subtitle: result.resolution.subtitle || null,
          providerResolution: result.resolution,
          availability: {
            state: 'unavailable',
            observedAt: Date.now(),
            expiresAt: Date.now(),
            requiredRangeCount: 1,
            reachableRangeCount: 0,
            independentPeerCount: 0,
            completePeerCount: 0,
            offlinePlayable: false,
            archivePledged: false,
            reasonCodes: [],
          },
          sources: [],
        }
        router.push({
          pathname: '/media/[id]',
          params: {
            id: encodeURIComponent(routeId),
            item: encodeURIComponent(JSON.stringify(item)),
          },
        })
        return
      }
      setProviderSearch(current => ({ ...current, status: 'error', openingRef: null }))
    } catch {
      setProviderSearch(current => ({ ...current, status: 'error', openingRef: null }))
    }
  }, [router, rpc])


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
          searching={catalog.status === 'loading' || catalog.refreshing || providerSearch.status === 'searching'}
          onSubmit={submitSearch}
        />
      ) : null}

      {query ? (
        <>
          {providerSearch.hits.length > 0 ? (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>More results</Text>
              {providerSearch.hits.slice(0, 3).map((hit) => {
                const opening = providerSearch.openingRef === hit.resolutionRef
                return (
                  <Pressable
                    key={hit.resolutionRef}
                    accessibilityRole="button"
                    accessibilityLabel={`${hit.published ? 'Play' : 'Open'} ${hit.title}`}
                    disabled={Boolean(providerSearch.openingRef)}
                    onPress={() => { void openProviderHit(hit) }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: 12,
                      backgroundColor: colors.bgSecondary,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      opacity: providerSearch.openingRef && !opening ? 0.55 : 1,
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>{hit.title}</Text>
                      <Text style={{ color: colors.textMuted }} numberOfLines={1}>
                        {hit.subtitle || (hit.published ? 'Ready to watch' : 'Available by request')}
                      </Text>
                    </View>
                    <Text style={{ color: colors.primary, fontWeight: '700' }}>
                      {opening ? 'Opening…' : hit.published ? 'Play' : 'View'}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          ) : null}
          {providerSearch.status === 'error' ? (
            <Text accessibilityRole="alert" style={{ color: colors.textMuted, paddingHorizontal: 16, paddingBottom: 8 }}>
              More results are unavailable.
            </Text>
          ) : null}
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
        </>
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
