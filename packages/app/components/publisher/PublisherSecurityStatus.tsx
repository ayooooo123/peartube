import React, { useEffect, useState } from 'react'
import { Text, View, StyleSheet } from 'react-native'
import {
  PublisherDeviceStatus,
  type PublisherCapabilityAction,
  type PublisherDeviceStatusInput,
} from './PublisherDeviceStatus'
import { colors, spacing } from '@/lib/colors'
import { fonts } from '@/lib/typography'

export type PublisherStatusRpc = {
  getPublisherDeviceStatus(request: { publisherId?: unknown, devicePublicKey?: unknown }): Promise<PublisherDeviceStatusInput>
}

const STATUS_LOAD_FAILURE: Readonly<PublisherDeviceStatusInput> = Object.freeze({
  success: false,
  status: 'unable-to-publish',
  canPublish: false,
  canPlayLocal: false,
  canExportLocal: false,
  canDeleteLocal: false,
  canRootTransition: false,
})

export async function loadPublisherDeviceStatus(rpc: PublisherStatusRpc | null | undefined): Promise<PublisherDeviceStatusInput> {
  if (!rpc || typeof rpc.getPublisherDeviceStatus !== 'function') return { ...STATUS_LOAD_FAILURE }
  try {
    const response = await rpc.getPublisherDeviceStatus({})
    if (!response || response.success !== true) return { ...STATUS_LOAD_FAILURE }
    return {
      success: true,
      status: response.status,
      reasonCode: response.reasonCode,
      canPublish: response.canPublish === true,
      canPlayLocal: response.canPlayLocal === true,
      canExportLocal: response.canExportLocal === true,
      canDeleteLocal: response.canDeleteLocal === true,
      canRootTransition: response.canRootTransition === true,
    }
  } catch {
    return { ...STATUS_LOAD_FAILURE }
  }
}

export type PublisherStatusSnapshot = {
  rpc: PublisherStatusRpc | null | undefined
  generation: number
  status: PublisherDeviceStatusInput | null
}

export function snapshotForPublisherStatusRpc(
  snapshot: PublisherStatusSnapshot,
  rpc: PublisherStatusRpc | null | undefined,
): PublisherStatusSnapshot {
  if (snapshot.rpc === rpc) return snapshot
  return {
    rpc,
    generation: snapshot.generation + 1,
    status: null,
  }
}

export type PublisherSecurityStatusProps = {
  rpc: PublisherStatusRpc | null | undefined
  initialStatus?: PublisherDeviceStatusInput | null
  actionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
}

export function PublisherSecurityStatus({ rpc, initialStatus = null, actionHandlers }: PublisherSecurityStatusProps) {
  const [snapshot, setSnapshot] = useState<PublisherStatusSnapshot>(() => ({
    rpc,
    generation: 0,
    status: initialStatus,
  }))
  const currentSnapshot = snapshotForPublisherStatusRpc(snapshot, rpc)
  if (currentSnapshot !== snapshot) setSnapshot(currentSnapshot)

  useEffect(() => {
    let active = true
    const generation = currentSnapshot.generation
    loadPublisherDeviceStatus(rpc).then((loaded) => {
      if (!active) return
      setSnapshot((current) => current.rpc === rpc && current.generation === generation
        ? { ...current, status: loaded }
        : current)
    })
    return () => {
      active = false
    }
  }, [rpc, currentSnapshot.generation])

  const status = currentSnapshot.status

  if (!status) {
    return (
      <View accessibilityRole="summary" style={styles.loading}>
        <Text style={styles.loadingText}>Loading publisher security status from this device…</Text>
      </View>
    )
  }
  return <PublisherDeviceStatus status={status} actionHandlers={actionHandlers} />
}

const styles = StyleSheet.create({
  loading: {
    paddingVertical: spacing.md,
  },
  loadingText: {
    ...fonts.meta.sm,
    color: colors.textSecondary,
  },
})
