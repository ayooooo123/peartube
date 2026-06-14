/**
 * Unified Thumbnail Generation
 *
 * Uses bare-ffmpeg for video frame extraction and image encoding across all
 * platforms running the Bare runtime (desktop Pear worker + mobile BareKit
 * worklet).
 *
 * This intentionally reuses the SAME bare-ffmpeg native addon that the
 * transcoder already depends on, instead of pulling in `bare-media` (which
 * bundled its own second copy of FFmpeg just for thumbnails). One FFmpeg blob,
 * full codec coverage.
 *
 * Pipeline: open file -> decode the target frame -> scale/convert -> encode.
 * Output is JPEG (via the always-available `mjpeg` encoder). WebP is NOT in the
 * bare-ffmpeg build (no libwebp), so a requested `image/webp` transparently
 * falls back to JPEG. PNG is used when explicitly requested and available.
 */

import fs from 'bare-fs'

import { logger } from './logger.js'
import { safeDestroy, ResourceTracker } from './transcode/ffmpeg-utils.mjs'

const log = logger('Thumbnail')

let ffmpegRuntime = null
let ffmpegLoadFailed = false

async function getFfmpegRuntime() {
  if (ffmpegRuntime) return ffmpegRuntime
  if (ffmpegLoadFailed) return null

  let mod = null
  // Prefer require when available (matches transcoder loader), fall back to
  // dynamic import for environments without a CJS require.
  if (typeof require === 'function') {
    try {
      mod = require('bare-ffmpeg')
    } catch {
      mod = null
    }
  }
  if (!mod) {
    try {
      mod = await import('bare-ffmpeg')
    } catch (err) {
      ffmpegLoadFailed = true
      log.warn('bare-ffmpeg unavailable; thumbnail generation disabled', { error: err?.message || String(err) })
      return null
    }
  }

  const ff = mod?.default ?? mod
  if (
    !ff ||
    typeof ff.InputFormatContext !== 'function' ||
    typeof ff.IOContext !== 'function' ||
    typeof ff.Scaler !== 'function' ||
    typeof ff.Frame !== 'function' ||
    typeof ff.Packet !== 'function' ||
    !ff.constants
  ) {
    ffmpegLoadFailed = true
    log.warn('bare-ffmpeg loaded but missing required API; thumbnail generation disabled')
    return null
  }

  ffmpegRuntime = ff
  return ff
}

/**
 * Default thumbnail configuration
 */
const THUMBNAIL_CONFIG = {
  // Frame index to extract (default ~10 seconds at 30fps)
  frameIndex: 300,
  // Fallback frame index if target not available
  fallbackFrameIndex: 0,
  // Output dimensions
  maxWidth: 640,
  maxHeight: 360,
  // Output format. WebP is unsupported by the bare-ffmpeg build and falls back
  // to JPEG (see selectImageEncoder).
  mimeType: 'image/jpeg',
  // Quality (0-100)
  quality: 80
}

/**
 * Create a streaming IOContext that reads from a file via fs.readSync.
 * Avoids loading the entire video into memory; the demuxer reads sequentially.
 * (Mirrors the transcoder's createFileReadIOContext.)
 */
function createFileReadIOContext(ff, filePath, fileSize) {
  const fd = fs.openSync(filePath, 'r')
  let currentPos = 0

  const ioContext = new ff.IOContext(16384, {
    onread: (buffer) => {
      if (currentPos >= fileSize) return 0 // EOF
      const bytesToRead = Math.min(buffer.length, fileSize - currentPos)
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, currentPos)
      currentPos += bytesRead
      return bytesRead
    },

    onseek: (offset, whence) => {
      const SEEK_SET = 0
      const SEEK_CUR = 1
      const SEEK_END = 2
      const AVSEEK_SIZE = 0x10000

      if (whence === AVSEEK_SIZE) return fileSize
      if (whence === SEEK_SET) currentPos = offset
      else if (whence === SEEK_CUR) currentPos += offset
      else if (whence === SEEK_END) currentPos = fileSize + offset

      currentPos = Math.max(0, Math.min(currentPos, fileSize))
      return currentPos
    }
  })

  ioContext._cleanup = () => {
    try { fs.closeSync(fd) } catch {}
  }

  return ioContext
}

