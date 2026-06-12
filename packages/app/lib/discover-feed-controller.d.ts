export function withFeedTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T>

export function mergeUniqueFeedVideos<T extends { channelKey?: string; driveKey?: string; id?: string; path?: string }>(
  previousVideos?: T[],
  incomingVideos?: T[],
  limit?: number,
): T[]

export function mergeVerticalFeedEntries<T extends { channelKey?: string; driveKey?: string }>(
  previousEntries?: T[],
  incomingEntries?: T[],
): T[]

export function getVerticalFeedHydrationKey(entry: any): string

export function pruneHydratedFeedChannels(
  hydratedChannelsRef: { current?: Set<string> } | null | undefined,
  entries?: any[],
): void

export function hasRichVerticalFeedSnapshot(entries?: any[], videos?: any[]): boolean

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

