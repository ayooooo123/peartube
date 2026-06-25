export function hasDirectBlobRef(video?: any): boolean
export function hasDirectBlobReadinessProof(video?: any): boolean
export function isFeedVideoPlaybackReady(video?: any, identityDriveKey?: string | null): boolean
export function isFeedVideoStreamAddressable(video?: any, identityDriveKey?: string | null): boolean
export function getMissingChannelMetaRequests(feedEntries: any[], channelMeta: Record<string, any>, limit?: number): any[]
export function getVisibleSeededFeedEntries(feedEntries: any[], limit?: number): any[]
export function getFeedVideoLoadEntries(feedEntries: any[], limit?: number): any[]
export function getFeedPreviewVideos(feedEntries: any[], channelMeta: Record<string, any>, identityDriveKey?: string | null, limit?: number): any[]
export function getFeedVideoHydrationMode(options: { feedEntries?: any[]; swarmStatus?: any }): 'off' | 'local-only' | 'network'
export function shouldAutoLoadFeedVideos(options: { feedEntries?: any[]; swarmStatus?: any }): boolean
export function selectFeedEntryVideosWithPreviewFallback(loadedVideos?: any[], previewFallback?: any[]): any[]
export function shouldKeepFeedVideoForVisibleEntries(options: {
  video?: any
  seededFeedChannelKeys?: Set<string>
  snapshotChannelKeys?: Set<string>
}): boolean
export function shouldRenderFeedVideo(options: { video?: any; identityDriveKey?: string | null }): boolean
export function isConfirmedFeedHydrationResult(options: { entry?: any; resolved?: boolean; videos?: any[] }): boolean
export function mergeHydratedFeedVideos(options: {
  previousVideos?: any[]
  incomingVideos?: any[]
  refreshedChannelKeys?: string[]
  feedEntries?: any[]
  identityDriveKey?: string | null
  limit?: number
}): any[]
export function mergePreviewFeedVideos(options: {
  previousVideos?: any[]
  previewVideos?: any[]
  limit?: number
}): any[]
