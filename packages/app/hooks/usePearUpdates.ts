import { useCallback, useEffect, useState } from 'react'

import type { PearUpdateEvent } from '@peartube/platform/rpc'

type PearUpdatesFacade = {
  onEvent?: (listener: (event: PearUpdateEvent) => void) => (() => void) | void
  apply?: () => Promise<void>
  restart?: () => Promise<void>
}

type PlatformRpcModule = { rpc?: { updates?: PearUpdatesFacade | null } | null }

export type PearUpdateState = {
  update: PearUpdateEvent | null
  busy: boolean
  error: string | null
  apply: () => Promise<void>
  dismiss: () => void
}

/**
 * OTA update state for the root layout.
 *
 * The updater lives in the backend, so events only arrive once the platform
 * RPC module is loaded. `updates` is absent on shells without an updater, and
 * the subscription is then skipped rather than faked.
 *
 * @param platformRPC the loaded platform RPC module, or null before it loads
 * @param generation bump to resubscribe once the backend is ready
 */
export function usePearUpdates(platformRPC: PlatformRpcModule | null | undefined, generation: unknown): PearUpdateState {
  const updates = platformRPC?.rpc?.updates
  const [update, setUpdate] = useState<PearUpdateEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof updates?.onEvent !== 'function') return

    return updates.onEvent((event: PearUpdateEvent) => {
      console.log('[App] Pear update:', event.state, event.version || '', event.minver || '')
      setUpdate(event)
      setError(null)
    })
    // `updates` is read through a module-level singleton that is replaced when
    // the backend restarts, so the generation is what makes this resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation])

  const apply = useCallback(async () => {
    if (typeof updates?.apply !== 'function') return

    setBusy(true)
    setError(null)
    try {
      // apply() has to fully resolve first: it is what swaps the payload onto
      // disk. Restarting before it settles reloads the old bundle.
      await updates.apply()
      await updates.restart?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? '')
      console.error('[App] Pear update failed:', message)
      setError(message || 'Update failed')
      setBusy(false)
    }
  }, [updates])

  const dismiss = useCallback(() => {
    setUpdate(null)
    setError(null)
  }, [])

  return { update, busy, error, apply, dismiss }
}
