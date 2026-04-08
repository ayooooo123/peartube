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
        proxiedUrl = `${staticOrigin}/__blob?${blobUrlObj.searchParams.toString()}`
      } catch {}
      console.log('[MsePlayer] Initializing with mediabunny for:', proxiedUrl.substring(0, 100))

      // Dynamic import — only loaded when needed (keeps bundle small for non-MKV videos)
      const mb = await import('mediabunny')
      const {
        Input, Output, Conversion,
        UrlSource, Mp4OutputFormat, StreamTarget,
      } = mb

      // Dynamically import ALL_FORMATS
      const ALL_FORMATS = mb.ALL_FORMATS || [
        mb.MatroskaInputFormat, mb.Mp4InputFormat, mb.WebMInputFormat,
        mb.OggInputFormat, mb.WavInputFormat,
      ].filter(Boolean)

      const source = new UrlSource(proxiedUrl)
      const input = new Input({ source, formats: ALL_FORMATS })

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

      const conversion = await Conversion.init({ input, output })
      conversionRef.current = conversion

      if (!conversion.isValid) {
        const discarded = conversion.discardedTracks?.map((t: any) => t.codecId || t.type).join(', ')
        console.error('[MsePlayer] Incompatible tracks:', discarded)
        onError?.({ message: `Incompatible tracks: ${discarded}` })
        return
      }

      // Create MediaSource and wire it up
      const mediaSource = new MediaSource()
      mediaSourceRef.current = mediaSource
      video.src = URL.createObjectURL(mediaSource)

      await new Promise<void>((resolve) => { mediaSource.onsourceopen = () => resolve() })

      // Get the codec MIME type from mediabunny
      const mimeType = await output.getMimeType()
      console.log('[MsePlayer] MIME type:', mimeType)

      if (!MediaSource.isTypeSupported(mimeType)) {
        console.error('[MsePlayer] MIME type not supported:', mimeType)
        onError?.({ message: `Unsupported MIME: ${mimeType}` })
        return
      }

      const sourceBuffer = mediaSource.addSourceBuffer(mimeType)
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

  useEffect(() => {
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
