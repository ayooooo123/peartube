export const MEDIABUNNY_MOBILE_BRIDGE_PHASES = Object.freeze([
  'capability-probe',
  'custom-coder-registration-stubs',
  'native-avc-aac-encode-spike',
  'mediabunny-hls-package-spike',
  'decode-encode-pipeline-spike',
])

const VIDEO_CODEC_ALIASES = new Map([
  ['avc', 'avc'],
  ['h264', 'avc'],
  ['h.264', 'avc'],
  ['video/avc', 'avc'],
  ['video/h264', 'avc'],
  ['hevc', 'hevc'],
  ['h265', 'hevc'],
  ['h.265', 'hevc'],
  ['video/hevc', 'hevc'],
  ['video/h265', 'hevc'],
  ['vp8', 'vp8'],
  ['video/x-vnd.on2.vp8', 'vp8'],
  ['vp9', 'vp9'],
  ['video/x-vnd.on2.vp9', 'vp9'],
  ['av1', 'av1'],
  ['video/av01', 'av1'],
  ['video/av1', 'av1'],
])

const AUDIO_CODEC_ALIASES = new Map([
  ['aac', 'aac'],
  ['audio/aac', 'aac'],
  ['audio/mp4a-latm', 'aac'],
  ['mp3', 'mp3'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['opus', 'opus'],
  ['audio/opus', 'opus'],
  ['vorbis', 'vorbis'],
  ['audio/vorbis', 'vorbis'],
  ['flac', 'flac'],
  ['audio/flac', 'flac'],
])

function normalizeCodecList(values, aliases) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(values) ? values : []) {
    const key = String(raw || '').trim().toLowerCase()
    const normalized = aliases.get(key)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

export function normalizeNativeCodecCapabilities(capabilities = {}) {
  return {
    platform: capabilities.platform || 'unknown',
    video: {
      encoders: normalizeCodecList(capabilities.video?.encoders, VIDEO_CODEC_ALIASES),
      decoders: normalizeCodecList(capabilities.video?.decoders, VIDEO_CODEC_ALIASES),
    },
    audio: {
      encoders: normalizeCodecList(capabilities.audio?.encoders, AUDIO_CODEC_ALIASES),
      decoders: normalizeCodecList(capabilities.audio?.decoders, AUDIO_CODEC_ALIASES),
    },
  }
}

export function selectPreferredMobileEncodingPlan(rawCapabilities = {}) {
  const capabilities = normalizeNativeCodecCapabilities(rawCapabilities)
  const hasAvcEncoder = capabilities.video.encoders.includes('avc')
  const hasAacEncoder = capabilities.audio.encoders.includes('aac')

  if (hasAvcEncoder && hasAacEncoder) {
    return {
      kind: 'native-mediabunny-hls',
      container: 'hls',
      videoCodec: 'avc',
      audioCodec: 'aac',
      usesNativeCodecBridge: true,
      reason: 'H.264 + AAC is the safest target for mobile playback and Chromecast-compatible HLS.',
    }
  }

  return {
    kind: 'mediabunny-remux-only',
    container: 'fragmented-mp4-or-hls',
    videoCodec: null,
    audioCodec: null,
    usesNativeCodecBridge: false,
    reason: 'Native H.264/AAC encoding is unavailable; keep Mediabunny to packet/container work only.',
  }
}
