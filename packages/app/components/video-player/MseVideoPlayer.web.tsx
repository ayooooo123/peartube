/* eslint-disable no-empty, no-constant-condition, jsx-a11y/media-has-caption */
/**
 * MseVideoPlayer — streaming MSE player with sliding buffer window.
 *
 * Uses mediabunny to remux MKV→fMP4 and feeds segments to MSE SourceBuffer.
 * Only keeps a window of data buffered around the playback position:
 *   - ~60s ahead of current position
 *   - ~30s behind current position
 * Removes old segments to stay within WebKit's SourceBuffer memory quota (~200MB).
 * Supports seeking by clearing the buffer and re-appending from the target position.
 */

import { memo, useCallback, useRef } from 'react'

const BUFFER_AHEAD_SEC = 60   // Buffer 60s ahead of current position
const BUFFER_BEHIND_SEC = 30  // Keep 30s behind current position
const POLL_MS = 500           // Main loop poll interval

interface Segment {
  time: number       // Timestamp in seconds from mediabunny onMoof
  data: Uint8Array   // moof+mdat combined
}

import { createWebMsePlayerPort, type PlayerPort } from '@/lib/video-player'

type MseVideoPlayerProps = {
  videoUrl: string
  style?: any
  isPlaying: boolean
  playbackRate?: number
  onProgress?: (data: { currentTime: number; duration: number }) => void
  onLoad?: (data?: any) => void
  onPlaying?: () => void
  onPaused?: () => void
  onEnded?: () => void
  onError?: (error: any) => void
  playerRef?: React.RefObject<PlayerPort | null>
}

