/* eslint-disable no-empty, jsx-a11y/media-has-caption */
/**
 * WebMseVideoBackend — seek-aware streaming MSE backend for PearInlineVideoView.
 *
 * Two fragment sources feed the same MediaSource/SourceBuffer contract
 * (init segment, then moof/mdat fragments carrying absolute timestamps):
 *
 * 1. mediabunny remux (the ~90% path): repackages MKV/MP4 into fMP4 ON
 *    DEMAND using mediabunny's random-access packet API, stream-copying
 *    packets — no transcode. Seeking looks up the keyframe before the target
 *    through the container index (fetched via HTTP range requests against the
 *    local P2P blob server) and starts a fresh remux pipeline from there.
 *
 * 2. bare-ffmpeg compat fallback: when the webview can't decode a track
 *    (AC-3/E-AC-3/DTS audio, or a codec mediabunny can't repackage), the
 *    renderer asks the backend (via webPreparePlayback) for a compat
 *    transcode — video stream-copy + audio→AAC — and pulls the resulting
 *    fMP4 fragments from the local HTTP server (an fMP4 HLS playlist on
 *    127.0.0.1). Selection is driven by MediaSource.isTypeSupported, not a
 *    hardcoded codec matrix.
 *
 * Only a sliding window is kept buffered (~60s ahead / ~30s behind) to stay
 * within WebKit's SourceBuffer memory quota.
 */

import { memo, useCallback, useEffect, useRef } from 'react'

import {
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  resolveAgainstPlaylist,
  findSegmentIndexForTime,
  buildCompatMimeCandidates,
} from '@/lib/hls-fragment-source.mjs'
import { createWebMsePlayerPort, type PlayerPort } from '@/lib/video-player'
import type { CompatPlaybackResult, WebMseVideoBackendProps } from './WebMseVideoBackend.types'

type ParsedMediaPlaylist = {
  initUri: string | null
  segments: Array<{ uri: string; duration: number; start: number }>
  ended: boolean
  mediaSequence: number
  targetDuration: number
}

const BUFFER_AHEAD_SEC = 60   // Remux/buffer this far ahead of playback
const BUFFER_BEHIND_SEC = 30  // Keep this much behind playback
const POLL_MS = 250           // Pump idle poll interval
const MAX_PENDING_SEGMENTS = 64 // Hard cap on segments awaiting append
const PLAYLIST_POLL_MS = 1000   // Compat path: live playlist refresh interval
const PLAYLIST_READY_TIMEOUT_MS = 30000 // Compat path: max wait for first segment
const MSE_AUTOPLAY_RETRY_MAX_ATTEMPTS = 5
const MSE_AUTOPLAY_RETRY_BASE_DELAY_MS = 150

