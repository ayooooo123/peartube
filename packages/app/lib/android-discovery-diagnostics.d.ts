export function getAndroidDiscoveryPermissionRequests(options?: {
  platformOS?: string
  platformVersion?: string | number
  permissions?: Record<string, string>
}): string[]

export function classifyFeedDiscoveryState(options?: {
  ready?: boolean
  entries?: any[]
  videos?: any[]
  peerCount?: number
  swarmStatus?: any
  permissionStatus?: any
  hasCachedSnapshot?: boolean
}): {
  state:
    | 'backend-starting'
    | 'permission-degraded'
    | 'content-ready'
    | 'hydrating'
    | 'cached-fallback'
    | 'discovery-waiting'
    | 'network-degraded'
  recoverable: boolean
  reason?: string
}
