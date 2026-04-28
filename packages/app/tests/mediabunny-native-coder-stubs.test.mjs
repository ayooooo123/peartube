import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createNativeMobileCoderClasses,
  getNativeMobileCoderRegistrationPlan,
} from '../lib/mobile-media/mediabunny-native-coders.mjs'

test('getNativeMobileCoderRegistrationPlan selects AVC/AAC stubs from native capabilities', () => {
  const plan = getNativeMobileCoderRegistrationPlan({
    platform: 'android',
    video: { encoders: ['video/avc'], decoders: ['video/avc'] },
    audio: { encoders: ['audio/mp4a-latm'], decoders: ['audio/mp4a-latm'] },
  })

  assert.deepEqual(plan.encoders, ['NativeAvcEncoder', 'NativeAacEncoder'])
  assert.deepEqual(plan.decoders, ['NativeAvcDecoder', 'NativeAacDecoder'])
  assert.equal(plan.readyForNativeEncodeSpike, true)
})

test('native Mediabunny coder stubs expose supports() without implementing encode/decode yet', async () => {
  const classes = await createNativeMobileCoderClasses({
    platform: 'ios',
    video: { encoders: ['avc'], decoders: ['avc'] },
    audio: { encoders: ['aac'], decoders: ['aac'] },
  })

  assert.equal(classes.NativeAvcEncoder.supports('avc', { width: 320, height: 180 }), true)
  assert.equal(classes.NativeAvcEncoder.supports('hevc', { width: 320, height: 180 }), false)
  assert.equal(classes.NativeAacEncoder.supports('aac', { numberOfChannels: 2, sampleRate: 48000 }), true)
  assert.equal(classes.NativeAacEncoder.supports('opus', { numberOfChannels: 2, sampleRate: 48000 }), false)

  const encoder = new classes.NativeAvcEncoder()
  await encoder.init()
  await assert.rejects(
    () => encoder.encode({}, { keyFrame: true }),
    /Native AVC encoder bridge is not implemented yet/,
  )
  await encoder.flush()
  await encoder.close()
})
