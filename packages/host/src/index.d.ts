export type HostReadyData = {
  blobServerPort: number | null
  blobServerReady?: boolean
  blobServerError?: string | null
  protocolVersion: 3
}

export type HostLifecycleEvent =
  | { type: 'host.ready'; data: HostReadyData }
  | { type: 'host.error'; code: string; message: string; retryable: boolean }
  | { type: 'transport.closed'; reason?: string }

export const PROTOCOL_VERSION: 2

export const HOST_ERROR_CODES: {
  readonly HOST_START_FAILED: 'HOST_START_FAILED'
  readonly STORAGE_INIT_FAILED: 'STORAGE_INIT_FAILED'
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED'
  readonly TRANSPORT_DISCONNECTED: 'TRANSPORT_DISCONNECTED'
  readonly PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH'
  readonly CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE'
  readonly OFFLINE_UNAVAILABLE: 'OFFLINE_UNAVAILABLE'
  readonly REPLICATION_TIMEOUT: 'REPLICATION_TIMEOUT'
  readonly PLAYBACK_URL_UNAVAILABLE: 'PLAYBACK_URL_UNAVAILABLE'
  readonly PLAYER_LOAD_FAILED: 'PLAYER_LOAD_FAILED'
}

export function createHostError(
  code: string,
  message: string,
  options?: { cause?: unknown; retryable?: boolean }
): Error & { code: string; retryable: boolean; cause?: unknown }
