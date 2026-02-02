/**
 * FFmpeg Memory Safety Utilities
 *
 * Provides helpers for safe management of bare-ffmpeg native handles:
 * - safeDestroy() - Destroy objects without crashing on double-destroy
 * - safeUnref() - Unref objects safely
 * - ResourceTracker - Track and cleanup multiple native objects
 * - safeBufferCopy() - Defensive buffer copying to prevent shared memory issues
 * - safeBoundsCheck() - Validate array/buffer access bounds
 */

/**
 * Safely destroy a bare-ffmpeg native object.
 * Prevents crashes from double-destroy by checking _handle state.
 *
 * @param {object} obj - Object with destroy() method
 */
export function safeDestroy(obj) {
  if (!obj || typeof obj.destroy !== 'function') return
  // Check if handle already null (already destroyed)
  if (Object.prototype.hasOwnProperty.call(obj, '_handle') && !obj._handle) return
  try {
    obj.destroy()
  } catch (err) {
    // Silently ignore destroy errors (may already be destroyed)
  }
}

/**
 * Safely unref a bare-ffmpeg packet/frame.
 * Prevents crashes from invalid unrefs.
 *
 * @param {object} obj - Object with unref() method
 */
export function safeUnref(obj) {
  if (!obj || typeof obj.unref !== 'function') return
  if (Object.prototype.hasOwnProperty.call(obj, '_handle') && !obj._handle) return
  try {
    obj.unref()
  } catch (err) {
    // Silently ignore unref errors
  }
}

/**
 * Create a defensive copy of a buffer.
 * Uses manual byte-by-byte copy to guarantee no shared memory.
 *
 * @param {Buffer} source - Source buffer to copy
 * @returns {Buffer} New buffer with copied data
 */
export function safeBufferCopy(source) {
  if (!source || !source.length) {
    return Buffer.alloc(0)
  }
  const len = source.length
  const copy = Buffer.alloc(len)
  for (let i = 0; i < len; i++) {
    copy[i] = source[i]
  }
  return copy
}

/**
 * Check if array/buffer access is within bounds.
 *
 * @param {number} index - Index to access
 * @param {number} length - Total length of array/buffer
 * @param {string} context - Description for error messages
 * @returns {boolean} True if within bounds
 * @throws {RangeError} If out of bounds
 */
export function safeBoundsCheck(index, length, context = 'access') {
  if (index < 0 || index >= length) {
    throw new RangeError(`[FFmpegUtils] ${context}: index ${index} out of bounds (length ${length})`)
  }
  return true
}

/**
 * Check if a range is valid for a buffer.
 *
 * @param {number} start - Start offset
 * @param {number} end - End offset (exclusive)
 * @param {number} length - Total length of buffer
 * @param {string} context - Description for error messages
 * @returns {boolean} True if valid
 * @throws {RangeError} If invalid range
 */
export function safeRangeCheck(start, end, length, context = 'range') {
  if (start < 0 || end < 0 || start > end || end > length) {
    throw new RangeError(
      `[FFmpegUtils] ${context}: range [${start}, ${end}) invalid for length ${length}`
    )
  }
  return true
}

/**
 * ResourceTracker - Tracks native FFmpeg objects for cleanup.
 *
 * Use pattern:
 *   const tracker = new ResourceTracker()
 *   try {
 *     const packet = tracker.track(new ffmpeg.Packet(), 'packet')
 *     const frame = tracker.track(new ffmpeg.Frame(), 'frame')
 *     // ... use objects ...
 *   } finally {
 *     tracker.destroyAll()
 *   }
 */
export class ResourceTracker {
  constructor() {
    // Map of name -> object for debugging
    this._resources = new Map()
    // Array for LIFO destruction order
    this._ordered = []
  }

  /**
   * Track a native object for later cleanup.
   *
   * @param {object} obj - Object with destroy() method
   * @param {string} name - Name for debugging
   * @returns {object} The same object (for chaining)
   */
  track(obj, name) {
    if (!obj) return obj
    const key = name || `resource_${this._ordered.length}`
    this._resources.set(key, obj)
    this._ordered.push({ key, obj })
    return obj
  }

  /**
   * Destroy a specific tracked object by name.
   *
   * @param {string} name - Name used in track()
   */
  destroy(name) {
    const obj = this._resources.get(name)
    if (obj) {
      safeDestroy(obj)
      this._resources.delete(name)
      this._ordered = this._ordered.filter(r => r.key !== name)
    }
  }

  /**
   * Destroy all tracked objects in reverse order (LIFO).
   * This is the proper order for FFmpeg objects where later
   * objects may reference earlier ones.
   */
  destroyAll() {
    // Destroy in reverse order (LIFO)
    for (let i = this._ordered.length - 1; i >= 0; i--) {
      const { key, obj } = this._ordered[i]
      safeDestroy(obj)
    }
    this._resources.clear()
    this._ordered = []
  }

  /**
   * Get count of tracked resources (for debugging).
   */
  get size() {
    return this._ordered.length
  }

  /**
   * Get names of all tracked resources (for debugging).
   */
  get names() {
    return Array.from(this._resources.keys())
  }
}

/**
 * Copy codec parameters from source to destination stream.
 * Works around missing copyFrom() in some bare-ffmpeg versions.
 *
 * @param {object} destCP - Destination codec parameters
 * @param {object} srcCP - Source codec parameters
 */
export function copyCodecParameters(destCP, srcCP) {
  if (typeof destCP.copyFrom === 'function') {
    destCP.copyFrom(srcCP)
    return
  }
  // Manual copy of common properties
  if (srcCP.id !== undefined) destCP.id = srcCP.id
  if (srcCP.type !== undefined) destCP.type = srcCP.type
  if (srcCP.codecName !== undefined) destCP.codecName = srcCP.codecName
  if (srcCP.profile !== undefined) destCP.profile = srcCP.profile
  if (srcCP.level !== undefined) destCP.level = srcCP.level
  if (srcCP.width !== undefined) destCP.width = srcCP.width
  if (srcCP.height !== undefined) destCP.height = srcCP.height
  if (srcCP.format !== undefined) destCP.format = srcCP.format
  if (srcCP.bitRate !== undefined) destCP.bitRate = srcCP.bitRate
  if (srcCP.sampleRate !== undefined) destCP.sampleRate = srcCP.sampleRate
  if (srcCP.nbChannels !== undefined) destCP.nbChannels = srcCP.nbChannels
  if (srcCP.channelLayout !== undefined) destCP.channelLayout = srcCP.channelLayout
  if (srcCP.extraData && srcCP.extraData.length > 0) {
    // Defensive copy of extraData
    destCP.extraData = safeBufferCopy(srcCP.extraData)
  }
}

export default {
  safeDestroy,
  safeUnref,
  safeBufferCopy,
  safeBoundsCheck,
  safeRangeCheck,
  ResourceTracker,
  copyCodecParameters,
}
