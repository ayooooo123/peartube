/**
 * useCast - React hook for casting videos to FCast/Chromecast devices
 *
 * This hook provides access to the casting functionality via RPC to the worker,
 * which uses the bare-fcast module to handle FCast and Chromecast protocols.
 */

console.log('[useCast.web] Module loading...')

import { useState, useEffect, useCallback, useRef } from 'react'
import { Alert } from 'react-native'
import { useApp } from '@/lib/AppContext'

console.log('[useCast.web] Imports complete')

// Module-level cache for cast availability (persists across re-renders/re-mounts)
let cachedCastAvailable: boolean | null = null

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

  // Discovery
  startDiscovery: () => Promise<void>
  stopDiscovery: () => Promise<void>
  addManualDevice: (name: string, host: string, port?: number, protocol?: string) => Promise<CastDevice | null>

  // Connection
  connect: (deviceId: string) => Promise<boolean>
  disconnect: () => Promise<void>

  // Playback
  play: (options: { url: string; contentType: string; title?: string; thumbnail?: string; time?: number }) => Promise<boolean>
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

type ChromecastSupportResult = {
  supported: boolean
  reason: string
  mimeType?: string
  videoCodec?: string | null
  audioCodec?: string | null
  codecString?: string
  internalCodecId?: string
}

function isChromecastSupported(options: { url: string; contentType: string; title?: string }): ChromecastSupportResult {
  const contentType = options.contentType?.toLowerCase() || ''
  const url = options.url || ''
  const title = options.title || ''
  const hints = `${contentType} ${title} ${url}`.toLowerCase()
  const isMatroska = contentType.includes('matroska') || contentType.includes('mkv')
  const isAllowedContainer = chromecastSupportedMime.some((mime) => contentType.startsWith(mime))
  const isHevc =
    hints.includes('x265') ||
    hints.includes('h265') ||
    hints.includes('hevc') ||
    hints.includes('hev1') ||
    hints.includes('hvc1') ||
    hints.includes('10bit') ||
    hints.includes('10-bit')

  if (isMatroska) {
    return {
      supported: false,
      reason: 'Chromecast does not support MKV/Matroska containers.',
    }
  }

  if (!isAllowedContainer && contentType) {
    return {
      supported: false,
      reason: `Chromecast supports MP4 (H.264/AAC) or WebM (VP8/VP9). This video is ${contentType}.`,
    }
  }

  if (isHevc) {
    return {
      supported: false,
      reason: 'This video appears to be HEVC/x265/10-bit, which Chromecast does not support.',
    }
  }

  return { supported: true, reason: '' }
}

const chromecastProbeCache = new Map<string, Promise<ChromecastSupportResult>>()

function formatCodecDetails(details: ChromecastSupportResult) {
  const parts = []
  if (details.mimeType) parts.push(`mime: ${details.mimeType}`)
  if (details.videoCodec) parts.push(`video: ${details.videoCodec}`)
  if (details.audioCodec) parts.push(`audio: ${details.audioCodec}`)
  if (details.codecString) parts.push(`codec: ${details.codecString}`)
  if (details.internalCodecId) parts.push(`internal: ${details.internalCodecId}`)
  return parts.length ? parts.join(', ') : 'codec: unknown'
}

