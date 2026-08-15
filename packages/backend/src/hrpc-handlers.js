let sharedBackendModulesPromise = null

function loadSharedBackendModules() {
  if (!sharedBackendModulesPromise) {
    sharedBackendModulesPromise = Promise.all([
      import('./api.js'),
      import('./storage.js'),
      import('./upload.js'),
      import('./video-stats.js'),
      import('./seeding.js'),
    ]).then(([apiModule, storageModule, uploadModule, videoStatsModule, seedingModule]) => ({
      apiModule,
      storageModule,
      uploadModule,
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
  'AddToPlaylist',
  'AssessSourceOffload',
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
  'DesktopBootstrap',
  'DesktopRefreshBrowse',
  'DesktopShutdown',
  'CreateIdentity',
  'DeleteVideo',
  'DownloadVideo',
  'EventCastDeviceFound',
  'EventDownloadProgress',
  'EventCastDeviceLost',
  'EventCastPlaybackState',
  'EventCastTimeUpdate',
  'EventError',
  'EventMediaGraphUpdate',
  'EventLog',
  'EventReady',
  'EventTranscodeProgress',
  'EventUploadProgress',
  'EventVideoStats',
  'FfmpegDecodeAvailable',
  'GetBlobServerPort',
  'GetChannel',
  'GetChannelMeta',
  'GetContentCatalog',
  'GetContentItems',
  'GetMediaCatalog',
  'GetMediaAgent',
  'GetMediaCollection',
  'GetMediaCollectionItems',
  'GetMediaEntity',
  'GetAgentContributions',
  'GetPublicationSources',
  'GetClaimProvenance',
  'SetSourcePreference',
  'GetIdentities',
  'GetIdentity',
  'GetPinnedChannels',
  'GetReactions',
  'GetRecommendations',
  'GetSeedingStatus',
  'GetStatus',
  'GetStorageStats',
  'GetSubscriptions',
  'GetSwarmStatus',
  'GetTranscodeSettings',
  'GetVideoData',
  'GetVideoMetadata',
  'GetVideoRecommendations',
  'GetVideoStats',
  'GetLivestreamStatus',
  'GetVideoThumbnail',
  'GetVideoUrl',
  'PrepareLivePlayback',
  'PreparePlayback',
  'ProvisionPublisherCatalog',
  'PreparePublisherRootOperation',
  'GlobalSearchVideos',
  'HideChannel',
  'HideComment',
  'IndexVideoVectors',
  'JoinChannel',
  'ListComments',
  'ListDevices',
  'ListVideos',
  'LogWatchEvent',
  'ConfirmSourceOffload',
  'PairDevice',
  'PickImageFile',
  'PickVideoFile',
  'PinChannel',
  'PrefetchVideo',
  'RecoverIdentity',
  'RemoveComment',
  'RemoveReaction',
  'GetNetworkPolicy',
  'SuspendNetwork',
  'ResumeNetwork',
  'SetPlaybackActive',
  'RetrySyncChannel',
  'SearchVideos',
  'SetActiveIdentity',
  'SetSeedingConfig',
  'SetNetworkPolicy',
  'SetStorageLimit',
  'SetTranscodeSettings',
  'SetVideoThumbnail',
  'SetVideoThumbnailFromFile',
  'StartLivestream',
  'StopLivestream',
  'SubmitPublisherRootOperation',
  'SubscribeChannel',
  'TranscodeStart',
  'TranscodeStatus',
  'TranscodeStop',
  'UnpinChannel',
  'UnsubscribeChannel',
  'UpdateChannel',
  'UpdateChannelAvatar',
  'UpdateVideoMetadata',
  'UploadVideo',
  'VerifyAttestation',
  'WebPreparePlayback',
  // Operability, migration, portability, and local capacity diagnostics
  'GetMigrationStatus',
  'RetryMigration',
  'ExportMigrationReport',
  'GetPublisherDeviceStatus',
  'ExportPortableState',
  'RestorePortableState',
  'PreviewStorageLimit',
  'GetArchiveOperatorStatus',
  'GetArchiveParticipation',
  'SetArchiveParticipation',
  'RequestArchivePublication',
  // Personal Sync (playlists / history / settings)
  'CreatePlaylist',
  'UpdatePlaylist',
  'DeletePlaylist',
  'RemoveFromPlaylist',
  'GetPlaylists',
  'GetPlaylistItems',
  'LogWatchHistory',
  'GetWatchHistory',
  'GetResumePosition',
  'ListResumePositions',
  'SetPersonalSetting',
  'GetPersonalSettings',
  'ProvisionPersonalEncryption',
]

function toCamelCase(name) {
  return `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`
}

function getSharedHandler(backend, name) {
  const direct = backend?.sharedHandlers?.[name]
  if (typeof direct === 'function') return direct

  const onName = backend?.[`on${name}`]
  if (typeof onName === 'function') return onName

  const camelName = toCamelCase(name)
  const camel = backend?.[camelName]
  if (typeof camel === 'function') return camel

  const apiHandler = backend?.api?.[camelName]
  if (typeof apiHandler === 'function') return apiHandler

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
