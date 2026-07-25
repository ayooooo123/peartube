import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createNetworkPolicyActions,
  normalizeNetworkPolicyResponse,
  type NetworkPolicy,
  type NetworkPolicyPatch,
  type NetworkPolicyRpc,
} from '@/lib/network-policy'

type NetworkPolicyState = {
  policy: NetworkPolicy | null
  loading: boolean
  saving: boolean
  error: string | null
  reload(): Promise<void>
  update(patch: NetworkPolicyPatch): Promise<void>
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.trim().slice(0, 240) || 'Network policy action failed'
}

export function useNetworkPolicy(
  rpc: NetworkPolicyRpc | null | undefined,
  initialPolicy?: Partial<NetworkPolicy> | null,
): NetworkPolicyState {
  const explicitPolicy = useMemo(
    () => initialPolicy ? normalizeNetworkPolicyResponse(initialPolicy) : null,
    [initialPolicy],
  )
  const actions = useMemo(() => createNetworkPolicyActions(rpc), [rpc])
  const [policy, setPolicy] = useState<NetworkPolicy | null>(explicitPolicy)
  const [loading, setLoading] = useState(explicitPolicy === null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!rpc) {
      setLoading(true)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setPolicy(await actions.load())
    } catch (nextError) {
      setError(safeMessage(nextError))
    } finally {
      setLoading(false)
    }
  }, [actions, rpc])

  useEffect(() => {
    if (explicitPolicy) {
      setPolicy(explicitPolicy)
      setLoading(false)
      setError(null)
      return
    }
    if (!rpc) {
      setLoading(true)
      setError(null)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    actions.load().then(
      (nextPolicy) => {
        if (!active) return
        setPolicy(nextPolicy)
        setLoading(false)
      },
      (nextError) => {
        if (!active) return
        setError(safeMessage(nextError))
        setLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [actions, explicitPolicy, rpc])

  const update = useCallback(async (patch: NetworkPolicyPatch) => {
    if (!policy || saving) return
    setSaving(true)
    setError(null)
    try {
      setPolicy(await actions.save(policy, patch))
    } catch (nextError) {
      setError(safeMessage(nextError))
    } finally {
      setSaving(false)
    }
  }, [actions, policy, saving])

  return { policy, loading, saving, error, reload, update }
}