/** Binary search for the segment whose time is <= target */
function findSegmentIndex(segments: Segment[], target: number): number {
  let lo = 0
  let hi = segments.length - 1
  let result = 0
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (segments[mid].time <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
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
      playerRef.current = createWebMsePlayerPort(el)
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
        let moofTimestamp = 0
        let lastMoof: Uint8Array | null = null
        const segments: Segment[] = []

        const output = new Output({
          target: new NullTarget(),
          format: new Mp4OutputFormat({
            fastStart: 'fragmented',
            onFtyp: (data: Uint8Array) => {
              initSegment = new Uint8Array(data)
            },
            onMoov: (data: Uint8Array) => {
              if (initSegment) {
                const combined = new Uint8Array(initSegment.length + data.length)
                combined.set(initSegment, 0)
                combined.set(data, initSegment.length)
                initSegment = combined
              }
            },
            onMoof: (data: Uint8Array, _pos: number, timestamp: number) => {
              lastMoof = new Uint8Array(data)
              moofTimestamp = timestamp // seconds from mediabunny
            },
            onMdat: (data: Uint8Array) => {
              if (!lastMoof) return
              const segment = new Uint8Array(lastMoof.length + data.length)
              segment.set(lastMoof, 0)
              segment.set(data, lastMoof.length)
              segments.push({ time: moofTimestamp, data: segment })
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

        // Add SourceBuffer
        const mimes = [
          'video/mp4; codecs="hev1.1.6.L150.B0"',
          'video/mp4; codecs="avc1.640032"',
          'video/mp4',
        ]
        let sb: SourceBuffer | null = null
        for (const m of mimes) {
          if (MediaSource.isTypeSupported(m)) {
            try { sb = ms.addSourceBuffer(m); break }
            catch {}
          }
        }
        if (!sb) { onError?.({ message: 'No MSE MIME support' }); return }

        // --- SourceBuffer append/remove helpers ---

        /** Wait for sb.updating to become false */
        const waitForUpdate = () => new Promise<void>(resolve => {
          if (!sb!.updating) { resolve(); return }
          sb!.addEventListener('updateend', () => resolve(), { once: true })
        })

        /** Safely append data, handling QuotaExceededError by evicting */
        const safeAppend = async (data: Uint8Array): Promise<boolean> => {
          try {
            await waitForUpdate()
            sb!.appendBuffer(data)
            await waitForUpdate()
            return true
          } catch (err: any) {
            if (err.name === 'QuotaExceededError') {
              // Evict everything before current position and retry
              console.warn('[MsePlayer] QuotaExceeded, evicting')
              try {
                await waitForUpdate()
                sb!.remove(0, el.currentTime)
                await waitForUpdate()
                sb!.appendBuffer(data)
                await waitForUpdate()
                return true
              } catch {
                return false
              }
            }
            return false
          }
        }

        /** Remove buffered range */
        const removeRange = async (start: number, end: number) => {
          try {
            await waitForUpdate()
            if (sb!.buffered.length > 0) {
              sb!.remove(start, end)
              await waitForUpdate()
            }
          } catch {}
        }

        // --- Conversion runs in background ---
        let conversionDone = false
        const conversionPromise = (async () => {
          await conversion.execute()
          conversionDone = true
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
        await safeAppend(initSegment)

        // --- State for sliding window ---
        // Track which segments are currently in the SourceBuffer
        let windowStart = 0  // Index of first segment currently appended
        let windowEnd = 0    // Index past last segment appended (exclusive)
        let seekGeneration = 0  // Increments on seek to abort stale appends

        /** Append segments from `from` to cover up to `targetTime` seconds ahead */
        const fillWindow = async (from: number, targetTime: number, gen: number): Promise<number> => {
          let idx = from
          while (idx < segments.length && segments[idx].time < targetTime) {
            if (gen !== seekGeneration) return idx // Abort if seek happened
            const ok = await safeAppend(segments[idx].data)
            if (!ok) break // Quota still exceeded, stop
            idx++
          }
          return idx
        }

        // Append initial batch — enough to start playback
        const initialEnd = Math.min(segments.length, 10)
        for (let i = 0; i < initialEnd; i++) {
          await safeAppend(segments[i].data)
        }
        windowStart = 0
        windowEnd = initialEnd

        el.play().catch(() => {})
        onLoad?.({ duration: 0, durationMs: 0 })

        // --- Seek handler ---
        let seekPending = false

        el.onseeking = async () => {
          const target = el.currentTime

          // Check if target is within the currently buffered range
          if (sb!.buffered.length > 0) {
            for (let i = 0; i < sb!.buffered.length; i++) {
              if (target >= sb!.buffered.start(i) && target <= sb!.buffered.end(i)) {
                return // Already buffered, nothing to do
              }
            }
          }

          // Target is outside buffered range — need to clear and re-fill
          seekPending = true
          const gen = ++seekGeneration

          try {
            // Abort any pending operation
            if (sb!.updating) {
              sb!.abort()
            }

            // Clear entire SourceBuffer
            await removeRange(0, Infinity)

            // Re-append init segment
            await safeAppend(initSegment!)

            // Find segment closest to seek target
            const startIdx = findSegmentIndex(segments, Math.max(0, target - 1))
            const endTime = target + BUFFER_AHEAD_SEC

            windowStart = startIdx
            windowEnd = await fillWindow(startIdx, endTime, gen)
          } catch (err: any) {
            console.warn('[MsePlayer] Seek error:', err?.message)
          }

          seekPending = false
        }

        // --- Main streaming loop ---
        const streamLoop = async () => {
          while (true) {
            await new Promise(r => setTimeout(r, POLL_MS))

            // Skip if a seek is in progress
            if (seekPending) continue

            const currentGen = seekGeneration
            const now = el.currentTime

            // 1. Evict old buffer behind playback
            if (now > BUFFER_BEHIND_SEC && sb!.buffered.length > 0) {
              const evictEnd = now - BUFFER_BEHIND_SEC
              if (sb!.buffered.start(0) < evictEnd) {
                await removeRange(sb!.buffered.start(0), evictEnd)
                // Update windowStart to reflect evicted segments
                while (windowStart < windowEnd && segments[windowStart].time < evictEnd) {
                  windowStart++
                }
              }
            }

            // 2. Append ahead of playback (only within window)
            if (currentGen === seekGeneration) {
              const targetTime = now + BUFFER_AHEAD_SEC
              if (windowEnd < segments.length && segments[windowEnd].time < targetTime) {
                windowEnd = await fillWindow(windowEnd, targetTime, currentGen)
              }
            }

            // 3. Report duration if available
            if (el.duration && isFinite(el.duration) && el.duration > 0) {
              onLoad?.({ duration: el.duration, durationMs: Math.round(el.duration * 1000) })
            }

            // 4. Set MediaSource duration once conversion is done
            if (conversionDone && ms.readyState === 'open' && segments.length > 0) {
              const lastSeg = segments[segments.length - 1]
              // Estimate: last segment time + typical segment duration
              const estDuration = lastSeg.time + (segments.length > 1
                ? lastSeg.time - segments[segments.length - 2].time
                : 4)
              try {
                await waitForUpdate()
                ms.duration = estDuration
              } catch {}
              onLoad?.({ duration: estDuration, durationMs: Math.round(estDuration * 1000) })
            }

            // 5. End of stream when all segments have been seen
            // (but only if playback is near the end — don't end prematurely)
            if (conversionDone && windowEnd >= segments.length) {
              const lastSegTime = segments[segments.length - 1]?.time ?? 0
              if (now >= lastSegTime - 10) {
                await waitForUpdate()
                if (ms.readyState === 'open') {
                  try { ms.endOfStream() } catch {}
                }
                break
              }
            }
          }
        }

        await Promise.all([conversionPromise, streamLoop()])
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
