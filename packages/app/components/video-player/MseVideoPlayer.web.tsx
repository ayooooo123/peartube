/**
 * MseVideoPlayer — fallback video player for containers WebKit can't handle.
 *
 * Uses mediabunny to demux MKV/WebM and remux to fMP4 in pure TypeScript,
 * then feeds segments to MediaSource Extensions for native playback.
 * No server processing — everything runs client-side.
 *
 * WebKit CAN decode H.265, EAC3, AC3 via VideoToolbox/AudioToolbox.
 * It just can't parse MKV containers. This component strips the container.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'

interface MseVideoPlayerProps {
  videoUrl: string
  style?: any
  isPlaying: boolean
  onLoad?: (data: { duration: number; durationMs: number }) => void
  onProgress?: (data: { currentTime: number; duration: number }) => void
  onPlaying?: () => void
  onPaused?: () => void
  onEnded?: () => void
  onError?: (error: { message: string }) => void
  onReady?: () => void
  playerRef?: React.RefObject<any>
}

export const MseVideoPlayer = memo(function MseVideoPlayer({
  videoUrl,
  style,
  isPlaying,
  onLoad,
  onProgress,
  onPlaying,
  onPaused,
  onEnded,
  onError,
  onReady,
  playerRef,
}: MseVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const conversionRef = useRef<any>(null)
  const [isInitialized, setIsInitialized] = useState(false)

  // Expose player controls via ref
  useEffect(() => {
    if (!playerRef) return
    playerRef.current = {
      play: async () => videoRef.current?.play(),
      pause: async () => videoRef.current?.pause(),
      stop: async () => { videoRef.current?.pause(); if (videoRef.current) videoRef.current.currentTime = 0 },
      destroy: async () => { conversionRef.current?.cancel?.() },
      seek: async (timeSec: number) => { if (videoRef.current) videoRef.current.currentTime = timeSec },
      resume: async (playing: boolean) => { if (playing) videoRef.current?.play(); else videoRef.current?.pause() },
      enterPip: () => {},
    }
    return () => { if (playerRef.current) playerRef.current = null }
  }, [playerRef])

  // Progress reporting
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const interval = setInterval(() => {
      if (video.duration && !isNaN(video.duration)) {
        onProgress?.({
          currentTime: Math.round(video.currentTime * 1000),
          duration: Math.round(video.duration * 1000),
        })
      }
    }, 500)
    return () => clearInterval(interval)
  }, [onProgress, isInitialized])

  // Play/pause control
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isInitialized) return
    if (isPlaying) video.play().catch(() => {})
    else video.pause()
  }, [isPlaying, isInitialized])

  // Initialize MSE + mediabunny conversion
  const initMse = useCallback(async () => {
    const video = videoRef.current
    if (!video || !videoUrl) return

    try {
      // Rewrite the blob URL to go through the same-origin proxy.
      // The blob server runs on a different port → CORS blocked.
      // The static server's /__blob endpoint proxies with CORS headers.
      let proxiedUrl = videoUrl
      try {
        const blobUrlObj = new URL(videoUrl)
        const staticOrigin = window.location.origin
        // Pass the blob server port so the proxy knows where to forward
        proxiedUrl = `${staticOrigin}/__blob?__port=${blobUrlObj.port}&${blobUrlObj.searchParams.toString()}`
      } catch {}
      console.log('[MsePlayer] Initializing with mediabunny for:', proxiedUrl.substring(0, 100))

      // Dynamic import — only loaded when needed
      console.log('[MsePlayer] Importing mediabunny...')
      const mb = await import('mediabunny')
      console.log('[MsePlayer] mediabunny imported, exports:', Object.keys(mb).slice(0, 10).join(', '))

      const {
        Input, Output, Conversion,
        UrlSource, Mp4OutputFormat, StreamTarget,
      } = mb

      const ALL_FORMATS = mb.ALL_FORMATS || [
        mb.MatroskaInputFormat, mb.Mp4InputFormat, mb.WebMInputFormat,
        mb.OggInputFormat, mb.WavInputFormat,
      ].filter(Boolean)
      console.log('[MsePlayer] Formats:', ALL_FORMATS?.length || 0)

      console.log('[MsePlayer] Creating UrlSource...')
      const source = new UrlSource(proxiedUrl)
      console.log('[MsePlayer] Creating Input...')
      const input = new Input({ source, formats: ALL_FORMATS })
      console.log('[MsePlayer] Input created')

      // Buffer chunks until MSE sourceBuffer is ready
      const pendingChunks: Uint8Array[] = []
      let appendQueue = Promise.resolve()

      const appendToSourceBuffer = (data: Uint8Array) => {
        const sb = sourceBufferRef.current
        if (!sb) {
          pendingChunks.push(data)
          return
        }
        appendQueue = appendQueue.then(() => new Promise<void>((resolve) => {
          try {
            sb.appendBuffer(data)
            sb.onupdateend = () => resolve()
          } catch (err: any) {
            console.warn('[MsePlayer] appendBuffer error:', err?.message)
            resolve()
          }
        }))
      }

      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
        target: new StreamTarget(new WritableStream({
          write(chunk: any) {
            appendToSourceBuffer(chunk.data || chunk)
          },
        })),
      })

      console.log('[MsePlayer] Calling Conversion.init()...')
      const conversion = await Conversion.init({ input, output })
      console.log('[MsePlayer] Conversion initialized, valid:', conversion.isValid)
      conversionRef.current = conversion

      if (!conversion.isValid) {
        const discarded = conversion.discardedTracks?.map((t: any) => t.codecId || t.type).join(', ')
        console.error('[MsePlayer] Incompatible tracks:', discarded)
        onError?.({ message: `Incompatible tracks: ${discarded}` })
        return
      }

      // Check if MSE is available
      console.log('[MsePlayer] MediaSource available:', typeof MediaSource !== 'undefined')
      console.log('[MsePlayer] MediaSource.isTypeSupported:', typeof MediaSource?.isTypeSupported)

      if (typeof MediaSource === 'undefined') {
        console.error('[MsePlayer] MediaSource API not available in this browser')
        onError?.({ message: 'MediaSource API not available' })
        return
      }

      // Create MediaSource and wire it up
      const mediaSource = new MediaSource()
      mediaSourceRef.current = mediaSource
      console.log('[MsePlayer] MediaSource created, state:', mediaSource.readyState)
      video.src = URL.createObjectURL(mediaSource)
      console.log('[MsePlayer] video.src set, waiting for sourceopen...')

      await Promise.race([
        new Promise<void>((resolve) => { mediaSource.onsourceopen = () => { console.log('[MsePlayer] sourceopen fired!'); resolve() } }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('sourceopen timeout (5s)')), 5000))
      ])

      // Add SourceBuffer IMMEDIATELY after sourceopen — WebKit closes
      // the MediaSource if no SourceBuffer is added promptly.
      // Try MIME types until one works.
      const mimeOptions = [
        'video/mp4; codecs="hev1.1.6.L150.B0"',
        'video/mp4; codecs="hvc1.1.6.L150.B0"',
        'video/mp4; codecs="avc1.640032"',
        'video/mp4',
      ]

      let sourceBuffer: SourceBuffer | null = null
      for (const mime of mimeOptions) {
        if (MediaSource.isTypeSupported(mime)) {
          try {
            console.log('[MsePlayer] Trying MIME:', mime)
            sourceBuffer = mediaSource.addSourceBuffer(mime)
            console.log('[MsePlayer] SourceBuffer added with:', mime)
            break
          } catch (e: any) {
            console.warn('[MsePlayer] addSourceBuffer failed for', mime, ':', e?.message)
          }
        }
      }

      if (!sourceBuffer) {
        onError?.({ message: 'No supported MIME type for MSE' })
        return
      }
      sourceBufferRef.current = sourceBuffer

      // Flush any chunks that arrived before sourceBuffer was ready
      for (const chunk of pendingChunks) {
        appendToSourceBuffer(chunk)
      }
      pendingChunks.length = 0

      setIsInitialized(true)
      onReady?.()

      // Start conversion (streaming — chunks flow as they're ready)
      console.log('[MsePlayer] Starting conversion...')
      await conversion.execute()
      console.log('[MsePlayer] Conversion complete')

      // Wait for all pending appends
      await appendQueue
      if (mediaSource.readyState === 'open') {
        mediaSource.endOfStream()
      }
    } catch (err: any) {
      console.error('[MsePlayer] Error:', err?.message || err)
      onError?.({ message: err?.message || 'MSE player error' })
    }
  }, [videoUrl, onError, onReady])

  const initStartedRef = useRef(false)
  useEffect(() => {
    if (initStartedRef.current) return
    initStartedRef.current = true
    initMse()
    return () => {
      conversionRef.current?.cancel?.()
      if (mediaSourceRef.current?.readyState === 'open') {
        try { mediaSourceRef.current.endOfStream() } catch {}
      }
    }
  }, [initMse])

  return (
    <video
      ref={videoRef}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        backgroundColor: '#000',
        ...(style || {}),
      }}
      onLoadedMetadata={() => {
        const v = videoRef.current
        if (v && v.duration) {
          onLoad?.({
            duration: v.duration,
            durationMs: Math.round(v.duration * 1000),
          })
        }
      }}
      onPlay={() => onPlaying?.()}
      onPause={() => onPaused?.()}
      onEnded={() => onEnded?.()}
      onError={(e) => {
        const v = videoRef.current
        const code = v?.error?.code
        console.error('[MsePlayer] Video element error:', code, v?.error?.message)
        onError?.({ message: v?.error?.message || `Video error code ${code}` })
      }}
      playsInline
      autoPlay={isPlaying}
    />
  )
})
