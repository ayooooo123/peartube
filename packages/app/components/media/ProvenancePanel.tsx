import { StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import type { MediaCockpitItem } from './HeroFeatureCard'

export interface ProvenancePanelProps {
  provenance?: unknown[]
  item?: (MediaCockpitItem & {
    selectedSource?: Record<string, unknown> | null
    item?: { selectedSource?: Record<string, unknown> | null } | null
  }) | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function provenanceTitle(entry: unknown, index: number): string {
  if (typeof entry === 'string') return `Provenance record ${index + 1}`
  const record = asRecord(entry)
  return pickString(record?.role, record?.claimType, record?.source) || `Claim ${index + 1}`
}

function provenanceDetail(entry: unknown): string {
  if (typeof entry === 'string') return entry
  const record = asRecord(entry)
  const publisher = pickString(record?.publisherName, record?.publisherId, record?.issuerName)
  const publication = pickString(record?.publicationId, record?.renditionId, record?.claimId, record?.id)
  if (publisher && publication) return `${publisher} · ${publication}`
  return publisher || publication || 'Provenance details are unavailable.'
}

function provenanceKey(entry: unknown, index: number): string {
  if (typeof entry === 'string') return `${entry}:${index}`
  const record = asRecord(entry)
  return pickString(record?.claimId, record?.publicationId, record?.renditionId) || `provenance-${index}`
}

export function ProvenancePanel({ provenance, item = null }: ProvenancePanelProps) {
  const selectedSource = item?.selectedSource || item?.item?.selectedSource || null
  const directRows = provenance ?? item?.provenance ?? []
  const rows: unknown[] = directRows.length > 0
    ? directRows
    : selectedSource
      ? [{
          role: 'selected-source',
          publisherName: selectedSource.publisherName,
          publicationId: selectedSource.publicationId,
          renditionId: selectedSource.renditionId,
        }]
      : []
  const entityId = pickString(item?.localEntityId, item?.publicationId, selectedSource?.publicationId)

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Publisher claims</Text>
        <Text style={styles.count}>{rows.length} claim{rows.length === 1 ? '' : 's'}</Text>
      </View>
      <Text style={styles.summary}>{entityId || 'Publisher-signed provenance for the resolved entity.'}</Text>
      <View style={styles.list}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>No provenance claims are attached to this resolved media entity.</Text>
        ) : rows.slice(0, 6).map((entry, index) => (
          <View key={provenanceKey(entry, index)} style={styles.row}>
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

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgElevated,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 16 },
  count: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  summary: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
  list: { gap: 10, marginTop: 14 },
  row: { flexDirection: 'row', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginTop: 5 },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },
  rowDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  empty: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
})
