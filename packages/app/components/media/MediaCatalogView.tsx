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
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'

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
  const archiveState = source?.archiveState || source?.cacheState || source?.availabilityState || 'not archived'

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
        <Text style={styles.factLabel}>Archive</Text>
        <Text style={styles.factValue}>Archive: {archiveState}</Text>
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
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.headerSubtitle}>{subtitle}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh media catalog"
        accessibilityState={{ busy: state.refreshing }}
        disabled={state.refreshing}
        onPress={onRefresh}
        style={styles.refreshButton}
      >
        {state.refreshing ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.refreshText}>Refresh</Text>}
      </Pressable>
    </View>
  )

  const empty = state.status === 'loading' ? (
    <View style={styles.message}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.messageTitle}>Resolving media catalog</Text>
      <Text style={styles.messageDetail}>Verifying accepted claims and publication sources…</Text>
    </View>
  ) : diagnostic ? (
    <View style={styles.message}>
      <Text style={styles.messageTitle}>{diagnostic.title}</Text>
      <Text style={styles.messageDetail}>{diagnostic.detail}</Text>
      {diagnostic.errorCode ? <Text style={styles.errorCode}>{diagnostic.errorCode}</Text> : null}
      <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.actionButton}>
        <Text style={styles.actionText}>{diagnostic.actionLabel}</Text>
      </Pressable>
    </View>
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
  content: { paddingHorizontal: 20, gap: 12 },
  header: { paddingTop: 24, paddingBottom: 8, flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  headerCopy: { flex: 1 },
  title: { color: colors.text, fontFamily: fonts.heading, fontSize: 28 },
  headerSubtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  refreshButton: { minHeight: 40, minWidth: 72, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 14 },
  refreshText: { color: colors.primary, fontWeight: '700' },
  card: { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 16, gap: 8 },
  cardPressed: { opacity: 0.72 },
  cardHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  kindPill: { backgroundColor: colors.bgSecondary, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  kindText: { color: colors.primary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  sourceCount: { color: colors.textMuted, fontSize: 12 },
  cardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: 19, lineHeight: 24 },
  subtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  factRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  factLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', width: 54 },
  factValue: { color: colors.text, fontSize: 12, flex: 1 },
  trustRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  trustText: { color: colors.textMuted, backgroundColor: colors.bgSecondary, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11 },
  conflictText: { color: colors.warning },
  message: { minHeight: 260, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 10 },
  messageTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: 19, textAlign: 'center' },
  messageDetail: { color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  errorCode: { color: colors.textMuted, fontFamily: 'monospace', fontSize: 11 },
  actionButton: { marginTop: 6, backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  actionText: { color: colors.onPrimary, fontWeight: '700' },
  loadMore: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
})