/**
 * Pick an image encoder for the requested mime type.
 * - image/png  -> 'png' encoder (RGB24) when available
 * - image/webp -> 'libwebp' encoder when the bare-ffmpeg build provides one
 * - everything else (incl. webp on builds without libwebp) -> 'mjpeg' (YUVJ420P)
 *
 * WebP is detected at runtime: the current bare-ffmpeg build ships without
 * libwebp, so requests fall back to JPEG. If/when libwebp is added to the
 * build, it is picked up automatically — no code change needed here.
 *
 * @returns {{ encoder, pixelFormat: number, mimeType: string } | null}
 */
function selectImageEncoder(ff, mimeType) {
  const want = String(mimeType || 'image/jpeg').toLowerCase()

  const findByName = (name) => {
    try {
      const e = ff.findEncoderByName?.(name)
      if (e && e._handle) return e
    } catch {}
    return null
  }

  if (want === 'image/png') {
    const png = findByName('png')
    if (png) return { encoder: png, pixelFormat: ff.constants.pixelFormats.RGB24, mimeType: 'image/png' }
    log.debug('PNG encoder unavailable, falling back to JPEG')
  } else if (want === 'image/webp') {
    const webp = findByName('libwebp') || findByName('libwebp_anim') || findByName('webp')
    if (webp) {
      const pf = ff.constants.pixelFormats
      // libwebp accepts yuv420p natively; fall back to other formats if the
      // build exposes a different set of constants.
      const pixelFormat = pf.YUV420P ?? pf.YUVJ420P ?? pf.RGB24
      return { encoder: webp, pixelFormat, mimeType: 'image/webp' }
    }
    log.debug('WebP encoder unavailable in this bare-ffmpeg build, falling back to JPEG')
  }

  let mjpeg = findByName('mjpeg')
  if (!mjpeg) {
    try { mjpeg = ff.Codec?.for?.(ff.constants.codecs.MJPEG)?.encoder } catch {}
  }
  if (mjpeg && mjpeg._handle) {
    return { encoder: mjpeg, pixelFormat: ff.constants.pixelFormats.YUVJ420P, mimeType: 'image/jpeg' }
  }
  return null
}

/**
 * Compute output dimensions that fit within max bounds while preserving aspect
 * ratio. Never upscales. Rounds to even dimensions (required by YUV 4:2:0).
 */
function fitDimensions(srcW, srcH, maxW, maxH) {
  if (!srcW || !srcH || srcW <= 0 || srcH <= 0) {
    return { width: maxW, height: maxH }
  }
  let w = srcW
  let h = srcH
  if (w > maxW || h > maxH) {
    const ratio = Math.min(maxW / w, maxH / h)
    w = Math.round(w * ratio)
    h = Math.round(h * ratio)
  }
  w = Math.max(2, w - (w % 2))
  h = Math.max(2, h - (h % 2))
  return { width: w, height: h }
}

/**
 * Generate a thumbnail from a video file.
 *
 * Uses bare-ffmpeg for frame extraction, scaling and image encoding.
 * Works on all platforms running the Bare runtime.
 *
 * @param {string} filePath - Path to video file
 * @param {object} [options] - Thumbnail options
 * @param {number} [options.frameIndex=300] - Frame index to extract (~10s at 30fps)
 * @param {number} [options.maxWidth=640] - Maximum width
 * @param {number} [options.maxHeight=360] - Maximum height
 * @param {string} [options.mimeType='image/jpeg'] - Output format (image/jpeg, image/png)
 * @param {number} [options.quality=80] - Output quality (0-100)
 * @returns {Promise<{buffer: Buffer, mimeType: string} | null>}
 */
