import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GlassCard, SectionHeader } from '@/components/primitives'
import { colors } from '@/app/_layout'
import { fonts } from '@/lib/typography'
import {
  boundedError,
  boundedDiagnosticCode,
  canRetryMigration,
  createMaintenanceActions,
  maintenanceCapabilities,
  migrationCounterRows,
  migrationPresentation,
  type MaintenanceCapability,
  type MaintenanceFiles,
  type MaintenanceRpc,
  type MigrationStatus,
  type PortableSelection,
} from './maintenance-model.mjs'

type Props = {
  rpc?: MaintenanceRpc | null
  files: MaintenanceFiles
  onBack(): void
}

type BusyAction = 'status' | 'retry' | 'report' | 'export' | 'select' | 'restore' | null

function statusColor(tone: string) {
  if (tone === 'success') return colors.success
  if (tone === 'danger') return colors.error
  if (tone === 'active') return colors.primary
  return colors.textMuted
}

function formatUpdatedAt(value: MigrationStatus['updatedAt']) {
  if (typeof value !== 'number' && typeof value !== 'string') return 'Update time unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Update time unavailable' : `Updated ${date.toLocaleString()}`
}

function CapabilityReason({ capability }: { capability: MaintenanceCapability }) {
  if (capability.available) return null
  return <Text selectable style={styles.capabilityReason}>{capability.reason}</Text>
}

