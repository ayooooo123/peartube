import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'

import { DeveloperModeGate } from '@/lib/developer-mode'
import { colors } from '@/lib/colors'
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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>Back</Text>
        </Pressable>
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginLeft: 18 }}>Acquisition policy</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text style={{ color: colors.textMuted }}>
          Local operator limits for requesting, verifying, publishing, and retaining media. Source credentials never appear here.
        </Text>

        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>Enable acquisitions</Text>
              <Text style={{ color: colors.textMuted }}>Closed until explicit consent and non-zero limits are saved.</Text>
            </View>
            <Switch value={policy.enabled} onValueChange={(enabled) => setPolicy(current => ({ ...current, enabled }))} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>Accept public requests</Text>
              <Text style={{ color: colors.textMuted }}>Allow requests outside this local device only when policy limits admit them.</Text>
            </View>
            <Switch value={policy.acceptPublicRequests} onValueChange={(acceptPublicRequests) => setPolicy(current => ({ ...current, acceptPublicRequests }))} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>I consent to bounded media acquisition</Text>
              <Text style={{ color: colors.textMuted }}>Required before enabling downloads or retention.</Text>
            </View>
            <Switch value={consent} onValueChange={setConsent} />
          </View>
        </View>

        <Text style={{ color: colors.text, fontWeight: '700' }}>Requester mode</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['local-only', 'allowlisted', 'public'] as const).map((requesterMode) => (
            <Pressable
              key={requesterMode}
              accessibilityRole="button"
              accessibilityState={{ selected: policy.requesterMode === requesterMode }}
              onPress={() => setPolicy(current => ({ ...current, requesterMode }))}
              style={{ borderWidth: 1, borderColor: policy.requesterMode === requesterMode ? colors.primary : colors.border, borderRadius: 10, padding: 10 }}
            >
              <Text style={{ color: colors.text }}>{requesterMode}</Text>
            </Pressable>
          ))}
        </View>

        <TextInput
          accessibilityLabel="Allowed publisher IDs"
          value={policy.allowedPublisherIds.join(', ')}
          onChangeText={(value) => setPolicy(current => ({ ...current, allowedPublisherIds: value.split(',').map(entry => entry.trim()).filter(Boolean) }))}
          placeholder="Allowed publisher IDs"
          placeholderTextColor={colors.textMuted}
          style={{ color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 }}
        />
        <TextInput
          accessibilityLabel="Allowed adapter IDs"
          value={policy.allowedAdapterIds.join(', ')}
          onChangeText={(value) => setPolicy(current => ({ ...current, allowedAdapterIds: value.split(',').map(entry => entry.trim()).filter(Boolean) }))}
          placeholder="Allowed adapter IDs"
          placeholderTextColor={colors.textMuted}
          style={{ color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 }}
        />

        {LIMIT_FIELDS.map((field) => (
          <View key={field} style={{ gap: 5 }}>
            <Text style={{ color: colors.textMuted }}>{field}</Text>
            <TextInput
              accessibilityLabel={field}
              keyboardType="numeric"
              value={String(policy[field])}
              onChangeText={(value) => setPolicy(current => ({ ...current, [field]: Math.max(0, Number.parseInt(value, 10) || 0) }))}
              style={{ color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 }}
            />
          </View>
        ))}

        {!consent && policy.enabled ? <Text accessibilityRole="alert" style={{ color: colors.error }}>Consent is required before acquisitions can be enabled.</Text> : null}
        {status === 'error' ? <Text accessibilityRole="alert" style={{ color: colors.error }}>Unable to update acquisition policy.</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save acquisition policy"
          disabled={!canSave}
          onPress={() => { void save() }}
          style={{ backgroundColor: colors.primary, borderRadius: 12, padding: 14, opacity: canSave ? 1 : 0.5 }}
        >
          <Text style={{ color: colors.onPrimary, fontWeight: '700', textAlign: 'center' }}>
            {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save policy'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}

export default function DeveloperAcquisitionSettingsScreen() {
  return <DeveloperModeGate><AcquisitionSettingsScreen /></DeveloperModeGate>
}
