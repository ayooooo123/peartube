import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'

interface SwarmStatusRpc {
  getSwarmStatus?(): Promise<{ swarmConnections?: number } | null>
}

export function useSwarmConnectionCount(rpc: SwarmStatusRpc | null | undefined, enabled = true): number {
  const [connections, setConnections] = useState(0)

  useFocusEffect(useCallback(() => {
    setConnections(0)
    if (!enabled || !rpc?.getSwarmStatus) return
    let mounted = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const status = await rpc.getSwarmStatus?.()
        if (mounted) setConnections(status?.swarmConnections ?? 0)
      } catch {
        // The backend may still be starting or reconnecting.
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [enabled, rpc]))

  return connections
}
