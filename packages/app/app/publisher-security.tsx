import React, { useEffect, useState } from 'react'
import { Text, View, StyleSheet } from 'react-native'
import { useApp } from '../lib/AppContext'
import {
  loadPublisherDeviceStatus,
  type PublisherStatusRpc,
} from '../components/publisher/PublisherSecurityStatus'
import {
  PublisherDeviceStatus,
  type PublisherCapabilityAction,
  type PublisherDeviceStatusInput,
} from '../components/publisher/PublisherDeviceStatus'
import { DeveloperModeGate } from '../lib/developer-mode'
import { colors, spacing, borderWidth } from '@/lib/colors'
import { fonts } from '@/lib/typography'

export type PublisherSecurityRouteProps = {
  rpc: PublisherStatusRpc | null | undefined
  initialStatus?: PublisherDeviceStatusInput | null
  actionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
}

export function PublisherSecurityRoute({ rpc, initialStatus, actionHandlers }: PublisherSecurityRouteProps) {
  const [status, setStatus] = useState<PublisherDeviceStatusInput | null>(initialStatus ?? null)
  useEffect(() => {
    let active = true
    setStatus(initialStatus ?? null)
    void loadPublisherDeviceStatus(rpc).then((nextStatus) => {
      if (active) setStatus(nextStatus)
    })
    return () => { active = false }
  }, [rpc, initialStatus])

  return (
    <View accessibilityLabel="Publisher security" style={styles.screen}>
      <Text style={styles.eyebrow}>DEVICE / SECURITY</Text>
      <Text style={styles.title}>Publishing security</Text>
      <View style={styles.rule} />
      {status
        ? <PublisherDeviceStatus status={status} actionHandlers={actionHandlers} />
        : <Text accessibilityRole="progressbar" style={styles.loading}>Loading publisher security status from this device…</Text>}
    </View>
  )
}

function ConnectedPublisherSecurityRoute() {
  const { rpc } = useApp()
  return <PublisherSecurityRoute rpc={rpc} />
}

export default function DeveloperPublisherSecurityRoute() {
  return <DeveloperModeGate><ConnectedPublisherSecurityRoute /></DeveloperModeGate>
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  eyebrow: {
    ...fonts.caption.sm,
    color: colors.textMuted,
  },
  title: {
    ...fonts.title.lg,
    color: colors.text,
  },
  rule: {
    height: borderWidth.rule,
    backgroundColor: colors.primary,
    marginBottom: spacing.sm,
  },
  loading: {
    ...fonts.meta.sm,
    color: colors.textSecondary,
  },
})
