import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, radius, borderWidth } from '@/lib/colors'
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
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: { ...fonts.title.md, color: colors.text },
  count: { ...fonts.caption.sm, color: colors.primary },
  summary: { ...fonts.meta.sm, color: colors.textMuted, marginTop: spacing.sm },
  list: { gap: spacing.md, marginTop: spacing.md },
  row: { flexDirection: 'row', gap: spacing.md },
  dot: { width: 8, height: 8, backgroundColor: colors.primary, marginTop: 4 },
  rowCopy: { flex: 1 },
  rowTitle: { ...fonts.caption.sm, color: colors.text },
  rowDetail: { ...fonts.meta.sm, color: colors.textMuted, marginTop: 2 },
  empty: { ...fonts.body.sm, color: colors.textMuted },
})
