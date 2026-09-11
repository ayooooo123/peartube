/**
 * Profile — identity, devices, how this device helps the network, storage,
 * advanced settings.
 * Replaces the old Settings tab (which now redirects here).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
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
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Feather } from '@expo/vector-icons'
import DiagnosticsPanel from '@/components/native-diagnostics/DiagnosticsPanel'
import type { SeedingStatus, SwarmStatus } from '@/components/native-diagnostics/types'
import StorageOperabilityDetails from '@/components/StorageOperabilityDetails'
import { NativeSwitch } from '@/components/native-ui'
import { useApp } from './_layout'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { Button, Panel, ScreenHeader, SectionHeader } from '@/components/primitives'
import { fonts } from '@/lib/typography'
import * as haptics from '@/lib/haptics'
import { useDeveloperMode } from '@/lib/developer-mode'
import { canShowIdentityTools, developerModeDestination } from '@/lib/developer-mode-routes'
import {
  ensurePersonalEncryption,
  generatePersonalSecretHex,
  persistPersonalSecret,
  readPersonalSecretRecord,
} from '@/lib/personal-encryption'
import { hasSecureVault } from '@/lib/secure-storage'
import {
  buildStorageLimitConfirmationCopy,
  runStorageLimitChange,
  type ArchiveOperatorStatus,
  type StorageCategoryStats,
  type StorageLimitPreview,
} from '@/lib/storage-operability.js'
import { useDeviceConditionsReporter, useNetworkPolicy, useParticipationStatus } from '@/hooks/useNetworkPolicy'
import {
  PARTICIPATION_MODE_OPTIONS,
  PARTICIPATION_STATE_COPY,
  PARTICIPATION_UNAVAILABLE_COPY,
  participationReasonCopy,
  type ParticipationMode,
  type ParticipationStatus,
} from '@/lib/network-policy'

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

/** A device authorized to replicate this viewer's encrypted personal store. */
interface PersonalDevice {
  keyHex?: string
  deviceName?: string
  addedAt?: number
  self?: boolean
}

/**
 * There is exactly one contribution choice on this screen: the participation
 * mode. The old Light/Balanced/Generous cache presets wrote the same seeding
 * budget the mode now decides, so two controls disagreed about how much this
 * device helps. The exact byte ceiling stays available to operators in
 * Developer Settings and in the developer-gated field on the storage card.
 */
const GIB = 1024 ** 3

/** Personal-store invites are single-use; the backend clamps anything longer. */
const PERSONAL_INVITE_TTL_MS = 5 * 60 * 1000

/**
 * The one revoke failure where the new encrypted epoch is already recorded and
 * a restart reopens it, so the key this device just supplied has to stay. Every
 * other refusal — including `personal-revoke-failed` and
 * `personal-epoch-unavailable` — is raised with nothing written, and the
 * pre-rotation key is still the live one.
 */
const ROTATION_ALREADY_RECORDED = 'personal-revoke-incomplete'

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

function RecoveryPhraseCard({
  recoveryPhrase,
  onCopy,
  onConfirmSaved,
}: {
  recoveryPhrase: string | null
  onCopy: (phrase: string) => void
  onConfirmSaved: () => void
}) {
  if (!recoveryPhrase) return null
  return (
    <>
      <SectionHeader title="Recovery phrase" subtitle="Shown once — write these words down" />
      <Panel tone="accent" style={styles.sectionCard}>
        <Text style={styles.recoveryWarning}>
          These 12 words are the only way to recover your channel on a new device.
          Anyone who has them controls your channel — store them somewhere safe, offline.
        </Text>
        <View style={styles.recoveryPhraseBox}>
          <Text selectable style={styles.recoveryPhraseText}>{recoveryPhrase}</Text>
        </View>
        <Pressable
          onPress={() => onCopy(recoveryPhrase)}
          style={styles.secondaryButton}
        >
          <Feather name="copy" size={15} color={colors.text} />
          <Text style={styles.secondaryLabel}>Copy phrase</Text>
        </Pressable>
        <Pressable onPress={onConfirmSaved} style={styles.primaryButton}>
          <Feather name="check" size={16} color={colors.onPrimary} />
          <Text style={styles.primaryLabel}>I&apos;ve saved my phrase</Text>
        </Pressable>
      </Panel>
    </>
  )
}

function RestoreCard({
  restorePhrase,
  restoring,
  onPhraseChange,
  onRestore,
}: {
  restorePhrase: string
  restoring: boolean
  onPhraseChange: (text: string) => void
  onRestore: () => void
}) {
  return (
    <Panel style={styles.sectionCard}>
      <TextInput
        placeholder="Enter your 12-word recovery phrase"
        value={restorePhrase}
        onChangeText={onPhraseChange}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        style={[styles.input, styles.phraseInput]}
      />
      <Pressable
        onPress={onRestore}
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
    </Panel>
  )
}

