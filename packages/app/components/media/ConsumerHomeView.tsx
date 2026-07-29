import React, { memo, useCallback, useMemo } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import type { MediaEntitySummary } from '@peartube/core'
import { MediaPosterCard, MEDIA_POSTER_CARD_WIDTH } from './MediaPosterCard'
import { HomeHeroCarousel, type HomeHeroItem } from './HomeHeroCarousel'
import { projectHomeRails } from '@/lib/home-rails.js'
import { colors, radius, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'

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
  watchState?: unknown[]
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
// The column count is whatever lands closest to the poster card's own width at
// the current window width - two on a phone, more as the window grows. The
// clamp keeps a narrow phone from dropping to a single oversized column and a
// desktop from shrinking posters into thumbnails.
const TARGET_CARD_WIDTH = MEDIA_POSTER_CARD_WIDTH
const MIN_COLUMNS = 2
const MAX_COLUMNS = 5
const HERO_ITEM_LIMIT = 5

/**
 * One grid cell. The stable `onPress` is the point: an inline closure at the
 * call site would hand every card a new function on each render and defeat the
 * memo inside the poster card.
 */
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

  // Cards are sized to fill the row edge to edge: the leftover after the page
  // padding and the gutters between columns, split evenly. One title no longer
  // leaves the rest of the row empty.
  const cardWidth = useMemo(() => {
    const available = windowWidth - PAGE_PADDING * 2
    // Only before layout has reported a width, which is also what a static
    // render sees. The card's own baseline width is the honest stand-in.
    if (available <= 0) return MEDIA_POSTER_CARD_WIDTH
    const fit = Math.round((available + COLUMN_GUTTER) / (TARGET_CARD_WIDTH + COLUMN_GUTTER))
    const columns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, fit))
    return Math.max(1, Math.floor((available - COLUMN_GUTTER * (columns - 1)) / columns))
  }, [windowWidth])

  // The hero features the top shelf, the way MediaStorm's does. Artwork is not
  // a condition of appearing there: a title with none draws the same placeholder
  // the grid draws, and a hero that comes and goes with replication state would
  // move the whole screen under the viewer.
  const featured = useMemo(
    () => ((rails[0]?.items ?? []) as HomeHeroItem[]).slice(0, HERO_ITEM_LIMIT),
    [rails],
  )

  if (rails.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={[styles.emptyContent, { paddingBottom: contentBottomInset }]}
        refreshControl={<RefreshControl refreshing={state.refreshing === true} onRefresh={onRefresh} />}
      >
        {state.status === 'loading' ? <ActivityIndicator color={colors.primary} /> : null}
        <Text style={styles.emptyTitle}>{diagnostic?.title || 'Nothing to watch yet'}</Text>
        <Text style={styles.emptyDetail}>
          {diagnostic?.detail || 'Nothing is available yet. Pull down to refresh.'}
        </Text>
        {diagnostic?.errorCode ? <Text style={styles.emptyCode}>{diagnostic.errorCode}</Text> : null}
        <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.emptyAction}>
          <Text style={styles.emptyActionLabel}>{diagnostic?.actionLabel || 'Check again'}</Text>
        </Pressable>
      </ScrollView>
    )
  }

  return (
    <ScrollView
      testID="consumer-home"
      contentContainerStyle={{ paddingBottom: contentBottomInset }}
      refreshControl={<RefreshControl refreshing={state.refreshing === true} onRefresh={onRefresh} />}
      showsVerticalScrollIndicator={false}
    >
      <HomeHeroCarousel items={featured} windowWidth={windowWidth} onOpenEntity={onOpenEntity} />
      {rails.map(rail => (
        <View key={rail.id} testID={`home-section-${rail.id}`} style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{rail.title}</Text>
            {rail.subtitle ? <Text style={styles.sectionSubtitle}>{rail.subtitle}</Text> : null}
          </View>
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
  )
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.xl,
  },
  sectionHeader: {
    paddingHorizontal: PAGE_PADDING,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...fonts.title.md,
    fontFamily: fonts.heading,
    color: colors.text,
  },
  sectionSubtitle: {
    ...fonts.body.sm,
    color: colors.textMuted,
    marginTop: spacing.xs,
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
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.sm,
  },
  emptyTitle: {
    ...fonts.title.md,
    fontFamily: fonts.heading,
    color: colors.text,
    textAlign: 'center',
  },
  emptyDetail: {
    ...fonts.body.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },
  emptyCode: {
    ...fonts.caption.sm,
    color: colors.textDisabled,
  },
  emptyAction: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.bgHover,
  },
  emptyActionLabel: {
    ...fonts.label.md,
    color: colors.text,
  },
})
