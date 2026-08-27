export const PROTOCOL_EVENTS = Object.freeze({
  HOST_READY: 'host.ready',
  HOST_ERROR: 'host.error',
  LOG: 'log',
  UPLOAD_PROGRESS: 'upload.progress',
  DOWNLOAD_PROGRESS: 'download.progress',
  TRANSCODE_PROGRESS: 'transcode.progress',
  MEDIA_GRAPH_UPDATED: 'mediaGraph.updated',
  NETWORK_STATUS: 'network.status',
  VIDEO_STATS: 'video.stats',
  CAST_DEVICE_FOUND: 'cast.deviceFound',
  CAST_DEVICE_LOST: 'cast.deviceLost',
  CAST_PLAYBACK_STATE: 'cast.playbackState',
  CAST_TIME_UPDATE: 'cast.timeUpdate',
  ACQUISITION_LIFECYCLE: 'acquisition.lifecycle',
  TRANSPORT_CLOSED: 'transport.closed'
})

export const PROTOCOL_EVENT_BINDINGS = Object.freeze([
  ['onEventReady', PROTOCOL_EVENTS.HOST_READY],
  ['onEventError', PROTOCOL_EVENTS.HOST_ERROR],
  ['onEventLog', PROTOCOL_EVENTS.LOG],
  ['onEventUploadProgress', PROTOCOL_EVENTS.UPLOAD_PROGRESS],
  ['onEventDownloadProgress', PROTOCOL_EVENTS.DOWNLOAD_PROGRESS],
  ['onEventTranscodeProgress', PROTOCOL_EVENTS.TRANSCODE_PROGRESS],
  ['onEventMediaGraphUpdate', PROTOCOL_EVENTS.MEDIA_GRAPH_UPDATED],
  ['onEventVideoStats', PROTOCOL_EVENTS.VIDEO_STATS],
  ['onEventCastDeviceFound', PROTOCOL_EVENTS.CAST_DEVICE_FOUND],
  ['onEventCastDeviceLost', PROTOCOL_EVENTS.CAST_DEVICE_LOST],
  ['onEventCastPlaybackState', PROTOCOL_EVENTS.CAST_PLAYBACK_STATE],
  ['onEventCastTimeUpdate', PROTOCOL_EVENTS.CAST_TIME_UPDATE],
  ['onEventAcquisitionLifecycle', PROTOCOL_EVENTS.ACQUISITION_LIFECYCLE]
])
