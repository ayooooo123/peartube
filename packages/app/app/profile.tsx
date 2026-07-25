/**
 * Profile — identity, devices, storage & network support, advanced settings.
 * Replaces the old Settings tab (which now redirects here).
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import DiagnosticsPanel from '@/components/native-diagnostics/DiagnosticsPanel'
import StorageOperabilityDetails from '@/components/StorageOperabilityDetails'
import { NativeSwitch } from '@/components/native-ui'
import { useApp, colors } from './_layout'
import { GlassCard, SectionHeader } from '@/components/primitives'
import { fonts } from '@/lib/typography'
import * as haptics from '@/lib/haptics'
import {
  buildStorageLimitConfirmationCopy,
  runStorageLimitChange,
  type ArchiveOperatorStatus,
  type StorageCategoryStats,
  type StorageLimitPreview,
} from '@/lib/storage-operability.js'

interface StorageStats extends StorageCategoryStats {
  usedBytes: number
  maxBytes: number
  usedGB: string
  maxGB: number
  seedCount: number
  pinnedCount: number
  // Real on-disk usage measured for the whole P2P store (uploads + cache +
  // metadata), surfaced alongside the tracked-cache quota so the storage card
  // reflects what is actually consuming space — not just the seeded subset.
  totalStorageBytes?: number
  totalStorageGB?: string
  untrackedStorageBytes?: number
  untrackedStorageGB?: string
}

interface ArchiveParticipationStatus {
  success: boolean
  enabled: boolean
  capacityBytes: number
  maxRequestBytes: number
  reservedBytes: number
  availableBytes: number
  acceptedRequests: number
  receivedPledges: number
  acceptancePermille: number
  errorCode?: string | null
}

interface TranscodeSettings {
  videoToolboxDecodeEnabled: boolean
  videoToolboxDecodeLocked?: boolean
  videoToolboxDecodeDefault?: boolean
  videoToolboxDecodeSource?: string
  videoToolboxHwMapEnabled?: boolean
  videoToolboxHwMapLocked?: boolean
  videoToolboxHwMapDefault?: boolean
  videoToolboxHwMapSource?: string
}

function formatArchiveBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  const gib = bytes / GIB
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`
}

/** Network-support presets are cache budgets — the knob that actually feeds peers. */
const SUPPORT_PRESETS: Array<{ label: string; gb: number; blurb: string }> = [
  { label: 'Light', gb: 5, blurb: 'Host a little for the network' },
  { label: 'Balanced', gb: 20, blurb: 'A solid contribution' },
  { label: 'Generous', gb: 50, blurb: 'Keep lots of videos alive' },
]

const GIB = 1024 ** 3

function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message ? `${title}\n\n${message}` : title)
    return
  }
  Alert.alert(title, message)
}

function confirmDestructive(title: string, message: string, confirmLabel: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm()
    return
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ])
}

