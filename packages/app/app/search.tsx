import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'

import { colors } from '@/lib/colors'
import { usePlatform } from '@/lib/PlatformProvider'
import { providerHitAction, resolveProviderHit, type ProviderHit, type ProviderResolution } from '@/lib/provider-consumer-flow'
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
  nextCursor: string | null
  loadingNext: boolean
  openingRef: string | null
  partial: boolean
  stale: boolean
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
type ResolvedHit =
  | { kind: 'published'; entityId: string; publicationId: string | null }
  | { kind: 'local'; entityId: string; entityKind: string }
  | { kind: 'request'; resolution: ProviderResolution }
  | { kind: 'unavailable' }

type ParsedSearchResponse = {
  hits: ProviderHit[]
  nextCursor: string | null
  partial: boolean
  stale: boolean
}

function parseSearchResponse(response: unknown): ParsedSearchResponse {
  if (!response || typeof response !== 'object' || !('success' in response)) {
    throw new Error('Search unavailable')
  }
  const hasSuccess = 'success' in response && response.success === true
  if (!hasSuccess) {
    throw new Error('Search unavailable')
  }
  const hits = 'hits' in response && Array.isArray(response.hits) ? response.hits.filter(isProviderHit) : []
  const nextCursor = 'nextCursor' in response && typeof response.nextCursor === 'string' ? response.nextCursor : null
  const partial = 'partial' in response && response.partial === true
  const stale = 'stale' in response && response.stale === true
  return { hits, nextCursor, partial, stale }
}

function mergeSearchResult(
  current: ProviderSearchState,
  parsed: ParsedSearchResponse,
  cursor: string | null,
): ProviderSearchState {
  return {
    ...current,
    status: 'ready',
    hits: cursor ? [...current.hits, ...parsed.hits] : parsed.hits,
    nextCursor: parsed.nextCursor,
    loadingNext: false,
    partial: Boolean(cursor && current.partial) || parsed.partial,
    stale: Boolean(cursor && current.stale) || parsed.stale,
  }
}

function navigateDirectHit(router: ReturnType<typeof useRouter>, hit: ProviderHit): boolean {
  if (hit.mediaKind === 'collection' && hit.entityId) {
    router.push({
      pathname: '/collection/[id]',
      params: { id: encodeURIComponent(hit.entityId) },
    })
    return true
  }
  if ((hit.mediaKind === 'creator' || hit.mediaKind === 'agent') && hit.entityId) {
    router.push({
      pathname: '/creator/[id]',
      params: { id: encodeURIComponent(hit.entityId) },
    })
    return true
  }
  return false
}

function navigateResolvedHit(router: ReturnType<typeof useRouter>, result: ResolvedHit): boolean {
  if (result.kind === 'local') {
    if (result.entityKind === 'collection') {
      router.push({
        pathname: '/collection/[id]',
        params: { id: encodeURIComponent(result.entityId) },
      })
      return true
    }
    if (result.entityKind === 'creator' || result.entityKind === 'agent') {
      router.push({
        pathname: '/creator/[id]',
        params: { id: encodeURIComponent(result.entityId) },
      })
      return true
    }
    router.push({
      pathname: '/media/[id]',
      params: { id: encodeURIComponent(result.entityId) },
    })
    return true
  }
  if (result.kind === 'published') {
    router.push({
      pathname: '/media/[id]',
      params: {
        id: encodeURIComponent(result.entityId),
        autoplay: 'true',
        ...(result.publicationId ? { publicationId: result.publicationId } : {}),
      },
    })
    return true
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
    return true
  }
  return false
}



