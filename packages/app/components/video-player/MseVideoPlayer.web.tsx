/* eslint-disable no-empty, jsx-a11y/media-has-caption */
/**
 * MseVideoPlayer — seek-aware streaming MSE player.
 *
 * Remuxes (MKV→fMP4) ON DEMAND using mediabunny's random-access packet API
 * instead of a single linear Conversion. Seeking looks up the keyframe before
 * the target through the container index (fetched via HTTP range requests
 * against the local P2P blob server) and starts a fresh remux pipeline from
 * there — so seeking into an uncached region of a streamed file only
 * downloads bytes around the seek target instead of everything before it.
 *
 * Fragments carry absolute timestamps (fMP4 tfdt), so they land at the right
 * place on the MSE timeline without timestampOffset bookkeeping. Only a
 * sliding window is kept buffered (~60s ahead / ~30s behind) to stay within
 * WebKit's SourceBuffer memory quota.
 */

import { memo, useCallback, useRef } from 'react'

const BUFFER_AHEAD_SEC = 60   // Remux/buffer this far ahead of playback
const BUFFER_BEHIND_SEC = 30  // Keep this much behind playback
const POLL_MS = 250           // Pump idle poll interval
const MAX_PENDING_SEGMENTS = 64 // Hard cap on segments awaiting append

interface Segment {
  time: number       // Fragment start timestamp in seconds (absolute)
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const combined = new Uint8Array(a.length + b.length)
  combined.set(a, 0)
  combined.set(b, a.length)
  return combined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  const disposeRef = useRef<(() => void) | null>(null)

