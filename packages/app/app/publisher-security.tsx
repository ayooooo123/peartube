import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
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
    <View accessibilityLabel="Publisher security" style={{ flex: 1, padding: 20 }}>
      <Text style={{ color: '#f8fafc', fontSize: 20, fontWeight: '700', marginBottom: 12 }}>Publishing security</Text>
      {status
        ? <PublisherDeviceStatus status={status} actionHandlers={actionHandlers} />
        : <Text accessibilityRole="progressbar" style={{ color: '#94a3b8' }}>Loading publisher security status from this device…</Text>}
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
