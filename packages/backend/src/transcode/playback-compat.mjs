/**
 * Playback compatibility policy (Phase 0 of cross-platform libmpv retirement).
 *
 * Pure, dependency-free decision logic: given a probe result and the target
 * OS-native player, decide whether the source can play directly or needs the
 * bare-ffmpeg compatibility layer (remux / audio-transcode / full transcode),
 * served as local HLS/fMP4.
 *
 * This is the per-player generalization of the existing Chromecast/web checks in
 * transcoder.mjs (`checkTranscodeNeeded` / `checkWebTranscodeNeeded`). The
 * `webkit` and `chromecast` tables below are kept faithful to those so the
 * existing web/cast paths keep their behavior when routed through here.
 *
 * Codec/container lists are deliberately conservative (better to transcode than
 * to fail playback) and are intended to be tuned with on-device validation.
 *
 * See: docs/superpowers/plans/2026-06-11-retire-libmpv-cross-platform.md
 */

// ─── Codec name normalization ───────────────────────────────────────────────
// Probe names come from mapCodecIdToName (h264, hevc, vp9, aac, ac3, …) but may
// also arrive as container-level aliases (avc1, h265, ec-3, dca, …).
const VIDEO_ALIASES = {
  avc1: 'h264', avc: 'h264', x264: 'h264',
  h265: 'hevc', hev1: 'hevc', hvc1: 'hevc',
}
const AUDIO_ALIASES = {
  'ac-3': 'ac3',
  'ec-3': 'eac3', 'e-ac-3': 'eac3', 'eac-3': 'eac3',
  dca: 'dts',
  'mp4a': 'aac',
}

function normVideo(codec) {
  if (!codec) return null
  const c = String(codec).toLowerCase().trim()
  return VIDEO_ALIASES[c] || c
}

function normAudio(codec) {
  if (!codec) return null
  const c = String(codec).toLowerCase().trim()
  return AUDIO_ALIASES[c] || c
}

// H.264 profiles that browsers/Chromecast (and conservatively, AVPlayer) can't
// reliably decode — 10-bit (High 10) and 4:4:4 (High 4:4:4).
const H264_UNSUPPORTED_PROFILES = ['high 10', 'high 4:4:4', 'high422', 'high444', '10', '4:4:4']

/**
 * Per-player capability tables. A codec/container NOT listed here is treated as
 * "needs the compatibility layer".
 *
 * - video / audio: Sets of normalized codec names the player decodes natively.
 * - remuxContainerPatterns: substrings that force a remux when present in the
 *   (possibly comma-joined) ffmpeg container string. A deny-list, because
 *   ffmpeg reports both .mkv and .webm as the shared format "matroska,webm" —
 *   so we can't allow-list "webm" without also passing MKV. This mirrors the
 *   existing checkTranscodeNeeded / checkWebTranscodeNeeded container checks.
 * - h264MaxLevel: if set, H.264 above this level needs transcode (Chromecast).
 * - rejectHiProfileH264: reject 10-bit / 4:4:4 H.264.
 */
export const PLAYER_POLICIES = {
  // iOS + macOS AVFoundation. Conservative: HW H.264/HEVC + AAC/MP3/ALAC/FLAC.
  // Opus/Vorbis/AC-3/E-AC-3/DTS and MKV/WebM go through the compat layer.
  avplayer: {
    video: new Set(['h264', 'hevc']),
    audio: new Set(['aac', 'mp3', 'alac', 'flac']),
    remuxContainerPatterns: ['matroska', 'mkv', 'webm', 'avi', 'flv', 'ogg'],
    rejectHiProfileH264: true,
  },

  // Android ExoPlayer — codec-complete; only DTS / odd containers need help.
  exoplayer: {
    video: new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']),
    audio: new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3']),
    remuxContainerPatterns: ['avi', 'flv'],
    rejectHiProfileH264: false,
  },

  // WKWebView / Chromium (Electrobun). Faithful to checkWebTranscodeNeeded:
  // video h264/vp8/vp9/av1/hevc, audio aac/mp3/opus/vorbis/flac, MKV → remux.
  // (Pure WebM over-remuxes since it shares the matroska format name, matching
  // the existing web check; on Electrobun mediabunny remuxes in the renderer.)
  webkit: {
    video: new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc']),
    audio: new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']),
    remuxContainerPatterns: ['matroska', 'mkv', 'avi', 'flv', 'ogg'],
    rejectHiProfileH264: true,
  },

  // Chromecast. Faithful to checkTranscodeNeeded (audio AAC-only).
  chromecast: {
    video: new Set(['h264', 'vp8', 'vp9', 'av1']),
    audio: new Set(['aac']),
    remuxContainerPatterns: ['matroska', 'mkv', 'avi', 'flv'],
    h264MaxLevel: 4.2,
    rejectHiProfileH264: true,
  },
}

