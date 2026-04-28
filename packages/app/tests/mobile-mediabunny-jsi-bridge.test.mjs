import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MEDIABUNNY_MOBILE_BRIDGE_PHASES,
  normalizeNativeCodecCapabilities,
  selectPreferredMobileEncodingPlan,
} from '../lib/mobile-media/native-codec-capabilities.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(testDir, '..')

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

test('mobile media bridge plan keeps JSI zero-copy constraints explicit', async () => {
  const planPath = path.join(appDir, 'docs/mobile-mediabunny-jsi-bridge.md')
  const plan = await readFile(planPath, 'utf8')

  assert.match(plan, /Software Mansion React Native Best Practices JSI skill/)
  assert.match(plan, /zero-copy ArrayBuffer/i)
  assert.match(plan, /jsi::MutableBuffer/)
  assert.match(plan, /CallInvoker/)
  assert.match(plan, /MediaCodec/)
  assert.match(plan, /VideoToolbox|AVFoundation/)
  assert.match(plan, /Mediabunny custom coders/)
})

test('bridge phases start with capability probe before native encode implementation', () => {
  assert.deepEqual(MEDIABUNNY_MOBILE_BRIDGE_PHASES.slice(0, 3), [
    'capability-probe',
    'custom-coder-registration-stubs',
    'native-avc-aac-encode-spike',
  ])
})