export async function generateThumbnail(filePath, options = {}) {
  const config = { ...THUMBNAIL_CONFIG, ...options }
  const ff = await getFfmpegRuntime()
  if (!ff) return null

  let fileSize = 0
  try {
    fileSize = fs.statSync(filePath).size
  } catch (err) {
    log.warn('Could not stat video file for thumbnail', { filePath, error: err?.message })
    return null
  }
  if (!fileSize) return null

  log.debug('Generating thumbnail', {
    filePath,
    frameIndex: config.frameIndex,
    maxWidth: config.maxWidth
  })

  const imageSel = selectImageEncoder(ff, config.mimeType)
  if (!imageSel) {
    log.warn('No image encoder available; thumbnail generation disabled')
    return null
  }

  const tracker = new ResourceTracker()
  let ioContext = null

  try {
    ioContext = createFileReadIOContext(ff, filePath, fileSize)
    const input = tracker.track(new ff.InputFormatContext(ioContext), 'input')

    const videoStream = input.getBestStream(ff.constants.mediaTypes.VIDEO)
    if (!videoStream) {
      log.warn('No video stream found for thumbnail')
      return null
    }

    const decoder = tracker.track(videoStream.decoder(), 'decoder')
    decoder.timeBase = videoStream.timeBase
    decoder.open()

    const packet = tracker.track(new ff.Packet(), 'packet')
    const frame = tracker.track(new ff.Frame(), 'frame')

    const targetIndex = Math.max(0, config.frameIndex | 0)
    let decodedCount = 0
    let captured = false
    let hitTarget = false
    let scaler = null
    let scaledFrame = null
    let outW = 0
    let outH = 0

    const ensureScaler = (srcFormat, srcW, srcH) => {
      const NONE = ff.constants.pixelFormats.NONE
      let inFmt = srcFormat
      if (inFmt == null || inFmt === NONE || inFmt < 0) {
        inFmt = ff.constants.pixelFormats.YUV420P
      }
      const dims = fitDimensions(srcW, srcH, config.maxWidth, config.maxHeight)
      outW = dims.width
      outH = dims.height
      // Scaler args: srcPixelFormat, srcW, srcH, dstPixelFormat, dstW, dstH
      scaler = tracker.track(
        new ff.Scaler(inFmt, srcW, srcH, imageSel.pixelFormat, outW, outH),
        'scaler'
      )
      scaledFrame = tracker.track(new ff.Frame(), 'scaledFrame')
      scaledFrame.width = outW
      scaledFrame.height = outH
      scaledFrame.format = imageSel.pixelFormat
      scaledFrame.alloc()
    }

    // Capture the current decoder `frame` into `scaledFrame` (scaling/converting).
    const captureCurrentFrame = () => {
      const srcW = frame.width || videoStream.codecParameters.width
      const srcH = frame.height || videoStream.codecParameters.height
      if (!scaler) ensureScaler(frame.format, srcW, srcH)
      scaler.scale(frame, scaledFrame)
      scaledFrame.pts = 0
      captured = true
    }

    // Decode until we reach the target frame. Always keep the first decoded
    // frame as a fallback (covers videos shorter than the target index).
    const consumeDecodedFrames = () => {
      while (decoder.receiveFrame(frame)) {
        if (decodedCount === 0 || decodedCount === targetIndex) {
          captureCurrentFrame()
          if (decodedCount === targetIndex) {
            hitTarget = true
            return
          }
        }
        decodedCount++
      }
    }

    while (input.readFrame(packet)) {
      if (packet.streamIndex === videoStream.index && decoder.sendPacket(packet)) {
        consumeDecodedFrames()
      }
      packet.unref()
      if (hitTarget) break
    }

    // Flush the decoder for any buffered frames if we haven't hit the target.
    if (!hitTarget) {
      decoder.sendPacket(null)
      consumeDecodedFrames()
    }

    if (!captured || !scaledFrame) {
      log.warn('No frame could be extracted from video')
      return null
    }

    // Encode the captured frame to a still image.
    const encoder = tracker.track(new ff.CodecContext(imageSel.encoder), 'encoder')
    encoder.width = outW
    encoder.height = outH
    encoder.pixelFormat = imageSel.pixelFormat
    encoder.timeBase = { numerator: 1, denominator: 25 }

    const quality = Math.max(1, Math.min(100, config.quality))
    if (imageSel.mimeType === 'image/webp') {
      // libwebp takes a 0..100 quality (higher = better), the inverse of MJPEG's
      // qscale. Best-effort; ignored by builds/encoders that don't expose it.
      try { encoder.setOption('quality', String(quality)) } catch {}
    } else {
      // Best-effort quality control for MJPEG (qscale 2=best .. 31=worst).
      const qscale = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)))
      try { encoder.setOption('qscale', String(qscale)) } catch {}
      try { encoder.setOption('q:v', String(qscale)) } catch {}
    }

    encoder.open()

    const outPacket = tracker.track(new ff.Packet(), 'outPacket')
    let encoded = null
    if (encoder.sendFrame(scaledFrame) && encoder.receivePacket(outPacket)) {
      encoded = Buffer.from(outPacket.data)
      outPacket.unref()
    }
    if (!encoded) {
      // Flush the encoder (single intra frame may emit on flush).
      encoder.sendFrame(null)
      if (encoder.receivePacket(outPacket)) {
        encoded = Buffer.from(outPacket.data)
        outPacket.unref()
      }
    }

    if (!encoded || !encoded.length) {
      log.warn('Encoder produced no thumbnail data')
      return null
    }

    log.info('Thumbnail generated', {
      size: encoded.length,
      mimeType: imageSel.mimeType,
      width: outW,
      height: outH
    })

    return { buffer: encoded, mimeType: imageSel.mimeType }
  } catch (err) {
    log.error('Thumbnail generation failed', err)
    return null
  } finally {
    tracker.destroyAll()
    try { ioContext?._cleanup?.() } catch {}
  }
}