export function MigrationBackupPanel({ rpc, files, onBack }: Props) {
  const insets = useSafeAreaInsets()
  const capabilities = useMemo(() => maintenanceCapabilities({ rpc, files }), [files, rpc])
  const actions = useMemo(() => createMaintenanceActions({ rpc, files }), [files, rpc])
  const [status, setStatus] = useState<MigrationStatus | null>(null)
  const [busy, setBusy] = useState<BusyAction>(capabilities.status.available ? 'status' : null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selection, setSelection] = useState<PortableSelection | null>(null)

  const refreshStatus = useCallback(async () => {
    if (!capabilities.status.available) return
    setBusy('status')
    setError(null)
    try {
      setStatus(await actions.getMigrationStatus())
    } catch (cause) {
      setStatus(null)
      setError(boundedError(cause, 'Migration status could not be loaded'))
    } finally {
      setBusy(null)
    }
  }, [actions, capabilities.status.available])

  useEffect(() => {
    if (capabilities.status.available) void refreshStatus()
  }, [capabilities.status.available, refreshStatus])

  const retryMigration = async () => {
    if (!capabilities.retry.available || !canRetryMigration(status)) return
    setBusy('retry')
    setError(null)
    setNotice(null)
    try {
      setStatus(await actions.retryMigration(status))
      setNotice('Migration retry started. Progress will appear here.')
    } catch (cause) {
      setError(boundedError(cause, 'Migration retry failed'))
    } finally {
      setBusy(null)
    }
  }

  const saveMigrationReport = async () => {
    if (!capabilities.report.available) return
    setBusy('report')
    setError(null)
    setNotice(null)
    try {
      await actions.saveMigrationReport()
      setNotice('Migration report saved to a file.')
    } catch (cause) {
      setError(boundedError(cause, 'Migration report export failed'))
    } finally {
      setBusy(null)
    }
  }

  const savePortableState = async () => {
    if (!capabilities.export.available) return
    setBusy('export')
    setError(null)
    setNotice(null)
    try {
      await actions.savePortableState()
      setNotice('Portable state backup saved. Keep the file intact so its checksum can be verified.')
    } catch (cause) {
      setError(boundedError(cause, 'Portable state export failed'))
    } finally {
      setBusy(null)
    }
  }

  const selectPortableState = async () => {
    if (!capabilities.select.available) return
    setBusy('select')
    setError(null)
    setNotice(null)
    setSelection(null)
    try {
      setSelection(await actions.selectPortableState())
    } catch (cause) {
      setError(boundedError(cause, 'Restore file rejected'))
    } finally {
      setBusy(null)
    }
  }

  const restorePortableState = async () => {
    if (!selection || !capabilities.restore.available) return
    setBusy('restore')
    setError(null)
    setNotice(null)
    try {
      const result = await actions.restorePortableState(selection)
      const imported = Math.max(0, Number(result.importedCount) || 0)
      const skipped = Math.max(0, Number(result.skippedCount) || 0)
      setSelection(null)
      setNotice(`Restore verified and applied: ${imported} imported, ${skipped} already present.`)
    } catch (cause) {
      setError(boundedError(cause, 'Portable state restore failed'))
    } finally {
      setBusy(null)
    }
  }

  const presentation = migrationPresentation(status?.state)
  const retryEnabled = capabilities.retry.available && canRetryMigration(status) && busy === null
  const anyBusy = busy !== null
  const refreshDisabled = anyBusy || !capabilities.status.available
  const reportDisabled = anyBusy || !capabilities.report.available
  const exportDisabled = anyBusy || !capabilities.export.available
  const selectDisabled = anyBusy || !capabilities.select.available
  const restoreDisabled = busy === 'restore' || !capabilities.restore.available

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>Maintenance & backup</Text>
          <Text style={styles.headerSubtitle}>Migration history and portable state</Text>
        </View>
        <Pressable onPress={() => { void refreshStatus() }} disabled={refreshDisabled} hitSlop={10} style={[styles.headerButton, refreshDisabled && styles.disabledButton]} accessibilityRole="button" accessibilityLabel="Refresh migration status" accessibilityHint={capabilities.status.reason || undefined} accessibilityState={{ disabled: refreshDisabled }}>
          {busy === 'status' ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="refresh-cw" size={18} color={colors.text} />}
        </Pressable>
      </View>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 32, gap: 4 }}
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <View accessibilityRole="alert" style={[styles.message, styles.errorMessage]}>
            <Feather name="alert-triangle" size={16} color={colors.error} />
            <Text selectable style={[styles.messageText, { color: colors.error }]}>{error}</Text>
          </View>
        ) : null}
        {notice ? (
          <View style={[styles.message, styles.noticeMessage]}>
            <Feather name="check-circle" size={16} color={colors.success} />
            <Text selectable style={styles.messageText}>{notice}</Text>
          </View>
        ) : null}

        <SectionHeader title="Legacy migration" subtitle="Publication v1 import lifecycle" />
        <GlassCard style={styles.card}>
          <View style={styles.statusHeader}>
            <View style={[styles.statusDot, { backgroundColor: statusColor(presentation.tone) }]} />
            <View style={styles.statusCopy}>
              <Text selectable style={styles.cardTitle}>{presentation.label}</Text>
              <Text selectable style={styles.cardMeta}>{status ? formatUpdatedAt(status.updatedAt) : busy === 'status' ? 'Loading migration status…' : 'No migration status available'}</Text>
            </View>
          </View>

          <View style={styles.counterGrid}>
            {migrationCounterRows(status).map(([label, value]) => (
              <View key={label} style={styles.counterCell}>
                <Text selectable style={styles.counterValue}>{value.toLocaleString()}</Text>
                <Text style={styles.counterLabel}>{label}</Text>
              </View>
            ))}
          </View>
          <CapabilityReason capability={capabilities.status} />

          {status?.state === 'failed' ? (
            <View style={styles.failureBox}>
              <Text style={styles.failureTitle}>Failure details</Text>
              <Text selectable style={styles.failureCode}>{boundedDiagnosticCode(status.errorCode)}</Text>
              {status.errorMessage ? <Text selectable style={styles.failureMessage}>{boundedError(status.errorMessage)}</Text> : null}
              {!status.retryable ? <Text style={styles.failureMessage}>This failure requires a new app version or manual repair before retrying.</Text> : null}
            </View>
          ) : null}

          <View style={styles.actionRow}>
            <Pressable
              onPress={() => { void retryMigration() }}
              disabled={!retryEnabled}
              accessibilityRole="button"
              accessibilityHint={capabilities.retry.reason || undefined}
              accessibilityState={{ disabled: !retryEnabled }}
              style={[styles.primaryButton, !retryEnabled && styles.disabledButton]}
            >
              {busy === 'retry' ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Feather name="rotate-cw" size={15} color={colors.onPrimary} />}
              <Text style={styles.primaryLabel}>{busy === 'retry' ? 'Retrying…' : 'Retry migration'}</Text>
            </Pressable>
            <Pressable
              onPress={() => { void saveMigrationReport() }}
              disabled={reportDisabled}
              accessibilityRole="button"
              accessibilityHint={capabilities.report.reason || undefined}
              accessibilityState={{ disabled: reportDisabled }}
              style={[styles.secondaryButton, reportDisabled && styles.disabledButton]}
            >
              {busy === 'report' ? <ActivityIndicator size="small" color={colors.text} /> : <Feather name="download" size={15} color={colors.text} />}
              <Text style={styles.secondaryLabel}>Save report</Text>
            </Pressable>
          </View>
          <CapabilityReason capability={capabilities.retry} />
          <CapabilityReason capability={capabilities.report} />
        </GlassCard>

        <SectionHeader title="Portable state" subtitle="Move transferable settings without moving authority" />
        <GlassCard style={styles.card}>
          <View style={styles.explainRow}>
            <View style={styles.explainIcon}><Feather name="package" size={18} color={colors.primary} /></View>
            <View style={styles.explainCopy}>
              <Text style={styles.cardTitle}>Portable, public app state</Text>
              <Text style={styles.bodyText}>The publisher service prepares transferable state and a checksum. The receiving publisher service verifies that checksum before applying the file.</Text>
            </View>
          </View>
          <View style={styles.boundaryBox}>
            <Text style={styles.boundaryTitle}>Never included</Text>
            <Text style={styles.bodyText}>Private publisher root, recovery phrase, device signing keys, and other secret authority are excluded.</Text>
          </View>
          <View style={styles.boundaryBox}>
            <Text style={styles.boundaryTitle}>Device-local stays local</Text>
            <Text style={styles.bodyText}>Device-local cache, downloads, archive replicas, and per-device policy are not portable state.</Text>
          </View>
          <Pressable
            onPress={() => { void savePortableState() }}
            disabled={exportDisabled}
            accessibilityRole="button"
            accessibilityHint={capabilities.export.reason || undefined}
            accessibilityState={{ disabled: exportDisabled }}
            style={[styles.primaryButton, exportDisabled && styles.disabledButton]}
          >
            {busy === 'export' ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Feather name="download-cloud" size={16} color={colors.onPrimary} />}
            <Text style={styles.primaryLabel}>{busy === 'export' ? 'Preparing backup…' : 'Export portable state'}</Text>
          </Pressable>
          <CapabilityReason capability={capabilities.export} />
        </GlassCard>

        <SectionHeader title="Restore portable state" subtitle="Select a PearTube portable-state JSON file" />
        <GlassCard style={styles.card}>
          <Text style={styles.bodyText}>Selection reads only the bounded backup file. Nothing is changed until you review the checksum and confirm below.</Text>
          <Pressable
            onPress={() => { void selectPortableState() }}
            disabled={selectDisabled}
            accessibilityRole="button"
            accessibilityHint={capabilities.select.reason || undefined}
            accessibilityState={{ disabled: selectDisabled }}
            style={[styles.secondaryButton, selectDisabled && styles.disabledButton]}
          >
            {busy === 'select' ? <ActivityIndicator size="small" color={colors.text} /> : <Feather name="folder" size={15} color={colors.text} />}
            <Text style={styles.secondaryLabel}>{busy === 'select' ? 'Reading file…' : 'Select backup file'}</Text>
          </Pressable>
          <CapabilityReason capability={capabilities.select} />

          {selection ? (
            <View style={styles.confirmBox}>
              <View style={styles.confirmTitleRow}>
                <Feather name="alert-octagon" size={18} color={colors.error} />
                <Text style={styles.confirmTitle}>Confirm destructive restore</Text>
              </View>
              <Text selectable numberOfLines={2} style={styles.selectedName}>{selection.fileName}</Text>
              <Text selectable numberOfLines={2} style={styles.digest}>Checksum: {selection.manifestDigest}</Text>
              <Text style={styles.failureMessage}>This can replace conflicting portable settings. It cannot restore or replace your private publisher root or device keys.</Text>
              <View style={styles.actionRow}>
                <Pressable onPress={() => setSelection(null)} disabled={busy === 'restore'} style={styles.secondaryButton} accessibilityRole="button">
                  <Text style={styles.secondaryLabel}>Cancel</Text>
                </Pressable>
                <Pressable onPress={() => { void restorePortableState() }} disabled={restoreDisabled} style={[styles.destructiveButton, restoreDisabled && styles.disabledButton]} accessibilityRole="button" accessibilityHint={capabilities.restore.reason || undefined} accessibilityState={{ disabled: restoreDisabled }}>
                  {busy === 'restore' ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="shield" size={15} color="#fff" />}
                  <Text style={styles.destructiveLabel}>{busy === 'restore' ? 'Verifying…' : 'Verify & restore'}</Text>
                </Pressable>
              </View>
              <CapabilityReason capability={capabilities.restore} />
            </View>
          ) : null}
        </GlassCard>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { minHeight: 72, paddingHorizontal: 12, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerCopy: { flex: 1, paddingHorizontal: 8 },
  headerTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: 18 },
  headerSubtitle: { color: colors.textMuted, fontSize: 12, paddingTop: 2 },
  message: { marginTop: 12, borderWidth: 1, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  errorMessage: { borderColor: `${colors.error}55`, backgroundColor: `${colors.error}10` },
  noticeMessage: { borderColor: `${colors.success}55`, backgroundColor: `${colors.success}10` },
  capabilityReason: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  messageText: { color: colors.text, flex: 1, fontFamily: fonts.headingMedium, fontSize: 13, lineHeight: 18 },
  card: { gap: 14 },
  statusHeader: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  statusDot: { width: 11, height: 11, borderRadius: 6 },
  statusCopy: { flex: 1, gap: 3 },
  cardTitle: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 15 },
  cardMeta: { color: colors.textMuted, fontSize: 12 },
  counterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  counterCell: { width: '31%', minWidth: 88, flexGrow: 1, padding: 10, borderRadius: 10, backgroundColor: colors.bgElevated, gap: 3 },
  counterValue: { color: colors.text, fontFamily: fonts.heading, fontSize: 17, fontVariant: ['tabular-nums'] },
  counterLabel: { color: colors.textMuted, fontFamily: fonts.headingMedium, fontSize: 11 },
  failureBox: { borderLeftWidth: 3, borderLeftColor: colors.error, backgroundColor: `${colors.error}0D`, padding: 12, gap: 5 },
  failureTitle: { color: colors.error, fontFamily: fonts.headingMedium, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  failureCode: { color: colors.text, fontFamily: 'monospace', fontSize: 12 },
  failureMessage: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primaryButton: { minHeight: 44, flexGrow: 1, paddingHorizontal: 15, borderRadius: 12, backgroundColor: colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryLabel: { color: colors.onPrimary, fontFamily: fonts.headingMedium, fontSize: 13 },
  secondaryButton: { minHeight: 44, flexGrow: 1, paddingHorizontal: 15, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryLabel: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 13 },
  disabledButton: { opacity: 0.4 },
  explainRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  explainIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: `${colors.primary}16`, alignItems: 'center', justifyContent: 'center' },
  explainCopy: { flex: 1, gap: 5 },
  bodyText: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  boundaryBox: { padding: 12, borderRadius: 10, backgroundColor: colors.bgElevated, gap: 4 },
  boundaryTitle: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 12 },
  confirmBox: { borderWidth: 1, borderColor: `${colors.error}66`, borderRadius: 12, padding: 13, gap: 9, backgroundColor: `${colors.error}0A` },
  confirmTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confirmTitle: { color: colors.error, fontFamily: fonts.heading, fontSize: 14 },
  selectedName: { color: colors.text, fontFamily: fonts.headingMedium, fontSize: 13 },
  digest: { color: colors.textMuted, fontFamily: 'monospace', fontSize: 11 },
  destructiveButton: { minHeight: 44, flexGrow: 1, paddingHorizontal: 15, borderRadius: 12, backgroundColor: colors.error, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  destructiveLabel: { color: '#fff', fontFamily: fonts.headingMedium, fontSize: 13 },
})