interface Segment {
  time: number       // Fragment start timestamp in seconds (absolute)
  data: Uint8Array   // moof+mdat combined
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const combined = new Uint8Array(a.length + b.length)
  combined.set(a, 0)
  combined.set(b, a.length)
  return combined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type WebMseBackendController = {
  play(): Promise<void>
  pause(): void
  stop(): void
  seek(timeSeconds: number): void
  seekBy(seconds: number): void
  replace(sourceUrl: string | null): void
  setPlaybackRate(rate: number): void
  destroy(): void
  get currentTime(): number
  set currentTime(value: number)
}

function createWebMseBackendController(el: HTMLVideoElement): WebMseBackendController {
  const setSource = (sourceUrl: string | null) => {
    el.pause()
    if (sourceUrl) {
      el.setAttribute('src', sourceUrl)
    } else {
      el.removeAttribute('src')
    }
    el.load()
  }

  return {
    play: () => el.play(),
    pause: () => { el.pause() },
    stop: () => {
      el.pause()
      el.currentTime = 0
    },
    seek: (timeSeconds: number) => {
      el.currentTime = Math.max(0, timeSeconds)
    },
    seekBy: (seconds: number) => {
      el.currentTime = Math.max(0, el.currentTime + seconds)
    },
    replace: setSource,
    setPlaybackRate: (rate: number) => { el.playbackRate = rate },
    destroy: () => { setSource(null) },
    get currentTime(): number {
      return el.currentTime
    },
    set currentTime(value: number) {
      el.currentTime = Math.max(0, value)
    },
  }
}

/** Shared SourceBuffer append/remove helpers used by both fragment sources. */
function createSourceBufferOps(sb: SourceBuffer, el: HTMLVideoElement) {
  /** Wait for sb.updating to become false */
  const waitForUpdate = () => new Promise<void>(resolve => {
    if (!sb.updating) { resolve(); return }
    sb.addEventListener('updateend', () => resolve(), { once: true })
  })

  /** Safely append data, handling QuotaExceededError by evicting */
  const safeAppend = async (data: Uint8Array): Promise<boolean> => {
    try {
      await waitForUpdate()
      sb.appendBuffer(data as BufferSource)
      await waitForUpdate()
      return true
    } catch (err: any) {
      if (err.name === 'QuotaExceededError') {
        // Evict everything before current position and retry
        console.warn('[WebMseBackend] QuotaExceeded, evicting')
        try {
          await waitForUpdate()
          sb.remove(0, Math.max(0, el.currentTime - 1))
          await waitForUpdate()
          sb.appendBuffer(data as BufferSource)
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
      if (sb.buffered.length > 0) {
        sb.remove(start, end)
        await waitForUpdate()
      }
    } catch {}
  }

  const isBuffered = (time: number) => {
    for (let i = 0; i < sb.buffered.length; i++) {
      if (time >= sb.buffered.start(i) && time <= sb.buffered.end(i)) return true
    }
    return false
  }

  return { waitForUpdate, safeAppend, removeRange, isBuffered }
}

/**
 * Compat fragment source: pull fMP4 fragments produced by the backend
 * bare-ffmpeg transcoder from its local HTTP server and append them to a
 * fresh SourceBuffer. The playlist is live (EVENT) while the transcode runs;
 * production is paced near realtime, so far-forward seeks wait for the
 * transcoder to catch up.
 */
async function runCompatHlsPipeline(opts: {
  el: HTMLVideoElement
  hlsUrl: string
  videoCodecString: string | null
  durationHint: number
  onLoad?: (data?: any) => void
  onError?: (error: any) => void
  setDispose: (fn: () => void) => void
  shouldAutoPlay?: () => boolean
  requestAutoplay?: () => void
}): Promise<void> {
  const { el, hlsUrl, videoCodecString, durationHint, onLoad, onError, setDispose, shouldAutoPlay, requestAutoplay } = opts

  const ctl = { disposed: false, generation: 0 }
  const stale = (gen: number) => ctl.disposed || gen !== ctl.generation
  let removeSeekingListener: (() => void) | null = null
  setDispose(() => {
    ctl.disposed = true
    ctl.generation++
    removeSeekingListener?.()
    removeSeekingListener = null
  })

  const fetchText = async (url: string): Promise<string | null> => {
    const res = await fetch(url, { cache: 'no-store' })
    if (res.status === 503) return null // manifest not ready yet
    if (!res.ok) throw new Error(`Compat playlist HTTP ${res.status}`)
    return res.text()
  }
  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Compat segment HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  // Resolve master → media playlist (the server serves both).
  let mediaPlaylistUrl = hlsUrl
  const firstText = await fetchText(hlsUrl)
  if (firstText && isMasterPlaylist(firstText)) {
    const variant = parseMasterPlaylist(firstText)
    mediaPlaylistUrl = resolveAgainstPlaylist(hlsUrl, variant) || hlsUrl
  }

  let playlist: ParsedMediaPlaylist | null = null
  const refreshPlaylist = async (): Promise<ParsedMediaPlaylist | null> => {
    const text = await fetchText(mediaPlaylistUrl)
    if (text == null) return playlist
    const parsed = parseMediaPlaylist(text) as ParsedMediaPlaylist
    if (parsed.segments.length > 0 || parsed.ended) playlist = parsed
    return playlist
  }

  // Wait for the first segment (transcode startup).
  const readyDeadline = Date.now() + PLAYLIST_READY_TIMEOUT_MS
  while (!ctl.disposed) {
    const nextPlaylist = await refreshPlaylist()
    if (nextPlaylist && nextPlaylist.segments.length > 0) {
      playlist = nextPlaylist
      break
    }
    if (nextPlaylist?.ended || Date.now() > readyDeadline) {
      onError?.({ message: 'Compat transcode produced no playable segments' })
      return
    }
    await sleep(PLAYLIST_POLL_MS)
  }
  if (ctl.disposed || !playlist) return

  const ms = new MediaSource()
  el.src = URL.createObjectURL(ms)
  await new Promise<void>(r => { ms.onsourceopen = () => r() })
  if (ctl.disposed) return

  let sb: SourceBuffer | null = null
  for (const mime of buildCompatMimeCandidates(videoCodecString)) {
    if (MediaSource.isTypeSupported(mime)) {
      try {
        sb = ms.addSourceBuffer(mime)
        break
      } catch {}
    }
  }
  if (!sb) { onError?.({ message: 'No MSE MIME support for compat stream' }); return }

  const ops = createSourceBufferOps(sb, el)

  if (durationHint > 0) {
    await ops.waitForUpdate()
    try { ms.duration = durationHint } catch {}
    onLoad?.({ duration: durationHint, durationMs: Math.round(durationHint * 1000) })
  }

  let playbackStarted = false

  const pump = async (startIndex: number, gen: number) => {
    const initUri = resolveAgainstPlaylist(mediaPlaylistUrl, playlist!.initUri || 'init.mp4')
    if (!initUri) { onError?.({ message: 'Compat stream missing init segment' }); return }
    const initData = await fetchBytes(initUri)
    if (stale(gen)) return
    if (!(await ops.safeAppend(initData))) return

    let index = startIndex
    while (!stale(gen)) {
      if (index >= playlist!.segments.length) {
        if (playlist!.ended) {
          await ops.waitForUpdate()
          if (ms.readyState === 'open') {
            try { ms.endOfStream() } catch {}
          }
          return
        }
        await sleep(PLAYLIST_POLL_MS)
        await refreshPlaylist()
        continue
      }

      // Throttle: stay BUFFER_AHEAD_SEC ahead of the playhead, evict behind
      const seg = playlist!.segments[index]
      if (seg.start > el.currentTime + BUFFER_AHEAD_SEC && ops.isBuffered(el.currentTime)) {
        const evictEnd = el.currentTime - BUFFER_BEHIND_SEC
        if (sb!.buffered.length > 0 && sb!.buffered.start(0) < evictEnd) {
          await ops.removeRange(sb!.buffered.start(0), evictEnd)
        }
        await sleep(POLL_MS)
        continue
      }

      const data = await fetchBytes(resolveAgainstPlaylist(mediaPlaylistUrl, seg.uri)!)
      if (stale(gen)) return
      if (!(await ops.safeAppend(data))) return
      if (!playbackStarted) {
        playbackStarted = true
        if (shouldAutoPlay?.() ?? true) {
          requestAutoplay?.()
        }
      }
      index++
    }
  }

  // Seek: jump to the covering segment if produced, else wait for the
  // transcoder to reach it (production is paced near realtime).
  const handleSeeking = () => {
    const target = el.currentTime
    if (ops.isBuffered(target)) return

    ctl.generation++
    const gen = ctl.generation
    ;(async () => {
      try {
        if (sb!.updating) {
          try { sb!.abort() } catch {}
        }
        await ops.removeRange(0, Infinity)
        if (stale(gen)) return
        let idx = findSegmentIndexForTime(playlist!.segments, target)
        while (idx === -1 && !playlist!.ended && !stale(gen)) {
          await sleep(PLAYLIST_POLL_MS)
          await refreshPlaylist()
          idx = findSegmentIndexForTime(playlist!.segments, target)
        }
        if (stale(gen)) return
        if (idx === -1) idx = Math.max(0, playlist!.segments.length - 1)
        await pump(idx, gen)
      } catch (err: any) {
          console.warn('[WebMseBackend] Compat seek error:', err?.message)
      }
    })()
  }
  el.addEventListener('seeking', handleSeeking)
  removeSeekingListener = () => el.removeEventListener('seeking', handleSeeking)

  try {
    await pump(0, ctl.generation)
  } catch (err: any) {
    if (!ctl.disposed) {
      console.warn('[WebMseBackend] Compat pipeline error:', err?.message)
      onError?.({ message: err?.message || 'Compat stream error' })
    }
  }
}

export const WebMseVideoBackend = memo(function WebMseVideoBackend({
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
  requestCompatPlayback,
}: WebMseVideoBackendProps) {
  const initStarted = useRef(false)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  const mseBackendPortRef = useRef<PlayerPort | null>(null)
  const mseBackendControllerRef = useRef<WebMseBackendController | null>(null)
  const mseAutoplayRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestDesiredPlaybackRef = useRef<(attempt?: number) => void>(() => {})
  const callbacksRef = useRef({
    onLoad,
    onProgress,
    onPlaying,
    onPaused,
    onEnded,
    onError,
    requestCompatPlayback,
  })
  const isPlayingRef = useRef(isPlaying)
  callbacksRef.current = {
    onLoad,
    onProgress,
    onPlaying,
    onPaused,
    onEnded,
    onError,
    requestCompatPlayback,
  }
  isPlayingRef.current = isPlaying

  const clearMseAutoplayRetry = useCallback(() => {
    if (mseAutoplayRetryTimerRef.current) {
      clearTimeout(mseAutoplayRetryTimerRef.current)
      mseAutoplayRetryTimerRef.current = null
    }
  }, [])

  const scheduleMseAutoplayRetry = useCallback((attempt: number = 0) => {
    clearMseAutoplayRetry()
    if (attempt >= MSE_AUTOPLAY_RETRY_MAX_ATTEMPTS) return
    mseAutoplayRetryTimerRef.current = setTimeout(() => {
      mseAutoplayRetryTimerRef.current = null
      if (!isPlayingRef.current) return
      requestDesiredPlaybackRef.current(attempt)
    }, MSE_AUTOPLAY_RETRY_BASE_DELAY_MS * 2 ** attempt)
  }, [clearMseAutoplayRetry])

  const requestDesiredPlayback = useCallback((attempt: number = 0) => {
    const controller = mseBackendControllerRef.current
    if (!controller || !isPlayingRef.current) return
    controller.play().catch(() => {
      scheduleMseAutoplayRetry(attempt + 1)
    })
  }, [scheduleMseAutoplayRetry])

  useEffect(() => {
    requestDesiredPlaybackRef.current = requestDesiredPlayback
  }, [requestDesiredPlayback])

  useEffect(() => {
    const controller = mseBackendControllerRef.current
    if (!controller) return
    if (isPlaying) {
      requestDesiredPlayback()
    } else {
      clearMseAutoplayRetry()
      controller.pause()
    }
  }, [clearMseAutoplayRetry, isPlaying, requestDesiredPlayback])

  useEffect(() => () => {
    clearMseAutoplayRetry()
  }, [clearMseAutoplayRetry])

  const videoRefCallback = useCallback((el: HTMLVideoElement | null) => {
    if (!el) {
      disposeRef.current?.()
      disposeRef.current = null
      clearMseAutoplayRetry()
      initStarted.current = false
      videoElRef.current = null
      mseBackendControllerRef.current = null
      if (playerRef?.current === mseBackendPortRef.current) {
        playerRef.current = null
      }
      mseBackendPortRef.current = null
      return
    }
    if (initStarted.current) return
    initStarted.current = true
    videoElRef.current = el
    const controller = createWebMseBackendController(el)
    mseBackendControllerRef.current = controller

    if (playerRef) {
      const port = createWebMsePlayerPort(controller)
      mseBackendPortRef.current = port
      playerRef.current = port
    }

    // Progress reporting
    const progressTimer = setInterval(() => {
      if (el.duration && !isNaN(el.duration)) {
        callbacksRef.current.onProgress?.({
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
        const input = new Input({ source, formats: ALL_FORMATS, prefetchProfile: 'network' } as any)

        const videoTrack = await input.getPrimaryVideoTrack()
        if (!videoTrack) {
          callbacksRef.current.onError?.({ message: 'No video track' })
          return
        }
        const videoCodec = await videoTrack.getCodec()
        const videoDecoderConfig = videoCodec ? await videoTrack.getDecoderConfig() : null
        const mp4Codecs = new Mp4OutputFormat({ fastStart: 'fragmented' }).getSupportedCodecs()
        const videoUsable = Boolean(videoCodec && videoDecoderConfig && mp4Codecs.includes(videoCodec))

        const audioTrack = await input.getPrimaryAudioTrack()
        const audioCodec = audioTrack ? await audioTrack.getCodec() : null
        const audioDecoderConfig = audioTrack && audioCodec ? await audioTrack.getDecoderConfig() : null
        const audioUsable = Boolean(audioCodec && audioDecoderConfig && mp4Codecs.includes(audioCodec))

        // Build the SourceBuffer MIME from the precise codec strings, falling
        // back to the legacy hardcoded candidates.
        let videoCodecString: string | null = null
        try { videoCodecString = videoUsable ? await videoTrack.getCodecParameterString() : null } catch {}
        let audioCodecString: string | null = null
        try { audioCodecString = audioUsable ? await audioTrack!.getCodecParameterString() : null } catch {}

        // Real duration is known up front from the container index.
        const duration = await input.computeDuration()

        // Capability gate (see the MSE-fallback design doc): the source plays
        // through mediabunny remux only if mediabunny can repackage every track
        // into fMP4 AND this webview reports it can decode them. Otherwise ask
        // the backend for a bare-ffmpeg compat stream (audio→AAC, video copy).
        const audioPlayable = Boolean(
          audioUsable && videoCodecString && audioCodecString &&
          MediaSource.isTypeSupported(`video/mp4; codecs="${videoCodecString}, ${audioCodecString}"`)
        )
        const videoPlayable = Boolean(
          videoUsable && (!videoCodecString ||
            MediaSource.isTypeSupported(`video/mp4; codecs="${videoCodecString}"`))
        )
        const needsCompat = !videoPlayable || (audioTrack && !audioPlayable)

        const requestCompatPlayback = callbacksRef.current.requestCompatPlayback
        if (needsCompat && requestCompatPlayback) {
          let compat: CompatPlaybackResult = null
          try { compat = await requestCompatPlayback() } catch {}
          if (compat?.transcoded && compat.url) {
            console.log('[WebMseBackend] Using compat fragment source')
            try { (input as any).dispose?.() } catch {}
            const compatDisposeRef: { current: (() => void) | null } = { current: null }
            disposeRef.current = () => {
              clearInterval(progressTimer)
              compatDisposeRef.current?.()
            }
            await runCompatHlsPipeline({
              el,
              hlsUrl: compat.url,
              videoCodecString,
              durationHint: duration > 0 ? duration : 0,
              onLoad: (data) => callbacksRef.current.onLoad?.(data),
              onError: (error) => callbacksRef.current.onError?.(error),
              setDispose: (fn) => { compatDisposeRef.current = fn },
              shouldAutoPlay: () => isPlayingRef.current,
              requestAutoplay: requestDesiredPlayback,
            })
            return
          }
          if (compat?.transcodeError) {
            console.warn('[WebMseBackend] Compat playback unavailable:', compat.transcodeError)
          }
        }

        if (!videoUsable || !videoCodec) {
          callbacksRef.current.onError?.({ message: `Unsupported video codec: ${videoCodec || 'unknown'}` })
          return
        }
        const videoDecoderConfigForOutput = videoDecoderConfig || undefined

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
        if (!sb) { callbacksRef.current.onError?.({ message: 'No MSE MIME support' }); return }

        const { waitForUpdate, safeAppend, removeRange, isBuffered } = createSourceBufferOps(sb, el)

        // Report the duration and size the MediaSource so the whole timeline
        // is seekable immediately (the old linear conversion only grew the
        // seekable range as it progressed through the file).
        if (duration > 0) {
          await waitForUpdate()
          try { ms.duration = duration } catch {}
          callbacksRef.current.onLoad?.({ duration, durationMs: Math.round(duration * 1000) })
        }

        const videoSink = new EncodedPacketSink(videoTrack)
        const audioSink = includeAudio && audioTrack ? new EncodedPacketSink(audioTrack) : null

        // --- On-demand remux pipeline ---
        let generation = 0
        let activeOutput: any = null
        let playbackStarted = false
        let disposed = false
        let removeSeekingListener: (() => void) | null = null

        disposeRef.current = () => {
          disposed = true
          generation++
          removeSeekingListener?.()
          removeSeekingListener = null
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
                if (isPlayingRef.current) {
                  requestDesiredPlayback()
                }
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
                await videoOut.add(nextVideo.value, firstVideo ? { decoderConfig: videoDecoderConfigForOutput } : undefined)
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
              console.warn('[WebMseBackend] Pipeline error:', err?.message)
              callbacksRef.current.onError?.({ message: err?.message || 'Remux pipeline error' })
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
        const handleSeeking = () => {
          const target = el.currentTime
          if (isBuffered(target)) return // Data already present, the element recovers on its own

          generation++
          const gen = generation
          const oldOutput = activeOutput
          activeOutput = null
          try { oldOutput?.cancel?.()?.catch?.(() => {}) } catch {}

          (async () => {
            try {
              if (sb!.updating) {
                try { sb!.abort() } catch {}
              }
              await removeRange(0, Infinity)
              if (gen !== generation) return
              await runPipeline(Math.max(0, target - 0.5), gen)
            } catch (err: any) {
              console.warn('[WebMseBackend] Seek error:', err?.message)
            }
          })()
        }
        el.addEventListener('seeking', handleSeeking)
        removeSeekingListener = () => el.removeEventListener('seeking', handleSeeking)

        await runPipeline(0, generation)
      } catch (err: any) {
        console.error('[WebMseBackend] Error:', err?.message)
        callbacksRef.current.onError?.({ message: err?.message || 'MSE error' })
      }
    })()
  }, [clearMseAutoplayRetry, playerRef, requestDesiredPlayback, videoUrl])

  return (
    <video
      ref={videoRefCallback}
      style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000', ...(style || {}) }}
      onPlay={() => callbacksRef.current.onPlaying?.()}
      onPause={() => callbacksRef.current.onPaused?.()}
      onEnded={() => callbacksRef.current.onEnded?.()}
      onLoadedMetadata={() => {
        const v = videoElRef.current
        if (v?.duration) callbacksRef.current.onLoad?.({ duration: v.duration, durationMs: Math.round(v.duration * 1000) })
      }}
      playsInline
    />
  )
})
