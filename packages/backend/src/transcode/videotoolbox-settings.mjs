/**
 * VideoToolbox Settings Module
 *
 * Manages VideoToolbox hardware decode and hwmap settings for macOS/iOS.
 * Extracted from hls-transcoder.mjs to allow independent import.
 */

const isPearRuntime = typeof globalThis !== 'undefined' && typeof globalThis.Pear !== 'undefined'
const vtDecodeEnv = typeof process !== 'undefined' ? process?.env?.PEARTUBE_ENABLE_VT_DECODE : undefined
const vtDecodeEnvValue = vtDecodeEnv === '1' ? true : vtDecodeEnv === '0' ? false : null
const vtHwMapEnv = typeof process !== 'undefined' ? process?.env?.PEARTUBE_ENABLE_VT_HWMAP : undefined
const vtHwMapEnvValue = vtHwMapEnv === '1' ? true : vtHwMapEnv === '0' ? false : null
const videoToolboxDecodeDefault = !isPearRuntime
const videoToolboxHwMapDefault = isPearRuntime
let videoToolboxDecodeEnabled = vtDecodeEnvValue ?? videoToolboxDecodeDefault
let videoToolboxDecodeSource = vtDecodeEnvValue !== null ? 'env' : 'default'
let videoToolboxHwMapEnabled = vtHwMapEnvValue ?? videoToolboxHwMapDefault
let videoToolboxHwMapSource = vtHwMapEnvValue !== null ? 'env' : 'default'

export function getVideoToolboxDecodeSettings() {
  return {
    videoToolboxDecodeEnabled: videoToolboxDecodeEnabled,
    videoToolboxDecodeLocked: vtDecodeEnvValue !== null,
    videoToolboxDecodeDefault: videoToolboxDecodeDefault,
    videoToolboxDecodeSource: videoToolboxDecodeSource,
    videoToolboxHwMapEnabled: videoToolboxHwMapEnabled,
    videoToolboxHwMapLocked: vtHwMapEnvValue !== null,
    videoToolboxHwMapDefault: videoToolboxHwMapDefault,
    videoToolboxHwMapSource: videoToolboxHwMapSource
  }
}

export function setVideoToolboxDecodeEnabled(enabled, source = 'stored') {
  if (vtDecodeEnvValue !== null) return getVideoToolboxDecodeSettings()
  videoToolboxDecodeEnabled = Boolean(enabled)
  videoToolboxDecodeSource = source
  return getVideoToolboxDecodeSettings()
}

export function setVideoToolboxHwMapEnabled(enabled, source = 'stored') {
  if (vtHwMapEnvValue !== null) return getVideoToolboxDecodeSettings()
  videoToolboxHwMapEnabled = Boolean(enabled)
  videoToolboxHwMapSource = source
  return getVideoToolboxDecodeSettings()
}
