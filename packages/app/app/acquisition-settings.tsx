import { useEffect, useMemo, useState } from 'react'
import { ScrollView, Switch, Text, TextInput, View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { DeveloperModeGate } from '@/lib/developer-mode'
import { colors, radius, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'
import { Button, Chip, Panel, ScreenHeader, SectionHeader } from '@/components/primitives'
import { useApp } from './_layout'

type AcquisitionPolicy = {
  policyVersion: 1
  revision: number
  consentVersion: number
  migrationRequired: boolean
  enabled: boolean
  acceptPublicRequests: boolean
  requesterMode: 'local-only' | 'allowlisted' | 'public'
  allowedPublisherIds: string[]
  allowedAdapterIds: string[]
  maxQueuedJobs: number
  maxConcurrentJobs: number
  maxConcurrentPerRequester: number
  maxRequestBytes: number
  maxAcquireBytesPer24h: number
  maxAcquireBytesPerSecond: number
  maxStagingBytes: number
  minFreeDiskBytes: number
  maxJobRuntimeMs: number
  sourceGrantTtlMs: number
  publicRequestsPerMinute: number
  maxAttempts: number
  retryBaseMs: number
  retryMaxMs: number
}

const LIMIT_FIELDS = [
  'maxQueuedJobs',
  'maxConcurrentJobs',
  'maxConcurrentPerRequester',
  'maxRequestBytes',
  'maxAcquireBytesPer24h',
  'maxAcquireBytesPerSecond',
  'maxStagingBytes',
  'minFreeDiskBytes',
  'maxJobRuntimeMs',
  'sourceGrantTtlMs',
  'publicRequestsPerMinute',
  'maxAttempts',
  'retryBaseMs',
  'retryMaxMs',
] as const

const CLOSED_POLICY: AcquisitionPolicy = {
  policyVersion: 1,
  revision: 0,
  consentVersion: 1,
  migrationRequired: true,
  enabled: false,
  acceptPublicRequests: false,
  requesterMode: 'local-only',
  allowedPublisherIds: [],
  allowedAdapterIds: [],
  maxQueuedJobs: 0,
  maxConcurrentJobs: 0,
  maxConcurrentPerRequester: 0,
  maxRequestBytes: 0,
  maxAcquireBytesPer24h: 0,
  maxAcquireBytesPerSecond: 0,
  maxStagingBytes: 0,
  minFreeDiskBytes: 0,
  maxJobRuntimeMs: 0,
  sourceGrantTtlMs: 0,
  publicRequestsPerMinute: 0,
  maxAttempts: 0,
  retryBaseMs: 0,
  retryMaxMs: 0,
}

function AcquisitionSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { rpc } = useApp()
  const provider = rpc?.provider
  const [policy, setPolicy] = useState<AcquisitionPolicy>(CLOSED_POLICY)
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading')

  useEffect(() => {
    let active = true
    if (typeof provider?.getAcquisitionPolicy !== 'function') {
      setStatus('error')
      return
    }
    void provider.getAcquisitionPolicy().then((response: unknown) => {
      if (!active) return
      if (response && typeof response === 'object' && 'success' in response && response.success === true && 'policy' in response && response.policy) {
        setPolicy(response.policy as AcquisitionPolicy)
        setConsent(response.policy && typeof response.policy === 'object' && 'migrationRequired' in response.policy && response.policy.migrationRequired === false)
        setStatus('ready')
      } else {
        setStatus('error')
      }
    }).catch(() => {
      if (active) setStatus('error')
    })
    return () => { active = false }
  }, [provider])

  const canSave = useMemo(
    () => status !== 'saving' && (!policy.enabled || consent),
    [consent, policy.enabled, status],
  )

  const save = async () => {
    if (!canSave || typeof provider?.setAcquisitionPolicy !== 'function') return
    setStatus('saving')
    const next = {
      ...policy,
      consentVersion: 1,
      migrationRequired: policy.enabled ? false : policy.migrationRequired,
    }
    try {
      const response: unknown = await provider.setAcquisitionPolicy({
        policy: next,
        expectedRevision: policy.revision,
        consent: { version: 1, granted: consent },
      })
      if (!response || typeof response !== 'object' || !('success' in response) || response.success !== true || !('policy' in response) || !response.policy) {
        throw new Error('Policy update failed')
      }
      setPolicy(response.policy as AcquisitionPolicy)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  return (
    <View style={styles.screen}>
      <View style={{ paddingTop: insets.top }}>
        <ScreenHeader title="Acquisition policy" eyebrow="OPERATOR / LIMITS" onBack={() => router.back()} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <Text style={styles.intro}>
          Local operator limits for requesting, verifying, publishing, and retaining media. Source credentials never appear here.
        </Text>

        <Panel style={styles.panel}>
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.rowTitle}>Enable acquisitions</Text>
              <Text style={styles.rowDetail}>Closed until explicit consent and non-zero limits are saved.</Text>
            </View>
            <Switch
              value={policy.enabled}
              onValueChange={(enabled) => setPolicy(current => ({ ...current, enabled }))}
              trackColor={{ false: colors.bgActive, true: colors.primary }}
              thumbColor={colors.text}
            />
          </View>
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.rowTitle}>Accept public requests</Text>
              <Text style={styles.rowDetail}>Allow requests outside this local device only when policy limits admit them.</Text>
            </View>
            <Switch
              value={policy.acceptPublicRequests}
              onValueChange={(acceptPublicRequests) => setPolicy(current => ({ ...current, acceptPublicRequests }))}
              trackColor={{ false: colors.bgActive, true: colors.primary }}
              thumbColor={colors.text}
            />
          </View>
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.rowTitle}>I consent to bounded media acquisition</Text>
              <Text style={styles.rowDetail}>Required before enabling downloads or retention.</Text>
            </View>
            <Switch
              value={consent}
              onValueChange={setConsent}
              trackColor={{ false: colors.bgActive, true: colors.primary }}
              thumbColor={colors.text}
            />
          </View>
        </Panel>

        <SectionHeader title="Requester mode" flush />
        <View style={styles.chipRow}>
          {(['local-only', 'allowlisted', 'public'] as const).map((requesterMode) => (
            <Chip
              key={requesterMode}
              label={requesterMode}
              selected={policy.requesterMode === requesterMode}
              onPress={() => setPolicy(current => ({ ...current, requesterMode }))}
            />
          ))}
        </View>

        <Text style={styles.fieldLabel}>Allowed publisher IDs</Text>
        <TextInput
          accessibilityLabel="Allowed publisher IDs"
          value={policy.allowedPublisherIds.join(', ')}
          onChangeText={(value) => setPolicy(current => ({ ...current, allowedPublisherIds: value.split(',').map(entry => entry.trim()).filter(Boolean) }))}
          placeholder="Allowed publisher IDs"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />
        <Text style={styles.fieldLabel}>Allowed adapter IDs</Text>
        <TextInput
          accessibilityLabel="Allowed adapter IDs"
          value={policy.allowedAdapterIds.join(', ')}
          onChangeText={(value) => setPolicy(current => ({ ...current, allowedAdapterIds: value.split(',').map(entry => entry.trim()).filter(Boolean) }))}
          placeholder="Allowed adapter IDs"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />

        <SectionHeader title="Limits" eyebrow="BYTES / COUNTS" flush />
        {LIMIT_FIELDS.map((field) => (
          <View key={field} style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>{field}</Text>
            <TextInput
              accessibilityLabel={field}
              keyboardType="numeric"
              value={String(policy[field])}
              onChangeText={(value) => setPolicy(current => ({ ...current, [field]: Math.max(0, Number.parseInt(value, 10) || 0) }))}
              style={styles.input}
            />
          </View>
        ))}

        {!consent && policy.enabled ? <Text accessibilityRole="alert" style={styles.error}>Consent is required before acquisitions can be enabled.</Text> : null}
        {status === 'error' ? <Text accessibilityRole="alert" style={styles.error}>Unable to update acquisition policy.</Text> : null}
        <Button
          label={status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save policy'}
          accessibilityLabel="Save acquisition policy"
          disabled={!canSave}
          loading={status === 'saving'}
          onPress={() => { void save() }}
          block
        />
      </ScrollView>
    </View>
  )
}

export default function DeveloperAcquisitionSettingsScreen() {
  return <DeveloperModeGate><AcquisitionSettingsScreen /></DeveloperModeGate>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  intro: { ...fonts.body.sm, color: colors.textMuted, lineHeight: 20 },
  panel: { gap: spacing.lg },
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: spacing.md },
  switchCopy: { flex: 1 },
  rowTitle: { ...fonts.title.md, fontSize: 14, lineHeight: 18, color: colors.text },
  rowDetail: { ...fonts.body.sm, fontSize: 12, lineHeight: 17, color: colors.textMuted, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fieldBlock: { gap: spacing.xs },
  fieldLabel: { ...fonts.caption.sm, color: colors.textMuted },
  input: {
    color: colors.text,
    ...fonts.meta.sm,
    backgroundColor: colors.surfaceHover,
    borderWidth: borderWidth.rule,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  error: { ...fonts.meta.sm, color: colors.error },
})
