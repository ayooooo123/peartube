import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { Tag } from '@/components/primitives'
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
              <Tag
                label={row.protection === 'protected' ? 'Protected' : 'Evictable'}
                tone={row.protection === 'protected' ? 'default' : 'accent'}
              />
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
  root: { marginTop: spacing.md, gap: spacing.sm },
  summaryRow: { flexDirection: 'row', gap: spacing.sm },
  summaryCell: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
  },
  summaryLabel: { ...fonts.caption.sm, color: colors.textMuted },
  summaryValue: { marginTop: spacing.xs, ...fonts.meta.md, color: colors.text },
  heading: { marginTop: spacing.xs, ...fonts.caption.sm, color: colors.textSecondary },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.borderSubtle,
  },
  categoryCopy: { flex: 1, minWidth: 0 },
  categoryTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm - 2 },
  categoryLabel: { ...fonts.meta.sm, color: colors.text, fontFamily: fonts.monoMedium },
  categoryDetail: { marginTop: spacing.xs, ...fonts.body.sm, fontSize: 11, lineHeight: 16, color: colors.textMuted },
  categoryBytes: { ...fonts.meta.sm, color: colors.textSecondary },
  pledgeNote: {
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  pledgeTitle: { ...fonts.caption.sm, color: colors.text },
  pledgeCopy: { marginTop: spacing.xs, ...fonts.body.sm, fontSize: 11, lineHeight: 16, color: colors.textMuted },
  preview: {
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.surface,
  },
  feasiblePreview: { borderColor: colors.primary },
  blockedPreview: { borderColor: colors.error },
  previewTitle: { ...fonts.caption.sm, color: colors.text },
  previewText: { ...fonts.meta.xs, lineHeight: 16, color: colors.textSecondary },
  consequence: { ...fonts.meta.xs, lineHeight: 16, color: colors.textMuted },
})
