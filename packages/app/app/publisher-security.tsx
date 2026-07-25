import React from 'react'
import { useApp } from '../lib/AppContext'
import {
  PublisherSecurityStatus,
  type PublisherSecurityStatusProps,
  type PublisherStatusRpc,
} from '../components/publisher/PublisherSecurityStatus'

export type PublisherSecurityRouteProps = Omit<PublisherSecurityStatusProps, 'rpc'> & {
  rpc: PublisherStatusRpc | null | undefined
}

export function PublisherSecurityRoute({ rpc, initialStatus, actionHandlers }: PublisherSecurityRouteProps) {
  return (
    <main>
      <PublisherSecurityStatus
        rpc={rpc}
        initialStatus={initialStatus}
        actionHandlers={actionHandlers}
      />
    </main>
  )
}

export default function ConnectedPublisherSecurityRoute() {
  const { rpc } = useApp()
  return <PublisherSecurityRoute rpc={rpc} />
}
