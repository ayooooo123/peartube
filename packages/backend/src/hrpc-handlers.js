export const SHARED_HANDLER_NAMES = [
  'AddComment', 'AddReaction', 'AttestDevice', 'BootstrapDevice',
  'CastAddManualDevice', 'CastAvailable', 'CastConnect', 'CastDisconnect', 'CastGetDevices', 'CastGetState', 'CastIsConnected', 'CastPause', 'CastPlay', 'CastResume', 'CastSeek', 'CastSetVolume', 'CastStartDiscovery', 'CastStop', 'CastStopDiscovery',
  'ClearCache', 'CreateDeviceInvite', 'DesktopBootstrap', 'DesktopRefreshBrowse', 'DesktopShutdown',
  'CreateIdentity', 'DeleteVideo', 'DownloadVideo',
  'EventCastDeviceFound', 'EventDownloadProgress', 'EventCastDeviceLost', 'EventCastPlaybackState', 'EventCastTimeUpdate', 'EventError', 'EventFeedUpdate', 'EventLog', 'EventReady', 'EventTranscodeProgress', 'EventUploadProgress', 'EventVideoStats',
  'FfmpegDecodeAvailable', 'GetBlobServerPort', 'GetChannel', 'GetChannelMeta', 'GetIdentities', 'GetIdentity', 'GetPinnedChannels', 'GetPublicFeed', 'GetReactions', 'GetRecommendations', 'GetSeedingStatus', 'GetStatus', 'GetStorageStats', 'GetSubscriptions', 'GetSwarmStatus', 'GetTranscodeSettings', 'GetVideoData', 'GetVideoMetadata', 'GetVideoRecommendations', 'GetVideoStats', 'GetVideoThumbnail', 'GetVideoUrl', 'PreparePlayback', 'GlobalSearchVideos',
  'HideChannel', 'HideComment', 'IndexVideoVectors', 'IsChannelPublished', 'JoinChannel', 'ListComments', 'ListDevices', 'ListVideos', 'LogWatchEvent',
  'MpvAvailable', 'MpvCreate', 'MpvDestroy', 'MpvGetState', 'MpvLoadFile', 'MpvPause', 'MpvPlay', 'MpvRenderFrame', 'MpvSeek',
  'PairDevice', 'PickImageFile', 'PickVideoFile', 'PinChannel', 'PrefetchVideo', 'RecoverIdentity', 'RefreshFeed', 'RemoveComment', 'RemoveReaction', 'RetrySyncChannel', 'SearchVideos', 'SetActiveIdentity', 'SetSeedingConfig', 'SetStorageLimit', 'SetTranscodeSettings', 'SetVideoThumbnail', 'SetVideoThumbnailFromFile', 'SubmitToFeed', 'SubscribeChannel', 'TranscodeStart', 'TranscodeStatus', 'TranscodeStop', 'UnpinChannel', 'UnpublishFromFeed', 'UnsubscribeChannel', 'UpdateChannel', 'UpdateChannelAvatar', 'UpdateVideoMetadata', 'UploadVideo', 'VerifyAttestation', 'WebPreparePlayback'
]

function toCamelCase(name) {
  return `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`
}

function getSharedHandler(backend, name) {
  const direct = backend?.sharedHandlers?.[name]
  if (typeof direct === 'function') return direct
  const onName = backend?.[`on${name}`]
  if (typeof onName === 'function') return onName
  const camel = backend?.[toCamelCase(name)]
  if (typeof camel === 'function') return camel
  const apiHandler = backend?.api?.[toCamelCase(name)]
  if (typeof apiHandler === 'function') return apiHandler
  return null
}

async function invokeSharedHandler(name, rpc, backend, req) {
  const handler = getSharedHandler(backend, name)
  if (typeof handler !== 'function') throw new Error(`Missing shared HRPC handler implementation: ${name}`)
  return handler(req, { rpc, backend, modules: {} })
}

export function registerSharedHandlers(rpc, backend) {
  if (!rpc || !backend) throw new Error('registerSharedHandlers requires rpc and backend')
  for (const name of SHARED_HANDLER_NAMES) {
    const register = rpc[`on${name}`]
    if (typeof register === 'function') register.call(rpc, (req) => invokeSharedHandler(name, rpc, backend, req))
  }
  return SHARED_HANDLER_NAMES
}
