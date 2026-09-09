import React, { memo, useCallback } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native'
import type { MediaCatalogState, MediaEntitySummary, MediaPublicationSource } from '@peartube/core'
import type { MediaCatalogDiagnostic } from '@/lib/media-catalog-controller.mjs'
import { describeAvailability } from '@/lib/media-availability'
import { colors, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { ScreenHeader, Button, EmptyState } from '@/components/primitives'

interface Props {
  title?: string
  subtitle?: string
  state: MediaCatalogState
  diagnostic: MediaCatalogDiagnostic | null
  onRefresh(): void
  onLoadNext(): void
  onEntityPress(entityId: string, item: MediaEntitySummary): void
  contentBottomInset?: number
}

const sourceForDisplay = (item: MediaEntitySummary): MediaPublicationSource | undefined => (
  item.sources.find((source) => source.selected)
  ?? item.sources.find((source) => source.preferred)
  ?? item.sources[0]
)

function MediaCatalogEntityCard({ item, onPress }: { item: MediaEntitySummary; onPress(): void }) {
  const source = sourceForDisplay(item)
  const title = item.title?.trim() || 'Untitled media'
  const sourceCount = item.sources.length
  const claimCount = item.claimCount ?? 0
  const conflictCount = item.conflictCount ?? 0
  const archiveState = source?.archiveState || source?.cacheState || 'not archived'
  // One assessment, one answer: the card quotes exactly what detail and Other
  // Sources quote, and it decays with the same expiry.
  const availability = describeAvailability(item.availability ?? source?.availability ?? null)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open media entity ${title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardHeading}>
        <View style={styles.kindPill}>
          <Text style={styles.kindText}>{item.entityKind}</Text>
        </View>
        <Text style={styles.sourceCount}>{sourceCount} {sourceCount === 1 ? 'source' : 'sources'}</Text>
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>{title}</Text>
      {item.subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{item.subtitle}</Text> : null}
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>Source</Text>
        <Text style={styles.factValue} numberOfLines={1}>{source?.publisherId || 'No playable publication'}</Text>
      </View>
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>Availability</Text>
        <Text style={styles.factValue} numberOfLines={1}>{availability.label}</Text>
      </View>
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>Archive</Text>
        <Text style={styles.factValue}>{archiveState}</Text>
      </View>
      <View style={styles.trustRow}>
        <Text style={styles.trustText}>{claimCount} verified {claimCount === 1 ? 'claim' : 'claims'}</Text>
        <Text style={[styles.trustText, conflictCount > 0 && styles.conflictText]}>
          {conflictCount} {conflictCount === 1 ? 'conflict' : 'conflicts'}
        </Text>
        <Text style={styles.trustText}>{item.renditions.length} {item.renditions.length === 1 ? 'rendition' : 'renditions'}</Text>
      </View>
    </Pressable>
  )
}

const MemoizedEntityCard = memo(MediaCatalogEntityCard)

export function MediaCatalogView({
  title = 'Media catalog',
  subtitle = 'Resolved entities from authority-accepted publisher catalogs',
  state,
  diagnostic,
  onRefresh,
  onLoadNext,
  onEntityPress,
  contentBottomInset = 24,
}: Props) {
  const renderItem = useCallback(({ item }: ListRenderItemInfo<MediaEntitySummary>) => (
    <MemoizedEntityCard item={item} onPress={() => onEntityPress(item.entityId, item)} />
  ), [onEntityPress])

  const header = (
    <>
      <ScreenHeader title={title} eyebrow="VERIFIED CATALOG" />
      {subtitle && (
        <View style={styles.headerCopy}>
          <Text style={styles.headerSubtitle}>{subtitle}</Text>
          <Button
            label="Refresh"
            variant="secondary"
            size="sm"
            loading={state.refreshing}
            disabled={state.refreshing}
            onPress={onRefresh}
            accessibilityLabel="Refresh media catalog"
          />
        </View>
      )}
    </>
  )

  const empty = state.status === 'loading' ? (
    <View style={styles.message}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.messageTitle}>Resolving media catalog</Text>
      <Text style={styles.messageDetail}>Verifying accepted claims and publication sources…</Text>
    </View>
  ) : diagnostic ? (
    <EmptyState
      icon="wifi-off"
      status={diagnostic.errorCode ?? undefined}
      title={diagnostic.title}
      body={diagnostic.detail}
      action={{ label: diagnostic.actionLabel, onPress: onRefresh }}
    />
  ) : null

  const footer = state.nextCursor ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Load more media"
      accessibilityState={{ busy: state.loadingMore }}
      disabled={state.loadingMore}
      onPress={onLoadNext}
      style={styles.loadMore}
    >
      {state.loadingMore ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.refreshText}>Load more</Text>}
    </Pressable>
  ) : null

  return (
    <FlatList
      data={state.items}
      keyExtractor={(item) => item.entityId}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      contentContainerStyle={[styles.content, { paddingBottom: contentBottomInset }]}
      onEndReached={state.nextCursor ? onLoadNext : undefined}
      onEndReachedThreshold={0.35}
    />
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 0, gap: 0 },
  headerCopy: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.lg },
  headerSubtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  refreshText: { color: colors.primary, fontWeight: '700', fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  card: { backgroundColor: colors.surface, borderWidth: borderWidth.hairline, borderColor: colors.border, borderRadius: 4, marginHorizontal: spacing.lg, marginVertical: spacing.sm, padding: spacing.lg, gap: spacing.md },
  cardPressed: { opacity: 0.72 },
  cardHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  kindPill: { backgroundColor: colors.bgActive, borderRadius: 4, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  kindText: { color: colors.primary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  sourceCount: { color: colors.textMuted, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  cardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: 16, lineHeight: 20 },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  factLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, width: 60 },
  factValue: { color: colors.text, fontSize: 12, flex: 1, fontFamily: fonts.mono },
  trustRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.sm },
  trustText: { color: colors.textMuted, backgroundColor: colors.bgActive, borderRadius: 4, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' },
  conflictText: { color: colors.warning },
  message: { minHeight: 260, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.md },
  messageTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: 18, textAlign: 'center', letterSpacing: -0.2 },
  messageDetail: { color: colors.textMuted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  loadMore: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginVertical: spacing.lg, borderWidth: borderWidth.hairline, borderColor: colors.border, borderRadius: 4, marginHorizontal: spacing.lg },
})
