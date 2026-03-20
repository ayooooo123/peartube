let sharedBackendModulesPromise = null

function loadSharedBackendModules() {
  if (!sharedBackendModulesPromise) {
    sharedBackendModulesPromise = Promise.all([
      import('./api.js'),
      import('./storage.js'),
      import('./upload.js'),
      import('./public-feed.js'),
      import('./video-stats.js'),
      import('./seeding.js'),
    ]).then(([apiModule, storageModule, uploadModule, publicFeedModule, videoStatsModule, seedingModule]) => ({
      apiModule,
      storageModule,
      uploadModule,
      publicFeedModule,
      videoStatsModule,
      seedingModule,
    }))
  }

  return sharedBackendModulesPromise
}

// Keep shared handler registration centralized even as client packages group the
// same methods into higher-level namespaces like system/feed/video/shell.
export const SHARED_HANDLER_NAMES = [
  'AddComment',
  'AddReaction',
  'AttestDevice',
  'BootstrapDevice',
  'CastAddManualDevice',
  'CastAvailable',
  'CastConnect',
  'CastDisconnect',
  'CastGetDevices',
  'CastGetState',
  'CastIsConnected',
  'CastPause',
  'CastPlay',
  'CastResume',
  'CastSeek',
  'CastSetVolume',
  'CastStartDiscovery',
  'CastStop',
  'CastStopDiscovery',
  'ClearCache',
  'CreateDeviceInvite',
  'CreateIdentity',
  'DeleteVideo',
  'DownloadVideo',
  'EventCastDeviceFound',
  'EventCastDeviceLost',
  'EventCastPlaybackState',
  'EventCastTimeUpdate',
  'EventError',
  'EventFeedUpdate',
  'EventLog',
  'EventReady',
  'EventTranscodeProgress',
  'EventUploadProgress',
  'EventVideoStats',
  'GetBlobServerPort',
  'GetChannel',
  'GetChannelMeta',
  'GetIdentities',
  'GetIdentity',
  'GetPinnedChannels',
  'GetPublicFeed',
  'GetReactions',
  'GetSeedingStatus',
  'GetStatus',
  'GetStorageStats',
  'GetSubscriptions',
  'GetSwarmStatus',
  'GetTranscodeSettings',
  'GetVideoData',
  'GetVideoMetadata',
  'GetVideoStats',
  'GetVideoThumbnail',
  'GetVideoUrl',
  'GlobalSearchVideos',
  'HideChannel',
  'HideComment',
  'IsChannelPublished',
  'JoinChannel',
  'ListComments',
  'ListDevices',
  'ListVideos',
  'MpvAvailable',
  'MpvCreate',
  'MpvDestroy',
  'MpvGetState',
  'MpvLoadFile',
  'MpvPause',
  'MpvPlay',
  'MpvRenderFrame',
  'MpvSeek',
  'PairDevice',
  'PickImageFile',
  'PickVideoFile',
  'PinChannel',
  'PrefetchVideo',
  'RecoverIdentity',
  'RefreshFeed',
  'RemoveComment',
  'RemoveReaction',
  'SetActiveIdentity',
  'SetSeedingConfig',
  'SetStorageLimit',
  'SetTranscodeSettings',
  'SetVideoThumbnail',
  'SetVideoThumbnailFromFile',
  'SubmitToFeed',
  'SubscribeChannel',
  'TranscodeStart',
  'TranscodeStatus',
  'TranscodeStop',
  'UnpinChannel',
  'UnpublishFromFeed',
  'UnsubscribeChannel',
  'UpdateChannel',
  'UpdateChannelAvatar',
  'UpdateVideoMetadata',
  'UploadVideo',
  'VerifyAttestation',
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

  return null
}

async function invokeSharedHandler(name, rpc, backend, req) {
  const handler = getSharedHandler(backend, name)
  if (typeof handler !== 'function') {
    throw new Error(`Missing shared HRPC handler implementation: ${name}`)
  }

  const modules = await loadSharedBackendModules()

  return handler(req, {
    rpc,
    backend,
    modules,
  })
}

export function registerSharedHandlers(rpc, backend) {
  if (!rpc || !backend) {
    throw new Error('registerSharedHandlers requires rpc and backend')
  }

  for (const name of SHARED_HANDLER_NAMES) {
    const methodName = `on${name}`
    const register = rpc[methodName]
    if (typeof register === 'function') {
      register.call(rpc, async (req) => invokeSharedHandler(name, rpc, backend, req))
    }
  }

  return SHARED_HANDLER_NAMES
}
