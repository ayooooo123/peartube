export const PROTOCOL_EVENTS = Object.freeze({
  HOST_READY: 'host.ready',
  HOST_ERROR: 'host.error',
  LOG: 'log',
  UPLOAD_PROGRESS: 'upload.progress',
  DOWNLOAD_PROGRESS: 'download.progress',
  FEED_UPDATED: 'feed.updated',
  NETWORK_STATUS: 'network.status',
  VIDEO_STATS: 'video.stats',
  CAST_DEVICE_FOUND: 'cast.deviceFound',
  CAST_DEVICE_LOST: 'cast.deviceLost',
  CAST_PLAYBACK_STATE: 'cast.playbackState',
  CAST_TIME_UPDATE: 'cast.timeUpdate',
  TRANSPORT_CLOSED: 'transport.closed'
})

export const PROTOCOL_EVENT_BINDINGS = Object.freeze([
  ['onEventReady', PROTOCOL_EVENTS.HOST_READY],
  ['onEventError', PROTOCOL_EVENTS.HOST_ERROR],
  ['onEventLog', PROTOCOL_EVENTS.LOG],
  ['onEventUploadProgress', PROTOCOL_EVENTS.UPLOAD_PROGRESS],
  ['onEventDownloadProgress', PROTOCOL_EVENTS.DOWNLOAD_PROGRESS],
  ['onEventFeedUpdate', PROTOCOL_EVENTS.FEED_UPDATED],
  ['onEventVideoStats', PROTOCOL_EVENTS.VIDEO_STATS],
  ['onEventCastDeviceFound', PROTOCOL_EVENTS.CAST_DEVICE_FOUND],
  ['onEventCastDeviceLost', PROTOCOL_EVENTS.CAST_DEVICE_LOST],
  ['onEventCastPlaybackState', PROTOCOL_EVENTS.CAST_PLAYBACK_STATE],
  ['onEventCastTimeUpdate', PROTOCOL_EVENTS.CAST_TIME_UPDATE]
])