async function analyzeChromecastMedia(options: { url: string; contentType: string; title?: string }): Promise<ChromecastSupportResult> {
  const fallback = isChromecastSupported(options)
  if (!options.url || typeof window === 'undefined') {
    return fallback
  }

  const cacheKey = `${options.url}|${options.contentType || ''}`
  if (chromecastProbeCache.has(cacheKey)) {
    return chromecastProbeCache.get(cacheKey)!
  }

  const probePromise = (async () => {
    let input: any = null
    try {
      const { Input, UrlSource, ALL_FORMATS } = await import('mediabunny')
      input = new Input({
        source: new UrlSource(options.url, {}),
        formats: ALL_FORMATS,
      })

      const mimeType = await input.getMimeType().catch(() => '')
      const videoTrack = await input.getPrimaryVideoTrack().catch(() => null)
      const audioTrack = await input.getPrimaryAudioTrack().catch(() => null)
      const videoCodec = videoTrack?.codec ?? null
      const audioCodec = audioTrack?.codec ?? null
      const codecString = (await videoTrack?.getCodecParameterString?.()) ?? ''
      const internalCodecId = typeof videoTrack?.internalCodecId === 'string' ? videoTrack.internalCodecId : ''
      const containerHint = `${mimeType || ''} ${options.contentType || ''}`.toLowerCase()
      const codecHint = `${codecString} ${internalCodecId}`.toLowerCase()

      if (containerHint.includes('matroska') || containerHint.includes('mkv')) {
        return {
          supported: false,
          reason: 'Chromecast does not support MKV/Matroska containers.',
          mimeType: mimeType || options.contentType,
          videoCodec,
          audioCodec,
          codecString,
          internalCodecId,
        }
      }

      if (videoCodec === 'hevc' || codecHint.includes('hevc') || codecHint.includes('hvc1') || codecHint.includes('hev1')) {
        return {
          supported: false,
          reason: 'This video is HEVC/x265/10-bit, which Chromecast does not support.',
          mimeType: mimeType || options.contentType,
          videoCodec,
          audioCodec,
          codecString,
          internalCodecId,
        }
      }

      // Unsupported audio codecs
      const unsupportedAudioCodecs = ['flac', 'ac3', 'eac3', 'dts', 'truehd', 'mlp']
      if (audioCodec && unsupportedAudioCodecs.includes(audioCodec.toLowerCase())) {
        return {
          supported: false,
          reason: `This video uses ${audioCodec.toUpperCase()} audio, which Chromecast does not support.`,
          mimeType: mimeType || options.contentType,
          videoCodec,
          audioCodec,
          codecString,
          internalCodecId,
        }
      }

      return {
        supported: true,
        reason: '',
        mimeType: mimeType || options.contentType,
        videoCodec,
        audioCodec,
        codecString,
        internalCodecId,
      }
    } catch (err) {
      console.warn('[useCast] mediabunny probe failed:', (err as Error)?.message || err)
      return fallback
    } finally {
      try {
        input?.dispose?.()
      } catch {}
    }
  })()

  chromecastProbeCache.set(cacheKey, probePromise)
  return probePromise
}

function showCastError(message: string) {
  console.error('[useCast] Chromecast:', message)
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message)
    return
  }
  try {
    Alert.alert('Chromecast', message)
  } catch {}
}

