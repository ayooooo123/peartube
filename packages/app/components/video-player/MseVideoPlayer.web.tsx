/**
 * MseVideoPlayer — streaming MSE player with sliding buffer window.
 *
 * Uses mediabunny to remux MKV→fMP4 and feeds segments to MSE SourceBuffer.
 * Only keeps ~60s of data buffered ahead of playback position.
 * Removes old segments behind playback to stay within WebKit's memory limits.
 */

import { memo, useCallback, useRef } from 'react'

const BUFFER_AHEAD_SEC = 60   // Buffer 60s ahead of current position
const BUFFER_BEHIND_SEC = 30  // Keep 30s behind current position
const EVICT_CHECK_MS = 2000   // Check buffer every 2s

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

  const videoRefCallback = useCallback((el: HTMLVideoElement | null) => {
    if (!el || initStarted.current) return
    initStarted.current = true
    videoElRef.current = el

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

    // Progress reporting
    setInterval(() => {
      if (el.duration && !isNaN(el.duration)) {
        onProgress?.({
          currentTime: Math.round(el.currentTime * 1000),
          duration: Math.round(el.duration * 1000),
        })
      }
    }, 500)

    // Start pipeline
    ;(async () => {
      try {
        console.log('[MsePlayer] Init:', videoUrl.substring(0, 100))

        const mb = await import('mediabunny')
        const { Input, Output, Conversion, UrlSource, Mp4OutputFormat, NullTarget } = mb
        const ALL_FORMATS = mb.ALL_FORMATS || [mb.MatroskaInputFormat, mb.Mp4InputFormat].filter(Boolean)

        const source = new UrlSource(videoUrl, {
          maxCacheSize: 256 * 1024 * 1024,
          parallelism: 4,
        })
        const input = new Input({ source, formats: ALL_FORMATS, prefetchProfile: 'network' })

        // Collect fMP4 segments (ftyp+moov init + moof+mdat pairs)
        let initSegment: Uint8Array | null = null
        let lastMoof: Uint8Array | null = null
        const segments: { time: number; data: Uint8Array }[] = []

        const output = new Output({
          target: new NullTarget(),
          format: new Mp4OutputFormat({
            fastStart: 'fragmented',
            onFtyp: (data: Uint8Array) => {
              initSegment = new Uint8Array(data)
            },
            onMoov: (data: Uint8Array) => {
              // Combine ftyp + moov as the init segment
              if (initSegment) {
                const combined = new Uint8Array(initSegment.length + data.length)
                combined.set(initSegment, 0)
                combined.set(data, initSegment.length)
                initSegment = combined
              }
            },
            onMoof: (data: Uint8Array, _pos: number, timestamp: number) => {
              lastMoof = new Uint8Array(data)
              // timestamp is in seconds
            },
            onMdat: (data: Uint8Array) => {
              if (!lastMoof) return
              // Combine moof + mdat as one segment
              const segment = new Uint8Array(lastMoof.length + data.length)
              segment.set(lastMoof, 0)
              segment.set(data, lastMoof.length)
              segments.push({ time: segments.length > 0 ? -1 : 0, data: segment })
              lastMoof = null
            },
          }),
        })

        const conversion = await Conversion.init({ input, output })
        if (!conversion.isValid) {
          onError?.({ message: 'Incompatible tracks' })
          return
        }

        // Create MediaSource
        const ms = new MediaSource()
        el.src = URL.createObjectURL(ms)
        await new Promise<void>(r => { ms.onsourceopen = () => r() })

        // Add SourceBuffer with known MIME
        const mimes = [
          'video/mp4; codecs="hev1.1.6.L150.B0"',
          'video/mp4; codecs="avc1.640032"',
          'video/mp4',
        ]
        let sb: SourceBuffer | null = null
        for (const m of mimes) {
          if (MediaSource.isTypeSupported(m)) {
            try { sb = ms.addSourceBuffer(m); console.log('[MsePlayer] SourceBuffer:', m); break }
            catch {}
          }
        }
        if (!sb) { onError?.({ message: 'No MSE MIME support' }); return }

        // Append helper with queue
        let appendQueue = Promise.resolve()
        const appendBuffer = (data: Uint8Array) => {
          appendQueue = appendQueue.then(() => new Promise<void>(r => {
            try { sb!.appendBuffer(data); sb!.onupdateend = () => r() }
            catch { r() }
          }))
          return appendQueue
        }

        // Start conversion in background — segments accumulate
        let conversionDone = false
        const conversionPromise = (async () => {
          console.log('[MsePlayer] Converting...')
          await conversion.execute()
          conversionDone = true
          console.log('[MsePlayer] Conversion done, segments:', segments.length)
        })()

        // Wait for init segment + first few media segments
        while (!initSegment || segments.length < 2) {
          await new Promise(r => setTimeout(r, 100))
          if (conversionDone && segments.length === 0) {
            onError?.({ message: 'No segments produced' })
            return
          }
        }

        // Append init segment
        await appendBuffer(initSegment)
        console.log('[MsePlayer] Init segment appended')

        // Append first segments to start playback
        let appendedUpTo = 0
        for (let i = 0; i < Math.min(10, segments.length); i++) {
          await appendBuffer(segments[i].data)
          appendedUpTo = i + 1
        }

        el.play().catch(() => {})
        onLoad?.({ duration: 0, durationMs: 0 })

        // Streaming loop: append new segments as they arrive,
        // evict old buffered data to stay within memory limits
        const streamLoop = async () => {
          while (true) {
            await new Promise(r => setTimeout(r, 500))

            // Append new segments
            while (appendedUpTo < segments.length) {
              await appendBuffer(segments[appendedUpTo].data)
              appendedUpTo++
            }

            // Evict old buffer behind playback position
            if (sb && !sb.updating && el.currentTime > BUFFER_BEHIND_SEC) {
              const evictEnd = el.currentTime - BUFFER_BEHIND_SEC
              try {
                if (sb.buffered.length > 0 && sb.buffered.start(0) < evictEnd) {
                  sb.remove(0, evictEnd)
                  await new Promise<void>(r => { sb!.onupdateend = () => r() })
                }
              } catch {}
            }

            // Update duration
            if (el.duration && isFinite(el.duration) && el.duration > 0) {
              onLoad?.({ duration: el.duration, durationMs: Math.round(el.duration * 1000) })
            }

            // Check if done
            if (conversionDone && appendedUpTo >= segments.length) {
              // All segments appended
              await appendQueue
              if (sb?.updating) {
                await new Promise<void>(r => { sb!.onupdateend = () => r() })
              }
              if (ms.readyState === 'open') {
                try { ms.endOfStream() } catch {}
              }
              if (el.duration && isFinite(el.duration)) {
                console.log('[MsePlayer] Final duration:', el.duration)
                onLoad?.({ duration: el.duration, durationMs: Math.round(el.duration * 1000) })
              }
              break
            }
          }
        }

        await Promise.all([conversionPromise, streamLoop()])
        console.log('[MsePlayer] Complete')
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
