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

interface Html5FallbackProps extends MpvPlayerProps {
  error?: string | null
}

/**
 * HTML5 Video Fallback - Used when mpv is not available
 * Supports MP4/WebM/H.264/AAC but not MKV/HEVC/AC3/DTS
 */
const Html5VideoFallback = forwardRef<MpvPlayerRef, Html5FallbackProps>(({
  url,
  autoPlay = true,
  onProgress,
  onPlaying,
  onPaused,
  onEnded,
  onError,
  onCanPlay,
  style,
  error: mpvError,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showWarning, setShowWarning] = useState(true)
  const [videoError, setVideoError] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({
    play: () => { videoRef.current?.play() },
    pause: () => { videoRef.current?.pause() },
    seek: (time: number) => {
      if (videoRef.current) videoRef.current.currentTime = time
    },
    getCurrentTime: () => videoRef.current?.currentTime || 0,
    getDuration: () => videoRef.current?.duration || 0,
  }))

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleTimeUpdate = () => {
      onProgress?.({ currentTime: video.currentTime, duration: video.duration || 0 })
    }
    const handlePlay = () => onPlaying?.()
    const handlePause = () => onPaused?.()
    const handleEnded = () => onEnded?.()
    const handleCanPlay = () => {
      setShowWarning(false)
      onCanPlay?.()
    }
    const handleError = () => {
      const errorMsg = 'This video format is not supported by your browser. MKV, HEVC, AC3, and DTS require mpv to be installed.'
      setVideoError(errorMsg)
      onError?.(errorMsg)
    }

    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('ended', handleEnded)
    video.addEventListener('canplay', handleCanPlay)
    video.addEventListener('error', handleError)

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('ended', handleEnded)
      video.removeEventListener('canplay', handleCanPlay)
      video.removeEventListener('error', handleError)
    }
  }, [onProgress, onPlaying, onPaused, onEnded, onCanPlay, onError])

  if (videoError) {
    return (
      <div style={{
        ...style,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#fff',
        padding: 24,
        textAlign: 'center',
      }}>
        <span style={{ color: '#f97316', fontSize: 18, marginBottom: 12 }}>Unsupported Format</span>
        <span style={{ color: '#9ca3af', fontSize: 14, maxWidth: 400, lineHeight: 1.5 }}>
          {videoError}
        </span>
        <span style={{ color: '#6b7280', fontSize: 12, marginTop: 16 }}>
          Install mpv: <code style={{ background: '#374151', padding: '2px 6px', borderRadius: 4 }}>
            {typeof navigator !== 'undefined' && navigator.platform?.includes('Linux')
              ? 'sudo apt install mpv'
              : 'brew install mpv'}
          </code>
        </span>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      {showWarning && (
        <div style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          background: 'rgba(251, 146, 60, 0.9)',
          color: '#000',
          padding: '8px 12px',
          borderRadius: 6,
          fontSize: 12,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span>⚠️</span>
          <span>
            mpv not available - using browser player. Some formats (MKV, HEVC, AC3) may not work.
          </span>
          <button
            onClick={() => setShowWarning(false)}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              color: '#000',
            }}
          >
            ✕
          </button>
        </div>
      )}
      <video
        ref={videoRef}
        src={url}
        autoPlay={autoPlay}
        controls={false}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#000',
          objectFit: 'contain',
        }}
      />
    </div>
  )
})

Html5VideoFallback.displayName = 'Html5VideoFallback'

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

  // Fallback to HTML5 video when mpv is not available
  if (mpvAvailable === false) {
    return (
      <Html5VideoFallback
        ref={ref}
        url={url}
        autoPlay={autoPlay}
        onProgress={onProgress}
        onPlaying={onPlaying}
        onPaused={onPaused}
        onEnded={onEnded}
        onError={onError}
        onCanPlay={onCanPlay}
        style={style}
        error={error}
      />
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
