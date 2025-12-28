/**
 * MpvPlayer - React component for libmpv video playback on Pear Desktop
 * Uses bare-mpv native addon for universal codec support (AC3, DTS, etc.)
 * Renders frames to canvas via software rendering
 */

import { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react'

// Types for bare-mpv player
interface MpvPlayerInstance {
  initialize(): number
  loadFile(url: string): number
  play(): number
  pause(): number
  seek(seconds: number): number
  get currentTime(): number
  get duration(): number
  get paused(): boolean
  initRender(width: number, height: number): void
  renderFrame(): Uint8Array | null
  needsRender(): boolean
  destroy(): void
}

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

// Dynamic import for bare-mpv (only available on Pear)
let MpvPlayerClass: new () => MpvPlayerInstance
try {
  // This will only work in Pear runtime
  const bareMpv = require('bare-mpv')
  MpvPlayerClass = bareMpv.MpvPlayer
} catch {
  // Not running in Pear - component will render fallback
  MpvPlayerClass = null as any
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
  const playerRef = useRef<MpvPlayerInstance | null>(null)
  const animationRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(0)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Expose player controls via ref
  useImperativeHandle(ref, () => ({
    play: () => {
      if (playerRef.current) {
        playerRef.current.play()
        onPlaying?.()
      }
    },
    pause: () => {
      if (playerRef.current) {
        playerRef.current.pause()
        onPaused?.()
      }
    },
    seek: (time: number) => {
      if (playerRef.current) {
        playerRef.current.seek(time)
      }
    },
    getCurrentTime: () => playerRef.current?.currentTime ?? 0,
    getDuration: () => playerRef.current?.duration ?? 0,
  }))

  // Initialize player and start render loop
  useEffect(() => {
    if (!MpvPlayerClass) {
      setError('bare-mpv not available (not running on Pear)')
      onError?.('bare-mpv not available')
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setError('Failed to get canvas context')
      onError?.('Failed to get canvas context')
      return
    }

    // Create player
    let player: MpvPlayerInstance
    try {
      player = new MpvPlayerClass()
      const status = player.initialize()
      if (status !== 0) {
        throw new Error(`Failed to initialize mpv: ${status}`)
      }
      playerRef.current = player
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create player'
      setError(msg)
      onError?.(msg)
      return
    }

    // Initialize renderer with canvas size
    const width = canvas.width || 1280
    const height = canvas.height || 720
    player.initRender(width, height)

    // Load the video
    try {
      player.loadFile(url)
      setIsReady(true)
      onCanPlay?.()

      if (autoPlay) {
        player.play()
        onPlaying?.()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load video'
      setError(msg)
      onError?.(msg)
      return
    }

    // Render loop
    let lastReportTime = 0
    const render = () => {
      if (!playerRef.current) return

      const p = playerRef.current

      // Check if we need to render a new frame
      if (p.needsRender()) {
        const frame = p.renderFrame()
        if (frame) {
          const imageData = new ImageData(
            new Uint8ClampedArray(frame.buffer),
            width,
            height
          )
          ctx.putImageData(imageData, 0, 0)
        }
      }

      // Report progress every 250ms
      const now = performance.now()
      if (now - lastReportTime > 250) {
        const currentTime = p.currentTime
        const duration = p.duration

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

      animationRef.current = requestAnimationFrame(render)
    }

    animationRef.current = requestAnimationFrame(render)

    // Cleanup
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      if (playerRef.current) {
        playerRef.current.destroy()
        playerRef.current = null
      }
    }
  }, [url, autoPlay, onProgress, onPlaying, onPaused, onEnded, onError, onCanPlay])

  if (error) {
    return (
      <div style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000',
        color: '#f00',
      }}>
        <span>Error: {error}</span>
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
