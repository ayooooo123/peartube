/**
 * useCast - React hook for casting videos to Chromecast devices
 *
 * This hook provides access to the casting functionality via RPC to the worker,
 * which uses the backend cast context to handle Chromecast protocol operations.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useApp } from '@/lib/AppContext'
import {
  isChromecastSupported,
  showCastError,
  normalizeVolumeToCast,
  normalizeVolumeFromCast,
} from './cast-utils'

export interface CastDevice {
  id: string
  name: string
  host: string
  port: number
  protocol: 'chromecast'
}

export interface CastPlaybackState {
  state: 'idle' | 'playing' | 'paused' | 'buffering' | 'stopped'
  currentTime: number
  duration: number
  volume: number
}

export interface UseCastOptions {
  autoDiscover?: boolean
}

export interface TranscodeStatus {
  isTranscoding: boolean
  progress: number
  sessionId: string | null
  error: string | null
}

export interface UseCastReturn {
  // Availability
  available: boolean
  isDiscovering: boolean

  // Devices
  devices: CastDevice[]
  connectedDevice: CastDevice | null
  isConnected: boolean

  // Playback state
  playbackState: CastPlaybackState

  // Transcode state (for Chromecast with unsupported codecs)
  transcodeStatus: TranscodeStatus

  // Discovery
  startDiscovery: () => Promise<void>
  stopDiscovery: () => Promise<void>
  addManualDevice: (name: string, host: string, port?: number, protocol?: string) => Promise<CastDevice | null>

  // Connection
  lastError: string | null
  connect: (deviceId: string) => Promise<boolean>
  disconnect: () => Promise<void>

  // Playback
  play: (options: { url: string; contentType: string; title?: string; thumbnail?: string; time?: number; duration?: number }) => Promise<boolean>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => Promise<void>
}

type ConnectedDeviceListener = (device: CastDevice | null) => void

const sharedConnection = {
  connectedDevice: null as CastDevice | null,
  listeners: new Set<ConnectedDeviceListener>(),
}

function notifyConnectedDevice(device: CastDevice | null) {
  sharedConnection.connectedDevice = device
  sharedConnection.listeners.forEach((listener) => {
    listener(device)
  })
}

function subscribeConnectedDevice(listener: ConnectedDeviceListener) {
  sharedConnection.listeners.add(listener)
  listener(sharedConnection.connectedDevice)
  return () => {
    sharedConnection.listeners.delete(listener)
  }
}
function shouldRetryConnect(message: string): boolean {
  const normalized = message.toLowerCase()
  if (normalized.includes('cast context not available')) return false
  if (normalized.includes('not available')) return false
  return (
    normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('handshake')
    || normalized.includes('network')
    || normalized.includes('econn')
    || normalized.includes('refused')
    || normalized.includes('closed')
    || normalized.includes('reset')
  )
}

function resolveConnectedDevice(
  resultDevice: CastDevice | undefined | null,
  devices: CastDevice[],
  refreshedDevices: CastDevice[] | undefined | null,
  deviceId: string,
): CastDevice {
  if (resultDevice) return resultDevice
  const found = devices.find((d: CastDevice) => d.id === deviceId)
  if (found) return found
  if (refreshedDevices) {
    const fromRefreshed = refreshedDevices.find((d: CastDevice) => d.id === deviceId)
    if (fromRefreshed) return fromRefreshed
  }
  return {
    id: deviceId,
    name: 'Casting device',
    host: '',
    port: 0,
    protocol: 'chromecast',
  }
}

function formatCastConnectError(error: unknown, fallback = 'Failed to connect to Chromecast device.'): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

async function maybeRefreshCastDevices(
  rpc: { castGetDevices: (args: Record<string, never>) => Promise<{ devices?: CastDevice[] } | null | undefined> },
  resultDevice: CastDevice | undefined | null,
  devices: CastDevice[],
  deviceId: string,
  setDevices: (devices: CastDevice[] | ((prev: CastDevice[]) => CastDevice[])) => void,
): Promise<CastDevice[] | undefined> {
  if (resultDevice || devices.some((d: CastDevice) => d.id === deviceId)) return undefined
  const refreshed = await rpc.castGetDevices({})
  if (!refreshed?.devices) return undefined
  setDevices(refreshed.devices)
  return refreshed.devices
}

async function attemptCastConnectWithRetry(
  attemptConnect: () => Promise<{ success?: boolean; error?: unknown; device?: CastDevice } | null | undefined>,
): Promise<{ success?: boolean; error?: unknown; device?: CastDevice } | null | undefined> {
  const result = await attemptConnect()
  if (result?.success) return result
  const firstError = typeof result?.error === 'string' ? result.error : ''
  if (!firstError || !shouldRetryConnect(firstError)) return result
  console.warn('[useCast] connect failed, retrying once:', firstError)
  await new Promise<void>((resolve) => setTimeout(resolve, 700))
  return attemptConnect()
}

async function waitForPlayRateLimit(
  minIntervalMs: number,
  lastPlayAt: number,
  requestId: number,
  currentRequestId: () => number,
): Promise<boolean> {
  if (requestId !== currentRequestId()) return false
  const sinceLast = Date.now() - lastPlayAt
  if (sinceLast < minIntervalMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, minIntervalMs - sinceLast))
    if (requestId !== currentRequestId()) return false
  }
  return true
}

type CastPlayPayloadOptions = {
  url: string
  contentType: string
  title?: string
  thumbnail?: string
  time?: number
  duration?: number
}

function createCastPlayPayload(options: CastPlayPayloadOptions, volume: number) {
  return {
    url: options.url,
    contentType: options.contentType,
    title: options.title || '',
    thumbnail: options.thumbnail || '',
    time: Math.floor(options.time || 0),
    volume: normalizeVolumeToCast(volume),
    duration: options.duration || 0,
  }
}

type CastPlayAttemptOutcome =
  | { status: 'success' }
  | { status: 'retry' }
  | { status: 'superseded'; reason?: string }
  | { status: 'failed'; error?: string; notConnected: boolean }

function evaluateCastPlayResult(result: unknown): CastPlayAttemptOutcome {
  if (result && typeof result === 'object') {
    const res = result as Record<string, unknown>
    if (res.success) {
      if (res.reason === 'debounced' || res.reason === 'in-progress') {
        return { status: 'retry' }
      }
      return { status: 'success' }
    }
    if (res.outcome === 'superseded' || res.reason === 'already-active') {
      const reason = typeof res.reason === 'string'
        ? res.reason
        : typeof res.outcome === 'string'
          ? res.outcome
          : undefined
      return { status: 'superseded', reason }
    }
    const error = typeof res.error === 'string' ? res.error : undefined
    const notConnected = Boolean(error && error.includes('Not connected to cast device'))
    return { status: 'failed', error, notConnected }
  }
  return { status: 'failed', notConnected: false }
}


export function useCast(options: UseCastOptions = {}): UseCastReturn {
  const { autoDiscover = false } = options
  const { rpc, platformEvents } = useApp()

  const [available, setAvailable] = useState(false)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [devices, setDevices] = useState<CastDevice[]>([])
  const [connectedDevice, setConnectedDevice] = useState<CastDevice | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const connectedDeviceRef = useRef<CastDevice | null>(null)
  const [playbackState, setPlaybackState] = useState<CastPlaybackState>({
    state: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 100,
  })
  const [transcodeStatus, setTranscodeStatus] = useState<TranscodeStatus>({
    isTranscoding: false,
    progress: 0,
    sessionId: null,
    error: null,
  })

  const mountedRef = useRef(true)
  const castKeepaliveActiveRef = useRef(false)

  const startCastKeepalive = useCallback(async (_title: string, _deviceName: string) => {
    // Cast keepalive - no longer using MediaSession foreground service
    // react-native-video handles playback natively
  }, [])

  const stopCastKeepalive = useCallback(async () => {
    // Cast keepalive - no longer using MediaSession foreground service
    castKeepaliveActiveRef.current = false
  }, [])

  // Serialize cast commands that are known to be crash-prone when fired rapidly
  // (e.g. switching videos quickly while already casting).
  const playSequenceRef = useRef(Promise.resolve())
  const playRequestIdRef = useRef(0)
  const lastPlayAtRef = useRef(0)
  const pendingCastStartAtRef = useRef(0)

  useEffect(() => {
    connectedDeviceRef.current = connectedDevice
  }, [connectedDevice])

  useEffect(() => {
    return subscribeConnectedDevice((device) => {
      connectedDeviceRef.current = device
      setConnectedDevice(device)
    })
  }, [])

  // Check if casting is available (with retry for backend startup race)
  useEffect(() => {
    if (!rpc) return

    // Check if cast methods are available on the RPC client
    if (typeof rpc.castAvailable !== 'function') {
      console.log('[useCast] castAvailable not available on rpc client')
      return
    }

    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const MAX_ATTEMPTS = 8
    const RETRY_DELAY_MS = 1500

    function checkAvailable() {
      rpc.castAvailable({})
        .then((result: { available: boolean; error?: string | null }) => {
          if (!mountedRef.current) return
          if (result?.available) {
            setAvailable(true)
          } else {
            // Backend responded but cast context not loaded yet — retry
            attempts++
            if (attempts < MAX_ATTEMPTS) {
              console.log(`[useCast] castAvailable returned false, retrying (${attempts}/${MAX_ATTEMPTS})`)
              retryTimer = setTimeout(checkAvailable, RETRY_DELAY_MS)
            } else {
              console.warn('[useCast] castAvailable still false after retries, error:', result?.error)
              setAvailable(false)
            }
          }
        })
        .catch((err: Error) => {
          if (!mountedRef.current) return
          // Backend not ready yet (handler not registered) — retry
          attempts++
          if (attempts < MAX_ATTEMPTS) {
            console.log(`[useCast] castAvailable call failed, retrying (${attempts}/${MAX_ATTEMPTS}):`, err?.message)
            retryTimer = setTimeout(checkAvailable, RETRY_DELAY_MS)
          } else {
            console.error('[useCast] castAvailable check failed after retries:', err)
            setAvailable(false)
          }
        })
    }

    checkAvailable()

    return () => {
      mountedRef.current = false
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [rpc])

  // Subscribe to cast events from platform RPC (device discovery + playback)
  useEffect(() => {
    if (!platformEvents?.onCastDeviceFound) return

    const handleDeviceFound = (data: any) => {
      const device = data?.device ?? data
      if (!device?.id) return
      setDevices(prev => {
        const idx = prev.findIndex(d => d.id === device.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], ...device }
          return next
        }
        return [...prev, device]
      })
      if (connectedDeviceRef.current?.id === device.id) {
        const nextDevice = { ...connectedDeviceRef.current, ...device }
        notifyConnectedDevice(nextDevice)
      }
    }

    const handleDeviceLost = (data: any) => {
      const deviceId = data?.deviceId
      if (!deviceId) return
      setDevices(prev => prev.filter(d => d.id !== deviceId))
      if (connectedDeviceRef.current?.id === deviceId) {
        console.log('[useCast] Ignoring device-lost for active cast target')
      }
    }

    const handlePlaybackState = (data: any) => {
      if (!data?.state) return
      const state = String(data.state).toLowerCase()

      if (state === 'playing') {
        pendingCastStartAtRef.current = 0
      } else if (state === 'loading' && pendingCastStartAtRef.current === 0) {
        pendingCastStartAtRef.current = Date.now()
      }

      if (data.state === 'error') {
        const message = data?.error ? `Chromecast error: ${data.error}` : 'Chromecast error.'
        showCastError(message)
        pendingCastStartAtRef.current = 0
        setPlaybackState(prev => ({ ...prev, state: 'idle' }))
        return
      }

      setPlaybackState(prev => ({ ...prev, state: data.state }))
    }

    const handleTimeUpdate = (data: any) => {
      if (typeof data?.currentTime !== 'number') return
      setPlaybackState(prev => ({ ...prev, currentTime: data.currentTime }))
    }

    const unsubFound = platformEvents.onCastDeviceFound(handleDeviceFound)
    const unsubLost = platformEvents.onCastDeviceLost?.(handleDeviceLost)
    const unsubState = platformEvents.onCastPlaybackState?.(handlePlaybackState)
    const unsubTime = platformEvents.onCastTimeUpdate?.(handleTimeUpdate)

    return () => {
      if (typeof unsubFound === 'function') unsubFound()
      if (typeof unsubLost === 'function') unsubLost()
      if (typeof unsubState === 'function') unsubState()
      if (typeof unsubTime === 'function') unsubTime()
    }
  }, [platformEvents])

  // Subscribe to transcode progress events
  useEffect(() => {
    if (!platformEvents?.onTranscodeProgress) return

    const handleTranscodeProgress = (data: any) => {
      if (!data?.sessionId) return
      setTranscodeStatus({
        isTranscoding: true,
        progress: data.percent || 0,
        sessionId: data.sessionId,
        error: null,
      })

      // Clear transcode status when complete
      if (data.percent >= 100) {
        setTimeout(() => {
          setTranscodeStatus(prev =>
            prev.sessionId === data.sessionId
              ? { isTranscoding: false, progress: 100, sessionId: null, error: null }
              : prev
          )
        }, 2000)
      }
    }

    const unsub = platformEvents.onTranscodeProgress(handleTranscodeProgress)
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [platformEvents])

  // Auto-discover devices if enabled
  useEffect(() => {
    if (!available || !autoDiscover || !rpc) return

    rpc.castStartDiscovery({}).catch((err: Error) => {
      console.error('[useCast] Auto-discovery failed:', err)
    })

    return () => {
      rpc.castStopDiscovery({}).catch(() => {})
    }
  }, [available, autoDiscover, rpc])

  // Start discovery
  const startDiscovery = useCallback(async () => {
    if (!rpc || !available) return

    try {
      setIsDiscovering(true)
      await rpc.castStartDiscovery({})

      // Load current devices
      const result = await rpc.castGetDevices({})
      if (result?.devices) {
        setDevices(result.devices)
      }
    } catch (err) {
      console.error('[useCast] startDiscovery failed:', err)
    } finally {
      setIsDiscovering(false)
    }
  }, [rpc, available])

  // Stop discovery
  const stopDiscovery = useCallback(async () => {
    if (!rpc) return

    try {
      await rpc.castStopDiscovery({})
      setIsDiscovering(false)
    } catch (err) {
      console.error('[useCast] stopDiscovery failed:', err)
    } finally {
      setIsDiscovering(false)
    }
  }, [rpc])

  // Add manual device
  const addManualDevice = useCallback(async (
    name: string,
    host: string,
    port?: number,
    protocol?: string
  ): Promise<CastDevice | null> => {
    if (!rpc) return null

    try {
      const result = await rpc.castAddManualDevice({
        name,
        host,
        port: port || 0,
        protocol: protocol || 'chromecast'
      })

      if (result?.success && result?.device) {
        setDevices(prev => [...prev, result.device])
        return result.device
      }
      return null
    } catch (err) {
      console.error('[useCast] addManualDevice failed:', err)
      return null
    }
  }, [rpc])

  // Connect to device
  const connect = useCallback(async (deviceId: string): Promise<boolean> => {
    if (!rpc) return false

    const attemptConnect = async () => rpc.castConnect({ deviceId })

    try {
      setLastError(null)
      const result = await attemptCastConnectWithRetry(attemptConnect)

      if (result?.success) {
        const refreshedDevices = await maybeRefreshCastDevices(
          rpc,
          result.device,
          devices,
          deviceId,
          setDevices,
        )
        const device = resolveConnectedDevice(result?.device, devices, refreshedDevices, deviceId)
        notifyConnectedDevice(device)
        setLastError(null)
        return true
      }

      const errorMessage = formatCastConnectError(result?.error)
      console.error('[useCast] connect failed:', errorMessage)
      setLastError(errorMessage)
      return false
    } catch (err) {
      const errorMessage = formatCastConnectError(err)
      console.error('[useCast] connect failed:', err)
      setLastError(errorMessage)
      return false
    }
  }, [rpc, devices])

  // Disconnect from device
  const disconnect = useCallback(async () => {
    if (!rpc) return

    try {
      await rpc.castDisconnect({})
      await stopCastKeepalive()
      notifyConnectedDevice(null)
      setPlaybackState({
        state: 'idle',
        currentTime: 0,
        duration: 0,
        volume: 100,
      })
    } catch (err) {
      console.error('[useCast] disconnect failed:', err)
    }
  }, [rpc, stopCastKeepalive])

  // Play video
  const play = useCallback(async (options: {
    url: string
    contentType: string
    title?: string
    thumbnail?: string
    time?: number
    duration?: number
  }): Promise<boolean> => {
    if (!rpc) return false
    const device = connectedDeviceRef.current || connectedDevice

    // Last-request-wins: if the app switches videos rapidly, only execute the newest play.
    const requestId = ++playRequestIdRef.current

    // For Chromecast with unsupported formats, the worker will auto-transcode
    // Log a warning but don't block - let the worker handle it
    if (device?.protocol === 'chromecast') {
      const { supported, reason } = isChromecastSupported(options)
      if (!supported) {
        console.log('[useCast] Chromecast format check:', reason, '- worker will auto-transcode if possible')
        // Reset transcode status when starting new playback
        setTranscodeStatus({
          isTranscoding: false,
          progress: 0,
          sessionId: null,
          error: null,
        })
      }
    }

    // Mark as buffering immediately so the UI communicates "working".
    setPlaybackState(prev => ({ ...prev, state: 'buffering' }))

    const run = async (): Promise<boolean> => {
      const canProceed = await waitForPlayRateLimit(
        1200,
        lastPlayAtRef.current,
        requestId,
        () => playRequestIdRef.current,
      )
      if (!canProceed) return false

      try {
        pendingCastStartAtRef.current = Date.now()
        lastPlayAtRef.current = Date.now()

        const maxTransientAttempts = 4
        let attempt = 0
        const payload = createCastPlayPayload(options, playbackState.volume)

        while (attempt < maxTransientAttempts) {
          attempt += 1
          const result = await rpc.castPlay(payload)

          if (requestId !== playRequestIdRef.current) return false

          const outcome = evaluateCastPlayResult(result)
          if (outcome.status === 'retry') {
            await new Promise<void>((resolve) => setTimeout(resolve, 350))
            continue
          }
          if (outcome.status === 'success') {
            const deviceName = device?.name || 'Cast Device'
            await startCastKeepalive(options.title || 'PearTube', deviceName)
            setPlaybackState(prev => ({ ...prev, state: 'playing' }))
            return true
          }
          if (outcome.status === 'superseded') {
            console.log('[useCast] play superseded/rejected without fatal error:', outcome.reason)
            return false
          }

          console.error('[useCast] play failed:', outcome.error)
          if (outcome.notConnected) {
            notifyConnectedDevice(null)
          }
          await stopCastKeepalive()
          setPlaybackState(prev => ({ ...prev, state: 'idle' }))
          showCastError(`Chromecast failed to start playback.${outcome.error ? ` ${outcome.error}` : ''}`)
          return false
        }

        await stopCastKeepalive()
        setPlaybackState(prev => ({ ...prev, state: 'idle' }))
        showCastError('Chromecast did not start playback in time. Please try again.')
        return false
      } catch (err) {
        console.error('[useCast] play failed:', err)
        await stopCastKeepalive()
        setPlaybackState(prev => ({ ...prev, state: 'idle' }))
        showCastError('Chromecast failed to start playback.')
        return false
      }
    }

    // Chain onto the previous play call (serialize).
    const chained = playSequenceRef.current.then(run, run)
    playSequenceRef.current = chained.then(
      () => undefined,
      () => undefined
    )
    return chained
  }, [rpc, connectedDevice, playbackState.volume, startCastKeepalive, stopCastKeepalive])

  // Pause
  const pause = useCallback(async () => {
    if (!rpc) return

    try {
      await rpc.castPause({})
      setPlaybackState(prev => ({ ...prev, state: 'paused' }))
    } catch (err) {
      console.error('[useCast] pause failed:', err)
    }
  }, [rpc])

  // Resume
  const resume = useCallback(async () => {
    if (!rpc) return

    try {
      await rpc.castResume({})
      setPlaybackState(prev => ({ ...prev, state: 'playing' }))
    } catch (err) {
      console.error('[useCast] resume failed:', err)
    }
  }, [rpc])

  // Stop
  const stop = useCallback(async () => {
    if (!rpc) return

    try {
      await rpc.castStop({})
      await stopCastKeepalive()
      setPlaybackState({
        state: 'stopped',
        currentTime: 0,
        duration: 0,
        volume: playbackState.volume,
      })
    } catch (err) {
      console.error('[useCast] stop failed:', err)
    }
  }, [rpc, playbackState.volume, stopCastKeepalive])

  // Seek
  const seek = useCallback(async (time: number) => {
    if (!rpc) return

    try {
      await rpc.castSeek({ time: Math.floor(time) })
      setPlaybackState(prev => ({ ...prev, currentTime: time }))
    } catch (err) {
      console.error('[useCast] seek failed:', err)
    }
  }, [rpc])

  // Set volume (0-100)
  const setVolume = useCallback(async (volume: number) => {
    if (!rpc) return

    try {
      const normalizedVolume = Math.max(0, Math.min(100, Math.floor(volume)))
      await rpc.castSetVolume({ volume: normalizeVolumeToCast(normalizedVolume) })
      setPlaybackState(prev => ({ ...prev, volume: normalizedVolume }))
    } catch (err) {
      console.error('[useCast] setVolume failed:', err)
    }
  }, [rpc])

  // Poll for playback state while connected
  useEffect(() => {
    if (!rpc || !connectedDevice) return

    const pollState = async () => {
      try {
        const result = await rpc.castGetState({})
        if (result && mountedRef.current) {
          setPlaybackState({
            state: result.state || 'idle',
            currentTime: result.currentTime || 0,
            duration: result.duration || 0,
            volume: normalizeVolumeFromCast(result.volume),
          })
        }
      } catch (err) {
        // Ignore poll errors
      }
    }

    const interval = setInterval(pollState, 1000)
    return () => clearInterval(interval)
  }, [rpc, connectedDevice])

  useEffect(() => {
    return () => {
      stopCastKeepalive().catch(() => {})
    }
  }, [stopCastKeepalive])

  const isConnected = connectedDevice !== null

  return useMemo(() => ({
    available,
    isDiscovering,
    devices,
    connectedDevice,
    lastError,
    isConnected,
    playbackState,
    transcodeStatus,
    startDiscovery,
    stopDiscovery,
    addManualDevice,
    connect,
    disconnect,
    play,
    pause,
    resume,
    stop,
    seek,
    setVolume,
  }), [
    available,
    isDiscovering,
    devices,
    connectedDevice,
    lastError,
    isConnected,
    playbackState,
    transcodeStatus,
    startDiscovery,
    stopDiscovery,
    addManualDevice,
    connect,
    disconnect,
    play,
    pause,
    resume,
    stop,
    seek,
    setVolume,
  ])
}

export default useCast
