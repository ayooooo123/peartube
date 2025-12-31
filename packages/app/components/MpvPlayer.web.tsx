/**
 * MpvPlayer - React component for libmpv video playback on Pear Desktop
 * Uses bare-mpv via RPC to enable universal codec support (AC3, DTS, etc.)
 * Renders decoded frames to canvas via software rendering.
 *
 * The bare-mpv addon runs in the Pear worker (main process), and frames
 * are streamed to this component via RPC.
 */

import { useRef, useEffect, useState, forwardRef, useImperativeHandle, useCallback } from 'react'
import { useApp } from '@/lib/AppContext'

interface MpvPlayerProps {
  url: string
  autoPlay?: boolean
  onProgress?: (data: { currentTime: number; duration: number }) => void
  onPlaying?: () => void
  onPaused?: () => void
  onEnded?: () => void
  onError?: (error: string) => void
  onCanPlay?: () => void
  style?: React.CSSProperties
}

export interface MpvPlayerRef {
  play: () => void
  pause: () => void
  seek: (time: number) => void
  getCurrentTime: () => number
  getDuration: () => number
}

export const MpvPlayer = forwardRef<MpvPlayerRef, MpvPlayerProps>(({
  url,
  autoPlay = true,
  onProgress,
  onPlaying,
  onPaused,
  onEnded,
  onError,
  onCanPlay,
  style,
}, ref) => {
  const { rpc } = useApp()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerIdRef = useRef<string | null>(null)
  const animationRef = useRef<number | null>(null)
  const frameServerPortRef = useRef<number | null>(null)
  const frameInFlightRef = useRef(false)
  const playerLogKeyRef = useRef<string | null>(null)
  const stateRef = useRef({ currentTime: 0, duration: 0, paused: true })
  const lastTimeRef = useRef<number>(0)
  const lastStateFetchRef = useRef<number>(0)
  const lastFrameFetchRef = useRef<number>(0)
  const mountedRef = useRef(true)
  const onProgressRef = useRef(onProgress)
  const onPlayingRef = useRef(onPlaying)
  const onPausedRef = useRef(onPaused)
  const onEndedRef = useRef(onEnded)
  const onErrorRef = useRef(onError)
  const onCanPlayRef = useRef(onCanPlay)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mpvAvailable, setMpvAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    onProgressRef.current = onProgress
  }, [onProgress])

  useEffect(() => {
    onPlayingRef.current = onPlaying
  }, [onPlaying])

  useEffect(() => {
    onPausedRef.current = onPaused
  }, [onPaused])

  useEffect(() => {
    onEndedRef.current = onEnded
  }, [onEnded])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    onCanPlayRef.current = onCanPlay
  }, [onCanPlay])

  // Expose player controls via ref
  useImperativeHandle(ref, () => ({
    play: async () => {
      if (playerIdRef.current && rpc) {
        await rpc.mpvPlay({ playerId: playerIdRef.current })
        stateRef.current.paused = false
        onPlayingRef.current?.()
      }
    },
    pause: async () => {
      if (playerIdRef.current && rpc) {
        await rpc.mpvPause({ playerId: playerIdRef.current })
        stateRef.current.paused = true
        onPausedRef.current?.()
      }
    },
    seek: async (time: number) => {
      if (playerIdRef.current && rpc) {
        await rpc.mpvSeek({ playerId: playerIdRef.current, time })
      }
    },
    getCurrentTime: () => stateRef.current.currentTime,
    getDuration: () => stateRef.current.duration,
  }))

  // Check if mpv is available
  useEffect(() => {
    if (!rpc) return

    rpc.mpvAvailable({}).then((result: any) => {
      console.log('[MpvPlayer] mpvAvailable:', result?.available)
      setMpvAvailable(result?.available ?? false)
      if (!result?.available) {
        const message = result?.error || 'bare-mpv not available on worker'
        setError(message)
        onErrorRef.current?.(message)
      }
    }).catch((err: any) => {
      console.error('[MpvPlayer] mpvAvailable check failed:', err)
      setMpvAvailable(false)
      setError('Failed to check mpv availability')
      onErrorRef.current?.('Failed to check mpv availability')
    })
  }, [rpc])

  // Render loop - polls for frames via RPC
  const startRenderLoop = useCallback(async (playerId: string, ctx: CanvasRenderingContext2D, width: number, height: number) => {
    let lastProgressReport = 0
    let renderWidth = width
    let renderHeight = height

    const render = async () => {
      if (!mountedRef.current || !playerIdRef.current) return

      const now = performance.now()

      try {
        // Get player state (throttled)
        if (now - lastStateFetchRef.current > 100) {
          const state = await rpc.mpvGetState({ playerId })
          if (state.success !== false) {
            stateRef.current.currentTime = state.currentTime || 0
            stateRef.current.duration = state.duration || 0
            stateRef.current.paused = state.paused ?? true
          }
          lastStateFetchRef.current = now
        }

        // Fetch frame data from the local mpv frame server
        const frameServerPort = frameServerPortRef.current
        const shouldFetchFrame = now - lastFrameFetchRef.current > 33
        if (frameServerPort && shouldFetchFrame && !frameInFlightRef.current) {
          frameInFlightRef.current = true
          try {
            const response = await fetch(`http://127.0.0.1:${frameServerPort}/frame/${encodeURIComponent(playerId)}`)
            if (response.status === 200) {
              const headerWidth = parseInt(response.headers.get('X-Frame-Width') || String(renderWidth), 10)
              const headerHeight = parseInt(response.headers.get('X-Frame-Height') || String(renderHeight), 10)
              const buffer = await response.arrayBuffer()
              if (buffer.byteLength > 0) {
                const canvas = canvasRef.current
                if (canvas && (canvas.width !== headerWidth || canvas.height !== headerHeight)) {
                  canvas.width = headerWidth
                  canvas.height = headerHeight
                  renderWidth = headerWidth
                  renderHeight = headerHeight
                }

                const imageData = new ImageData(new Uint8ClampedArray(buffer), headerWidth, headerHeight)
                ctx.putImageData(imageData, 0, 0)
              }
            }
          } catch (e) {
            // Ignore frame fetch errors to keep playback loop alive
          } finally {
            lastFrameFetchRef.current = now
            frameInFlightRef.current = false
          }
        } else if (!frameServerPort && shouldFetchFrame) {
          // Fallback to RPC frame rendering if frame server is unavailable
          const frameResult = await rpc.mpvRenderFrame({ playerId })
          if (frameResult.success !== false && frameResult.hasFrame && frameResult.frameData) {
            const binaryString = atob(frameResult.frameData)
            const bytes = new Uint8Array(binaryString.length)
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i)
            }
            const imageData = new ImageData(
              new Uint8ClampedArray(bytes.buffer),
              frameResult.width || width,
              frameResult.height || height
            )
            ctx.putImageData(imageData, 0, 0)
          }
          lastFrameFetchRef.current = now
        }

        // Report progress every 250ms
        if (now - lastProgressReport > 250) {
          const { currentTime, duration } = stateRef.current
          if (duration > 0) {
            onProgressRef.current?.({ currentTime, duration })

            // Check if ended
            if (currentTime >= duration - 0.5 && lastTimeRef.current < duration - 0.5) {
              onEndedRef.current?.()
            }
            lastTimeRef.current = currentTime
          }
          lastProgressReport = now
        }
      } catch (e) {
        // Ignore render errors, continue loop
        console.warn('[MpvPlayer] Render error:', e)
      }

      if (mountedRef.current && playerIdRef.current) {
        animationRef.current = requestAnimationFrame(render)
      }
    }

    render()
  }, [rpc])

  // Initialize player
  useEffect(() => {
    if (!rpc || mpvAvailable === null || mpvAvailable === false) return
    mountedRef.current = true

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setError('Failed to get canvas context')
      onError?.('Failed to get canvas context')
      return
    }

    const width = canvas.width || 1280
    const height = canvas.height || 720

    let playerId: string | null = null

    const init = async () => {
      try {
        console.log('[MpvPlayer] Creating player...')

        // Create player
        const createResult = await rpc.mpvCreate({ width, height })
        if (!createResult.success || !createResult.playerId) {
          throw new Error(createResult.error || 'Failed to create player')
        }

        playerId = createResult.playerId
        playerIdRef.current = playerId
        frameServerPortRef.current = createResult.frameServerPort || null
        console.log('[MpvPlayer] Created player:', playerId, 'frame server port:', frameServerPortRef.current)
        const logKey = `${playerId}:${url}`
        if (playerLogKeyRef.current !== logKey) {
          playerLogKeyRef.current = logKey
          if (typeof window !== 'undefined') {
            ;(window as any).__PEARTUBE_PLAYER__ = {
              player: 'mpv',
              playerId,
              url,
            }
          }
          console.log('[MpvPlayer] Active player: mpv', 'playerId:', playerId)
        }

        // Load video
        console.log('[MpvPlayer] Loading:', url)
        const loadResult = await rpc.mpvLoadFile({ playerId, url })
        if (!loadResult.success) {
          throw new Error(loadResult.error || 'Failed to load file')
        }

        setIsReady(true)
        onCanPlayRef.current?.()

        if (autoPlay) {
          await rpc.mpvPlay({ playerId })
          stateRef.current.paused = false
          onPlayingRef.current?.()
        }

        // Start render loop
        startRenderLoop(playerId, ctx, width, height)
      } catch (e: any) {
        if (!mountedRef.current) return
        const msg = e?.message || 'Failed to initialize player'
        console.error('[MpvPlayer] Error:', msg)
        setError(msg)
        onErrorRef.current?.(msg)
      }
    }

    init()

    // Cleanup
    return () => {
      mountedRef.current = false
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      if (playerIdRef.current && rpc) {
        rpc.mpvDestroy({ playerId: playerIdRef.current }).catch(() => {})
        playerIdRef.current = null
      }
      frameServerPortRef.current = null
      frameInFlightRef.current = false
    }
  }, [rpc, mpvAvailable, url, autoPlay, startRenderLoop])

  if (mpvAvailable === null) {
    return (
      <div style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#888',
      }}>
        <span>Checking mpv...</span>
      </div>
    )
  }

  if (!mpvAvailable || error) {
    return (
      <div style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#f00',
      }}>
        <span>Error: {error || 'bare-mpv not available'}</span>
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      data-player="mpv"
      width={1280}
      height={720}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
        ...style,
      }}
    />
  )
})

MpvPlayer.displayName = 'MpvPlayer'

export default MpvPlayer
