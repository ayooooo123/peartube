import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Panel, ScreenHeader, SectionHeader } from '@/components/primitives'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import {
  boundedError,
  createMaintenanceActions,
  maintenanceCapabilities,
  type MaintenanceCapability,
  type MaintenanceFiles,
  type MaintenanceRpc,
  type PortableSelection,
} from './maintenance-model.mjs'

type Props = {
  rpc?: MaintenanceRpc | null
  files: MaintenanceFiles
  onBack(): void
}

type BusyAction = 'export' | 'select' | 'restore' | null

function CapabilityReason({ capability }: { capability: MaintenanceCapability }) {
  if (capability.available) return null
  return <Text selectable style={styles.capabilityReason}>{capability.reason}</Text>
}

function ExportPortableStateCard({
  capability,
  busy,
  exportDisabled,
  onExport,
}: {
  capability: MaintenanceCapability
  busy: BusyAction
  exportDisabled: boolean
  onExport: () => void
}) {
  return (
    <>
      <SectionHeader title="Portable state" eyebrow="01 / 02" subtitle="Move transferable settings without moving authority" flush />
      <Panel style={styles.card}>
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
          onPress={onExport}
          disabled={exportDisabled}
          accessibilityRole="button"
          accessibilityHint={capability.reason || undefined}
          accessibilityState={{ disabled: exportDisabled }}
          style={[styles.primaryButton, exportDisabled && styles.disabledButton]}
        >
          {busy === 'export' ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Feather name="download-cloud" size={16} color={colors.onPrimary} />}
          <Text style={styles.primaryLabel}>{busy === 'export' ? 'Preparing backup…' : 'Export portable state'}</Text>
        </Pressable>
        <CapabilityReason capability={capability} />
      </Panel>
    </>
  )
}

function RestorePortableStateCard({
  selection,
  capabilities,
  busy,
  selectDisabled,
  restoreDisabled,
  onSelect,
  onRestore,
  onCancelSelection,
}: {
  selection: PortableSelection | null
  capabilities: { select: MaintenanceCapability; restore: MaintenanceCapability }
  busy: BusyAction
  selectDisabled: boolean
  restoreDisabled: boolean
  onSelect: () => void
  onRestore: () => void
  onCancelSelection: () => void
}) {
  return (
    <>
      <SectionHeader title="Restore portable state" eyebrow="02 / 02" subtitle="Select a PearTube portable-state JSON file" flush />
      <Panel style={styles.card}>
        <Text style={styles.bodyText}>Selection reads only the bounded backup file. Nothing is changed until you review the checksum and confirm below.</Text>
        <Pressable
          onPress={onSelect}
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
              <Pressable onPress={onCancelSelection} disabled={busy === 'restore'} style={[styles.secondaryButton, styles.actionFlex]} accessibilityRole="button">
                <Text style={styles.secondaryLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={onRestore}
                disabled={restoreDisabled}
                style={[styles.destructiveButton, styles.actionFlex, restoreDisabled && styles.disabledButton]}
                accessibilityRole="button"
                accessibilityHint={capabilities.restore.reason || undefined}
                accessibilityState={{ disabled: restoreDisabled }}
              >
                {busy === 'restore' ? <ActivityIndicator size="small" color={colors.text} /> : <Feather name="shield" size={15} color={colors.text} />}
                <Text style={styles.destructiveLabel}>{busy === 'restore' ? 'Verifying…' : 'Verify & restore'}</Text>
              </Pressable>
            </View>
            <CapabilityReason capability={capabilities.restore} />
          </View>
        ) : null}
      </Panel>
    </>
  )
}

export function BackupPanel({ rpc, files, onBack }: Props) {
  const insets = useSafeAreaInsets()
  const capabilities = useMemo(() => maintenanceCapabilities({ rpc, files }), [files, rpc])
  const actions = useMemo(() => createMaintenanceActions({ rpc, files }), [files, rpc])
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selection, setSelection] = useState<PortableSelection | null>(null)

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

  const anyBusy = busy !== null
  const exportDisabled = anyBusy || !capabilities.export.available
  const selectDisabled = anyBusy || !capabilities.select.available
  const restoreDisabled = busy === 'restore' || !capabilities.restore.available
  return (
    <View style={styles.screen}>
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader
          title="Maintenance & backup"
          eyebrow="01 / ARCHIVE"
          onBack={onBack}
        />
      </View>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.xxl, gap: spacing.xs }}
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

        <ExportPortableStateCard
          capability={capabilities.export}
          busy={busy}
          exportDisabled={exportDisabled}
          onExport={() => { void savePortableState() }}
        />

        <RestorePortableStateCard
          selection={selection}
          capabilities={capabilities}
          busy={busy}
          selectDisabled={selectDisabled}
          restoreDisabled={restoreDisabled}
          onSelect={() => { void selectPortableState() }}
          onRestore={() => { void restorePortableState() }}
          onCancelSelection={() => setSelection(null)}
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  message: {
    marginTop: spacing.md,
    borderWidth: borderWidth.rule,
    borderRadius: radius.card,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  errorMessage: { borderColor: colors.error, backgroundColor: colors.surface },
  noticeMessage: { borderColor: colors.success, backgroundColor: colors.surface },
  capabilityReason: { ...fonts.meta.xs, color: colors.textMuted, lineHeight: 16 },
  messageText: { color: colors.text, flex: 1, ...fonts.body.sm, lineHeight: 18 },
  card: { gap: spacing.md },
  cardTitle: { color: colors.text, ...fonts.title.md, fontSize: 15, lineHeight: 20 },
  failureMessage: { color: colors.textSecondary, ...fonts.body.sm, fontSize: 12, lineHeight: 17 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  actionFlex: { flexGrow: 1, minWidth: 140 },
  primaryButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  primaryLabel: { color: colors.onPrimary, ...fonts.label.md },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surfaceHover,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  secondaryLabel: { color: colors.text, ...fonts.label.md },
  disabledButton: { opacity: 0.4 },
  explainRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  explainIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.card,
    backgroundColor: colors.primaryLight,
    borderWidth: borderWidth.rule,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  explainCopy: { flex: 1, gap: spacing.xs },
  bodyText: { color: colors.textSecondary, ...fonts.body.sm, lineHeight: 19 },
  boundaryBox: {
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    gap: spacing.xs,
  },
  boundaryTitle: { color: colors.text, ...fonts.caption.sm },
  confirmBox: {
    borderWidth: borderWidth.rule,
    borderColor: colors.error,
    borderRadius: radius.card,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  confirmTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  confirmTitle: { color: colors.error, ...fonts.title.md, fontSize: 14, lineHeight: 18 },
  selectedName: { color: colors.text, ...fonts.meta.sm },
  digest: { color: colors.textMuted, ...fonts.meta.xs },
  destructiveButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.error,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  destructiveLabel: { color: colors.text, ...fonts.label.md },
})
