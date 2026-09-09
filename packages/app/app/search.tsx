import { useCallback, useEffect, useMemo, useState } from 'react'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { MediaEntitySummary } from '@peartube/core'

import { MediaCatalogView } from '@/components/media/MediaCatalogView'
import {
  encodeMediaEntityRouteParam,
  getMediaEntityRouteId,
} from '@/components/media/MediaEntityDetailScreen'
import { Button, EmptyState, Panel, ScreenHeader } from '@/components/primitives'
import { useMediaCatalog } from '@/hooks/useMediaCatalog'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
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
    <View style={[styles.screen, { paddingTop: isDesktop ? 0 : insets.top }]}>
      {!isDesktop ? (
        <ScreenHeader title="Search" onBack={() => router.back()} />
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
            <View style={styles.providerBlock}>
              <Text style={styles.providerTitle}>More results</Text>
              {providerSearch.hits.slice(0, 3).map((hit) => {
                const opening = providerSearch.openingRef === hit.resolutionRef
                const busy = Boolean(providerSearch.openingRef)
                return (
                  <Panel
                    key={hit.resolutionRef}
                    padded
                    onPress={busy ? undefined : () => { void openProviderHit(hit) }}
                    accessibilityLabel={`${hit.published ? 'Play' : 'Open'} ${hit.title}`}
                    style={[
                      styles.providerHit,
                      busy && !opening ? { opacity: 0.55 } : null,
                    ]}
                  >
                    <View style={styles.providerHitCopy}>
                      <Text style={styles.hitTitle} numberOfLines={1}>{hit.title}</Text>
                      <Text style={styles.hitMeta} numberOfLines={1}>
                        {hit.subtitle || (hit.published ? 'Ready to watch' : 'Available by request')}
                      </Text>
                    </View>
                    <Text style={styles.hitAction}>
                      {opening ? 'Opening…' : hit.published ? 'Play' : 'View'}
                    </Text>
                  </Panel>
                )
              })}
            </View>
          ) : null}
          {providerSearch.status === 'error' ? (
            <Text accessibilityRole="alert" style={styles.providerError}>
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