export default function SearchScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ q?: string }>()
  const { isDesktop, insets } = usePlatform()
  const { ready, rpc } = useApp()
  const query = typeof params.q === 'string' ? params.q.trim() : ''
  const [providerSearch, setProviderSearch] = useState<ProviderSearchState>({
    status: 'idle',
    hits: [],
    nextCursor: null,
    loadingNext: false,
    openingRef: null,
    partial: false,
    stale: false,
  })

  const pendingSearch = useRef({ generation: 0, scope: 0, paging: false, query, ready, rpc })
  const requestPage = useCallback(async (cursor: string | null = null) => {
    if (cursor && (pendingSearch.current.paging || query !== pendingSearch.current.query
      || ready !== pendingSearch.current.ready || rpc !== pendingSearch.current.rpc)) return
    const generation = ++pendingSearch.current.generation
    pendingSearch.current.paging = cursor !== null
    pendingSearch.current.query = query
    pendingSearch.current.ready = ready
    pendingSearch.current.rpc = rpc
    const provider = rpc?.provider
    if (!ready || !query || typeof provider?.search !== 'function') {
      setProviderSearch({ status: 'idle', hits: [], nextCursor: null, loadingNext: false, openingRef: null, partial: false, stale: false })
      return
    }
    setProviderSearch(current => cursor
      ? { ...current, loadingNext: true }
      : { status: 'searching', hits: [], nextCursor: null, loadingNext: false, openingRef: null, partial: false, stale: false })
    try {
      const response: unknown = await provider.search({ query, limit: 20, ...(cursor ? { cursor } : {}) })
      const parsed = parseSearchResponse(response)
      if (generation !== pendingSearch.current.generation) return
      setProviderSearch(current => generation !== pendingSearch.current.generation
        ? current
        : mergeSearchResult(current, parsed, cursor))
    } catch {
      setProviderSearch(current => generation !== pendingSearch.current.generation
        ? current
        : { ...current, status: 'error', loadingNext: false })
    } finally {
      if (generation === pendingSearch.current.generation) pendingSearch.current.paging = false
    }
  }, [query, ready, rpc])

  useLayoutEffect(() => {
    void requestPage()
    return () => {
      pendingSearch.current.generation++
      pendingSearch.current.scope++
      pendingSearch.current.paging = false
    }
  }, [requestPage])

  const openProviderHit = useCallback(async (hit: ProviderHit) => {
    const provider = rpc?.provider
    const scope = pendingSearch.current.scope
    const isCurrent = () => scope === pendingSearch.current.scope
      && query === pendingSearch.current.query
      && ready === pendingSearch.current.ready
      && rpc === pendingSearch.current.rpc
    if (!ready || !provider || !isCurrent()) return
    setProviderSearch(current => isCurrent() ? { ...current, openingRef: hit.resolutionRef } : current)
    try {
      if (navigateDirectHit(router, hit)) {
        setProviderSearch(current => ({ ...current, openingRef: null }))
        return
      }
      const result = await resolveProviderHit(provider, hit)
      if (!isCurrent()) return
      if (result.kind === 'local') {
        setProviderSearch(current => ({ ...current, openingRef: null }))
      }
      const handled = navigateResolvedHit(router, result)
      if (!handled) {
        setProviderSearch(current => isCurrent() ? { ...current, status: 'error', openingRef: null } : current)
      }
    } catch {
      setProviderSearch(current => isCurrent() ? { ...current, status: 'error', openingRef: null } : current)
    }
  }, [query, ready, router, rpc])

  const submitSearch = useCallback((nextQuery: string) => {
    router.replace({ pathname: '/search', params: { q: nextQuery } })
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
          searching={providerSearch.status === 'searching'}
          onSubmit={submitSearch}
        />
      ) : null}

      {query ? (
        <FlatList
          data={providerSearch.hits}
          keyExtractor={(item) => item.resolutionRef}
          refreshing={providerSearch.status === 'searching'}
          onRefresh={() => { void requestPage() }}
          onEndReached={() => {
            if (providerSearch.nextCursor && providerSearch.status === 'ready') {
              void requestPage(providerSearch.nextCursor)
            }
          }}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingVertical: 12,
            paddingBottom: Math.max(insets.bottom + 24, 24),
            gap: 8,
          }}
          ListHeaderComponent={
            providerSearch.status === 'error' || providerSearch.partial || providerSearch.stale ? (
              <Text accessibilityRole="alert" style={{ color: colors.textMuted, paddingBottom: 8 }}>
                {providerSearch.status === 'error'
                  ? 'Search results are currently unavailable.'
                  : providerSearch.partial
                    ? 'Some index services did not respond. Results may be incomplete.'
                    : 'The index changed during this search. Refresh for current results.'}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            providerSearch.status === 'ready' && !providerSearch.partial && !providerSearch.stale ? (
              <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                <Text style={{ color: colors.textMuted, fontSize: 16 }}>No results found for “{query}”</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            providerSearch.loadingNext ? (
              <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : null
          }
          renderItem={({ item: hit }) => {
            const opening = providerSearch.openingRef === hit.resolutionRef
            const action = providerHitAction(hit)
            const actionLabel = opening
              ? 'Opening…'
              : action === 'open'
                ? 'View'
                : action === 'play'
                  ? 'Play'
                  : action === 'resolve' ? 'Request' : 'Unavailable'
            const badgeLabel = hit.subtitle
              || (hit.mediaKind === 'collection'
                ? 'Collection'
                : hit.mediaKind === 'creator' || hit.mediaKind === 'agent'
                  ? 'Creator'
                  : hit.published
                    ? 'Ready to watch'
                    : 'Available by request')
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${actionLabel} ${hit.title}`}
                disabled={Boolean(providerSearch.openingRef) || action === 'unavailable'}
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
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
                    {hit.title}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 13 }} numberOfLines={1}>
                    {badgeLabel}
                  </Text>
                </View>
                <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14 }}>
                  {actionLabel}
                </Text>
              </Pressable>
            )
          }}
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