function containerNeedsRemux(policy, container) {
  if (!container) return false // unknown container → don't force remux blindly
  const c = String(container).toLowerCase()
  return policy.remuxContainerPatterns.some((pat) => c.includes(pat))
}

/**
 * Decide how to play a source on a given OS-native player.
 *
 * @param {object} input
 * @param {string} input.player - one of PLAYER_POLICIES keys
 * @param {string|null} input.videoCodec
 * @param {string|null} input.audioCodec
 * @param {string|null} [input.container]
 * @param {string|null} [input.videoProfile]
 * @param {number} [input.videoLevel]
 * @returns {{ mode: 'direct'|'remux'|'audio-only'|'full',
 *            needsVideoTranscode: boolean, needsAudioTranscode: boolean,
 *            needsRemux: boolean, reason: string, player: string }}
 */
export function decidePlayback({ player, videoCodec, audioCodec, container, videoProfile, videoLevel } = {}) {
  const policy = PLAYER_POLICIES[player]
  // Unknown player → don't second-guess; play directly.
  if (!policy) {
    return {
      mode: 'direct',
      needsVideoTranscode: false,
      needsAudioTranscode: false,
      needsRemux: false,
      reason: player ? `Unknown player '${player}', passthrough` : 'No player specified, passthrough',
      player: player || null,
    }
  }

  const reasons = []
  const v = normVideo(videoCodec)
  const a = normAudio(audioCodec)

  let needsVideoTranscode = false
  if (v) {
    if (!policy.video.has(v)) {
      needsVideoTranscode = true
      reasons.push(`video ${v} unsupported on ${player}`)
    } else if (v === 'h264' && policy.rejectHiProfileH264 && videoProfile) {
      const profile = String(videoProfile).toLowerCase()
      if (H264_UNSUPPORTED_PROFILES.some((p) => profile.includes(p))) {
        needsVideoTranscode = true
        reasons.push(`H.264 profile '${videoProfile}' unsupported (10-bit/4:4:4)`)
      }
    }
    if (!needsVideoTranscode && v === 'h264' && policy.h264MaxLevel && videoLevel && videoLevel > policy.h264MaxLevel) {
      needsVideoTranscode = true
      reasons.push(`H.264 level ${videoLevel} > ${policy.h264MaxLevel}`)
    }
  }

  let needsAudioTranscode = false
  if (a && !policy.audio.has(a)) {
    needsAudioTranscode = true
    reasons.push(`audio ${a} unsupported on ${player}`)
  }

  // Container remux only matters when we're otherwise stream-copying — a video
  // or audio transcode already rewrites into the output (HLS/fMP4) container.
  let needsRemux = false
  if (!needsVideoTranscode && !needsAudioTranscode && containerNeedsRemux(policy, container)) {
    needsRemux = true
    reasons.push(`container '${container}' needs remux for ${player}`)
  }

  let mode = 'direct'
  if (needsVideoTranscode) mode = 'full'
  else if (needsAudioTranscode) mode = 'audio-only'
  else if (needsRemux) mode = 'remux'

  return {
    mode,
    needsVideoTranscode,
    needsAudioTranscode,
    needsRemux,
    reason: reasons.join('; ') || 'Compatible',
    player,
  }
}

/**
 * Convenience: does the player play this source as-is (no compat layer)?
 */
export function osPlayerCanHandle(input) {
  return decidePlayback(input).mode === 'direct'
}

export default { PLAYER_POLICIES, decidePlayback, osPlayerCanHandle }