function requestStorageLimitConfirmation(title: string, message: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`))
  }
  const { promise, resolve } = Promise.withResolvers<boolean>()
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: 'Reduce and evict', style: 'destructive', onPress: () => resolve(true) },
  ])
  return promise
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { identity, createIdentity, rpc, loadIdentity } = useApp()

  const [newName, setNewName] = useState('')
  // One-time recovery phrase display after channel creation (never persisted).
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null)
  const [restorePhrase, setRestorePhrase] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null)
  const [storageLimitPreview, setStorageLimitPreview] = useState<StorageLimitPreview | null>(null)
  const [customStorageLimit, setCustomStorageLimit] = useState('')
  const [storageLimitSaving, setStorageLimitSaving] = useState(false)
  const [clearingCache, setClearingCache] = useState(false)
  const [archiveParticipation, setArchiveParticipation] = useState<ArchiveParticipationStatus | null>(null)
  const [archiveParticipationSaving, setArchiveParticipationSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Devices
  const [devices, setDevices] = useState<any[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [pairInviteCode, setPairInviteCode] = useState('')
  const [pairDeviceName, setPairDeviceName] = useState('')
  const [pairing, setPairing] = useState(false)
  const [showPairForm, setShowPairForm] = useState(false)

  const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).Pear || !!(window as any).bridge)
  const canManageTranscodeSettings = isPear && typeof (rpc as any)?.getTranscodeSettings === 'function'
  const [transcodeSettings, setTranscodeSettings] = useState<TranscodeSettings | null>(null)
  const [transcodeSettingsLoading, setTranscodeSettingsLoading] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [swarmStatus, setSwarmStatus] = useState<any | null>(null)
  const [seedingStatus, setSeedingStatus] = useState<any | null>(null)
  const [archiveOperatorStatus, setArchiveOperatorStatus] = useState<ArchiveOperatorStatus | null>(null)


  const loadStorageStats = useCallback(async () => {
    if (!rpc) return
    try {
      const stats = await rpc.getStorageStats()
      setStorageStats(stats)
      setCustomStorageLimit(String(stats.maxGB))
    } catch (err) {
      console.error('[Profile] Failed to load storage stats:', err)
    }
  }, [rpc])

  useEffect(() => { loadStorageStats() }, [loadStorageStats])

  const loadArchiveParticipation = useCallback(async () => {
    if (!rpc || typeof rpc.getArchiveParticipation !== 'function') return
    try {
      const status = await rpc.getArchiveParticipation()
      setArchiveParticipation(status || null)
    } catch (err) {
      console.error('[Profile] Failed to load archive participation:', err)
      setArchiveParticipation(null)
    }
  }, [rpc])

  useEffect(() => { loadArchiveParticipation() }, [loadArchiveParticipation])

  const loadDiagnostics = useCallback(async () => {
    if (!rpc) return
    setDiagnosticsLoading(true)
    try {
      const [swarm, seeding, operatorStatus] = await Promise.all([
        typeof rpc.getSwarmStatus === 'function' ? rpc.getSwarmStatus().catch(() => null) : Promise.resolve(null),
        typeof rpc.getSeedingStatus === 'function' ? rpc.getSeedingStatus().catch(() => null) : Promise.resolve(null),
        typeof rpc.getArchiveOperatorStatus === 'function' ? rpc.getArchiveOperatorStatus().catch(() => null) : Promise.resolve(null),
      ])
      setSwarmStatus(swarm || null)
      setSeedingStatus(seeding || null)
      setArchiveOperatorStatus(operatorStatus || null)
    } catch (err) {
      console.error('[Profile] Failed to load diagnostics:', err)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [rpc])

  useEffect(() => { if (advancedOpen) loadDiagnostics() }, [advancedOpen, loadDiagnostics])

  const loadDevices = useCallback(async () => {
    if (!rpc || !identity?.driveKey) return
    setDevicesLoading(true)
    try {
      const res = await (rpc as any).listDevices(identity.driveKey)
      setDevices(res?.devices || [])
    } catch (err) {
      console.error('[Profile] Failed to load devices:', err)
    } finally {
      setDevicesLoading(false)
    }
  }, [rpc, identity?.driveKey])

  useEffect(() => { loadDevices() }, [loadDevices])

  const loadTranscodeSettings = useCallback(async () => {
    if (!canManageTranscodeSettings) return
    setTranscodeSettingsLoading(true)
    try {
      const res = await (rpc as any).getTranscodeSettings()
      setTranscodeSettings(res?.settings || null)
    } catch (err) {
      console.error('[Profile] Failed to load transcode settings:', err)
    } finally {
      setTranscodeSettingsLoading(false)
    }
  }, [canManageTranscodeSettings, rpc])

  useEffect(() => { loadTranscodeSettings() }, [loadTranscodeSettings])

  const handleTranscodeToggle = async (patch: { videoToolboxDecodeEnabled?: boolean; videoToolboxHwMapEnabled?: boolean }) => {
    if (!canManageTranscodeSettings) return
    setTranscodeSettings((prev) => ({ ...(prev || { videoToolboxDecodeEnabled: false }), ...patch }))
    setTranscodeSettingsLoading(true)
    try {
      const res = await (rpc as any).setTranscodeSettings(patch)
      if (res?.success === false) throw new Error(res?.error || 'Failed to update transcode settings')
      setTranscodeSettings(res?.settings || null)
    } catch (err: any) {
      console.error('[Profile] Failed to update transcode settings:', err)
      notify('Error', err?.message || 'Failed to update transcode settings')
      await loadTranscodeSettings()
    } finally {
      setTranscodeSettingsLoading(false)
    }
  }

  const createInvite = async () => {
    if (!rpc || !identity?.driveKey) return
    setInviteLoading(true)
    try {
      const res = await (rpc as any).createDeviceInvite(identity.driveKey)
      if (res?.inviteCode) {
        setInviteCode(res.inviteCode)
        haptics.success()
      }
    } catch (err: any) {
      console.error('[Profile] Failed to create invite:', err)
      notify('Error', err?.message || 'Failed to create invite')
    } finally {
      setInviteLoading(false)
    }
  }

  const pairDevice = async () => {
    if (!rpc) return
    const code = pairInviteCode.trim()
    if (!code) return
    setPairing(true)
    try {
      const res = await (rpc as any).pairDevice({
        inviteCode: code,
        deviceName: pairDeviceName.trim() || undefined,
      })
      if (res?.success) {
        setPairInviteCode('')
        setPairDeviceName('')
        setShowPairForm(false)
        haptics.success()
        notify('Linked', 'This device is now part of your channel.')
        await loadDevices()
      } else {
        throw new Error('Pair failed')
      }
    } catch (err: any) {
      console.error('[Profile] Pair device failed:', err)
      notify('Error', err?.message || 'Failed to link device')
    } finally {
      setPairing(false)
    }
  }

  const applyStorageLimit = async (boundedLimit: number) => {
    if (!rpc) return
    const result = await rpc.setStorageLimit(boundedLimit)
    if (result?.success === false) throw new Error('Failed to set storage limit')
  }

  const handleStorageLimitChange = async (newLimit: number) => {
    if (!rpc || !storageStats) return
    const boundedLimit = Math.max(1, Math.min(100, Math.round(newLimit)))
    const requestedMaxBytes = boundedLimit * GIB
    setCustomStorageLimit(String(boundedLimit))
    setStorageLimitSaving(true)

    try {
      const result = await runStorageLimitChange({
        currentMaxBytes: storageStats.maxBytes,
        requestedMaxBytes,
        previewStorageLimit: (request) => rpc.previewStorageLimit(request),
        confirm: (previewView) => requestStorageLimitConfirmation(
          `Reduce cache budget to ${boundedLimit} GB?`,
          buildStorageLimitConfirmationCopy(previewView),
        ),
        apply: () => applyStorageLimit(boundedLimit),
      })
      setStorageLimitPreview(result.preview)

      if (result.status === 'blocked') {
        notify('Limit cannot be applied', result.previewView?.summary || 'Safe eviction could not be verified.')
        return
      }
      if (result.status === 'cancelled') return

      await loadStorageStats()
      setStorageLimitPreview(null)
      haptics.success()
    } catch (err: unknown) {
      console.error('[Profile] Failed to update storage limit:', err)
      notify('Limit not changed', err instanceof Error ? err.message : 'Safe eviction could not be verified.')
      await loadStorageStats()
    } finally {
      setStorageLimitSaving(false)
    }
  }

  const handleCustomStorageLimitApply = async () => {
    const parsed = Number(customStorageLimit.trim())
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      notify('Invalid limit', 'Enter a cache budget from 1 to 100 GB')
      setCustomStorageLimit(String(storageStats?.maxGB ?? 5))
      return
    }
    await handleStorageLimitChange(parsed)
  }

  const handleArchiveParticipationChange = async (enabled: boolean) => {
    if (!rpc || typeof rpc.setArchiveParticipation !== 'function' || archiveParticipationSaving) return
    const defaultCapacity = Math.max(GIB, Math.min(storageStats?.maxBytes || (5 * GIB), 5 * GIB))
    const capacityBytes = archiveParticipation?.capacityBytes || defaultCapacity
    const maxRequestBytes = Math.min(archiveParticipation?.maxRequestBytes || capacityBytes, capacityBytes)
    const acceptancePermille = archiveParticipation?.acceptancePermille ?? 250
    setArchiveParticipationSaving(true)
    try {
      const status = await rpc.setArchiveParticipation({
        enabled,
        capacityBytes,
        maxRequestBytes,
        acceptancePermille,
      })
      if (!status?.success) throw new Error(status?.errorCode || 'Archive participation is unavailable')
      setArchiveParticipation(status)
      haptics.success()
    } catch (err: unknown) {
      notify('Archive setting not changed', err instanceof Error ? err.message : 'The backend rejected this setting.')
      await loadArchiveParticipation()
    } finally {
      setArchiveParticipationSaving(false)
    }
  }

  const handleClearCache = () => {
    if (!rpc) return
    confirmDestructive(
      'Clear cache',
      'Removes videos cached from other channels (except pinned ones). Your own videos are not affected.',
      'Clear',
      async () => {
        setClearingCache(true)
        try {
          const result = await rpc.clearCache()
          if (result.success) {
            const clearedMB = ((result.clearedBytes || 0) / (1024 * 1024)).toFixed(1)
            notify('Cache cleared', `Freed ${clearedMB} MB of tracked peer cache. Your own videos are kept.`)
            await loadStorageStats()
          }
        } catch (err) {
          console.error('[Profile] Failed to clear cache:', err)
        } finally {
          setClearingCache(false)
        }
      }
    )
  }

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await Clipboard.setStringAsync(text)
      notify('Copied', `${label} copied to clipboard`)
    } catch {
      notify('Error', 'Failed to copy to clipboard')
    }
  }

  const shareChannelKey = async () => {
    if (!identity?.driveKey) return
    try {
      await Share.share({
        message: `Subscribe to my PearTube channel: ${identity.driveKey}`,
        title: 'Share Channel',
      })
    } catch (err) {
      console.error('Share failed:', err)
    }
  }

  const shareInviteCode = async (code: string) => {
    try {
      await Share.share({ message: code, title: 'PearTube device invite' })
    } catch {
      copyToClipboard(code, 'Invite code')
    }
  }

  const handleCreateIdentity = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const newIdentity = await createIdentity(newName.trim())
      setNewName('')
      // The recovery phrase is derived at creation and never persisted by the
      // backend — this is the only chance to show it.
      const phrase = newIdentity?.seedPhrase
      if (typeof phrase === 'string' && phrase.trim().length > 0) {
        setRecoveryPhrase(phrase.trim())
      }
    } catch (err: any) {
      notify('Error', err.message || 'Failed to create channel')
    } finally {
      setCreating(false)
    }
  }


  const confirmRecoveryPhraseSaved = () => {
    confirmDestructive(
      'Phrase saved?',
      'PearTube cannot show this phrase again. Without it, your channel cannot be recovered if you lose this device.',
      "I've saved it",
      () => {
        setRecoveryPhrase(null)
      }
    )
  }

  const handleRestoreIdentity = async () => {
    if (!rpc) return
    const phrase = restorePhrase.trim().toLowerCase().split(/\s+/).join(' ')
    const wordCount = phrase ? phrase.split(' ').length : 0
    if (wordCount !== 12 && wordCount !== 24) {
      notify('Invalid phrase', 'Enter the 12-word recovery phrase, separated by spaces.')
      return
    }
    setRestoring(true)
    try {
      const result = await (rpc as any).recoverIdentity({ seedPhrase: phrase })
      const recovered = result?.identity
      if (!recovered?.publicKey) throw new Error(result?.error || 'Recovery failed')
      // recoverIdentity registers the identity but does not activate it.
      try { await (rpc as any).setActiveIdentity({ publicKey: recovered.publicKey }) } catch { /* best effort */ }
      await loadIdentity()
      setRestorePhrase('')
      setRestoreOpen(false)
      notify(
        'Channel restored',
        'Your channel key was recovered. Restart the app to finish applying the recovery key, then give the network a moment to re-sync your videos.'
      )
    } catch (err: any) {
      notify('Restore failed', err?.message || 'Could not recover a channel from that phrase.')
    } finally {
      setRestoring(false)
    }
  }


  // The budget tracks cache fetched from the network (seeded content). The
  // user's own uploads live in the same store but are never charged against
  // this limit, so we show the tracked cache sum, not raw on-disk usage.
  const usedPct = storageStats && storageStats.maxBytes > 0
    ? Math.min(100, (storageStats.usedBytes / storageStats.maxBytes) * 100)
    : 0

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
        <Feather name="chevron-down" size={22} color={colors.text} />
      </Pressable>
      <Text style={styles.headerTitle}>{identity ? 'Profile' : 'Welcome'}</Text>
      <View style={{ width: 36 }} />
    </View>
  )

  // ---------- Onboarding (no identity yet) ----------
  if (!identity) {
    return (
      <View style={styles.screen}>
        {header}
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <Text style={styles.heroTitle}>PearTube</Text>
            <Text style={styles.heroSubtitle}>Video, peer to peer. No servers, no accounts.</Text>
          </View>

          <SectionHeader title="Start a channel" subtitle="Your channel lives on your devices" />
          <GlassCard highlight style={styles.sectionCard}>
            <TextInput
              placeholder="Channel name"
              value={newName}
              onChangeText={setNewName}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              style={styles.input}
            />
            <Pressable
              onPress={handleCreateIdentity}
              disabled={creating || !newName.trim()}
              style={[styles.primaryButton, (creating || !newName.trim()) && { opacity: 0.4 }]}
            >
              {creating ? <ActivityIndicator size="small" color={colors.onPrimary} /> : (
                <>
                  <Feather name="plus" size={16} color={colors.onPrimary} />
                  <Text style={styles.primaryLabel}>Create channel</Text>
                </>
              )}
            </Pressable>
          </GlassCard>

          <SectionHeader title="Already have a channel?" subtitle="Link this device with an invite code" />
          <GlassCard style={styles.sectionCard}>
            <TextInput
              placeholder="Paste invite code"
              value={pairInviteCode}
              onChangeText={setPairInviteCode}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              style={styles.input}
            />
            <TextInput
              placeholder="Device name (optional)"
              value={pairDeviceName}
              onChangeText={setPairDeviceName}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              style={styles.input}
            />
            <Pressable
              onPress={async () => { await pairDevice(); await loadIdentity() }}
              disabled={pairing || !pairInviteCode.trim()}
              style={[styles.secondaryButton, (pairing || !pairInviteCode.trim()) && { opacity: 0.4 }]}
            >
              {pairing ? <ActivityIndicator size="small" color={colors.text} /> : (
                <>
                  <Feather name="link" size={15} color={colors.text} />
                  <Text style={styles.secondaryLabel}>Link this device</Text>
                </>
              )}
            </Pressable>
          </GlassCard>

          <SectionHeader title="Restore a channel" subtitle="Recover with your 12-word phrase" />
          {renderRestoreCard()}

          <SectionHeader title="Network cache" subtitle="Works even without a channel" />
          {renderStorageCard()}

          <SectionHeader title="Diagnostics" subtitle="Swarm, storage, and seeding state" />
          <GlassCard padded={false} style={styles.sectionCard}>
            <Pressable onPress={() => setAdvancedOpen((v) => !v)} style={styles.advancedToggle}>
              <Feather name="terminal" size={15} color={colors.textMuted} />
              <Text style={styles.advancedLabel}>Network diagnostics</Text>
              <Feather name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.textMuted} />
            </Pressable>
            {advancedOpen && (
              <DiagnosticsPanel
                swarmStatus={swarmStatus}
                storageStats={storageStats}
                seedingStatus={seedingStatus}
                operatorStatus={archiveOperatorStatus}
                loading={diagnosticsLoading}
                onRefresh={loadDiagnostics}
              />
            )}
          </GlassCard>
        </ScrollView>
      </View>
    )
  }

  function renderRecoveryPhraseCard() {
    if (!recoveryPhrase) return null
    return (
      <>
        <SectionHeader title="Recovery phrase" subtitle="Shown once — write these words down" />
        <GlassCard highlight style={styles.sectionCard}>
          <Text style={styles.recoveryWarning}>
            These 12 words are the only way to recover your channel on a new device.
            Anyone who has them controls your channel — store them somewhere safe, offline.
          </Text>
          <View style={styles.recoveryPhraseBox}>
            <Text selectable style={styles.recoveryPhraseText}>{recoveryPhrase}</Text>
          </View>
          <Pressable
            onPress={() => copyToClipboard(recoveryPhrase, 'Recovery phrase')}
            style={styles.secondaryButton}
          >
            <Feather name="copy" size={15} color={colors.text} />
            <Text style={styles.secondaryLabel}>Copy phrase</Text>
          </Pressable>
          <Pressable onPress={confirmRecoveryPhraseSaved} style={styles.primaryButton}>
            <Feather name="check" size={16} color={colors.onPrimary} />
            <Text style={styles.primaryLabel}>I&apos;ve saved my phrase</Text>
          </Pressable>
        </GlassCard>
      </>
    )
  }

  function renderRestoreCard() {
    return (
      <GlassCard style={styles.sectionCard}>
        <TextInput
          placeholder="Enter your 12-word recovery phrase"
          value={restorePhrase}
          onChangeText={setRestorePhrase}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, styles.phraseInput]}
        />
        <Pressable
          onPress={handleRestoreIdentity}
          disabled={restoring || !restorePhrase.trim()}
          style={[styles.secondaryButton, (restoring || !restorePhrase.trim()) && { opacity: 0.4 }]}
        >
          {restoring ? <ActivityIndicator size="small" color={colors.text} /> : (
            <>
              <Feather name="rotate-ccw" size={15} color={colors.text} />
              <Text style={styles.secondaryLabel}>Restore channel</Text>

            </>
          )}
        </Pressable>
      </GlassCard>
    )
  }

  // ---------- Authenticated profile ----------
  function renderStorageCard() {
    const currentGB = storageStats?.maxGB ?? null
    return (
      <GlassCard style={styles.sectionCard}>
        <View style={styles.storageHeader}>
          <View style={styles.storageIcon}>
            <Feather name="hard-drive" size={18} color={colors.swarm} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.cardTitle}>Supporting the network</Text>
            <Text style={styles.cardMeta}>
              {storageStats
                ? `Hosting ${storageStats.usedGB} GB for other viewers · ${storageStats.seedCount} videos`
                : 'Loading…'}
            </Text>
          </View>
        </View>

        <View style={styles.track}>
          <View style={[styles.fill, { width: `${usedPct}%` }]} />
        </View>
        <Text style={styles.trackLabel}>
          {storageStats ? `${storageStats.usedGB} GB of ${storageStats.maxGB} GB budget` : ' '}
        </Text>

        {storageStats?.totalStorageGB ? (
          <View style={styles.storageBreakdown}>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>On this device</Text>
              <Text style={styles.breakdownValue}>{storageStats.totalStorageGB} GB total</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>Tracked peer cache</Text>
              <Text style={styles.breakdownValue}>{storageStats.usedGB} GB cached</Text>
            </View>
            {storageStats.untrackedStorageGB && Number(storageStats.untrackedStorageBytes) > 0 ? (
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>Your videos & app/P2P data outside tracked peer cache</Text>
                <Text style={styles.breakdownValue}>{storageStats.untrackedStorageGB} GB</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <StorageOperabilityDetails stats={storageStats} preview={storageLimitPreview} />

        <View style={styles.presetRow}>
          {SUPPORT_PRESETS.map((preset) => {
            const selected = currentGB === preset.gb
            return (
              <Pressable
                key={preset.label}
                onPress={() => handleStorageLimitChange(preset.gb)}
                disabled={storageLimitSaving}
                style={[styles.preset, selected && styles.presetSelected, storageLimitSaving && { opacity: 0.7 }]}
              >
                <Text style={[styles.presetLabel, selected && { color: colors.onPrimary }]}>{preset.label}</Text>
                <Text style={[styles.presetGb, selected && { color: colors.onPrimary, opacity: 0.8 }]}>{preset.gb} GB</Text>
              </Pressable>
            )
          })}
        </View>

        <View style={styles.customRow}>
          <TextInput
            value={customStorageLimit}
            onChangeText={setCustomStorageLimit}
            onSubmitEditing={handleCustomStorageLimitApply}
            keyboardType="numeric"
            placeholder="Custom GB"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, { flex: 1, marginBottom: 0 }]}
          />
          <Pressable
            onPress={handleCustomStorageLimitApply}
            disabled={storageLimitSaving}
            style={[styles.secondaryButton, { marginTop: 0, paddingHorizontal: 16 }, storageLimitSaving && { opacity: 0.7 }]}
          >
            <Text style={styles.secondaryLabel}>{storageLimitSaving ? 'Saving…' : 'Set'}</Text>
          </Pressable>
        </View>

        {storageStats && storageStats.pinnedCount > 0 ? (
          <Text style={styles.pinnedNote}>
            <Feather name="anchor" size={11} color={colors.textMuted} />
            {'  '}{storageStats.pinnedCount} channel{storageStats.pinnedCount === 1 ? '' : 's'} kept online from your Library
          </Text>
        ) : null}

        <View style={styles.archiveParticipation}>
          <View style={styles.archiveParticipationCopy}>
            <View style={styles.archiveTitleRow}>
              <Feather name="archive" size={14} color={archiveParticipation?.enabled ? colors.swarm : colors.textMuted} />
              <Text style={styles.archiveTitle}>Volunteer archive</Text>
            </View>
            <Text style={styles.archiveDescription}>
              Randomly accept complete-copy requests from publishers. No allowlist or operator account required.
            </Text>
            <Text style={styles.archiveStatus}>
              {typeof rpc?.getArchiveParticipation !== 'function'
                ? 'Unavailable in this backend'
                : !archiveParticipation
                  ? 'Loading archive status…'
                  : !archiveParticipation.success
                    ? `Unavailable · ${archiveParticipation.errorCode || 'backend rejected status'}`
                    : archiveParticipation.enabled
                      ? `${formatArchiveBytes(archiveParticipation.reservedBytes)} pledged of ${formatArchiveBytes(archiveParticipation.capacityBytes)} · ${archiveParticipation.acceptedRequests} accepted`
                      : 'Off · no new archive requests will be accepted'}
            </Text>
          </View>
          <NativeSwitch
            value={archiveParticipation?.enabled === true}
            onValueChange={handleArchiveParticipationChange}
            disabled={!archiveParticipation?.success || archiveParticipationSaving}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor={colors.text}
          />
        </View>

        <Pressable
          onPress={handleClearCache}
          disabled={clearingCache}
          style={[styles.ghostButton, clearingCache && { opacity: 0.6 }]}
        >
          <Feather name="trash-2" size={14} color={colors.textMuted} />
          <Text style={styles.ghostLabel}>{clearingCache ? 'Clearing…' : 'Clear cached videos'}</Text>
        </Pressable>
      </GlassCard>
    )
  }

  return (
    <View style={styles.screen}>
      {header}
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
        {renderRecoveryPhraseCard()}

        {/* Identity */}
        <GlassCard highlight style={[styles.sectionCard, { marginTop: 8 }]}>
          <View style={styles.identityRow}>
            <View style={styles.bigAvatar}>
              <Text style={styles.bigAvatarLetter}>{identity.name?.charAt(0)?.toUpperCase() || '?'}</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={styles.identityName} numberOfLines={1}>{identity.name}</Text>
            </View>
          </View>

          <View style={styles.identityActions}>
            <Pressable onPress={shareChannelKey} style={[styles.primaryButton, { flex: 1 }]}>
              <Feather name="share-2" size={15} color={colors.onPrimary} />
              <Text style={styles.primaryLabel}>Share channel</Text>
            </Pressable>
            <Pressable
              onPress={() => identity.driveKey && copyToClipboard(identity.driveKey, 'Channel key')}
              style={[styles.secondaryButton, { flex: 1, marginTop: 0 }]}
            >
              <Feather name="copy" size={15} color={colors.text} />
              <Text style={styles.secondaryLabel}>Copy key</Text>
            </Pressable>
          </View>

        </GlassCard>

        {/* Devices */}
        <SectionHeader title="Your devices" subtitle="One channel, synced across devices" />
        <GlassCard style={styles.sectionCard}>
          {devices?.length ? (
            <View style={{ gap: 8, marginBottom: 12 }}>
              {devices.map((d, idx) => (
                <View key={`${d?.keyHex || idx}`} style={styles.deviceRow}>
                  <Feather name="smartphone" size={16} color={colors.textSecondary} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={styles.deviceName}>{d?.deviceName || `Device ${idx + 1}`}</Text>
                    <Text style={styles.deviceKey} numberOfLines={1}>{d?.keyHex || ''}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[styles.cardMeta, { marginBottom: 12 }]}>
              {devicesLoading ? 'Looking for linked devices…' : 'Just this device so far.'}
            </Text>
          )}

          {inviteCode ? (
            <View style={styles.inviteBox}>
              <Text style={styles.inviteLabel}>Invite code — enter it on your other device</Text>
              <Text style={styles.inviteCode} selectable>{inviteCode}</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Pressable onPress={() => copyToClipboard(inviteCode, 'Invite code')} style={[styles.secondaryButton, { flex: 1, marginTop: 0 }]}>
                  <Feather name="copy" size={14} color={colors.text} />
                  <Text style={styles.secondaryLabel}>Copy</Text>
                </Pressable>
                <Pressable onPress={() => shareInviteCode(inviteCode)} style={[styles.secondaryButton, { flex: 1, marginTop: 0 }]}>
                  <Feather name="share-2" size={14} color={colors.text} />
                  <Text style={styles.secondaryLabel}>Share</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={createInvite}
              disabled={inviteLoading}
              style={[styles.primaryButton, { flex: 1 }, inviteLoading && { opacity: 0.8 }]}
            >
              {inviteLoading ? <ActivityIndicator size="small" color={colors.onPrimary} /> : (
                <>
                  <Feather name="plus" size={15} color={colors.onPrimary} />
                  <Text style={styles.primaryLabel}>Link a device</Text>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={() => setShowPairForm((v) => !v)}
              style={[styles.secondaryButton, { flex: 1, marginTop: 0 }]}
            >
              <Feather name="key" size={14} color={colors.text} />
              <Text style={styles.secondaryLabel}>Enter code</Text>
            </Pressable>
          </View>

          {showPairForm && (
            <View style={{ marginTop: 12 }}>
              <TextInput
                placeholder="Paste invite code"
                value={pairInviteCode}
                onChangeText={setPairInviteCode}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                style={styles.input}
              />
              <TextInput
                placeholder="Device name (optional)"
                value={pairDeviceName}
                onChangeText={setPairDeviceName}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                style={styles.input}
              />
              <Pressable
                onPress={pairDevice}
                disabled={pairing || !pairInviteCode.trim()}
                style={[styles.secondaryButton, (pairing || !pairInviteCode.trim()) && { opacity: 0.4 }]}
              >
                {pairing ? <ActivityIndicator size="small" color={colors.text} /> : (
                  <Text style={styles.secondaryLabel}>Link with this code</Text>
                )}
              </Pressable>
            </View>
          )}
        </GlassCard>

        {/* Backup & recovery */}
        <SectionHeader title="Backup & recovery" subtitle="Restore a channel from its 12-word phrase" />
        {restoreOpen ? renderRestoreCard() : (
          <GlassCard padded={false} style={styles.sectionCard}>
            <Pressable onPress={() => setRestoreOpen(true)} style={styles.advancedToggle}>
              <Feather name="rotate-ccw" size={15} color={colors.textMuted} />
              <Text style={styles.advancedLabel}>Restore from recovery phrase</Text>
              <Feather name="chevron-down" size={17} color={colors.textMuted} />
            </Pressable>
          </GlassCard>
        )}

        <GlassCard padded={false} style={styles.sectionCard}>
          <Pressable onPress={() => router.push('/maintenance')} style={styles.advancedToggle} accessibilityRole="button">
            <Feather name="archive" size={15} color={colors.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.advancedLabel}>Maintenance & portable backup</Text>
              <Text style={styles.cardMeta}>Migration status, reports, export, and restore</Text>
            </View>
            <Feather name="chevron-right" size={17} color={colors.textMuted} />
          </Pressable>
        </GlassCard>

        {/* Storage / network support */}
        <SectionHeader title="Network support" subtitle="Cache space you donate to keep videos alive" />
        {renderStorageCard()}

        {/* Local trust and transfer policy */}
        <SectionHeader title="Local policy" subtitle="Control what this device discovers, transfers, and trusts" />
        <GlassCard padded={false} style={styles.sectionCard}>
          <Pressable onPress={() => router.push('/network-policy')} style={styles.advancedToggle} accessibilityRole="button">
            <Feather name="sliders" size={15} color={colors.textMuted} />
            <Text style={styles.advancedLabel}>Network, storage & retention</Text>
            <Feather name="chevron-right" size={17} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/subscriptions')}
            style={[styles.advancedToggle, { borderTopWidth: 1, borderTopColor: colors.glassBorder }]}
            accessibilityRole="button"
          >
            <Feather name="rss" size={15} color={colors.textMuted} />
            <Text style={styles.advancedLabel}>Subscriptions & feed trust</Text>
            <Feather name="chevron-right" size={17} color={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/moderation')}
            style={[styles.advancedToggle, { borderTopWidth: 1, borderTopColor: colors.glassBorder }]}
            accessibilityRole="button"
          >
            <Feather name="shield" size={15} color={colors.textMuted} />
            <Text style={styles.advancedLabel}>Moderation & analysis</Text>
            <Feather name="chevron-right" size={17} color={colors.textMuted} />
          </Pressable>
        </GlassCard>

        {/* Advanced */}
        <SectionHeader title="Advanced" />
        <GlassCard padded={false} style={styles.sectionCard}>
          <Pressable onPress={() => setAdvancedOpen((v) => !v)} style={styles.advancedToggle}>
            <Feather name="terminal" size={15} color={colors.textMuted} />
            <Text style={styles.advancedLabel}>Diagnostics & technical settings</Text>
            <Feather name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.textMuted} />
          </Pressable>

          {advancedOpen && (
            <View style={styles.advancedBody}>
              <Text style={styles.advancedFieldLabel}>Public key</Text>
              <Pressable onPress={() => copyToClipboard(identity.publicKey, 'Public key')}>
                <Text style={styles.mono} numberOfLines={2}>{identity.publicKey}</Text>
              </Pressable>

              <Text style={[styles.advancedFieldLabel, { marginTop: 14 }]}>Channel key</Text>
              <Pressable onPress={() => identity.driveKey && copyToClipboard(identity.driveKey, 'Channel key')}>
                <Text style={styles.mono} numberOfLines={2}>{identity.driveKey}</Text>
              </Pressable>

              {canManageTranscodeSettings && (
                <View style={{ marginTop: 16 }}>
                  <View style={styles.switchRow}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.cardTitle}>Hardware decode (VideoToolbox)</Text>
                      <Text style={styles.cardMeta}>Lower CPU use on this Mac. Turn off if playback is unstable.</Text>
                    </View>
                    <NativeSwitch
                      value={!!transcodeSettings?.videoToolboxDecodeEnabled}
                      onValueChange={(v: boolean) => handleTranscodeToggle({ videoToolboxDecodeEnabled: v })}
                      disabled={transcodeSettingsLoading || !!transcodeSettings?.videoToolboxDecodeLocked}
                      trackColor={{ false: colors.border, true: colors.primary }}
                      thumbColor={colors.text}
                    />
                  </View>
                  <View style={[styles.switchRow, { marginTop: 12 }]}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.cardTitle}>Hardware frame mapping</Text>
                      <Text style={styles.cardMeta}>Troubleshooting option for transfer errors.</Text>
                    </View>
                    <NativeSwitch
                      value={!!transcodeSettings?.videoToolboxHwMapEnabled}
                      onValueChange={(v: boolean) => handleTranscodeToggle({ videoToolboxHwMapEnabled: v })}
                      disabled={transcodeSettingsLoading || !!transcodeSettings?.videoToolboxHwMapLocked || !transcodeSettings?.videoToolboxDecodeEnabled}
                      trackColor={{ false: colors.border, true: colors.primary }}
                      thumbColor={colors.text}
                    />
                  </View>
                </View>
              )}

              <View style={{ marginTop: 16, marginHorizontal: -16 }}>
                <DiagnosticsPanel
                  swarmStatus={swarmStatus}
                  storageStats={storageStats}
                  seedingStatus={seedingStatus}
                  operatorStatus={archiveOperatorStatus}
                  loading={diagnosticsLoading}
                  onRefresh={loadDiagnostics}
                />
              </View>
            </View>
          )}
        </GlassCard>

        <Text style={styles.footer}>PearTube · Powered by Hyperswarm & Hyperdrive</Text>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: colors.text,
    fontSize: 17,
    fontFamily: fonts.heading,
  },
  hero: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  heroTitle: {
    color: colors.text,
    fontSize: 34,
    fontFamily: fonts.heading,
  },
  heroSubtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 6,
  },
  sectionCard: {
    marginHorizontal: 16,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  cardMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
  input: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: colors.text,
    fontSize: 14,
    marginBottom: 10,
  },
  phraseInput: {
    minHeight: 76,
    textAlignVertical: 'top',
  },
  recoveryWarning: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  recoveryPhraseBox: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  recoveryPhraseText: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 26,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.primary,
    borderRadius: 22,
    height: 42,
  },
  primaryLabel: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 22,
    height: 42,
    marginTop: 2,
  },
  secondaryLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  ghostButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginTop: 10,
  },
  ghostLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bigAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.bgActive,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigAvatarLetter: {
    color: colors.text,
    fontSize: 24,
    fontFamily: fonts.heading,
  },
  identityName: {
    color: colors.text,
    fontSize: 19,
    fontFamily: fonts.heading,
  },
  publishRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  publishDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  publishLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  identityActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 12,
    padding: 12,
  },
  deviceName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  deviceKey: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  inviteBox: {
    backgroundColor: colors.primaryLight,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  inviteLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 8,
  },
  inviteCode: {
    color: colors.text,
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.5,
  },
  storageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  storageIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.swarmDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: {
    height: 6,
    backgroundColor: colors.surface,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.swarm,
    borderRadius: 3,
  },
  trackLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 6,
    marginBottom: 14,
  },
  storageBreakdown: {
    backgroundColor: colors.glass,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 14,
    gap: 6,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  breakdownLabel: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
  },
  breakdownValue: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  preset: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  presetSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  presetLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  presetGb: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  customRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  pinnedNote: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 12,
  },
  archiveParticipation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  archiveParticipationCopy: {
    flex: 1,
  },
  archiveTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  archiveTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  archiveDescription: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 5,
  },
  archiveStatus: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 7,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
  },
  advancedLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  advancedBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    paddingTop: 14,
  },
  advancedFieldLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  mono: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  footer: {
    color: colors.textDisabled,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 24,
  },
})
