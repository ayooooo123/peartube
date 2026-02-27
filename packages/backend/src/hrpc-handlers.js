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

  rpc.onAddComment(async (req) => invokeSharedHandler('AddComment', rpc, backend, req))
  rpc.onAddReaction(async (req) => invokeSharedHandler('AddReaction', rpc, backend, req))
  rpc.onAttestDevice(async (req) => invokeSharedHandler('AttestDevice', rpc, backend, req))
  rpc.onBootstrapDevice(async (req) => invokeSharedHandler('BootstrapDevice', rpc, backend, req))
  rpc.onCastAddManualDevice(async (req) => invokeSharedHandler('CastAddManualDevice', rpc, backend, req))
  rpc.onCastAvailable(async (req) => invokeSharedHandler('CastAvailable', rpc, backend, req))
  rpc.onCastConnect(async (req) => invokeSharedHandler('CastConnect', rpc, backend, req))
  rpc.onCastDisconnect(async (req) => invokeSharedHandler('CastDisconnect', rpc, backend, req))
  rpc.onCastGetDevices(async (req) => invokeSharedHandler('CastGetDevices', rpc, backend, req))
  rpc.onCastGetState(async (req) => invokeSharedHandler('CastGetState', rpc, backend, req))
  rpc.onCastIsConnected(async (req) => invokeSharedHandler('CastIsConnected', rpc, backend, req))
  rpc.onCastPause(async (req) => invokeSharedHandler('CastPause', rpc, backend, req))
  rpc.onCastPlay(async (req) => invokeSharedHandler('CastPlay', rpc, backend, req))
  rpc.onCastResume(async (req) => invokeSharedHandler('CastResume', rpc, backend, req))
  rpc.onCastSeek(async (req) => invokeSharedHandler('CastSeek', rpc, backend, req))
  rpc.onCastSetVolume(async (req) => invokeSharedHandler('CastSetVolume', rpc, backend, req))
  rpc.onCastStartDiscovery(async (req) => invokeSharedHandler('CastStartDiscovery', rpc, backend, req))
  rpc.onCastStop(async (req) => invokeSharedHandler('CastStop', rpc, backend, req))
  rpc.onCastStopDiscovery(async (req) => invokeSharedHandler('CastStopDiscovery', rpc, backend, req))
  rpc.onClearCache(async (req) => invokeSharedHandler('ClearCache', rpc, backend, req))
  rpc.onCreateDeviceInvite(async (req) => invokeSharedHandler('CreateDeviceInvite', rpc, backend, req))
  rpc.onCreateIdentity(async (req) => invokeSharedHandler('CreateIdentity', rpc, backend, req))
  rpc.onDeleteVideo(async (req) => invokeSharedHandler('DeleteVideo', rpc, backend, req))
  rpc.onDownloadVideo(async (req) => invokeSharedHandler('DownloadVideo', rpc, backend, req))
  rpc.onEventCastDeviceFound(async (req) => invokeSharedHandler('EventCastDeviceFound', rpc, backend, req))
  rpc.onEventCastDeviceLost(async (req) => invokeSharedHandler('EventCastDeviceLost', rpc, backend, req))
  rpc.onEventCastPlaybackState(async (req) => invokeSharedHandler('EventCastPlaybackState', rpc, backend, req))
  rpc.onEventCastTimeUpdate(async (req) => invokeSharedHandler('EventCastTimeUpdate', rpc, backend, req))
  rpc.onEventError(async (req) => invokeSharedHandler('EventError', rpc, backend, req))
  rpc.onEventFeedUpdate(async (req) => invokeSharedHandler('EventFeedUpdate', rpc, backend, req))
  rpc.onEventLog(async (req) => invokeSharedHandler('EventLog', rpc, backend, req))
  rpc.onEventReady(async (req) => invokeSharedHandler('EventReady', rpc, backend, req))
  rpc.onEventTranscodeProgress(async (req) => invokeSharedHandler('EventTranscodeProgress', rpc, backend, req))
  rpc.onEventUploadProgress(async (req) => invokeSharedHandler('EventUploadProgress', rpc, backend, req))
  rpc.onEventVideoStats(async (req) => invokeSharedHandler('EventVideoStats', rpc, backend, req))
  rpc.onGetBlobServerPort(async (req) => invokeSharedHandler('GetBlobServerPort', rpc, backend, req))
  rpc.onGetChannel(async (req) => invokeSharedHandler('GetChannel', rpc, backend, req))
  rpc.onGetChannelMeta(async (req) => invokeSharedHandler('GetChannelMeta', rpc, backend, req))
  rpc.onGetIdentities(async (req) => invokeSharedHandler('GetIdentities', rpc, backend, req))
  rpc.onGetIdentity(async (req) => invokeSharedHandler('GetIdentity', rpc, backend, req))
  rpc.onGetPinnedChannels(async (req) => invokeSharedHandler('GetPinnedChannels', rpc, backend, req))
  rpc.onGetPublicFeed(async (req) => invokeSharedHandler('GetPublicFeed', rpc, backend, req))
  rpc.onGetReactions(async (req) => invokeSharedHandler('GetReactions', rpc, backend, req))
  rpc.onGetSeedingStatus(async (req) => invokeSharedHandler('GetSeedingStatus', rpc, backend, req))
  rpc.onGetStatus(async (req) => invokeSharedHandler('GetStatus', rpc, backend, req))
  rpc.onGetStorageStats(async (req) => invokeSharedHandler('GetStorageStats', rpc, backend, req))
  rpc.onGetSubscriptions(async (req) => invokeSharedHandler('GetSubscriptions', rpc, backend, req))
  rpc.onGetSwarmStatus(async (req) => invokeSharedHandler('GetSwarmStatus', rpc, backend, req))
  rpc.onGetTranscodeSettings(async (req) => invokeSharedHandler('GetTranscodeSettings', rpc, backend, req))
  rpc.onGetVideoData(async (req) => invokeSharedHandler('GetVideoData', rpc, backend, req))
  rpc.onGetVideoMetadata(async (req) => invokeSharedHandler('GetVideoMetadata', rpc, backend, req))
  rpc.onGetVideoStats(async (req) => invokeSharedHandler('GetVideoStats', rpc, backend, req))
  rpc.onGetVideoThumbnail(async (req) => invokeSharedHandler('GetVideoThumbnail', rpc, backend, req))
  rpc.onGetVideoUrl(async (req) => invokeSharedHandler('GetVideoUrl', rpc, backend, req))
  rpc.onGlobalSearchVideos(async (req) => invokeSharedHandler('GlobalSearchVideos', rpc, backend, req))
  rpc.onHideChannel(async (req) => invokeSharedHandler('HideChannel', rpc, backend, req))
  rpc.onHideComment(async (req) => invokeSharedHandler('HideComment', rpc, backend, req))
  rpc.onIsChannelPublished(async (req) => invokeSharedHandler('IsChannelPublished', rpc, backend, req))
  rpc.onJoinChannel(async (req) => invokeSharedHandler('JoinChannel', rpc, backend, req))
  rpc.onListComments(async (req) => invokeSharedHandler('ListComments', rpc, backend, req))
  rpc.onListDevices(async (req) => invokeSharedHandler('ListDevices', rpc, backend, req))
  rpc.onListVideos(async (req) => invokeSharedHandler('ListVideos', rpc, backend, req))
  rpc.onMpvAvailable(async (req) => invokeSharedHandler('MpvAvailable', rpc, backend, req))
  rpc.onMpvCreate(async (req) => invokeSharedHandler('MpvCreate', rpc, backend, req))
  rpc.onMpvDestroy(async (req) => invokeSharedHandler('MpvDestroy', rpc, backend, req))
  rpc.onMpvGetState(async (req) => invokeSharedHandler('MpvGetState', rpc, backend, req))
  rpc.onMpvLoadFile(async (req) => invokeSharedHandler('MpvLoadFile', rpc, backend, req))
  rpc.onMpvPause(async (req) => invokeSharedHandler('MpvPause', rpc, backend, req))
  rpc.onMpvPlay(async (req) => invokeSharedHandler('MpvPlay', rpc, backend, req))
  rpc.onMpvRenderFrame(async (req) => invokeSharedHandler('MpvRenderFrame', rpc, backend, req))
  rpc.onMpvSeek(async (req) => invokeSharedHandler('MpvSeek', rpc, backend, req))
  rpc.onPairDevice(async (req) => invokeSharedHandler('PairDevice', rpc, backend, req))
  rpc.onPickImageFile(async (req) => invokeSharedHandler('PickImageFile', rpc, backend, req))
  rpc.onPickVideoFile(async (req) => invokeSharedHandler('PickVideoFile', rpc, backend, req))
  rpc.onPinChannel(async (req) => invokeSharedHandler('PinChannel', rpc, backend, req))
  rpc.onPrefetchVideo(async (req) => invokeSharedHandler('PrefetchVideo', rpc, backend, req))
  rpc.onRecoverIdentity(async (req) => invokeSharedHandler('RecoverIdentity', rpc, backend, req))
  rpc.onRefreshFeed(async (req) => invokeSharedHandler('RefreshFeed', rpc, backend, req))
  rpc.onRemoveComment(async (req) => invokeSharedHandler('RemoveComment', rpc, backend, req))
  rpc.onRemoveReaction(async (req) => invokeSharedHandler('RemoveReaction', rpc, backend, req))
  rpc.onSetActiveIdentity(async (req) => invokeSharedHandler('SetActiveIdentity', rpc, backend, req))
  rpc.onSetSeedingConfig(async (req) => invokeSharedHandler('SetSeedingConfig', rpc, backend, req))
  rpc.onSetStorageLimit(async (req) => invokeSharedHandler('SetStorageLimit', rpc, backend, req))
  rpc.onSetTranscodeSettings(async (req) => invokeSharedHandler('SetTranscodeSettings', rpc, backend, req))
  rpc.onSetVideoThumbnail(async (req) => invokeSharedHandler('SetVideoThumbnail', rpc, backend, req))
  rpc.onSetVideoThumbnailFromFile(async (req) => invokeSharedHandler('SetVideoThumbnailFromFile', rpc, backend, req))
  rpc.onSubmitToFeed(async (req) => invokeSharedHandler('SubmitToFeed', rpc, backend, req))
  rpc.onSubscribeChannel(async (req) => invokeSharedHandler('SubscribeChannel', rpc, backend, req))
  rpc.onTranscodeStart(async (req) => invokeSharedHandler('TranscodeStart', rpc, backend, req))
  rpc.onTranscodeStatus(async (req) => invokeSharedHandler('TranscodeStatus', rpc, backend, req))
  rpc.onTranscodeStop(async (req) => invokeSharedHandler('TranscodeStop', rpc, backend, req))
  rpc.onUnpinChannel(async (req) => invokeSharedHandler('UnpinChannel', rpc, backend, req))
  rpc.onUnpublishFromFeed(async (req) => invokeSharedHandler('UnpublishFromFeed', rpc, backend, req))
  rpc.onUnsubscribeChannel(async (req) => invokeSharedHandler('UnsubscribeChannel', rpc, backend, req))
  rpc.onUpdateChannel(async (req) => invokeSharedHandler('UpdateChannel', rpc, backend, req))
  rpc.onUpdateChannelAvatar(async (req) => invokeSharedHandler('UpdateChannelAvatar', rpc, backend, req))
  rpc.onUpdateVideoMetadata(async (req) => invokeSharedHandler('UpdateVideoMetadata', rpc, backend, req))
  rpc.onUploadVideo(async (req) => invokeSharedHandler('UploadVideo', rpc, backend, req))
  rpc.onVerifyAttestation(async (req) => invokeSharedHandler('VerifyAttestation', rpc, backend, req))

  return SHARED_HANDLER_NAMES
}
