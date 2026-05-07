export function withFeedTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T>

export function mergeUniqueFeedVideos<T extends { channelKey?: string; driveKey?: string; id?: string; path?: string }>(
  previousVideos?: T[],
  incomingVideos?: T[],
  limit?: number,
): T[]

export function getVerticalFeedPreviewVideos<T = any>(
  entries: any[],
  options?: {
    identityDriveKey?: string
    channelMeta?: Record<string, any>
    limit?: number
  },
): T[]

export function mapHydratedVerticalFeedVideos<T = any>(
  entry: any,
  videoList: T[],
  options?: { identityDriveKey?: string },
): T[]

export function clearHydratedFeedChannels(hydratedChannelsRef: { current?: { clear?: () => void } } | null | undefined): void

export function warmNextPlaybackUrls(options: {
  videos: any[]
  activeIndex: number
  makePlaybackRequest: (video: any) => { cacheKey?: string | null; playbackRequest: any }
  getCachedVideoUrl: (cacheKey: string) => string | null | undefined
  setCachedVideoUrl: (cacheKey: string, url: string) => void
  preparePlayback?: (request: any) => Promise<{ url?: string | null } | null | undefined>
  windowSize?: number
}): Promise<void>
