import React, { memo, useCallback, useMemo } from 'react'
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import type { MediaEntitySummary } from '@peartube/core'
import { MediaPosterCard, MEDIA_POSTER_CARD_WIDTH } from './MediaPosterCard'
import { HomeHeroCarousel, type HomeHeroItem } from './HomeHeroCarousel'
import { SectionHeader, SwarmIndicator, Eyebrow, EmptyState } from '@/components/primitives'
import { projectHomeRails } from '@/lib/home-rails.js'
import type { LocalWatchStateRow } from '@/lib/watch-history'
import { colors, spacing, borderWidth } from '@/lib/colors'

export type ConsumerHomeState = {
  status?: string
  items?: MediaEntitySummary[] | null
  refreshing?: boolean
}

export type ConsumerHomeDiagnostic = {
  kind?: string
  title?: string
  detail?: string
  actionLabel?: string
  errorCode?: string | null
} | null

export type ConsumerHomeProps = {
  state: ConsumerHomeState
  diagnostic?: ConsumerHomeDiagnostic
  /** This device's own watch state. Never fetched, never reported. */
  watchState?: LocalWatchStateRow[]
  firstSeen?: Record<string, number>
  onRefresh(): void
  onOpenEntity(entityId: string, item: MediaEntitySummary): void
  contentBottomInset?: number
  now?: number
}

type GridItem = MediaEntitySummary & {
  availabilityView?: { label: string; playable: boolean }
  resume?: { fraction: number }
}

const PAGE_PADDING = spacing.lg
const COLUMN_GUTTER = spacing.md
const ROW_GUTTER = spacing.lg
const TARGET_CARD_WIDTH = MEDIA_POSTER_CARD_WIDTH
const MIN_COLUMNS = 2
const MAX_COLUMNS = 5
const HERO_ITEM_LIMIT = 5

function GridCard({
  item,
  width,
  onOpenEntity,
}: {
  item: GridItem
  width: number
  onOpenEntity(entityId: string, item: MediaEntitySummary): void
}) {
  const onPress = useCallback(() => onOpenEntity(item.entityId, item), [item, onOpenEntity])
  return <MediaPosterCard item={item} width={width} onPress={onPress} />
}

const MemoizedGridCard = memo(GridCard)

export function ConsumerHomeView({
  state,
  diagnostic = null,
  watchState = [],
  firstSeen = {},
  onRefresh,
  onOpenEntity,
  contentBottomInset = 24,
  now,
}: ConsumerHomeProps) {
  const { width: windowWidth } = useWindowDimensions()
  const items = useMemo<MediaEntitySummary[]>(() => (Array.isArray(state.items) ? state.items : []), [state.items])
  const rails = useMemo(
    () => projectHomeRails({ items, watchState, firstSeen, now: now ?? Date.now() }),
    [items, watchState, firstSeen, now],
  )

  const cardWidth = useMemo(() => {
    const available = windowWidth - PAGE_PADDING * 2
    if (available <= 0) return MEDIA_POSTER_CARD_WIDTH
    const fit = Math.round((available + COLUMN_GUTTER) / (TARGET_CARD_WIDTH + COLUMN_GUTTER))
    const columns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, fit))
    return Math.max(1, Math.floor((available - COLUMN_GUTTER * (columns - 1)) / columns))
  }, [windowWidth])

  const featured = useMemo(
    () => ((rails[0]?.items ?? []) as HomeHeroItem[]).slice(0, HERO_ITEM_LIMIT),
    [rails],
  )

  if (rails.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={styles.header}>
          <Eyebrow>PEARTUBE / HOME</Eyebrow>
          <SwarmIndicator peers={0} label="auto" />
        </View>
        <ScrollView
          contentContainerStyle={[styles.emptyContent, { paddingBottom: contentBottomInset }]}
          refreshControl={<RefreshControl refreshing={state.refreshing === true} onRefresh={onRefresh} />}
        >
          {state.status === 'loading' ? <ActivityIndicator color={colors.primary} /> : null}
          <EmptyState
            icon="film"
            status={diagnostic?.errorCode ?? undefined}
            title={diagnostic?.title || 'Nothing to watch yet'}
            body={diagnostic?.detail || 'Nothing is available yet. Pull down to refresh.'}
            action={{ label: diagnostic?.actionLabel || 'Check again', onPress: onRefresh }}
          />
        </ScrollView>
      </View>
    )
  }

  return (
    <View testID="consumer-home" style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <Eyebrow>PEARTUBE / HOME</Eyebrow>
        <SwarmIndicator peers={0} label="auto" />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: contentBottomInset }}
        refreshControl={<RefreshControl refreshing={state.refreshing === true} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <HomeHeroCarousel items={featured} windowWidth={windowWidth} onOpenEntity={onOpenEntity} />
        {rails.map((rail, index) => (
          <View key={rail.id} testID={`home-section-${rail.id}`} style={styles.section}>
            <SectionHeader 
              title={rail.title} 
              eyebrow={String(index + 1).padStart(2, '0')}
              subtitle={rail.subtitle}
              flush={false}
            />
            <View style={styles.grid}>
              {(rail.items as GridItem[]).map(item => (
                <MemoizedGridCard
                  key={item.entityId}
                  item={item}
                  width={cardWidth}
                  onOpenEntity={onOpenEntity}
                />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: borderWidth.rule,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  section: {
    marginTop: spacing.xl,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: PAGE_PADDING,
    columnGap: COLUMN_GUTTER,
    rowGap: ROW_GUTTER,
  },
  emptyContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
})
