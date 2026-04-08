/**
 * MseVideoPlayer — fallback player using mediabunny + MSE for MKV containers.
 * No useEffect for init — called once via ref callback to avoid React remount issues.
 */

import { memo, useCallback, useRef } from 'react'

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
  playerRef,
}: MseVideoPlayerProps) {
  const initStarted = useRef(false)
  const videoElRef = useRef<HTMLVideoElement | null>(null)

  // Ref callback — fires once when the <video> element mounts.
  // No useEffect, no cleanup, no remount issues.
  const videoRefCallback = useCallback((el: HTMLVideoElement | null) => {
    if (!el || initStarted.current) return
    initStarted.current = true
    videoElRef.current = el

    // Wire player controls
    if (playerRef) {
      playerRef.current = {
        play: async () => el.play(),
        pause: async () => el.pause(),
        stop: async () => { el.pause(); el.currentTime = 0 },
        destroy: async () => {},
        seek: async (t: number) => { el.currentTime = t },
        resume: async (p: boolean) => { if (p) el.play(); else el.pause() },
        enterPip: () => {},
      }
    }

    // Progress timer
    const progressInterval = setInterval(() => {
      if (el.duration && !isNaN(el.duration)) {
        onProgress?.({
          currentTime: Math.round(el.currentTime * 1000),
          duration: Math.round(el.duration * 1000),
        })
      }
    }, 500)

    // Start mediabunny conversion
    ;(async () => {
      try {
        // Use blob URL directly — CORS headers are patched on the blob server
        console.log('[MsePlayer] Init:', videoUrl.substring(0, 100))

        const mb = await import('mediabunny')
        const { Input, Output, Conversion, UrlSource, Mp4OutputFormat, StreamTarget } = mb
        const ALL_FORMATS = mb.ALL_FORMATS || [mb.MatroskaInputFormat, mb.Mp4InputFormat].filter(Boolean)

        const source = new UrlSource(videoUrl, {
          maxCacheSize: 256 * 1024 * 1024, // 256 MiB (default 64 MiB)
          parallelism: 4,                   // 4 parallel range requests (default 2)
        })
        const input = new Input({ source, formats: ALL_FORMATS, prefetchProfile: 'network' })

        // Buffer chunks until SourceBuffer is ready
        const pending: Uint8Array[] = []
        let sbRef: SourceBuffer | null = null
        let queue = Promise.resolve()

        const append = (data: Uint8Array) => {
          if (!sbRef) { pending.push(data); return }
          queue = queue.then(() => new Promise<void>(r => {
            try { sbRef!.appendBuffer(data); sbRef!.onupdateend = () => r() }
            catch { r() }
          }))
        }

        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
          target: new StreamTarget(new WritableStream({
            write(chunk: any) { append(chunk.data || chunk) },
          })),
        })

        const conversion = await Conversion.init({ input, output })
        if (!conversion.isValid) {
          onError?.({ message: 'Incompatible tracks' })
          return
        }

        // Create MediaSource + SourceBuffer
        const ms = new MediaSource()
        el.src = URL.createObjectURL(ms)
        await new Promise<void>(r => { ms.onsourceopen = () => r() })

        // Add SourceBuffer immediately with known MIME
        const mimes = [
          'video/mp4; codecs="hev1.1.6.L150.B0"',
          'video/mp4; codecs="avc1.640032"',
          'video/mp4',
        ]
        for (const m of mimes) {
          if (MediaSource.isTypeSupported(m)) {
            try { sbRef = ms.addSourceBuffer(m); console.log('[MsePlayer] SourceBuffer:', m); break }
            catch {}
          }
        }
        if (!sbRef) { onError?.({ message: 'No MSE MIME support' }); return }

        // Flush pending
        for (const c of pending) append(c)
        pending.length = 0

        // Play
        el.play().catch(() => {})
        onLoad?.({ duration: 0, durationMs: 0 })

        // Run conversion
        console.log('[MsePlayer] Converting...')
        await conversion.execute()
        console.log('[MsePlayer] Done')
        await queue
        // Wait for SourceBuffer to finish before ending stream
        if (sbRef?.updating) {
          await new Promise<void>(r => { sbRef!.onupdateend = () => r() })
        }
        if (ms.readyState === 'open') {
          try { ms.endOfStream() } catch {}
        }
        // Update duration for seeking — now that all data is appended,
        // the video element knows the full duration and seeking works
        if (el.duration && isFinite(el.duration)) {
          console.log('[MsePlayer] Final duration:', el.duration)
          onLoad?.({ duration: el.duration, durationMs: Math.round(el.duration * 1000) })
        }
      } catch (err: any) {
        console.error('[MsePlayer] Error:', err?.message)
        onError?.({ message: err?.message || 'MSE error' })
      }
    })()
  }, [videoUrl, onProgress, onLoad, onError, playerRef])

  return (
    <video
      ref={videoRefCallback}
      style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000', ...(style || {}) }}
      onPlay={() => onPlaying?.()}
      onPause={() => onPaused?.()}
      onEnded={() => onEnded?.()}
      onLoadedMetadata={() => {
        const v = videoElRef.current
        if (v?.duration) onLoad?.({ duration: v.duration, durationMs: Math.round(v.duration * 1000) })
      }}
      playsInline
      autoPlay
    />
  )
})
