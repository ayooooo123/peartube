/**
 * Engine-first thumbnail helpers.
 *
 * Frame extraction still uses bare-media when available, but storage is owned by
 * @peartube/engine via engine.setVideoThumbnail(). The old Hyperblobs channel
 * thumbnail path has been removed.
 */

import { logger } from './logger.js'

const log = logger('Thumbnail')

let bareMediaRuntime = null
let bareMediaLoadFailed = false

const THUMBNAIL_CONFIG = {
  frameIndex: 300,
  fallbackFrameIndex: 0,
  maxWidth: 640,
  maxHeight: 360,
  mimeType: 'image/webp',
  quality: 80
}

async function getBareMediaRuntime() {
  if (bareMediaRuntime) return bareMediaRuntime
  if (bareMediaLoadFailed) return null

  try {
    const mod = await import('bare-media')
    if (typeof mod?.video !== 'function' || typeof mod?.image?.encode !== 'function') {
      bareMediaLoadFailed = true
      return null
    }
    bareMediaRuntime = { video: mod.video, image: mod.image }
    return bareMediaRuntime
  } catch (err) {
    bareMediaLoadFailed = true
    log.warn('bare-media unavailable; thumbnail generation disabled', { error: err?.message || String(err) })
    return null
  }
}

export async function generateThumbnail(filePath, options = {}) {
  const config = { ...THUMBNAIL_CONFIG, ...options }
  const runtime = await getBareMediaRuntime()
  if (!runtime) return null
  const { video, image } = runtime

  try {
    let frame
    try {
      frame = video(filePath).extractFrames({ frameIndex: config.frameIndex })
    } catch {
      frame = video(filePath).extractFrames({ frameIndex: config.fallbackFrameIndex })
    }

    if (!frame?.data) return null

    let resizedFrame = frame
    if (frame.width > config.maxWidth || frame.height > config.maxHeight) {
      resizedFrame = await image.resize(frame, {
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight
      })
    }

    const encoded = await image.encode(resizedFrame, {
      mimetype: config.mimeType,
      quality: config.quality
    })

    return {
      buffer: Buffer.from(encoded),
      mimeType: config.mimeType
    }
  } catch (err) {
    log.warn('Thumbnail generation failed', { error: err?.message || String(err) })
    return null
  }
}

export async function generateAndAttachEngineThumbnail(engine, videoId, filePath, options = {}) {
  if (!engine || typeof engine.setVideoThumbnail !== 'function') {
    throw new Error('generateAndAttachEngineThumbnail requires an @peartube/engine instance')
  }

  const result = await generateThumbnail(filePath, options)
  if (!result) return null

  return engine.setVideoThumbnail(videoId, {
    bytes: result.buffer,
    mimeType: result.mimeType
  })
}

export function estimateFrameIndex(targetSeconds, fps = 30) {
  return Math.floor(targetSeconds * fps)
}

export { THUMBNAIL_CONFIG }

export default {
  generateThumbnail,
  generateAndAttachEngineThumbnail,
  estimateFrameIndex,
  THUMBNAIL_CONFIG
}
