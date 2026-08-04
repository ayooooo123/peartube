import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { Paths } from 'expo-file-system'
import {
  platformDeviceConditionSources,
  startDeviceConditionsReporting,
  type DeviceConditionsRpc,
} from '@/lib/device-conditions'
import {
  createNetworkPolicyActions,
  loadParticipationStatus,
  normalizeNetworkPolicyResponse,
  type NetworkPolicy,
  type NetworkPolicyPatch,
  type NetworkPolicyRpc,
  type ParticipationStatus,
} from '@/lib/network-policy'
import { playbackActiveEmitter } from '@/lib/video-player/VideoControlContext'

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

type ParticipationStatusState = {
  status: ParticipationStatus | null
  loading: boolean
  error: string | null
  reload(): Promise<void>
}

/**
 * Live contribution state, straight from the backend resource policy.
 *
 * The backend owns the decision, so this hook polls rather than modelling it:
 * playback, thermal, power, disk, and quota state all move without the app
 * touching anything. A failed read clears the status instead of leaving a stale
 * "uploading" on screen — the app must never claim a contribution it cannot
 * currently confirm.
 */
export function useParticipationStatus(
  rpc: NetworkPolicyRpc | null | undefined,
  refreshMs = 15000,
): ParticipationStatusState {
  const [status, setStatus] = useState<ParticipationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!rpc) return
    try {
      setStatus(await loadParticipationStatus(rpc))
      setError(null)
    } catch (nextError) {
      setStatus(null)
      setError(safeMessage(nextError))
    } finally {
      setLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    if (!rpc) {
      setStatus(null)
      setLoading(true)
      setError(null)
      return
    }
    let active = true
    const read = async () => {
      try {
        const next = await loadParticipationStatus(rpc)
        if (!active) return
        setStatus(next)
        setError(null)
      } catch (nextError) {
        if (!active) return
        setStatus(null)
        setError(safeMessage(nextError))
      } finally {
        if (active) setLoading(false)
      }
    }
    void read()
    if (!(refreshMs > 0)) return () => { active = false }
    const timer = setInterval(() => { void read() }, refreshMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [refreshMs, rpc])

  return { status, loading, error, reload }
}

/** What the reporter reads off a `BatteryManager`, and nothing more. */
type BatteryReading = { level?: number; charging?: boolean }

/**
 * Report this device's OS signals to the backend participation decision.
 *
 * Without this nothing ever calls `set-device-conditions`, every gate stays
 * unknown, and unknown is a constraint — so the contribution card sits on
 * Suspended forever no matter what the device is actually doing. The mapping
 * from platform modules to reported signals lives in `@/lib/device-conditions`;
 * this hook only supplies the modules and ties the reporter to a mount.
 *
 * Callers may mount it more than once: the reporter is shared per backend
 * connection so the throttle is shared with it.
 */
export function useDeviceConditionsReporter(rpc: DeviceConditionsRpc | null | undefined): void {
  useEffect(() => {
    // The Battery Status API is absent from TypeScript's DOM lib and from React
    // Native's `navigator` alike, so it is probed at runtime. The cast names the
    // shape a library type the compiler does not model actually answers with.
    const probe = typeof navigator === 'object' && navigator !== null && 'getBattery' in navigator
      ? navigator.getBattery
      : undefined
    const battery: (() => Promise<BatteryReading>) | null = typeof probe === 'function'
      ? (probe.bind(navigator) as () => Promise<BatteryReading>)
      : null
    return startDeviceConditionsReporting(rpc, platformDeviceConditionSources({
      platformOS: Platform.OS,
      appState: AppState,
      playback: playbackActiveEmitter,
      paths: Paths,
      // React Native has no `online`/`offline` on the global; the desktop shell
      // and the browser do, and they are the only network trigger available.
      eventTarget: typeof globalThis.addEventListener === 'function' ? globalThis : null,
      battery,
    }))
  }, [rpc])
}
