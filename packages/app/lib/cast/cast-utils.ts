/**
 * Pure helpers for the cast hook — container/codec heuristics, volume scaling,
 * and the throttled cast-error alert. No React state lives here, so these are
 * safe to share across the device-discovery and session/playback concerns.
 */

import { Alert } from 'react-native'

const chromecastSupportedMime = [
  'video/mp4',
  'audio/mp4',
  'video/webm',
  'audio/webm',
  'video/ogg',
  'audio/ogg',
]

// Quick content type check - the worker will probe actual codecs
export function isChromecastSupported(options: { url: string; contentType: string; title?: string }) {
  const contentType = options.contentType?.toLowerCase() || ''
  const url = options.url?.toLowerCase() || ''
  const isMatroska = contentType.includes('matroska') || contentType.includes('mkv')
  const isAllowedContainer = chromecastSupportedMime.some((mime) => contentType.startsWith(mime))

  // Check file extension
  const isMkvFile = url.endsWith('.mkv')
  const isAviFile = url.endsWith('.avi')
  const isTsFile = url.endsWith('.ts') || url.endsWith('.m2ts')

  if (isMatroska || isMkvFile) {
    return {
      supported: false,
      reason: 'MKV container - will check codecs and transcode if needed.',
    }
  }

  if (isAviFile || isTsFile) {
    return {
      supported: false,
      reason: 'Container format may need transcoding.',
    }
  }

  if (!isAllowedContainer && contentType) {
    return {
      supported: false,
      reason: `Format ${contentType} - will check codecs and transcode if needed.`,
    }
  }

  // For supported containers, the worker will still probe to check internal codecs
  return { supported: true, reason: '' }
}

let _lastCastErrorMsg: string | null = null
let _lastCastErrorTime = 0
const CAST_ERROR_COOLDOWN_MS = 5000

export function showCastError(message: string) {
  try {
    const now = Date.now()
    if (message === _lastCastErrorMsg && now - _lastCastErrorTime < CAST_ERROR_COOLDOWN_MS) {
      return
    }
    _lastCastErrorMsg = message
    _lastCastErrorTime = now
    console.error('[useCast] Chromecast:', message)
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message)
      return
    }
    Alert.alert('Chromecast', message)
  } catch (err) {
    console.warn('[useCast] Failed to display cast error alert:', err)
  }
}

export function normalizeVolumeToCast(volume: number | undefined): number {
  if (!Number.isFinite(volume)) return 1
  if ((volume as number) <= 1) {
    return Math.max(0, Math.min(1, volume as number))
  }
  const percent = Math.max(0, Math.min(100, Math.floor(volume as number)))
  return percent / 100
}

export function normalizeVolumeFromCast(volume: number | undefined): number {
  if (!Number.isFinite(volume)) return 100
  if ((volume as number) <= 1) {
    return Math.round((volume as number) * 100)
  }
  return Math.round(volume as number)
}
