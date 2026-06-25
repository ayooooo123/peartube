/**
 * Runtime orchestration for the playback compatibility layer (Phase 0).
 *
 * Best-effort: given a direct blob URL and the target OS-native player, decide
 * whether to route playback through the bare-ffmpeg compat transcoder (returning
 * a local HLS URL the player can consume) or play the source directly. ANY
 * failure falls back to the direct URL — playback must never break because the
 * compat path errored or bare-ffmpeg was unavailable.
 *
 * This is pure orchestration over an injected `castTranscoder`
 * (startCompatTranscode / getCastHlsUrl / getCastStatus), so it is fully
 * unit-testable with a mock. The per-player policy itself lives in
 * playback-compat.mjs and is applied inside startCompatTranscode.
 *
 * See: docs/superpowers/plans/2026-06-11-retire-libmpv-cross-platform.md
 */

const DEFAULT_READY_TIMEOUT_MS = 8000
const READY_POLL_INTERVAL_MS = 200

// Players routed through this HLS-based compat path. WKWebView/Chromium
// (`webkit`) is handled by the renderer-side MSE/mediabunny path instead.
// Android uses this path only when the source codec/container policy requires
// it; supported MP4 playback should stay on the direct blob URL and let the
// blob range-priority layer fetch the needed P2P blocks.
const HLS_COMPAT_PLAYERS = new Set(['avplayer', 'exoplayer'])

/**
 * @param {object} opts
 * @param {string} opts.player - target player id (e.g. 'avplayer')
 * @param {string} opts.directUrl - the direct blob-server URL
 * @param {string|null} [opts.sourceKey] - stable key for session reuse
 * @param {object} [opts.castTranscoder] - injected transcoder
 *   (startCompatTranscode / getCastHlsUrl / getCastStatus)
 * @param {{log?:Function,warn?:Function}|null} [opts.logger]
 * @param {number} [opts.readyTimeoutMs]
 * @param {boolean} [opts.force]
 * @param {'remux'|'audio-only'|'full'} [opts.forceMode]
 * @returns {Promise<{url: string, transcoded: boolean, mode: string, sessionId?: string}>}
 */
export async function resolveCompatPlaybackUrl({
  player,
  directUrl,
  sourceKey = null,
  castTranscoder,
  logger = null,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  force = false,
  forceMode = null,
} = {}) {
  const passthrough = { url: directUrl, transcoded: false, mode: 'direct' }

  if (!directUrl || !player || !castTranscoder || !HLS_COMPAT_PLAYERS.has(player)) {
    return passthrough
  }
  if (typeof castTranscoder.startCompatTranscode !== 'function' ||
      typeof castTranscoder.getCastHlsUrl !== 'function') {
    return passthrough
  }

  try {
    const result = await castTranscoder.startCompatTranscode(directUrl, {
      player,
      sourceKey,
      force,
      forceMode,
    })
    if (!result || !result.success) {
      // 'no-transcode-needed' (already compatible) or a startup failure → direct.
      return passthrough
    }

    // Wait for the first fragment so the player doesn't open an empty playlist.
    if (!result.reused && typeof castTranscoder.getCastStatus === 'function') {
      await waitForFirstFragment(castTranscoder, result.sessionId, readyTimeoutMs)
    }

    const url = await castTranscoder.getCastHlsUrl(result.sessionId, '127.0.0.1')
    if (!url) return passthrough

    logger?.log?.(`[compat-playback] routing ${player} through ${result.mode || 'transcode'} transcode`)
    return { url, transcoded: true, mode: result.mode || 'transcode', sessionId: result.sessionId }
  } catch (err) {
    logger?.warn?.(`[compat-playback] compat path failed, using direct URL: ${err?.message || err}`)
    return passthrough
  }
}

async function waitForFirstFragment(castTranscoder, sessionId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0)
  // Always poll at least once even with a zero/negative timeout.
  do {
    let status = null
    try { status = await castTranscoder.getCastStatus(sessionId) } catch { status = null }
    if (status) {
      if (status.status === 'error') return false
      if ((status.fragmentCount ?? 0) >= 1) return true
    }
    if (Date.now() >= deadline) break
    await delay(READY_POLL_INTERVAL_MS)
  } while (Date.now() < deadline)
  return false
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default { resolveCompatPlaybackUrl }
