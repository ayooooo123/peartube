/**
 * Lightweight per-video startup timing.
 *
 * Time-to-first-frame on desktop spans two subsystems that don't share a call
 * stack: the prepare path (`api.js` preparePlayback / prefetchVideo) and the
 * blob-server range path (`video-range-http.js`). This module lets both record
 * milestones for the same video, keyed by blobsCoreKey hex, so a single test
 * prints a contiguous timeline (`[PlaybackTiming]`) of where the seconds go:
 *
 *   begin -> url-resolved -> first-byte -> first-block -> head-local
 *
 * Log-only and best-effort — never affects playback. Grep `[PlaybackTiming]`.
 */

// keyHex -> { startedAt, label, marks: Map<name, msFromStart> }
const timers = new Map()
const MAX_TIMERS = 16

function shortKey(keyHex) {
  return typeof keyHex === 'string' && keyHex.length > 16 ? keyHex.slice(0, 16) : String(keyHex || '')
}

/** Start (or restart) the timeline for a video. */
export function beginPlaybackTiming(keyHex, label = '') {
  if (!keyHex) return
  timers.delete(keyHex)
  timers.set(keyHex, { startedAt: Date.now(), label, marks: new Map() })
  // Bound the registry; an active playback refreshes its own entry above.
  while (timers.size > MAX_TIMERS) {
    const oldest = timers.keys().next().value
    if (oldest === keyHex) break
    timers.delete(oldest)
  }
  console.log(`[PlaybackTiming] ${shortKey(keyHex)} begin${label ? ` (${label})` : ''}`)
}

/**
 * Record a milestone the first time it occurs for this video. Repeated calls
 * for the same (key, name) are ignored, so callers on hot paths (e.g. every
 * served range) can call unconditionally and only the first sticks.
 */
export function markPlaybackTiming(keyHex, name, extra = '') {
  if (!keyHex || !name) return
  const timer = timers.get(keyHex)
  if (!timer || timer.marks.has(name)) return
  const ms = Date.now() - timer.startedAt
  timer.marks.set(name, ms)
  console.log(`[PlaybackTiming] ${shortKey(keyHex)} ${name} +${ms}ms${extra ? ` ${extra}` : ''}`)
}

export function clearPlaybackTiming(keyHex) {
  if (keyHex) timers.delete(keyHex)
}
