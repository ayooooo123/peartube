/**
 * useCast - React hook for casting videos to FCast/Chromecast devices
 *
 * This hook provides access to the casting functionality via RPC to the worker,
 * which uses the bare-fcast module to handle FCast and Chromecast protocols.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Alert } from 'react-native'
import { useApp } from '@/lib/AppContext'

export interface CastDevice {
  id: string
  name: string
  host: string
  port: number
  protocol: 'fcast' | 'chromecast'
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

const chromecastSupportedMime = [
  'video/mp4',
  'audio/mp4',
  'video/webm',
  'audio/webm',
  'video/ogg',
  'audio/ogg',
]

// Quick content type check - the worker will probe actual codecs
function isChromecastSupported(options: { url: string; contentType: string; title?: string }) {
  const contentType = options.contentType?.toLowerCase() || ''
  const url = options.url?.toLowerCase() || ''
  const isMatroska = contentType.includes('matroska') || contentType.includes('mkv')
  const isAllowedContainer = chromecastSupportedMime.some((mime) => contentType.startsWith(mime))

  // Check file extension
  const isMkvFile = url.endsWith('.mkv')
  const isAviFile = url.endsWith('.avi')
  const isTsFile = url.endsWith('.ts') || url.endsWith('.m2ts')

  if (isMatroska || isMkvFile) {
    return {
      supported: false,
      reason: 'MKV container - will check codecs and transcode if needed.',
    }
  }

  if (isAviFile || isTsFile) {
    return {
      supported: false,
      reason: 'Container format may need transcoding.',
    }
  }

  if (!isAllowedContainer && contentType) {
    return {
      supported: false,
      reason: `Format ${contentType} - will check codecs and transcode if needed.`,
    }
  }

  // For supported containers, the worker will still probe to check internal codecs
  return { supported: true, reason: '' }
}

function showCastError(message: string) {
  try {
    console.error('[useCast] Chromecast:', message)
    Alert.alert('Chromecast', message)
  } catch {}
}

type ConnectedDeviceListener = (device: CastDevice | null) => void

const sharedConnection = {
  connectedDevice: null as CastDevice | null,
  listeners: new Set<ConnectedDeviceListener>(),
}

function notifyConnectedDevice(device: CastDevice | null) {
  sharedConnection.connectedDevice = device
  sharedConnection.listeners.forEach((listener) => listener(device))
}

function subscribeConnectedDevice(listener: ConnectedDeviceListener) {
  sharedConnection.listeners.add(listener)
  listener(sharedConnection.connectedDevice)
  return () => {
    sharedConnection.listeners.delete(listener)
  }
}

export function useCast(options: UseCastOptions = {}): UseCastReturn {
  const { autoDiscover = false } = options
  const { rpc, platformEvents } = useApp()

  const [available, setAvailable] = useState(false)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [devices, setDevices] = useState<CastDevice[]>([])
  const [connectedDevice, setConnectedDevice] = useState<CastDevice | null>(null)
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

  useEffect(() => {
    connectedDeviceRef.current = connectedDevice
  }, [connectedDevice])

  useEffect(() => {
    return subscribeConnectedDevice((device) => {
      connectedDeviceRef.current = device
      setConnectedDevice(device)
    })
  }, [])

  // Check if casting is available
  useEffect(() => {
    if (!rpc) return

    // Check if cast methods are available on the RPC client
    if (typeof rpc.castAvailable !== 'function') {
      console.log('[useCast] castAvailable not available on rpc client')
      return
    }

    rpc.castAvailable({})
      .then((result: { available: boolean }) => {
        if (mountedRef.current) {
          setAvailable(result?.available ?? false)
        }
      })
      .catch((err: Error) => {
        console.error('[useCast] castAvailable check failed:', err)
        if (mountedRef.current) {
          setAvailable(false)
        }
      })

    return () => {
      mountedRef.current = false
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
        notifyConnectedDevice(null)
      }
    }

    const handlePlaybackState = (data: any) => {
      if (!data?.state) return
      setPlaybackState(prev => ({ ...prev, state: data.state }))
      if (data.state === 'error') {
        const message = data?.error ? `Chromecast error: ${data.error}` : 'Chromecast error.'
        showCastError(message)
      }
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
        protocol: protocol || 'fcast'
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

    try {
      const result = await rpc.castConnect({ deviceId })

      if (result?.success) {
        let device = result?.device || devices.find(d => d.id === deviceId) || null
        if (!device) {
          const refreshed = await rpc.castGetDevices({})
          if (refreshed?.devices) {
            setDevices(refreshed.devices)
            device = refreshed.devices.find(d => d.id === deviceId) || null
          }
        }
        if (!device) {
          device = {
            id: deviceId,
            name: 'Casting device',
            host: '',
            port: 0,
            protocol: 'chromecast',
          }
        }
        notifyConnectedDevice(device)
        return true
      }

      console.error('[useCast] connect failed:', result?.error)
      return false
    } catch (err) {
      console.error('[useCast] connect failed:', err)
      return false
    }
  }, [rpc, devices])

  // Disconnect from device
  const disconnect = useCallback(async () => {
    if (!rpc) return

    try {
      await rpc.castDisconnect({})
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
  }, [rpc])

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

    try {
      const result = await rpc.castPlay({
        url: options.url,
        contentType: options.contentType,
        title: options.title || '',
        thumbnail: options.thumbnail || '',
        time: Math.floor(options.time || 0),
        volume: playbackState.volume,
        duration: options.duration || 0,
      })

      if (result?.success) {
        setPlaybackState(prev => ({ ...prev, state: 'playing' }))
        return true
      }

      console.error('[useCast] play failed:', result?.error)
      showCastError(`Chromecast failed to start playback.${result?.error ? ` ${result.error}` : ''}`)
      return false
    } catch (err) {
      console.error('[useCast] play failed:', err)
      showCastError('Chromecast failed to start playback.')
      return false
    }
  }, [rpc, connectedDevice, playbackState.volume])

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
      setPlaybackState({
        state: 'stopped',
        currentTime: 0,
        duration: 0,
        volume: playbackState.volume,
      })
    } catch (err) {
      console.error('[useCast] stop failed:', err)
    }
  }, [rpc, playbackState.volume])

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
      await rpc.castSetVolume({ volume: normalizedVolume })
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
            volume: result.volume ?? 100,
          })
        }
      } catch (err) {
        // Ignore poll errors
      }
    }

    const interval = setInterval(pollState, 1000)
    return () => clearInterval(interval)
  }, [rpc, connectedDevice])

  return {
    available,
    isDiscovering,
    devices,
    connectedDevice,
    isConnected: connectedDevice !== null,
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
  }
}

export default useCast
