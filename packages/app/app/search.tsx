import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'

import { Button, EmptyState, Panel, ScreenHeader } from '@/components/primitives'
import { colors, radius, spacing, borderWidth, fontSize } from '@/lib/colors'
import { fonts } from '@/lib/typography'
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
  const [focused, setFocused] = useState(false)
  const handleSubmit = useCallback(() => {
    const nextQuery = queryInput.trim()
    if (nextQuery) onSubmit(nextQuery)
  }, [onSubmit, queryInput])

  return (
    <View style={styles.searchBar}>
      <View style={[styles.inputShell, focused && styles.inputShellFocused]}>
        <Feather name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={queryInput}
          onChangeText={setQueryInput}
          placeholder="SEARCH THE SWARM"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={handleSubmit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </View>
      <Button
        label={searching ? 'Searching…' : 'Search'}
        onPress={handleSubmit}
        disabled={!queryInput.trim() || searching}
        loading={searching}
        size="md"
        accessibilityLabel="Search media catalog"
      />
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
    <View style={[styles.screen, { paddingTop: isDesktop ? 0 : insets.top }]}>
      {!isDesktop ? (
        <ScreenHeader title="Search" onBack={() => router.back()} />
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
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            paddingBottom: Math.max(insets.bottom + spacing.xl, spacing.xl),
            gap: spacing.sm,
          }}
          ListHeaderComponent={
            providerSearch.status === 'error' || providerSearch.partial || providerSearch.stale ? (
              <Text accessibilityRole="alert" style={styles.providerError}>
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
              <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
                <Text style={{ color: colors.textMuted, fontSize: fontSize.md }}>No results found for “{query}”</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            providerSearch.loadingNext ? (
              <View style={{ paddingVertical: spacing.lg, alignItems: 'center' }}>
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
            const busy = Boolean(providerSearch.openingRef)
            return (
              <Panel
                onPress={busy || action === 'unavailable' ? undefined : () => { void openProviderHit(hit) }}
                accessibilityLabel={`${actionLabel} ${hit.title}`}
                style={[
                  styles.providerHit,
                  busy && !opening ? { opacity: 0.55 } : null,
                ]}
              >
                <View style={styles.providerHitCopy}>
                  <Text style={styles.hitTitle} numberOfLines={1}>
                    {hit.title}
                  </Text>
                  <Text style={styles.hitMeta} numberOfLines={1}>
                    {badgeLabel}
                  </Text>
                </View>
                <Text style={styles.hitAction}>
                  {actionLabel}
                </Text>
              </Panel>
            )
          }}
        />
      ) : (
        <EmptyState
          icon="search"
          title="Search your media catalog"
          body="Search only includes entities currently visible under your local moderation profile."
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  inputShell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surfaceHover,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'web' ? spacing.sm : 10,
  },
  inputShellFocused: {
    borderColor: colors.borderFocus,
  },
  input: {
    flex: 1,
    color: colors.text,
    marginLeft: spacing.sm,
    ...fonts.meta.sm,
  },
  providerBlock: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  providerTitle: {
    ...fonts.title.md,
    color: colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  providerHit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  providerHitCopy: {
    flex: 1,
    paddingRight: spacing.md,
  },
  hitTitle: {
    ...fonts.title.md,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  hitMeta: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    marginTop: 2,
  },
  hitAction: {
    ...fonts.caption.sm,
    color: colors.primary,
  },
  providerError: {
    ...fonts.meta.sm,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
})