/**
 * Generate thumbnail and store in channel's Hyperblobs.
 *
 * @param {string} filePath - Path to video file
 * @param {string} videoId - Video ID in channel
 * @param {object} channel - MultiWriterChannel instance
 * @param {object} [options] - Thumbnail options
 * @returns {Promise<{thumbnailBlobId: string, thumbnailBlobsCoreKey: string, thumbnailMimeType: string} | null>}
 */
export async function generateAndStoreThumbnail(filePath, videoId, channel, options = {}) {
  const result = await generateThumbnail(filePath, options)

  if (!result) {
    log.warn('Could not generate thumbnail for video', { videoId })
    return null
  }

  if (!channel.blobs) {
    log.warn('Channel blobs not available for thumbnail storage')
    return null
  }

  try {
    const blobResult = await channel.putBlob(result.buffer)
    log.info('Thumbnail stored in Hyperblobs', {
      videoId,
      blobId: blobResult.id
    })

    return {
      thumbnailBlobId: blobResult.id,
      thumbnailBlobsCoreKey: channel.blobsKeyHex,
      thumbnailMimeType: result.mimeType
    }
  } catch (err) {
    log.error('Failed to store thumbnail in Hyperblobs', err)
    return null
  }
}

/**
 * Estimate frame index for a target time.
 *
 * @param {number} targetSeconds - Target time in seconds
 * @param {number} [fps=30] - Assumed frames per second
 * @returns {number} Estimated frame index
 */
export function estimateFrameIndex(targetSeconds, fps = 30) {
  return Math.floor(targetSeconds * fps)
}

export default {
  generateThumbnail,
  generateAndStoreThumbnail,
  estimateFrameIndex,
  THUMBNAIL_CONFIG
}
