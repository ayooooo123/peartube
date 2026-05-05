export function createFeedSnapshot(options?: {
  videos?: any[]
  channelMeta?: Record<string, any>
  identityDriveKey?: string | null | undefined
  now?: number
  limit?: number
}): { version: number; savedAt: number; videos: any[] }

export function restoreFeedSnapshot(snapshot: any, options?: {
  now?: number
  maxAgeMs?: number
  limit?: number
}): any[]

export function getSnapshotChannelKeys(videos?: any[]): string[]
