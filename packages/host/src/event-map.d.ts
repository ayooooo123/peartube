export const PROTOCOL_EVENTS: {
  readonly HOST_READY: 'host.ready'
  readonly HOST_ERROR: 'host.error'
  readonly LOG: 'log'
  readonly UPLOAD_PROGRESS: 'upload.progress'
  readonly DOWNLOAD_PROGRESS: 'download.progress'
  readonly TRANSCODE_PROGRESS: 'transcode.progress'
  readonly MEDIA_GRAPH_UPDATED: 'mediaGraph.updated'
  readonly NETWORK_STATUS: 'network.status'
  readonly VIDEO_STATS: 'video.stats'
  readonly CAST_DEVICE_FOUND: 'cast.deviceFound'
  readonly CAST_DEVICE_LOST: 'cast.deviceLost'
  readonly CAST_PLAYBACK_STATE: 'cast.playbackState'
  readonly CAST_TIME_UPDATE: 'cast.timeUpdate'
  readonly TRANSPORT_CLOSED: 'transport.closed'
}

export const PROTOCOL_EVENT_BINDINGS: ReadonlyArray<readonly [string, string]>
