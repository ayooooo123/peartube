import { StyleSheet, Text, View } from 'react-native'
import { colors } from '@/lib/colors'
import { buildArchiveOperatorView, type ArchiveOperatorStatus } from '@/lib/storage-operability.js'

interface ArchiveOperatorDiagnosticsProps {
  operatorStatus: ArchiveOperatorStatus | null
}

export default function ArchiveOperatorDiagnostics({ operatorStatus }: ArchiveOperatorDiagnosticsProps) {
  const view = buildArchiveOperatorView(operatorStatus)

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <Text style={styles.cardTitle}>Archive operator</Text>
        <Text style={styles.mode}>{view.modeLabel}</Text>
      </View>
      <Text style={styles.trustCopy}>{view.trustCopy}</Text>

      <View style={styles.healthRow}>
        <View style={[styles.healthDot, view.pledgeHealth === 'degraded' ? styles.degraded : styles.nominal]} />
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
  card: { backgroundColor: colors.bg, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.glassBorder, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  mode: { overflow: 'hidden', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, fontWeight: '700', color: colors.primary, backgroundColor: colors.glass },
  trustCopy: { fontSize: 11, lineHeight: 16, color: colors.textMuted },
  healthRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  healthDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  nominal: { backgroundColor: colors.swarm },
  degraded: { backgroundColor: colors.error },
  healthCopy: { flex: 1 },
  healthTitle: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'capitalize' },
  detailText: { fontSize: 12, lineHeight: 17, color: colors.textMuted },
  failureBox: { borderRadius: 10, borderWidth: 1, borderColor: colors.errorLight, padding: 10, gap: 3 },
  failureTitle: { marginBottom: 2, fontSize: 11, fontWeight: '700', color: colors.error },
  failureCode: { fontSize: 11, color: colors.textSecondary },
})
