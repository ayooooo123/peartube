import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEDIABUNNY_MOBILE_BRIDGE_PHASES,
  normalizeNativeCodecCapabilities,
  selectPreferredMobileEncodingPlan,
} from '../lib/mobile-media/native-codec-capabilities.mjs'


test('normalizeNativeCodecCapabilities maps platform MIME names to Mediabunny codec ids', () => {
  const normalized = normalizeNativeCodecCapabilities({
    platform: 'android',
    video: {
      encoders: ['video/avc', 'video/hevc', 'video/x-vnd.on2.vp9', 'video/av01', 'video/unknown'],
      decoders: ['video/avc'],
    },
    audio: {
      encoders: ['audio/mp4a-latm', 'audio/opus', 'audio/mpeg'],
      decoders: ['audio/mp4a-latm'],
    },
  })

  assert.deepEqual(normalized.video.encoders, ['avc', 'hevc', 'vp9', 'av1'])
  assert.deepEqual(normalized.video.decoders, ['avc'])
  assert.deepEqual(normalized.audio.encoders, ['aac', 'opus', 'mp3'])
  assert.deepEqual(normalized.audio.decoders, ['aac'])
})

test('selectPreferredMobileEncodingPlan chooses cast-friendly H264/AAC when native encoders exist', () => {
  const plan = selectPreferredMobileEncodingPlan({
    platform: 'ios',
    video: { encoders: ['hevc', 'avc'], decoders: ['hevc', 'avc'] },
    audio: { encoders: ['aac'], decoders: ['aac'] },
  })

  assert.equal(plan.kind, 'native-mediabunny-hls')
  assert.equal(plan.videoCodec, 'avc')
  assert.equal(plan.audioCodec, 'aac')
  assert.equal(plan.container, 'hls')
  assert.equal(plan.usesNativeCodecBridge, true)
})

test('selectPreferredMobileEncodingPlan falls back to remux-only when AAC or AVC encoder is missing', () => {
  const plan = selectPreferredMobileEncodingPlan({
    platform: 'android',
    video: { encoders: ['hevc'], decoders: ['hevc', 'avc'] },
    audio: { encoders: ['opus'], decoders: ['aac', 'opus'] },
  })

  assert.equal(plan.kind, 'mediabunny-remux-only')
  assert.equal(plan.usesNativeCodecBridge, false)
})

test('bridge phases start with capability probe before native encode implementation', () => {
  assert.deepEqual(MEDIABUNNY_MOBILE_BRIDGE_PHASES.slice(0, 3), [
    'capability-probe',
    'custom-coder-registration-stubs',
    'native-avc-aac-encode-spike',
  ])
})