function PersonalDevicesCard({
  devices,
  devicesLoading,
  vaultAvailable,
  inviteCode,
  inviteExpiresAt,
  inviteLoading,
  showPairForm,
  pairInviteCode,
  pairDeviceName,
  pairing,
  revokingKey,
  onCreateInvite,
  onTogglePairForm,
  onPairInviteCodeChange,
  onPairDeviceNameChange,
  onLinkDevice,
  onUnlinkDevice,
  onCopy,
  onShareInvite,
}: {
  devices: PersonalDevice[]
  devicesLoading: boolean
  vaultAvailable: boolean | null
  inviteCode: string | null
  inviteExpiresAt: number | null
  inviteLoading: boolean
  showPairForm: boolean
  pairInviteCode: string
  pairDeviceName: string
  pairing: boolean
  revokingKey: string | null
  onCreateInvite: () => void
  onTogglePairForm: () => void
  onPairInviteCodeChange: (code: string) => void
  onPairDeviceNameChange: (name: string) => void
  onLinkDevice: () => void
  onUnlinkDevice: (device: PersonalDevice) => void
  onCopy: (text: string, label: string) => void
  onShareInvite: (code: string) => void
}) {
  const vaultReady = vaultAvailable === true
  return (
    <>
      <SectionHeader title="Your devices" subtitle="Sync your watch state and library to devices you link" />
      <Panel style={styles.sectionCard}>
        {devices.length ? (
          <View style={{ gap: 8, marginBottom: 12 }}>
            {devices.map((device, idx) => {
              const keyHex = String(device?.keyHex || '')
              const isSelf = device?.self === true
              const busy = revokingKey === keyHex
              return (
                <View key={keyHex || idx} style={styles.deviceRow}>
                  <Feather name="smartphone" size={16} color={colors.textSecondary} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={styles.deviceName}>
                      {device?.deviceName || (isSelf ? 'This device' : `Device ${idx + 1}`)}
                    </Text>
                    <Text style={styles.deviceKey} numberOfLines={1}>{keyHex}</Text>
                  </View>
                  {isSelf || !vaultReady ? null : (
                    <Pressable
                      onPress={() => onUnlinkDevice(device)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel={`Unlink ${device?.deviceName || 'device'}`}
                      style={[styles.ghostButton, { marginTop: 0 }, busy && { opacity: 0.5 }]}
                    >
                      <Feather name="x-circle" size={14} color={colors.textMuted} />
                      <Text style={styles.ghostLabel}>{busy ? 'Unlinking…' : 'Unlink'}</Text>
                    </Pressable>
                  )}
                </View>
              )
            })}
          </View>
        ) : (
          <Text style={[styles.cardMeta, { marginBottom: 12 }]}>
            {devicesLoading ? 'Checking linked devices…' : 'Only this device holds your watch state and library.'}
          </Text>
        )}

        {vaultAvailable === false ? (
          <Text style={styles.cardMeta}>
            This device has no secure keychain that will hold a key for us, so it cannot hold the
            one that encrypts your personal store. Nothing is written to an encrypted store here
            and nothing syncs: your watch state, library, and recommendations stay on this device.
            Linking is turned off instead of keeping the key in plain text beside the data it
            protects.
          </Text>
        ) : (
          <>
            {inviteCode ? (
              <View style={styles.inviteBox}>
                <Text style={styles.inviteLabel}>
                  Single-use code — enter it on your other device within 5 minutes
                  {inviteExpiresAt ? ` (by ${new Date(inviteExpiresAt).toLocaleTimeString()})` : ''}
                </Text>
                <Text style={styles.inviteCode} selectable>{inviteCode}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <Pressable onPress={() => onCopy(inviteCode, 'Invite code')} style={[styles.secondaryButton, { flex: 1, marginTop: 0 }]}>
                    <Feather name="copy" size={14} color={colors.text} />
                    <Text style={styles.secondaryLabel}>Copy</Text>
                  </Pressable>
                  <Pressable onPress={() => onShareInvite(inviteCode)} style={[styles.secondaryButton, { flex: 1, marginTop: 0 }]}>
                    <Feather name="share-2" size={14} color={colors.text} />
                    <Text style={styles.secondaryLabel}>Share</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                onPress={onCreateInvite}
                disabled={inviteLoading || !vaultReady}
                style={[styles.primaryButton, { flex: 1 }, (inviteLoading || !vaultReady) && { opacity: 0.6 }]}
                accessibilityRole="button"
              >
                {inviteLoading ? <ActivityIndicator size="small" color={colors.onPrimary} /> : (
                  <>
                    <Feather name="plus" size={15} color={colors.onPrimary} />
                    <Text style={styles.primaryLabel}>Link a device</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                onPress={onTogglePairForm}
                disabled={!vaultReady}
                style={[styles.secondaryButton, { flex: 1, marginTop: 0 }, !vaultReady && { opacity: 0.4 }]}
                accessibilityRole="button"
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
                  onChangeText={onPairInviteCodeChange}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
                <TextInput
                  placeholder="Device name (optional)"
                  value={pairDeviceName}
                  onChangeText={onPairDeviceNameChange}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  style={styles.input}
                />
                <Pressable
                  onPress={onLinkDevice}
                  disabled={pairing || !pairInviteCode.trim() || !vaultReady}
                  style={[styles.secondaryButton, (pairing || !pairInviteCode.trim() || !vaultReady) && { opacity: 0.4 }]}
                >
                  {pairing ? (
                    <>
                      <ActivityIndicator size="small" color={colors.text} />
                      <Text style={styles.secondaryLabel}>Linking…</Text>
                    </>
                  ) : (
                    <Text style={styles.secondaryLabel}>Link with this code</Text>
                  )}
                </Pressable>
                {pairing ? (
                  <Text style={[styles.cardMeta, { marginTop: 8 }]}>
                    Finding your other device over the peer network. This usually takes a few
                    seconds and can take up to a minute — keep both devices online.
                  </Text>
                ) : null}
              </View>
            )}
          </>
        )}
      </Panel>
    </>
  )
}

function PrivacyCard({ vaultAvailable }: { vaultAvailable: boolean | null }) {
  return (
    <>
      <SectionHeader title="Privacy" subtitle="What stays here, and what other machines see" />
      <Panel style={styles.sectionCard}>
        <Text style={styles.cardTitle}>Your viewing stays on your devices</Text>
        <Text style={styles.cardMeta}>
          Watch position, completion, your library, and your recommendations are worked out
          on this device. PearTube collects no viewing analytics and runs no view counter.
          This state reaches another machine only if you link a device above.
        </Text>
        {vaultAvailable === false ? (
          <Text style={styles.cardMeta}>
            This device has no secure keychain, so there is no key to encrypt a personal store
            with and none is opened here. Anything that needs one stays unavailable rather than
            being stored unprotected.
          </Text>
        ) : (
          <Text style={styles.cardMeta}>
            It is stored in a personal store encrypted with a key that never leaves this
            device&apos;s keychain.
          </Text>
        )}

        <Text style={[styles.cardTitle, { marginTop: 14 }]}>Peers see your address and requests</Text>
        <Text style={styles.cardMeta}>
          Playback is peer-to-peer. The peers you swarm with see your IP address and the
          topics and byte ranges you ask for. That is how the transfer works and PearTube
          cannot hide it, so this is not anonymous browsing.
        </Text>

        <Text style={[styles.cardTitle, { marginTop: 14 }]}>Unlinking works forward only</Text>
        <Text style={styles.cardMeta}>
          Unlinking a device rotates your key so that device receives nothing further. It
          cannot erase what that device already read, and it cannot reach copies already
          made from it.
        </Text>
      </Panel>
    </>
  )
}

function ParticipationCard({
  networkPolicy,
  participation,
  participationSaving,
  onModeChange,
}: {
  networkPolicy: { policy?: { participationMode?: ParticipationMode | null } | null; error?: string | null; saving?: boolean }
  participation: { status: ParticipationStatus | null; loading?: boolean; error?: string | null }
  participationSaving: boolean
  onModeChange: (mode: ParticipationMode) => void
}) {
  const selectedMode = networkPolicy.policy?.participationMode ?? null
  const status = participation.status
  const stateCopy = status ? PARTICIPATION_STATE_COPY[status.state] : null
  const stateColor = !status
    ? colors.textMuted
    : status.state === 'uploading' ? colors.success
    : status.state === 'eligible' ? colors.swarm
    : colors.warning
  const busy = participationSaving || networkPolicy.saving
  const locked = busy || !networkPolicy.policy
  return (
    <>
      <SectionHeader title="How you help" eyebrow="01 NETWORK" subtitle="Sharing what you have watched keeps it reachable for other viewers" />
      <Panel style={styles.sectionCard}>
        <View style={styles.participationStateRow}>
          <View style={[styles.participationDot, { backgroundColor: stateColor }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>
              {stateCopy ? stateCopy.label : participation.loading ? 'Checking…' : 'Contribution status unavailable'}
            </Text>
            <Text style={styles.cardMeta}>
              {stateCopy
                ? stateCopy.detail
                : participation.loading
                  ? 'Reading this device\u2019s contribution state.'
                  : 'This device could not read its contribution state, so it is not reporting one.'}
            </Text>
          </View>
        </View>

        {status && (status.errorCode || status.reasonCodes.length > 0) ? (
          <View style={styles.participationReasons}>
            {status.errorCode ? (
              <Text style={styles.participationReason}>{`\u2022  ${PARTICIPATION_UNAVAILABLE_COPY}`}</Text>
            ) : null}
            {status.reasonCodes.map((code: string) => (
              <Text key={code} style={styles.participationReason}>{`\u2022  ${participationReasonCopy(code)}`}</Text>
            ))}
          </View>
        ) : null}

        {!status && participation.error ? (
          <View style={styles.participationReasons}>
            <Text style={styles.participationReason}>{participation.error}</Text>
          </View>
        ) : null}

        <View style={styles.participationModes} accessibilityRole="radiogroup">
          {PARTICIPATION_MODE_OPTIONS.map((option) => {
            const selected = selectedMode === option.value
            return (
              <Pressable
                key={option.value}
                onPress={() => onModeChange(option.value)}
                disabled={locked}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: locked }}
                style={[
                  styles.participationMode,
                  selected && styles.participationModeSelected,
                  locked && { opacity: 0.7 },
                ]}
              >
                <View style={styles.participationModeHeader}>
                  <Text style={[styles.participationModeLabel, selected && { color: colors.onPrimary }]}>{option.label}</Text>
                  {selected ? <Feather name="check" size={15} color={colors.onPrimary} /> : null}
                </View>
                <Text style={[styles.participationModeDetail, selected && { color: colors.onPrimary, opacity: 0.85 }]}>
                  {option.detail}
                </Text>
              </Pressable>
            )
          })}
        </View>

        {networkPolicy.error ? (
          <Text accessibilityRole="alert" style={styles.developerModeError}>{networkPolicy.error}</Text>
        ) : null}

        <Text style={styles.participationFootnote}>
          When your system reports that this device is warm, low on battery, low on storage, on a
          metered connection, or not allowed to work in the background, it stops on its own. Where
          it cannot read one of those signals it keeps background sharing off rather than guess.
          Helping is best effort: nothing here promises a video stays online, and none of these
          choices creates an archive pledge.
        </Text>
      </Panel>
    </>
  )
}

function StorageCard({
  storageStats,
  storageLimitPreview,
  usedPct,
  developerModeEnabled,
  customStorageLimit,
  storageLimitSaving,
  clearingCache,
  onCustomLimitChange,
  onCustomLimitApply,
  onClearCache,
}: {
  storageStats: StorageStats | null
  storageLimitPreview: StorageLimitPreview | null
  usedPct: number
  developerModeEnabled: boolean
  customStorageLimit: string
  storageLimitSaving: boolean
  clearingCache: boolean
  onCustomLimitChange: (val: string) => void
  onCustomLimitApply: () => void
  onClearCache: () => void
}) {
  return (
    <Panel style={styles.sectionCard}>
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

      <Text style={styles.cardMeta}>
        Your sharing choice above sets this budget, unless a different one has been set in
        Developer Settings. Cached video is evicted to stay inside it.
      </Text>

      {developerModeEnabled ? (
        <View style={styles.developerLimitBlock}>
          <Text style={styles.advancedFieldLabel}>Cache budget override (GB)</Text>
          <Text style={styles.cardMeta}>
            The same disk ceiling Developer Settings › Network policy edits. Set it to anything other
            than the sharing choice&apos;s own value and it stops following that choice in either
            direction; set it back and it follows again. Lowering it previews and confirms eviction
            before anything is removed.
          </Text>
          <View style={[styles.customRow, { marginTop: 10 }]}>
            <TextInput
              value={customStorageLimit}
              onChangeText={onCustomLimitChange}
              onSubmitEditing={onCustomLimitApply}
              keyboardType="numeric"
              placeholder="Custom GB"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
            />
            <Pressable
              onPress={onCustomLimitApply}
              disabled={storageLimitSaving}
              style={[styles.secondaryButton, { marginTop: 0, paddingHorizontal: 16 }, storageLimitSaving && { opacity: 0.7 }]}
            >
              <Text style={styles.secondaryLabel}>{storageLimitSaving ? 'Saving…' : 'Set'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {storageStats && storageStats.pinnedCount > 0 ? (
        <Text style={styles.pinnedNote}>
          <Feather name="anchor" size={11} color={colors.textMuted} />
          {'  '}{storageStats.pinnedCount} channel{storageStats.pinnedCount === 1 ? '' : 's'} kept online from your Library
        </Text>
      ) : null}

      <Pressable
        onPress={onClearCache}
        disabled={clearingCache}
        style={[styles.ghostButton, clearingCache && { opacity: 0.6 }]}
      >
        <Feather name="trash-2" size={14} color={colors.textMuted} />
        <Text style={styles.ghostLabel}>{clearingCache ? 'Clearing…' : 'Clear cached videos'}</Text>
      </Pressable>
    </Panel>
  )
}

function ProfileDiagnosticsCard({
  advancedOpen,
  identity,
  canManageTranscodeSettings,
  transcodeSettings,
  transcodeSettingsLoading,
  swarmStatus,
  storageStats,
  seedingStatus,
  archiveOperatorStatus,
  diagnosticsLoading,
  onToggleAdvanced,
  onCopy,
  onTranscodeToggle,
  onRefreshDiagnostics,
}: {
  advancedOpen: boolean
  identity: { publicKey: string; driveKey?: string | null }
  canManageTranscodeSettings: boolean
  transcodeSettings: TranscodeSettings | null
  transcodeSettingsLoading: boolean
  swarmStatus: SwarmStatus | null
  storageStats: StorageStats | null
  seedingStatus: SeedingStatus | null
  archiveOperatorStatus: ArchiveOperatorStatus | null
  diagnosticsLoading: boolean
  onToggleAdvanced: () => void
  onCopy: (text: string, label: string) => void
  onTranscodeToggle: (patch: { videoToolboxDecodeEnabled?: boolean; videoToolboxHwMapEnabled?: boolean }) => void
  onRefreshDiagnostics: () => void
}) {
  return (
    <>
      <SectionHeader title="Diagnostics" eyebrow="05 DIAGNOSTICS" subtitle="Local swarm, storage, and technical state" />
      <Panel padded={false} style={styles.sectionCard}>
        <Pressable onPress={onToggleAdvanced} style={styles.advancedToggle}>
          <Feather name="terminal" size={15} color={colors.textMuted} />
          <Text style={styles.advancedLabel}>Diagnostics & technical settings</Text>
          <Feather name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.textMuted} />
        </Pressable>
        {advancedOpen && (
          <View style={styles.advancedBody}>
            <Text style={styles.advancedFieldLabel}>Public key</Text>
            <Pressable onPress={() => onCopy(identity.publicKey, 'Public key')}>
              <Text style={styles.mono} numberOfLines={2}>{identity.publicKey}</Text>
            </Pressable>

            <Text style={[styles.advancedFieldLabel, { marginTop: 14 }]}>Channel key</Text>
            <Pressable onPress={() => identity.driveKey && onCopy(identity.driveKey, 'Channel key')}>
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
                    onValueChange={(v: boolean) => onTranscodeToggle({ videoToolboxDecodeEnabled: v })}
                    disabled={transcodeSettingsLoading || !!transcodeSettings?.videoToolboxDecodeLocked}
                    trackColor={{ false: colors.bgActive, true: colors.primary }}
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
                    onValueChange={(v: boolean) => onTranscodeToggle({ videoToolboxHwMapEnabled: v })}
                    disabled={transcodeSettingsLoading || !!transcodeSettings?.videoToolboxHwMapLocked || !transcodeSettings?.videoToolboxDecodeEnabled}
                    trackColor={{ false: colors.bgActive, true: colors.primary }}
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
                onRefresh={onRefreshDiagnostics}
              />
            </View>
          </View>
        )}
      </Panel>
    </>
  )
}

function ProfileHeader({
  title,
  topInset,
  onBack,
}: {
  title: string
  topInset: number
  onBack: () => void
}) {
  return (
    <View style={{ paddingTop: topInset }}>
      <ScreenHeader
        title={title}
        eyebrow="IDENTITY / DEVICE"
        onBack={onBack}
      />
    </View>
  )
}

function DeveloperModeSection({
  enabled,
  isLoading,
  error,
  onToggle,
  onOpenSettings,
}: {
  enabled: boolean
  isLoading: boolean
  error: string | null
  onToggle: (enabled: boolean) => void
  onOpenSettings: () => void
}) {
  return (
    <>
      <SectionHeader title="Developer Mode" eyebrow="04 DEVELOPER" subtitle="Local operator tools for this device" />
      <Panel style={styles.sectionCard}>
        <View style={styles.switchRow}>
          <View style={{ flex: 1, paddingRight: spacing.md }}>
            <Text style={styles.cardTitle}>Developer Mode</Text>
            <Text style={styles.cardMeta}>Shows publishing and network administration tools locally. It does not grant publishing permission.</Text>
          </View>
          <NativeSwitch
            value={enabled}
            disabled={isLoading}
            onValueChange={onToggle}
            trackColor={{ false: colors.bgActive, true: colors.primary }}
            thumbColor={colors.text}
          />
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.developerModeError}>{error}</Text> : null}
        {enabled ? (
          <Button
            label="Open Developer Settings"
            variant="secondary"
            icon="tool"
            onPress={onOpenSettings}
            style={{ marginTop: spacing.md }}
          />
        ) : null}
      </Panel>
    </>
  )
}

function ProfileSharedCards({
  devices,
  devicesLoading,
  vaultAvailable,
  inviteCode,
  inviteExpiresAt,
  inviteLoading,
  showPairForm,
  pairInviteCode,
  pairDeviceName,
  pairing,
  revokingKey,
  onCreateInvite,
  onTogglePairForm,
  onPairInviteCodeChange,
  onPairDeviceNameChange,
  onLinkDevice,
  onUnlinkDevice,
  onCopy,
  onShareInvite,
  networkPolicy,
  participation,
  participationSaving,
  onParticipationModeChange,
  storageStats,
  storageLimitPreview,
  usedPct,
  developerModeEnabled,
  customStorageLimit,
  storageLimitSaving,
  clearingCache,
  onCustomLimitChange,
  onCustomLimitApply,
  onClearCache,
  storageSectionSubtitle,
  developerModeSection,
}: {
  devices: PersonalDevice[]
  devicesLoading: boolean
  vaultAvailable: boolean | null
  inviteCode: string | null
  inviteExpiresAt: number | null
  inviteLoading: boolean
  showPairForm: boolean
  pairInviteCode: string
  pairDeviceName: string
  pairing: boolean
  revokingKey: string | null
  onCreateInvite: () => void
  onTogglePairForm: () => void
  onPairInviteCodeChange: (code: string) => void
  onPairDeviceNameChange: (name: string) => void
  onLinkDevice: () => void
  onUnlinkDevice: (device: PersonalDevice) => void
  onCopy: (text: string, label: string) => void
  onShareInvite: (code: string) => void
  networkPolicy: { policy?: { participationMode?: ParticipationMode | null } | null; error?: string | null; saving?: boolean }
  participation: { status: ParticipationStatus | null; loading?: boolean; error?: string | null }
  participationSaving: boolean
  onParticipationModeChange: (mode: ParticipationMode) => void
  storageStats: StorageStats | null
  storageLimitPreview: StorageLimitPreview | null
  usedPct: number
  developerModeEnabled: boolean
  customStorageLimit: string
  storageLimitSaving: boolean
  clearingCache: boolean
  onCustomLimitChange: (val: string) => void
  onCustomLimitApply: () => void
  onClearCache: () => void
  storageSectionSubtitle: string
  developerModeSection: ReactNode
}) {
  return (
    <>
      <PersonalDevicesCard
        devices={devices}
        devicesLoading={devicesLoading}
        vaultAvailable={vaultAvailable}
        inviteCode={inviteCode}
        inviteExpiresAt={inviteExpiresAt}
        inviteLoading={inviteLoading}
        showPairForm={showPairForm}
        pairInviteCode={pairInviteCode}
        pairDeviceName={pairDeviceName}
        pairing={pairing}
        revokingKey={revokingKey}
        onCreateInvite={onCreateInvite}
        onTogglePairForm={onTogglePairForm}
        onPairInviteCodeChange={onPairInviteCodeChange}
        onPairDeviceNameChange={onPairDeviceNameChange}
        onLinkDevice={onLinkDevice}
        onUnlinkDevice={onUnlinkDevice}
        onCopy={onCopy}
        onShareInvite={onShareInvite}
      />

      <PrivacyCard vaultAvailable={vaultAvailable} />

      <ParticipationCard
        networkPolicy={networkPolicy}
        participation={participation}
        participationSaving={participationSaving}
        onModeChange={onParticipationModeChange}
      />

      <SectionHeader title="Storage used for sharing" eyebrow="02 STORAGE" subtitle={storageSectionSubtitle} />
      <StorageCard
        storageStats={storageStats}
        storageLimitPreview={storageLimitPreview}
        usedPct={usedPct}
        developerModeEnabled={developerModeEnabled}
        customStorageLimit={customStorageLimit}
        storageLimitSaving={storageLimitSaving}
        clearingCache={clearingCache}
        onCustomLimitChange={onCustomLimitChange}
        onCustomLimitApply={onCustomLimitApply}
        onClearCache={onClearCache}
      />

      {developerModeSection}
    </>
  )
}

function ProfileOnboardingBody({
  showIdentityTools,
  newName,
  creating,
  onNameChange,
  onCreateIdentity,
  restorePhrase,
  restoring,
  onPhraseChange,
  onRestore,
  sharedCards,
}: {
  showIdentityTools: boolean
  newName: string
  creating: boolean
  onNameChange: (name: string) => void
  onCreateIdentity: () => void
  restorePhrase: string
  restoring: boolean
  onPhraseChange: (text: string) => void
  onRestore: () => void
  sharedCards: ReactNode
}) {
  return (
    <>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>PearTube</Text>
        <Text style={styles.heroSubtitle}>Video, peer to peer. No servers, no accounts.</Text>
      </View>

      {showIdentityTools ? (
        <>
          <SectionHeader title="Start a channel" subtitle="Your channel lives on your devices" />
          <Panel tone="accent" style={styles.sectionCard}>
            <TextInput
              placeholder="Channel name"
              value={newName}
              onChangeText={onNameChange}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              style={styles.input}
            />
            <Pressable
              onPress={onCreateIdentity}
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
          </Panel>

          <SectionHeader title="Restore a channel" subtitle="Recover with your 12-word phrase" />
          <RestoreCard
            restorePhrase={restorePhrase}
            restoring={restoring}
            onPhraseChange={onPhraseChange}
            onRestore={onRestore}
          />
        </>
      ) : null}

      {sharedCards}
    </>
  )
}

function ProfileIdentityBody({
  showIdentityTools,
  recoveryPhrase,
  onCopyPhrase,
  onConfirmPhraseSaved,
  identityName,
  identityKey,
  onShareChannel,
  onCopyKey,
  restoreOpen,
  onOpenRestore,
  restorePhrase,
  restoring,
  onPhraseChange,
  onRestore,
  sharedCards,
  developerModeEnabled,
  diagnostics,
}: {
  showIdentityTools: boolean
  recoveryPhrase: string | null
  onCopyPhrase: (phrase: string) => void
  onConfirmPhraseSaved: () => void
  identityName?: string | null
  identityKey?: string | null
  onShareChannel: () => void
  onCopyKey: () => void
  restoreOpen: boolean
  onOpenRestore: () => void
  restorePhrase: string
  restoring: boolean
  onPhraseChange: (text: string) => void
  onRestore: () => void
  sharedCards: ReactNode
  developerModeEnabled: boolean
  diagnostics: ReactNode
}) {
  return (
    <>
      {showIdentityTools ? (
        <>
          <RecoveryPhraseCard
            recoveryPhrase={recoveryPhrase}
            onCopy={onCopyPhrase}
            onConfirmSaved={onConfirmPhraseSaved}
          />

          <Panel tone="accent" style={[styles.sectionCard, { marginTop: spacing.sm }]}>
            <View style={styles.identityRow}>
              <View style={styles.bigAvatar}>
                <Text style={styles.bigAvatarLetter}>{identityName?.charAt(0)?.toUpperCase() || '?'}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Text style={styles.identityName} numberOfLines={1}>{identityName}</Text>
                {identityKey ? (
                  <Text style={styles.identityKey} numberOfLines={1}>
                    {(() => {
                      const key = String(identityKey)
                      return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key
                    })()}
                  </Text>
                ) : null}
              </View>
            </View>

            <View style={styles.identityActions}>
              <Button label="Share channel" icon="share-2" onPress={onShareChannel} style={{ flex: 1 }} />
              <Button
                label="Copy key"
                icon="copy"
                variant="secondary"
                onPress={onCopyKey}
                style={{ flex: 1 }}
              />
            </View>
          </Panel>

          <SectionHeader title="Backup & recovery" eyebrow="03 PUBLISHER" subtitle="Restore a channel from its 12-word phrase" />
          {restoreOpen ? (
            <RestoreCard
              restorePhrase={restorePhrase}
              restoring={restoring}
              onPhraseChange={onPhraseChange}
              onRestore={onRestore}
            />
          ) : (
            <Panel padded={false} style={styles.sectionCard}>
              <Pressable onPress={onOpenRestore} style={styles.advancedToggle}>
                <Feather name="rotate-ccw" size={15} color={colors.textMuted} />
                <Text style={styles.advancedLabel}>Restore from recovery phrase</Text>
                <Feather name="chevron-down" size={17} color={colors.textMuted} />
              </Pressable>
            </Panel>
          )}
        </>
      ) : null}

      {sharedCards}

      {developerModeEnabled ? diagnostics : null}
      <Text style={styles.footer}>PearTube · Powered by Hyperswarm & Hyperdrive</Text>
    </>
  )
}

async function runPersonalDeviceUnlink(args: {
  rpc: {
    revokePersonalDevice: (request: {
      keyHex: string
      secret: string
      deviceName?: string
    }) => Promise<{ success?: boolean; error?: string; bootstrapKey?: string } | null | undefined>
  }
  keyHex: string
  deviceName?: string
  personalOwner: string | null
  loadPersonalDevices: () => Promise<void>
}): Promise<void> {
  const { rpc, keyHex, deviceName, personalOwner, loadPersonalDevices } = args
  // Forward-only rotation: this device mints the next epoch key, and the
  // backend opens a new encrypted store with it. The old key is dead the
  // moment the backend rotates, so the new one has to be in the vault
  // before the request goes out — not after the response comes back. The
  // pre-rotation key rides along as the startup fallback for the one
  // outcome where the epoch is recorded but never activated.
  const previous = await readPersonalSecretRecord(personalOwner)
  const secret = generatePersonalSecretHex()
  await persistPersonalSecret(secret, { publicKey: personalOwner, previousSecret: previous?.secret })

  const res = await rpc.revokePersonalDevice({
    keyHex,
    secret,
    deviceName: deviceName || undefined,
  })
  if (!res?.success) {
    if (res?.error === ROTATION_ALREADY_RECORDED) {
      // The new epoch is already recorded and a restart reopens it, so
      // restoring the old key here would leave this device unable to
      // unwrap its own store. The new one stays.
      notify(
        'Unlink did not finish',
        'The new key is saved on this device. Restart PearTube and unlink again — your library may take a moment to reopen.',
      )
      return
    }
    // Every other refusal is raised before anything is written, so the
    // previous key is still the live one and has to go back.
    if (previous) await persistPersonalSecret(previous.secret, { publicKey: personalOwner, bootstrapKey: previous.bootstrapKey })
    throw new Error(res?.error || 'Failed to unlink device')
  }

  await persistPersonalSecret(secret, { publicKey: personalOwner, bootstrapKey: res.bootstrapKey })
  await ensurePersonalEncryption(rpc, personalOwner, { force: true, required: true })
  haptics.success()
  notify(
    'Device unlinked',
    'Future state stays on this device. Every device you keep has to be linked again before it syncs.',
  )
  await loadPersonalDevices()
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const params = useLocalSearchParams<{ developer?: string }>()
  const developerMode = useDeveloperMode()
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [developerModeError, setDeveloperModeError] = useState<string | null>(null)

  // Personal-store devices. This is the viewer's own encrypted watch state and
  // library — deliberately not publisher-channel pairing, which lives in
  // Studio behind Developer Mode and never appears on this screen.
  const [devices, setDevices] = useState<PersonalDevice[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [pairInviteCode, setPairInviteCode] = useState('')
  const [pairDeviceName, setPairDeviceName] = useState('')
  const [pairing, setPairing] = useState(false)
  const [showPairForm, setShowPairForm] = useState(false)
  const [revokingKey, setRevokingKey] = useState<string | null>(null)
  // null while the vault probe is in flight; false means "no vault on this device".
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null)
  const personalOwner = identity?.publicKey || null

  const isPear = Platform.OS === 'web' && typeof window !== 'undefined' && (!!(window as any).Pear || !!(window as any).bridge)
  const canManageTranscodeSettings = isPear && typeof (rpc as any)?.getTranscodeSettings === 'function'
  const [transcodeSettings, setTranscodeSettings] = useState<TranscodeSettings | null>(null)
  const [transcodeSettingsLoading, setTranscodeSettingsLoading] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [swarmStatus, setSwarmStatus] = useState<SwarmStatus | null>(null)
  const [seedingStatus, setSeedingStatus] = useState<SeedingStatus | null>(null)
  const [archiveOperatorStatus, setArchiveOperatorStatus] = useState<ArchiveOperatorStatus | null>(null)
  const diagnosticsDestination = developerModeDestination(developerMode.enabled, '/profile?developer=diagnostics')
  const showIdentityTools = canShowIdentityTools(developerMode.enabled)

  // The contribution choice and its live state both come from the backend. The
  // screen only picks a mode and renders what the resource policy reports; it
  // never decides locally whether this device is eligible or uploading.
  const networkPolicy = useNetworkPolicy(rpc)
  const participation = useParticipationStatus(rpc)
  // The status below is only as truthful as the signals the backend holds, and
  // the desktop shell has its own root layout, so the card reports this
  // device's OS signals for as long as it is on screen. The reporter is shared
  // per backend connection, so mounting it here as well costs nothing.
  useDeviceConditionsReporter(rpc)
  const [participationSaving, setParticipationSaving] = useState(false)


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

  useEffect(() => {
    if (!developerMode.enabled) setAdvancedOpen(false)
    if (developerMode.enabled && params.developer === 'diagnostics') setAdvancedOpen(true)
  }, [developerMode.enabled, params.developer])

  useEffect(() => {
    if (developerMode.enabled && advancedOpen) loadDiagnostics()
  }, [advancedOpen, developerMode.enabled, loadDiagnostics])

  // Linking moves a 32-byte store key onto this device. With no OS vault to
  // hold it, this device stays device-local instead of quietly writing the key
  // to a plaintext file, so the controls below are disabled and say why.
  useEffect(() => {
    let cancelled = false
    hasSecureVault()
      .then((available) => { if (!cancelled) setVaultAvailable(available) })
      .catch(() => { if (!cancelled) setVaultAvailable(false) })
    return () => { cancelled = true }
  }, [])

  const loadPersonalDevices = useCallback(async () => {
    if (typeof rpc?.listPersonalDevices !== 'function') return
    setDevicesLoading(true)
    try {
      const res = await rpc.listPersonalDevices()
      setDevices(res?.success === false ? [] : (res?.devices || []))
    } catch (err: unknown) {
      console.error('[Profile] Failed to load paired devices:', err instanceof Error ? err.message : err)
    } finally {
      setDevicesLoading(false)
    }
  }, [rpc])

  useEffect(() => { loadPersonalDevices() }, [loadPersonalDevices])

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

  const createPersonalInvite = async () => {
    if (!rpc || vaultAvailable !== true) return
    setInviteLoading(true)
    try {
      const res = await rpc.createPersonalDeviceInvite({ expiresInMs: PERSONAL_INVITE_TTL_MS })
      if (!res?.success || !res?.inviteCode) throw new Error(res?.error || 'Failed to create invite')
      setInviteCode(res.inviteCode)
      setInviteExpiresAt(typeof res.expiresAt === 'number' ? res.expiresAt : null)
      haptics.success()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create invite'
      console.error('[Profile] Failed to create device invite:', message)
      notify('Error', message)
    } finally {
      setInviteLoading(false)
    }
  }

  const linkThisDevice = async () => {
    if (!rpc || vaultAvailable !== true) return
    const code = pairInviteCode.trim()
    if (!code) return
    setPairing(true)
    try {
      const res = await rpc.redeemPersonalDeviceInvite({
        inviteCode: code,
        deviceName: pairDeviceName.trim() || undefined,
      })
      if (!res?.success || !res?.secret) throw new Error(res?.error || 'Failed to link this device')
      // The one response in the protocol that carries the store key. Persist it
      // durably before anything opens the store, then drop the response copy.
      // JS strings cannot be zeroed, so the discipline is: never render it,
      // never log it, never hold a reference past this block.
      await persistPersonalSecret(res.secret, {
        publicKey: personalOwner,
        bootstrapKey: res.bootstrapKey,
      })
      res.secret = ''
      await ensurePersonalEncryption(rpc, personalOwner, { force: true, required: true })
      setPairInviteCode('')
      setPairDeviceName('')
      setShowPairForm(false)
      haptics.success()
      notify('Device linked', 'Your watch state and library now sync between your linked devices.')
      await loadPersonalDevices()
    } catch (err: unknown) {
      // Only the block above ever holds the store key; error text never does.
      const message = err instanceof Error ? err.message : 'Failed to link this device'
      console.error('[Profile] Failed to link device:', message)
      notify('Error', message)
    } finally {
      setPairing(false)
    }
  }

  const unlinkDevice = (device: PersonalDevice) => {
    const keyHex = String(device?.keyHex || '')
    if (!rpc || !keyHex || vaultAvailable !== true) return
    confirmDestructive(
      'Unlink this device?',
      'Your other devices move to a new key and keep syncing; each of them has to be linked again. The unlinked device stops receiving updates, but everything it already read stays on it — unlinking cannot take that back.',
      'Unlink',
      async () => {
        setRevokingKey(keyHex)
        try {
          await runPersonalDeviceUnlink({
            rpc,
            keyHex,
            deviceName: device?.deviceName,
            personalOwner,
            loadPersonalDevices,
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Failed to unlink device'
          console.error('[Profile] Failed to unlink device:', message)
          notify('Error', message)
        } finally {
          setRevokingKey(null)
        }
      },
    )
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

  /**
   * Record the viewer's choice and re-read the backend. The new ceilings and
   * the new contribution state are both the backend's answer, so nothing here
   * predicts them: the card keeps showing the previous reported state until the
   * policy has actually been re-read. `update` reports a rejected save through
   * `networkPolicy.error`, so there is no success signal to fire here.
   */
  const handleParticipationModeChange = async (participationMode: ParticipationMode) => {
    if (!rpc || participationSaving) return
    setParticipationSaving(true)
    try {
      await networkPolicy.update({ participationMode })
      await participation.reload()
      await loadStorageStats()
    } finally {
      setParticipationSaving(false)
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

  const handleDeveloperModeChange = async (enabled: boolean) => {
    setDeveloperModeError(null)
    try {
      await developerMode.setEnabled(enabled)
    } catch {
      setDeveloperModeError('Unable to update Developer Mode locally. Please try again.')
    }
  }


  // The budget tracks cache fetched from the network (seeded content). The
  // user's own uploads live in the same store but are never charged against
  // this limit, so we show the tracked cache sum, not raw on-disk usage.
  const usedPct = storageStats && storageStats.maxBytes > 0
    ? Math.min(100, (storageStats.usedBytes / storageStats.maxBytes) * 100)
    : 0

  const developerModeSection = (
    <DeveloperModeSection
      enabled={developerMode.enabled}
      isLoading={developerMode.isLoading}
      error={developerModeError}
      onToggle={(enabled) => { void handleDeveloperModeChange(enabled) }}
      onOpenSettings={() => router.push('/developer-settings')}
    />
  )

  const renderSharedCards = (storageSectionSubtitle: string) => (
    <ProfileSharedCards
      devices={devices}
      devicesLoading={devicesLoading}
      vaultAvailable={vaultAvailable}
      inviteCode={inviteCode}
      inviteExpiresAt={inviteExpiresAt}
      inviteLoading={inviteLoading}
      showPairForm={showPairForm}
      pairInviteCode={pairInviteCode}
      pairDeviceName={pairDeviceName}
      pairing={pairing}
      revokingKey={revokingKey}
      onCreateInvite={createPersonalInvite}
      onTogglePairForm={() => setShowPairForm((v) => !v)}
      onPairInviteCodeChange={setPairInviteCode}
      onPairDeviceNameChange={setPairDeviceName}
      onLinkDevice={linkThisDevice}
      onUnlinkDevice={unlinkDevice}
      onCopy={copyToClipboard}
      onShareInvite={shareInviteCode}
      networkPolicy={networkPolicy}
      participation={participation}
      participationSaving={participationSaving}
      onParticipationModeChange={(mode) => { void handleParticipationModeChange(mode) }}
      storageStats={storageStats}
      storageLimitPreview={storageLimitPreview}
      usedPct={usedPct}
      developerModeEnabled={developerMode.enabled}
      customStorageLimit={customStorageLimit}
      storageLimitSaving={storageLimitSaving}
      clearingCache={clearingCache}
      onCustomLimitChange={setCustomStorageLimit}
      onCustomLimitApply={handleCustomStorageLimitApply}
      onClearCache={handleClearCache}
      storageSectionSubtitle={storageSectionSubtitle}
      developerModeSection={developerModeSection}
    />
  )

  if (!developerMode.isLoading && params.developer && diagnosticsDestination) {
    return <Redirect href={diagnosticsDestination as never} />
  }

  // ---------- Onboarding (no identity yet) ----------
  if (!identity) {
    return (
      <View style={styles.screen}>
        <ProfileHeader title="Welcome" topInset={insets.top} onBack={() => router.back()} />
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
          <ProfileOnboardingBody
            showIdentityTools={showIdentityTools}
            newName={newName}
            creating={creating}
            onNameChange={setNewName}
            onCreateIdentity={handleCreateIdentity}
            restorePhrase={restorePhrase}
            restoring={restoring}
            onPhraseChange={setRestorePhrase}
            onRestore={handleRestoreIdentity}
            sharedCards={renderSharedCards('Works even without a channel')}
          />
        </ScrollView>
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      <ProfileHeader title="Profile" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
        <ProfileIdentityBody
          showIdentityTools={showIdentityTools}
          recoveryPhrase={recoveryPhrase}
          onCopyPhrase={(phrase) => copyToClipboard(phrase, 'Recovery phrase')}
          onConfirmPhraseSaved={confirmRecoveryPhraseSaved}
          identityName={identity.name}
          identityKey={identity.publicKey || identity.driveKey}
          onShareChannel={shareChannelKey}
          onCopyKey={() => { if (identity.driveKey) void copyToClipboard(identity.driveKey, 'Channel key') }}
          restoreOpen={restoreOpen}
          onOpenRestore={() => setRestoreOpen(true)}
          restorePhrase={restorePhrase}
          restoring={restoring}
          onPhraseChange={setRestorePhrase}
          onRestore={handleRestoreIdentity}
          sharedCards={renderSharedCards('Cache space this device is holding for other viewers')}
          developerModeEnabled={developerMode.enabled}
          diagnostics={(
            <ProfileDiagnosticsCard
              advancedOpen={advancedOpen}
              identity={identity}
              canManageTranscodeSettings={canManageTranscodeSettings}
              transcodeSettings={transcodeSettings}
              transcodeSettingsLoading={transcodeSettingsLoading}
              swarmStatus={swarmStatus}
              storageStats={storageStats}
              seedingStatus={seedingStatus}
              archiveOperatorStatus={archiveOperatorStatus}
              diagnosticsLoading={diagnosticsLoading}
              onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
              onCopy={copyToClipboard}
              onTranscodeToggle={handleTranscodeToggle}
              onRefreshDiagnostics={loadDiagnostics}
            />
          )}
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  hero: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  heroTitle: {
    color: colors.text,
    ...fonts.title.xl,
  },
  heroSubtitle: {
    color: colors.textMuted,
    ...fonts.body.sm,
    marginTop: spacing.sm - 2,
  },
  sectionCard: {
    marginHorizontal: spacing.lg,
  },
  cardTitle: {
    color: colors.text,
    ...fonts.title.md,
    fontSize: 14,
    lineHeight: 18,
  },
  cardMeta: {
    color: colors.textMuted,
    ...fonts.body.sm,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
  input: {
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 1,
    color: colors.text,
    ...fonts.body.sm,
    marginBottom: spacing.sm,
  },
  phraseInput: {
    minHeight: 76,
    textAlignVertical: 'top',
  },
  recoveryWarning: {
    color: colors.textSecondary,
    ...fonts.body.sm,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  recoveryPhraseBox: {
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  recoveryPhraseText: {
    color: colors.text,
    ...fonts.meta.md,
    fontSize: 16,
    lineHeight: 26,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm - 1,
    backgroundColor: colors.primary,
    borderRadius: radius.card,
    height: 42,
  },
  primaryLabel: {
    color: colors.onPrimary,
    ...fonts.label.md,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm - 1,
    backgroundColor: colors.surface,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.card,
    height: 42,
    marginTop: 2,
  },
  secondaryLabel: {
    color: colors.text,
    ...fonts.label.md,
  },
  ghostButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm - 2,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  ghostLabel: {
    color: colors.textMuted,
    ...fonts.label.md,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bigAvatar: {
    width: 64,
    height: 64,
    borderRadius: radius.card,
    backgroundColor: colors.bgActive,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigAvatarLetter: {
    color: colors.text,
    ...fonts.title.lg,
    fontSize: 24,
    lineHeight: 28,
  },
  identityName: {
    color: colors.text,
    ...fonts.title.lg,
    fontSize: 20,
    lineHeight: 24,
  },
  identityKey: {
    color: colors.textMuted,
    ...fonts.meta.sm,
    marginTop: spacing.xs,
  },
  identityActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    borderRadius: radius.card,
    padding: spacing.md,
    minHeight: 52,
  },
  deviceName: {
    color: colors.text,
    ...fonts.title.md,
    fontSize: 13,
    lineHeight: 16,
  },
  deviceKey: {
    color: colors.textMuted,
    ...fonts.meta.xs,
    marginTop: 2,
  },
  inviteBox: {
    backgroundColor: colors.primaryLight,
    borderWidth: borderWidth.rule,
    borderColor: colors.primary,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  inviteLabel: {
    color: colors.textSecondary,
    ...fonts.meta.sm,
    marginBottom: spacing.sm,
  },
  inviteCode: {
    color: colors.text,
    ...fonts.meta.md,
    fontSize: 15,
    letterSpacing: 0.5,
  },
  storageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  storageIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: {
    height: 2,
    backgroundColor: colors.bgActive,
    borderRadius: 0,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 0,
  },
  trackLabel: {
    color: colors.textMuted,
    ...fonts.meta.xs,
    marginTop: spacing.sm - 2,
    marginBottom: spacing.md,
  },
  storageBreakdown: {
    backgroundColor: colors.surfaceHover,
    borderRadius: radius.card,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm - 2,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  breakdownLabel: {
    flex: 1,
    color: colors.textMuted,
    ...fonts.meta.sm,
  },
  breakdownValue: {
    color: colors.textSecondary,
    ...fonts.meta.sm,
  },
  participationStateRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  participationDot: {
    width: 8,
    height: 8,
    borderRadius: radius.sm,
    marginTop: 5,
  },
  participationReasons: {
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.hairline,
    borderColor: colors.borderSubtle,
    borderRadius: radius.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.sm - 2,
    marginBottom: spacing.md,
  },
  participationReason: {
    color: colors.textSecondary,
    ...fonts.meta.sm,
    lineHeight: 18,
  },
  participationModes: {
    gap: spacing.sm,
  },
  participationMode: {
    borderRadius: radius.card,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    backgroundColor: colors.surfaceHover,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  participationModeSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  participationModeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  participationModeLabel: {
    color: colors.text,
    ...fonts.title.md,
    fontSize: 14,
    lineHeight: 18,
  },
  participationModeDetail: {
    color: colors.textMuted,
    ...fonts.body.sm,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  participationFootnote: {
    color: colors.textMuted,
    ...fonts.body.sm,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.md,
  },
  developerLimitBlock: {
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.borderSubtle,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  customRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  pinnedNote: {
    color: colors.textMuted,
    ...fonts.meta.sm,
    marginTop: spacing.md,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    minHeight: 52,
  },
  advancedLabel: {
    flex: 1,
    color: colors.textSecondary,
    ...fonts.title.md,
    fontSize: 13,
    lineHeight: 16,
  },
  advancedBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.md,
  },
  advancedFieldLabel: {
    color: colors.textMuted,
    ...fonts.caption.sm,
    marginBottom: spacing.xs,
  },
  mono: {
    color: colors.textSecondary,
    ...fonts.meta.xs,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
  },
  developerModeError: {
    color: colors.error,
    ...fonts.meta.sm,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  footer: {
    color: colors.textDisabled,
    ...fonts.meta.xs,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
})
