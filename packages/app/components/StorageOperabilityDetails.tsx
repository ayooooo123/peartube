import { StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import {
  buildStorageCategoryRows,
  buildStoragePreviewView,
  formatStorageBytes,
  type StorageCategoryStats,
  type StorageLimitPreview,
} from '@/lib/storage-operability.js'

interface StorageOperabilityDetailsProps {
  stats: StorageCategoryStats | null
  preview: StorageLimitPreview | null
}

export default function StorageOperabilityDetails({ stats, preview }: StorageOperabilityDetailsProps) {
  if (!stats) return null

  const rows = buildStorageCategoryRows(stats)
  const previewView = buildStoragePreviewView(preview)

  return (
    <View style={styles.root}>
      <View style={styles.summaryRow}>
        <View style={styles.summaryCell}>
          <Text style={styles.summaryLabel}>Protected</Text>
          <Text style={styles.summaryValue}>{formatStorageBytes(stats.protectedBytes)}</Text>
        </View>
        <View style={styles.summaryCell}>
          <Text style={styles.summaryLabel}>Safely evictable</Text>
          <Text style={styles.summaryValue}>{formatStorageBytes(stats.evictableBytes)}</Text>
        </View>
      </View>

      <Text style={styles.heading}>Storage categories</Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.categoryRow}>
          <View style={styles.categoryCopy}>
            <View style={styles.categoryTitleRow}>
              <Text style={styles.categoryLabel}>{row.label}</Text>
              <Text style={[styles.badge, row.protection === 'protected' ? styles.protectedBadge : styles.evictableBadge]}>
                {row.protection === 'protected' ? 'Protected' : 'Evictable'}
              </Text>
            </View>
            <Text style={styles.categoryDetail}>{row.detail}</Text>
          </View>
          <Text style={styles.categoryBytes}>{row.formattedBytes}</Text>
        </View>
      ))}

      <View style={styles.pledgeNote}>
        <Text style={styles.pledgeTitle}>Archive pledge protection</Text>
        <Text style={styles.pledgeCopy}>
          Pledged bytes are not cache. They remain protected from safe eviction until the archive pledge ends.
        </Text>
      </View>

      {previewView ? (
        <View style={[styles.preview, previewView.feasible ? styles.feasiblePreview : styles.blockedPreview]}>
          <Text style={styles.previewTitle}>{previewView.feasible ? 'Safe-eviction preview' : 'Limit blocked'}</Text>
          <Text style={styles.previewText}>{previewView.summary}</Text>
          <Text style={styles.previewText}>{previewView.protectedCopy}</Text>
          <Text style={styles.previewText}>{previewView.affectedSeedCopy}</Text>
          {previewView.affectedCategories.map((category) => (
            <Text key={category} style={styles.consequence}>Affected: {category}</Text>
          ))}
          {previewView.hiddenCategoryCount > 0 ? (
            <Text style={styles.previewText}>+{previewView.hiddenCategoryCount} more affected categories</Text>
          ) : null}
          {previewView.consequences.map((consequence, index) => (
            <Text key={`${consequence}-${index}`} style={styles.consequence}>• {consequence}</Text>
          ))}
          {previewView.hiddenConsequenceCount > 0 ? (
            <Text style={styles.previewText}>+{previewView.hiddenConsequenceCount} more bounded consequences</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { marginTop: 14, gap: 10 },
  summaryRow: { flexDirection: 'row', gap: 10 },
  summaryCell: { flex: 1, padding: 10, borderRadius: 10, backgroundColor: colors.glass },
  summaryLabel: { fontSize: 11, color: colors.textMuted },
  summaryValue: { marginTop: 2, fontSize: 15, fontWeight: '700', color: colors.text },
  heading: { marginTop: 4, fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  categoryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.glassBorder },
  categoryCopy: { flex: 1, minWidth: 0 },
  categoryTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  categoryLabel: { fontSize: 12, fontWeight: '600', color: colors.text },
  categoryDetail: { marginTop: 3, fontSize: 11, lineHeight: 16, color: colors.textMuted },
  categoryBytes: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  badge: { overflow: 'hidden', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9, fontWeight: '700' },
  protectedBadge: { color: colors.textSecondary, backgroundColor: colors.glass },
  evictableBadge: { color: colors.primary, backgroundColor: colors.glass },
  pledgeNote: { borderRadius: 10, borderWidth: 1, borderColor: colors.glassBorder, padding: 10 },
  pledgeTitle: { fontSize: 12, fontWeight: '700', color: colors.text },
  pledgeCopy: { marginTop: 3, fontSize: 11, lineHeight: 16, color: colors.textMuted },
  preview: { borderRadius: 10, borderWidth: 1, padding: 10, gap: 4 },
  feasiblePreview: { borderColor: colors.swarm, backgroundColor: colors.glass },
  blockedPreview: { borderColor: colors.error, backgroundColor: colors.glass },
  previewTitle: { fontSize: 12, fontWeight: '700', color: colors.text },
  previewText: { fontSize: 11, lineHeight: 16, color: colors.textSecondary },
  consequence: { fontSize: 11, lineHeight: 16, color: colors.textMuted },
})
