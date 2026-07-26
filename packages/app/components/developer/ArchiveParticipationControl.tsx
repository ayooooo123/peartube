import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Platform, StyleSheet, Text, View } from 'react-native'
import { Feather } from '@expo/vector-icons'
import { NativeSwitch } from '@/components/native-ui'
import { colors } from '@/lib/colors'
import * as haptics from '@/lib/haptics'
import { archiveCapacityForStorageMax, GIB } from './archive-participation-model'

type ArchiveParticipationStatus = {
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

type ArchiveParticipationRpc = {
  getArchiveParticipation?: () => Promise<ArchiveParticipationStatus | null>
  getStorageStats?: () => Promise<{ maxBytes?: number } | null>
  setArchiveParticipation?: (request: {
    enabled: boolean
    capacityBytes: number
    maxRequestBytes: number
    acceptancePermille: number
  }) => Promise<ArchiveParticipationStatus | null>
}

function formatArchiveBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  const gib = bytes / GIB
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`
}

function notify(message: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message)
    return
  }
  Alert.alert('Archive setting not changed', message)
}

export function ArchiveParticipationControl({ rpc }: { rpc: ArchiveParticipationRpc | null | undefined }) {
  const [status, setStatus] = useState<ArchiveParticipationStatus | null>(null)
  const [storageMaxBytes, setStorageMaxBytes] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const requestGeneration = useRef(0)

  const loadArchiveParticipation = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (typeof rpc?.getArchiveParticipation !== 'function') {
      setStatus(null)
      setStorageMaxBytes(null)
      return
    }
    try {
      const [nextStatus, storageStats] = await Promise.all([
        rpc.getArchiveParticipation(),
        typeof rpc.getStorageStats === 'function'
          ? rpc.getStorageStats().catch((error) => {
            console.error('[Developer Settings] Failed to load storage stats:', error)
            return null
          })
          : Promise.resolve(null),
      ])
      if (generation !== requestGeneration.current) return
      setStatus(nextStatus || null)
      setStorageMaxBytes(typeof storageStats?.maxBytes === 'number' && Number.isFinite(storageStats.maxBytes)
        ? storageStats.maxBytes
        : null)
    } catch (error) {
      if (generation !== requestGeneration.current) return
      console.error('[Developer Settings] Failed to load archive participation:', error)
      setStatus(null)
      setStorageMaxBytes(null)
    }
  }, [rpc])

  useEffect(() => {
    setSaving(false)
    void loadArchiveParticipation()
    return () => { requestGeneration.current += 1 }
  }, [loadArchiveParticipation])

  const setArchiveParticipation = async (enabled: boolean) => {
    if (typeof rpc?.setArchiveParticipation !== 'function' || saving) return
    const generation = ++requestGeneration.current
    const capacityBytes = status?.capacityBytes || archiveCapacityForStorageMax(storageMaxBytes)
    setSaving(true)
    try {
      const nextStatus = await rpc.setArchiveParticipation({
        enabled,
        capacityBytes,
        maxRequestBytes: Math.min(status?.maxRequestBytes || capacityBytes, capacityBytes),
        acceptancePermille: status?.acceptancePermille ?? 250,
      })
      if (!nextStatus?.success) throw new Error(nextStatus?.errorCode || 'Archive participation is unavailable')
      if (generation !== requestGeneration.current) return
      setStatus(nextStatus)
      haptics.success()
    } catch (error: unknown) {
      if (generation !== requestGeneration.current) return
      notify(error instanceof Error ? error.message : 'The backend rejected this setting.')
      setSaving(false)
      void loadArchiveParticipation()
      return
    }
    if (generation === requestGeneration.current) setSaving(false)
  }

  return (
    <View style={styles.container}>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Feather name="archive" size={14} color={status?.enabled ? colors.swarm : colors.textMuted} />
          <Text style={styles.title}>Volunteer archive</Text>
        </View>
        <Text style={styles.description}>Randomly accept complete-copy requests from publishers. No allowlist or operator account required.</Text>
        <Text style={styles.status}>
          {typeof rpc?.getArchiveParticipation !== 'function'
            ? 'Unavailable in this backend'
            : !status
              ? 'Loading archive status…'
              : !status.success
                ? `Unavailable · ${status.errorCode || 'backend rejected status'}`
                : status.enabled
                  ? `${formatArchiveBytes(status.reservedBytes)} pledged of ${formatArchiveBytes(status.capacityBytes)} · ${status.acceptedRequests} accepted`
                  : 'Off · no new archive requests will be accepted'}
        </Text>
      </View>
      <NativeSwitch
        value={status?.enabled === true}
        onValueChange={(enabled) => { void setArchiveParticipation(enabled) }}
        disabled={!status?.success || saving}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={colors.text}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  copy: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  description: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 5 },
  status: { color: colors.textSecondary, fontSize: 11, fontWeight: '600', marginTop: 7 },
})
