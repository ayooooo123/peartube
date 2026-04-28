import {
  CustomAudioDecoder,
  CustomAudioEncoder,
  CustomVideoDecoder,
  CustomVideoEncoder,
} from 'mediabunny'

import { normalizeNativeCodecCapabilities } from './native-codec-capabilities.mjs'

export function getNativeMobileCoderRegistrationPlan(rawCapabilities = {}) {
  const capabilities = normalizeNativeCodecCapabilities(rawCapabilities)
  const encoders = []
  const decoders = []

  if (capabilities.video.encoders.includes('avc')) encoders.push('NativeAvcEncoder')
  if (capabilities.audio.encoders.includes('aac')) encoders.push('NativeAacEncoder')
  if (capabilities.video.decoders.includes('avc')) decoders.push('NativeAvcDecoder')
  if (capabilities.audio.decoders.includes('aac')) decoders.push('NativeAacDecoder')

  return {
    encoders,
    decoders,
    readyForNativeEncodeSpike: encoders.includes('NativeAvcEncoder') && encoders.includes('NativeAacEncoder'),
    normalizedCapabilities: capabilities,
  }
}

export async function createNativeMobileCoderClasses(rawCapabilities = {}) {
  const capabilities = normalizeNativeCodecCapabilities(rawCapabilities)
  const canEncodeAvc = capabilities.video.encoders.includes('avc')
  const canDecodeAvc = capabilities.video.decoders.includes('avc')
  const canEncodeAac = capabilities.audio.encoders.includes('aac')
  const canDecodeAac = capabilities.audio.decoders.includes('aac')

  class NativeAvcEncoder extends CustomVideoEncoder {
    static supports(codec, _config) {
      return canEncodeAvc && codec === 'avc'
    }

    async init() {}

    async encode(_videoSample, _options = {}) {
      throw new Error('Native AVC encoder bridge is not implemented yet')
    }

    async flush() {}

    async close() {}
  }

  class NativeAacEncoder extends CustomAudioEncoder {
    static supports(codec, _config) {
      return canEncodeAac && codec === 'aac'
    }

    async init() {}

    async encode(_audioSample) {
      throw new Error('Native AAC encoder bridge is not implemented yet')
    }

    async flush() {}

    async close() {}
  }

  class NativeAvcDecoder extends CustomVideoDecoder {
    static supports(codec, _config) {
      return canDecodeAvc && codec === 'avc'
    }

    async init() {}

    async decode(_packet) {
      throw new Error('Native AVC decoder bridge is not implemented yet')
    }

    async flush() {}

    async close() {}
  }

  class NativeAacDecoder extends CustomAudioDecoder {
    static supports(codec, _config) {
      return canDecodeAac && codec === 'aac'
    }

    async init() {}

    async decode(_packet) {
      throw new Error('Native AAC decoder bridge is not implemented yet')
    }

    async flush() {}

    async close() {}
  }

  return {
    NativeAvcEncoder,
    NativeAacEncoder,
    NativeAvcDecoder,
    NativeAacDecoder,
  }
}