  const videoRefCallback = useCallback((el: HTMLVideoElement | null) => {
    if (!el) {
      disposeRef.current?.()
      disposeRef.current = null
      return
    }
    if (initStarted.current) return
    initStarted.current = true
    videoElRef.current = el

    if (playerRef) {
      playerRef.current = createWebMsePlayerPort(el)
    }

    // Progress reporting
    const progressTimer = setInterval(() => {
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
        const {
          Input,
          Output,
          UrlSource,
          Mp4OutputFormat,
          NullTarget,
          EncodedPacketSink,
          EncodedVideoPacketSource,
          EncodedAudioPacketSource,
        } = mb
        const ALL_FORMATS = mb.ALL_FORMATS || [mb.MatroskaInputFormat, mb.Mp4InputFormat].filter(Boolean)

        const source = new UrlSource(videoUrl, {
          maxCacheSize: 256 * 1024 * 1024,
          parallelism: 4,
        })
        const input = new Input({ source, formats: ALL_FORMATS, prefetchProfile: 'network' })

        const videoTrack = await input.getPrimaryVideoTrack()
        if (!videoTrack) {
          onError?.({ message: 'No video track' })
          return
        }
        const videoCodec = await videoTrack.getCodec()
        const videoDecoderConfig = videoCodec ? await videoTrack.getDecoderConfig() : null
        const mp4Codecs = new Mp4OutputFormat({ fastStart: 'fragmented' }).getSupportedCodecs()
        if (!videoCodec || !videoDecoderConfig || !mp4Codecs.includes(videoCodec)) {
          onError?.({ message: `Unsupported video codec: ${videoCodec || 'unknown'}` })
          return
        }

        const audioTrack = await input.getPrimaryAudioTrack()
        const audioCodec = audioTrack ? await audioTrack.getCodec() : null
        const audioDecoderConfig = audioTrack && audioCodec ? await audioTrack.getDecoderConfig() : null
        const audioUsable = Boolean(audioCodec && audioDecoderConfig && mp4Codecs.includes(audioCodec))

        // Build the SourceBuffer MIME from the precise codec strings, falling
        // back to the legacy hardcoded candidates.
        const videoCodecString = await videoTrack.getCodecParameterString()
        const audioCodecString = audioUsable ? await audioTrack!.getCodecParameterString() : null
        const mimeCandidates: Array<{ mime: string; withAudio: boolean }> = []
        if (videoCodecString) {
          if (audioCodecString) {
            mimeCandidates.push({ mime: `video/mp4; codecs="${videoCodecString}, ${audioCodecString}"`, withAudio: true })
          }
          mimeCandidates.push({ mime: `video/mp4; codecs="${videoCodecString}"`, withAudio: false })
        }
        for (const legacy of ['video/mp4; codecs="hev1.1.6.L150.B0"', 'video/mp4; codecs="avc1.640032"', 'video/mp4']) {
          mimeCandidates.push({ mime: legacy, withAudio: audioUsable })
        }

        // Create MediaSource
        const ms = new MediaSource()
        el.src = URL.createObjectURL(ms)
        await new Promise<void>(r => { ms.onsourceopen = () => r() })

        let sb: SourceBuffer | null = null
        let includeAudio = false
        for (const candidate of mimeCandidates) {
          if (MediaSource.isTypeSupported(candidate.mime)) {
            try {
              sb = ms.addSourceBuffer(candidate.mime)
              includeAudio = candidate.withAudio
              break
            } catch {}
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
                sb!.remove(0, Math.max(0, el.currentTime - 1))
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

        const isBuffered = (time: number) => {
          for (let i = 0; i < sb!.buffered.length; i++) {
            if (time >= sb!.buffered.start(i) && time <= sb!.buffered.end(i)) return true
          }
          return false
        }

        // Real duration is known up front from the container index — report it
        // and size the MediaSource so the whole timeline is seekable
        // immediately (the old linear conversion only grew the seekable range
        // as it progressed through the file).
        const duration = await input.computeDuration()
        if (duration > 0) {
          await waitForUpdate()
          try { ms.duration = duration } catch {}
          onLoad?.({ duration, durationMs: Math.round(duration * 1000) })
        }

        const videoSink = new EncodedPacketSink(videoTrack)
        const audioSink = includeAudio && audioTrack ? new EncodedPacketSink(audioTrack) : null

        // --- On-demand remux pipeline ---
        let generation = 0
        let activeOutput: any = null
        let playbackStarted = false
        let disposed = false

        disposeRef.current = () => {
          disposed = true
          generation++
          clearInterval(progressTimer)
          try { activeOutput?.cancel?.()?.catch?.(() => {}) } catch {}
          activeOutput = null
          try { (input as any).dispose?.() } catch {}
        }

        /**
         * Remux from the keyframe at/before `fromTime` and feed fragments into
         * the SourceBuffer until end of file, a newer generation supersedes
         * this one, or the component is disposed. Stays ~BUFFER_AHEAD_SEC
         * ahead of playback and evicts ~BUFFER_BEHIND_SEC behind it.
         */
        const runPipeline = async (fromTime: number, gen: number) => {
          const stale = () => disposed || gen !== generation

          let startPacket = await videoSink.getKeyPacket(Math.max(0, fromTime), { verifyKeyPackets: true })
          if (!startPacket) startPacket = await videoSink.getFirstKeyPacket({ verifyKeyPackets: true })
          if (!startPacket || stale()) return
          const startTime = startPacket.timestamp

          const pending: Segment[] = []
          let ftyp: Uint8Array | null = null
          let initSegment: Uint8Array | null = null
          let initAppended = false
          let lastMoof: { data: Uint8Array; time: number } | null = null

          const output = new Output({
            target: new NullTarget(),
            format: new Mp4OutputFormat({
              fastStart: 'fragmented',
              onFtyp: (data: Uint8Array) => { ftyp = new Uint8Array(data) },
              onMoov: (data: Uint8Array) => {
                initSegment = ftyp ? concatBytes(ftyp, new Uint8Array(data)) : new Uint8Array(data)
              },
              onMoof: (data: Uint8Array, _pos: number, timestamp: number) => {
                lastMoof = { data: new Uint8Array(data), time: timestamp }
              },
              onMdat: (data: Uint8Array) => {
                if (!lastMoof) return
                pending.push({ time: lastMoof.time, data: concatBytes(lastMoof.data, new Uint8Array(data)) })
                lastMoof = null
              },
            }),
          })
          const videoOut = new EncodedVideoPacketSource(videoCodec)
          output.addVideoTrack(videoOut)
          let audioOut: any = null
          if (audioSink && audioCodec) {
            audioOut = new EncodedAudioPacketSource(audioCodec)
            output.addAudioTrack(audioOut)
          }
          await output.start()
          if (stale()) { output.cancel().catch(() => {}); return }
          activeOutput = output

          /** Append the init segment (once ready) and any finalized fragments */
          const drain = async (): Promise<boolean> => {
            while (pending.length > 0) {
              if (stale()) return false
              if (!initAppended) {
                if (!initSegment) return true // moov not written yet, fragments can't precede it for long
                if (!(await safeAppend(initSegment))) return false
                if (stale()) return false
                initAppended = true
              }
              const segment = pending.shift()!
              if (!(await safeAppend(segment.data))) return false
              if (stale()) return false
              if (!playbackStarted) {
                playbackStarted = true
                el.play().catch(() => {})
              }
            }
            return true
          }

          // Pump packets in timestamp order across tracks
          const videoIter: AsyncGenerator<any, void, unknown> = videoSink.packets(startPacket, undefined, { verifyKeyPackets: true })
          let nextVideo: IteratorResult<any> = await videoIter.next()
          let audioIter: AsyncGenerator<any, void, unknown> | null = null
          let nextAudio: IteratorResult<any> | null = null
          if (audioSink) {
            const audioStart = (await audioSink.getPacket(startTime)) ?? (await audioSink.getFirstPacket())
            if (audioStart) {
              audioIter = audioSink.packets(audioStart)
              nextAudio = await audioIter.next()
            }
          }

          let firstVideo = true
          let firstAudio = true
          try {
            while (!stale()) {
              if (!(await drain())) break

              const videoDone = nextVideo.done === true
              const audioDone = !nextAudio || nextAudio.done === true
              if (videoDone && audioDone) {
                await output.finalize() // flushes the trailing fragment via callbacks
                if (activeOutput === output) activeOutput = null
                await drain()
                if (!stale()) {
                  await waitForUpdate()
                  if (ms.readyState === 'open') {
                    try { ms.endOfStream() } catch {}
                  }
                }
                return
              }

              // Throttle: stay BUFFER_AHEAD_SEC ahead of the playhead, evict behind
              const headTimestamp = Math.min(
                videoDone ? Infinity : nextVideo.value.timestamp,
                audioDone ? Infinity : nextAudio!.value.timestamp
              )
              if (
                pending.length > MAX_PENDING_SEGMENTS ||
                (headTimestamp > el.currentTime + BUFFER_AHEAD_SEC && isBuffered(el.currentTime))
              ) {
                const evictEnd = el.currentTime - BUFFER_BEHIND_SEC
                if (sb!.buffered.length > 0 && sb!.buffered.start(0) < evictEnd) {
                  await removeRange(sb!.buffered.start(0), evictEnd)
                }
                await sleep(POLL_MS)
                continue
              }

              // Feed whichever track is furthest behind
              if (audioDone || (!videoDone && nextVideo.value.timestamp <= nextAudio!.value.timestamp)) {
                await videoOut.add(nextVideo.value, firstVideo ? { decoderConfig: videoDecoderConfig } : undefined)
                firstVideo = false
                nextVideo = await videoIter.next()
              } else {
                await audioOut.add(nextAudio!.value, firstAudio ? { decoderConfig: audioDecoderConfig } : undefined)
                firstAudio = false
                nextAudio = await audioIter!.next()
              }
            }
          } catch (err: any) {
            if (!stale()) {
              console.warn('[MsePlayer] Pipeline error:', err?.message)
              onError?.({ message: err?.message || 'Remux pipeline error' })
            }
          } finally {
            if (activeOutput === output) activeOutput = null
            if (output.state === 'pending' || output.state === 'started') {
              output.cancel().catch(() => {})
            }
            try { videoIter.return?.(undefined) } catch {}
            try { audioIter?.return?.(undefined) } catch {}
          }
        }

        // --- Seek handler: restart the pipeline from the seek target ---
        el.onseeking = () => {
          const target = el.currentTime
          if (isBuffered(target)) return // Data already present, the element recovers on its own

          generation++
          const gen = generation
          const oldOutput = activeOutput
          activeOutput = null
          try { oldOutput?.cancel?.()?.catch?.(() => {}) } catch {}

          ;(async () => {
            try {
              if (sb!.updating) {
                try { sb!.abort() } catch {}
              }
              await removeRange(0, Infinity)
              if (gen !== generation) return
              await runPipeline(Math.max(0, target - 0.5), gen)
            } catch (err: any) {
              console.warn('[MsePlayer] Seek error:', err?.message)
            }
          })()
        }

        await runPipeline(0, generation)
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