export function useCast(options: UseCastOptions = {}): UseCastReturn {
  console.log('========== USECAST HOOK CALLED ==========')
  console.log('[useCast.web] cachedCastAvailable:', cachedCastAvailable)
  const { autoDiscover = false } = options
  const { rpc, platformEvents } = useApp()
  console.log('[useCast.web] rpc:', rpc ? 'available' : 'null', 'castAvailable:', typeof rpc?.castAvailable)

  // Initialize with cached value if available
  const [available, setAvailableState] = useState(cachedCastAvailable ?? false)
  console.log('[useCast.web] available state value:', available)

  // Wrapper to also update cache when setting available
  const setAvailable = useCallback((value: boolean) => {
    console.log('[useCast.web] setAvailable called with:', value)
    cachedCastAvailable = value
    setAvailableState(value)
  }, [])

  // Sync with cache on mount (in case cache was updated by another instance)
  useEffect(() => {
    console.log('[useCast.web] Mount sync check - cached:', cachedCastAvailable, 'current:', available)
    if (cachedCastAvailable === true && !available) {
      console.log('[useCast.web] Syncing with cached value: true')
      setAvailableState(true)
    }
  }, []) // Run only on mount
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

  const mountedRef = useRef(true)
  const lastChromecastAnalysisRef = useRef<ChromecastSupportResult | null>(null)
  const playbackStateRef = useRef(playbackState)
  const castAttemptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    playbackStateRef.current = playbackState
  }, [playbackState])

  useEffect(() => {
    connectedDeviceRef.current = connectedDevice
  }, [connectedDevice])

  const clearCastAttemptTimer = useCallback(() => {
    if (castAttemptTimerRef.current) {
      clearTimeout(castAttemptTimerRef.current)
      castAttemptTimerRef.current = null
    }
  }, [])

  const isPlaybackActive = useCallback((state: CastPlaybackState) => {
    return state.state === 'playing' || state.state === 'buffering' || state.state === 'paused' || state.currentTime > 0
  }, [])

  // Check if casting is available - run once on mount and when rpc changes
  useEffect(() => {
    console.log('[useCast.web] useEffect running, rpc:', rpc ? 'exists' : 'null')
    mountedRef.current = true // Reset on each effect run

    if (!rpc) {
      console.log('[useCast.web] rpc is null, skipping')
      return
    }

    // Check if cast methods are available on the RPC client
    if (typeof rpc.castAvailable !== 'function') {
      console.log('[useCast.web] castAvailable not available on rpc client')
      return
    }

    console.log('[useCast.web] Calling rpc.castAvailable()...')
    rpc.castAvailable({})
      .then((result: { available: boolean }) => {
        console.log('[useCast.web] castAvailable result:', result)
        const isAvailable = result?.available ?? false
        cachedCastAvailable = isAvailable // Update module-level cache
        if (mountedRef.current) {
          setAvailable(isAvailable)
          console.log('[useCast.web] Set available to:', isAvailable)
        }
      })
      .catch((err: Error) => {
        console.error('[useCast.web] castAvailable check failed:', err)
        cachedCastAvailable = false
        if (mountedRef.current) {
          setAvailable(false)
        }
      })

    return () => {
      mountedRef.current = false
    }
  }, [rpc])

  // Subscribe to cast events from platform RPC
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
        connectedDeviceRef.current = nextDevice
        setConnectedDevice(nextDevice)
      }
    }

    const handleDeviceLost = (data: any) => {
      const deviceId = data?.deviceId
      if (!deviceId) return
      setDevices(prev => prev.filter(d => d.id !== deviceId))
      if (connectedDeviceRef.current?.id === deviceId) {
        connectedDeviceRef.current = null
        setConnectedDevice(null)
      }
    }

    const handlePlaybackState = (data: any) => {
      if (!data?.state) return
      setPlaybackState(prev => ({ ...prev, state: data.state }))
      if (data.state === 'error') {
        const detail = lastChromecastAnalysisRef.current
          ? `\n${formatCodecDetails(lastChromecastAnalysisRef.current)}`
          : ''
        const message = data?.error ? `Chromecast error: ${data.error}` : 'Chromecast error.'
        showCastError(`${message}${detail}`)
        clearCastAttemptTimer()
      } else if (data.state === 'playing' || data.state === 'buffering' || data.state === 'paused') {
        clearCastAttemptTimer()
      }
    }

    const handleTimeUpdate = (data: any) => {
      if (typeof data?.currentTime !== 'number') return
      setPlaybackState(prev => ({ ...prev, currentTime: data.currentTime }))
      if (data.currentTime > 0) {
        clearCastAttemptTimer()
      }
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
  }, [platformEvents, clearCastAttemptTimer])


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
        let device = devices.find(d => d.id === deviceId) || null
        if (!device) {
          const refreshed = await rpc.castGetDevices({})
          if (refreshed?.devices) {
            setDevices(refreshed.devices)
            device = refreshed.devices.find(d => d.id === deviceId) || null
          }
        }
        connectedDeviceRef.current = device
        setConnectedDevice(device)
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
      connectedDeviceRef.current = null
      setConnectedDevice(null)
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
  }): Promise<boolean> => {
    if (!rpc) return false
    const device = connectedDeviceRef.current || connectedDevice

    console.log('[useCast] play request', {
      protocol: device?.protocol,
      contentType: options.contentType,
      url: options.url?.slice?.(0, 120),
    })

    let playUrl = options.url
    let contentType = options.contentType

    if (device?.protocol === 'chromecast') {
      const analysis = await analyzeChromecastMedia(options)
      lastChromecastAnalysisRef.current = analysis
      console.log('[useCast] Chromecast probe:', formatCodecDetails(analysis))

      if (!analysis.supported) {
        console.warn('[useCast] Chromecast rejected by probe:', analysis.reason)
        showCastError(`${analysis.reason}\n${formatCodecDetails(analysis)}`)
        return false
      } else if (analysis.mimeType) {
        contentType = analysis.mimeType
      }
    }

    try {
      clearCastAttemptTimer()
      const result = await rpc.castPlay({
        url: playUrl,
        contentType,
        title: options.title || '',
        thumbnail: options.thumbnail || '',
        time: Math.floor(options.time || 0),
        volume: playbackState.volume,
      })

      if (result?.success) {
        if (device?.protocol === 'chromecast') {
          setPlaybackState(prev => ({ ...prev, state: 'buffering', currentTime: 0 }))
          castAttemptTimerRef.current = setTimeout(() => {
            const current = playbackStateRef.current
            if (!isPlaybackActive(current)) {
              const detail = lastChromecastAnalysisRef.current
                ? `\n${formatCodecDetails(lastChromecastAnalysisRef.current)}`
                : ''
              showCastError(
                `Chromecast did not start playback. If codecs look OK, the device likely cannot reach the blob URL.${detail}`
              )
            }
          }, 10000)
        } else {
          setPlaybackState(prev => ({ ...prev, state: 'playing' }))
        }
        return true
      }

      const analysis = lastChromecastAnalysisRef.current
      const detail = analysis ? `\n${formatCodecDetails(analysis)}` : ''
      console.error('[useCast] play failed:', result?.error)
      showCastError(`Chromecast failed to start playback.${result?.error ? ` ${result.error}` : ''}${detail}`)
      return false
    } catch (err) {
      const analysis = lastChromecastAnalysisRef.current
      const detail = analysis ? `\n${formatCodecDetails(analysis)}` : ''
      console.error('[useCast] play failed:', err)
      showCastError(`Chromecast failed to start playback.${detail}`)
      return false
    }
  }, [rpc, connectedDevice, playbackState.volume, clearCastAttemptTimer, isPlaybackActive])

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
