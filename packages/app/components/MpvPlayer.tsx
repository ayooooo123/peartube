/**
 * MpvPlayer - React component for libmpv video playback on Pear Desktop
 * Uses bare-mpv native addon via RPC for universal codec support (AC3, DTS, etc.)
 * Renders frames to canvas via software rendering
 */

import { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { rpc } from '@peartube/platform/rpc'

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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerIdRef = useRef<string | null>(null)
  const animationRef = useRef<number | null>(null)
  const stateRef = useRef({ currentTime: 0, duration: 0, paused: true })
  const lastTimeRef = useRef<number>(0)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mpvAvailable, setMpvAvailable] = useState<boolean | null>(null)

  // Expose player controls via ref
  useImperativeHandle(ref, () => ({
    play: async () => {
      if (playerIdRef.current) {
        await rpc.mpvPlay({ playerId: playerIdRef.current })
        onPlaying?.()
      }
    },
    pause: async () => {
      if (playerIdRef.current) {
        await rpc.mpvPause({ playerId: playerIdRef.current })
        onPaused?.()
      }
    },
    seek: async (time: number) => {
      if (playerIdRef.current) {
        await rpc.mpvSeek({ playerId: playerIdRef.current, time })
      }
    },
    getCurrentTime: () => stateRef.current.currentTime,
    getDuration: () => stateRef.current.duration,
  }))

  // Check if mpv is available
  useEffect(() => {
    const checkMpv = async () => {
      try {
        const result = await rpc.mpvAvailable()
        console.log('[MpvPlayer] mpv available:', result.available)
        setMpvAvailable(result.available)
        if (!result.available) {
          setError('bare-mpv not available in worker')
          onError?.('bare-mpv not available')
        }
      } catch (e: any) {
        console.error('[MpvPlayer] Failed to check mpv availability:', e)
        setMpvAvailable(false)
        setError('Failed to connect to mpv')
        onError?.('Failed to connect to mpv')
      }
    }
    checkMpv()
  }, [onError])

  // Initialize player and start render loop
  useEffect(() => {
    if (mpvAvailable !== true) return

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setError('Failed to get canvas context')
      onError?.('Failed to get canvas context')
      return
    }

    let mounted = true
    const width = canvas.width || 1280
    const height = canvas.height || 720

    const initPlayer = async () => {
      try {
        // Create player
        console.log('[MpvPlayer] Creating player...')
        const createResult = await rpc.mpvCreate({ width, height })
        if (!createResult.success || !createResult.playerId) {
          throw new Error(createResult.error || 'Failed to create player')
        }

        if (!mounted) {
          // Component unmounted during async operation
          await rpc.mpvDestroy({ playerId: createResult.playerId })
          return
        }

        playerIdRef.current = createResult.playerId
        console.log('[MpvPlayer] Player created:', createResult.playerId)

        // Load the video
        console.log('[MpvPlayer] Loading:', url)
        const loadResult = await rpc.mpvLoadFile({ playerId: createResult.playerId, url })
        if (!loadResult.success) {
          throw new Error(loadResult.error || 'Failed to load video')
        }

        setIsReady(true)
        onCanPlay?.()

        if (autoPlay) {
          await rpc.mpvPlay({ playerId: createResult.playerId })
          onPlaying?.()
        }

        // Render loop
        let lastReportTime = 0
        const render = async () => {
          if (!mounted || !playerIdRef.current) return

          try {
            // Get player state
            const state = await rpc.mpvGetState({ playerId: playerIdRef.current })
            if (state.success) {
              stateRef.current = {
                currentTime: state.currentTime || 0,
                duration: state.duration || 0,
                paused: state.paused ?? true,
              }
            }

            // Render frame
            const frame = await rpc.mpvRenderFrame({ playerId: playerIdRef.current })
            if (frame.success && frame.hasFrame && frame.frameData) {
              // Decode base64 RGBA data
              const binaryString = atob(frame.frameData)
              const bytes = new Uint8Array(binaryString.length)
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i)
              }

              const imageData = new ImageData(
                new Uint8ClampedArray(bytes.buffer),
                frame.width || width,
                frame.height || height
              )
              ctx.putImageData(imageData, 0, 0)
            }

            // Report progress every 250ms
            const now = performance.now()
            if (now - lastReportTime > 250) {
              const { currentTime, duration } = stateRef.current
              if (duration > 0) {
                onProgress?.({ currentTime, duration })

                // Check if ended (within 0.5s of end)
                if (currentTime >= duration - 0.5 && lastTimeRef.current < duration - 0.5) {
                  onEnded?.()
                }
                lastTimeRef.current = currentTime
              }
              lastReportTime = now
            }
          } catch (e) {
            // Ignore render errors, continue loop
          }

          if (mounted) {
            // Use setTimeout for RPC-based rendering (requestAnimationFrame is too fast)
            animationRef.current = window.setTimeout(render, 50) as unknown as number // ~20fps
          }
        }

        render()
      } catch (e: any) {
        if (!mounted) return
        const msg = e?.message || 'Failed to initialize player'
        console.error('[MpvPlayer] Error:', msg)
        setError(msg)
        onError?.(msg)
      }
    }

    initPlayer()

    // Cleanup
    return () => {
      mounted = false
      if (animationRef.current) {
        clearTimeout(animationRef.current)
        animationRef.current = null
      }
      if (playerIdRef.current) {
        rpc.mpvDestroy({ playerId: playerIdRef.current }).catch(() => {})
        playerIdRef.current = null
      }
    }
  }, [url, autoPlay, mpvAvailable, onProgress, onPlaying, onPaused, onEnded, onError, onCanPlay])

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
        <span>Checking mpv availability...</span>
      </div>
    )
  }

  if (error || !mpvAvailable) {
    return (
      <div style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#f00',
      }}>
        <span>Error: {error || 'mpv not available'}</span>
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
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
