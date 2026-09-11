import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { Tag } from '@/components/primitives'
import { buildArchiveOperatorView, type ArchiveOperatorStatus } from '@/lib/storage-operability.js'

interface ArchiveOperatorDiagnosticsProps {
  operatorStatus: ArchiveOperatorStatus | null
}

export default function ArchiveOperatorDiagnostics({ operatorStatus }: ArchiveOperatorDiagnosticsProps) {
  const view = buildArchiveOperatorView(operatorStatus)
  const healthTone = view.pledgeHealth === 'degraded' ? colors.error : colors.primary

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.cardTitle}>Archive operator</Text>
        <Tag label={view.modeLabel} tone="accent" />
      </View>
      <Text style={styles.trustCopy}>{view.trustCopy}</Text>

      <View style={styles.healthRow}>
        <View style={[styles.healthDot, { backgroundColor: healthTone }]} />
        <View style={styles.healthCopy}>
          <Text style={styles.healthTitle}>Pledge health · {view.pledgeHealth}</Text>
          <Text style={styles.detailText}>{view.pledgeCopy}</Text>
        </View>
      </View>

      <Text style={styles.detailText}>Challenges: {view.challengeCopy}</Text>
      <Text style={styles.detailText}>Capacity: {view.capacityCopy}</Text>
      <Text style={styles.detailText}>Offload: {view.offloadCopy}</Text>

      {view.failureCodes.length > 0 ? (
        <View style={styles.failureBox}>
          <Text style={styles.failureTitle}>Recent bounded failures</Text>
          {view.failureCodes.map((code, index) => (
            <Text key={`${code}-${index}`} style={styles.failureCode}>{code}</Text>
          ))}
          {view.hiddenFailureCount > 0 ? (
            <Text style={styles.detailText}>+{view.hiddenFailureCount} more not rendered</Text>
          ) : null}
        </View>
      ) : (
        <Text style={styles.detailText}>No recent challenge, capacity, or offload failures.</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: spacing.md,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { flex: 1, ...fonts.title.md, fontSize: 14, lineHeight: 18, color: colors.text, textTransform: 'uppercase' },
  trustCopy: { ...fonts.body.sm, fontSize: 11, lineHeight: 16, color: colors.textMuted },
  healthRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  healthDot: { width: 8, height: 8, borderRadius: radius.sm, marginTop: 4 },
  healthCopy: { flex: 1 },
  healthTitle: { ...fonts.caption.sm, color: colors.textSecondary, textTransform: 'capitalize' },
  detailText: { ...fonts.meta.sm, lineHeight: 17, color: colors.textMuted },
  failureBox: {
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.error,
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.surface,
  },
  failureTitle: { marginBottom: 2, ...fonts.caption.sm, color: colors.error },
  failureCode: { ...fonts.meta.xs, color: colors.textSecondary },
})
