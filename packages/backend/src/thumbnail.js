/**
 * Unified Thumbnail Generation
 *
 * Uses bare-media for video frame extraction across all platforms:
 * - Desktop (Pear): via pear-run worker
 * - Mobile (iOS/Android): via BareKit worklet
 *
 * This replaces platform-specific solutions:
 * - Previous: bare-ffmpeg on desktop, expo-video-thumbnails on mobile
 * - Now: bare-media everywhere (runs on Bare runtime)
 */

import { video, image } from 'bare-media'
import { logger } from './logger.js'

const log = logger('Thumbnail')

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
  // Output format
  mimeType: 'image/webp',
  // Quality (0-100)
  quality: 80
}

/**
 * Generate a thumbnail from a video file.
 *
 * Uses bare-media for frame extraction and image encoding.
 * Works on all platforms running Bare runtime.
 *
 * @param {string} filePath - Path to video file
 * @param {object} [options] - Thumbnail options
 * @param {number} [options.frameIndex=300] - Frame index to extract (~10s at 30fps)
 * @param {number} [options.maxWidth=640] - Maximum width
 * @param {number} [options.maxHeight=360] - Maximum height
 * @param {string} [options.mimeType='image/webp'] - Output format (image/webp, image/jpeg, image/png)
 * @param {number} [options.quality=80] - Output quality (0-100)
 * @returns {Promise<{buffer: Buffer, mimeType: string} | null>}
 */
export async function generateThumbnail(filePath, options = {}) {
  const config = { ...THUMBNAIL_CONFIG, ...options }

  log.debug('Generating thumbnail', {
    filePath,
    frameIndex: config.frameIndex,
    maxWidth: config.maxWidth
  })

  try {
    // Extract frame at target index
    let frame
    try {
      frame = video(filePath).extractFrames({ frameIndex: config.frameIndex })
      log.debug('Frame extracted at target index', {
        frameIndex: config.frameIndex,
        width: frame.width,
        height: frame.height
      })
    } catch (err) {
      // Frame not available, try fallback
      log.debug('Target frame not available, using fallback', {
        error: err?.message,
        fallbackIndex: config.fallbackFrameIndex
      })
      frame = video(filePath).extractFrames({ frameIndex: config.fallbackFrameIndex })
    }

    if (!frame || !frame.data) {
      log.warn('No frame data extracted from video')
      return null
    }

    // Resize if needed
    let resizedFrame = frame
    if (frame.width > config.maxWidth || frame.height > config.maxHeight) {
      resizedFrame = await image.resize(frame, {
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight
      })
      log.debug('Frame resized', {
        originalWidth: frame.width,
        originalHeight: frame.height,
        newWidth: resizedFrame.width,
        newHeight: resizedFrame.height
      })
    }

    // Encode to target format
    const encoded = await image.encode(resizedFrame, {
      mimetype: config.mimeType,
      quality: config.quality
    })

    log.info('Thumbnail generated', {
      size: encoded.length,
      mimeType: config.mimeType,
      width: resizedFrame.width,
      height: resizedFrame.height
    })

    return {
      buffer: Buffer.from(encoded),
      mimeType: config.mimeType
    }
  } catch (err) {
    log.error('Thumbnail generation failed', err)
    return null
  }
}

/**
 * Generate thumbnail and store in channel's Hyperblobs.
 *
 * @param {string} filePath - Path to video file
 * @param {string} videoId - Video ID in channel
 * @param {object} channel - MultiWriterChannel instance
 * @param {object} [options] - Thumbnail options
 * @returns {Promise<{thumbnailBlobId: string, thumbnailBlobsCoreKey: string} | null>}
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
      thumbnailBlobsCoreKey: channel.blobsKeyHex
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
