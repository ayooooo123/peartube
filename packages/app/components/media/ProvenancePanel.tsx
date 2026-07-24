import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

function asArray(value: unknown): Array<any> {
  return Array.isArray(value) ? value : []
}

function pickString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function provenanceTitle(entry: any, index: number): string {
  return pickString(entry?.role, entry?.claimType, entry?.source, `claim-${index + 1}`) || `claim-${index + 1}`
}

function provenanceDetail(entry: any): string {
  const publisher = pickString(entry?.publisherName, entry?.publisherId, entry?.issuerName)
  const publication = pickString(entry?.publicationId, entry?.renditionId, entry?.claimId, entry?.id)
  if (publisher && publication) return `${publisher} · ${publication}`
  return publisher || publication || 'Unsigned local metadata claim'
}

export interface ProvenancePanelProps {
  item: MediaCockpitItem & Record<string, any>
}

function ProvenancePanelComponent({ item }: ProvenancePanelProps) {
  const provenance = asArray(item?.provenance)
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  const rows = provenance.length > 0
    ? provenance
    : selectedSource
      ? [{ role: 'selected-source', publisherName: selectedSource.publisherName, publicationId: selectedSource.publicationId, renditionId: selectedSource.renditionId }]
      : []

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.kicker}>Publisher claims</Text>
        <Text style={styles.count}>{rows.length} claim{rows.length === 1 ? '' : 's'}</Text>
      </View>
      <Text style={styles.summary}>
        {pickString(item?.localEntityId, item?.publicationId, selectedSource?.publicationId) || 'No stable entity id attached yet.'}
      </Text>
      <View style={styles.list}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>This item is still running on legacy feed metadata, so provenance is limited to the playable source.</Text>
        ) : rows.slice(0, 6).map((entry, index) => (
          <View key={entry?.claimId || entry?.publicationId || entry?.renditionId || index} style={styles.row}>
            <View style={styles.dot} />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle} numberOfLines={1}>{provenanceTitle(entry, index)}</Text>
              <Text style={styles.rowDetail} numberOfLines={2}>{provenanceDetail(entry)}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

export const ProvenancePanel = memo(ProvenancePanelComponent)

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    padding: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  kicker: {
    color: colors.text,
    fontFamily: fonts.headingMedium,
    fontSize: 16,
  },
  count: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  summary: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 8,
  },
  list: {
    gap: 10,
    marginTop: 14,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginTop: 5,
  },
  rowCopy: {
    flex: 1,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  rowDetail: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
})
