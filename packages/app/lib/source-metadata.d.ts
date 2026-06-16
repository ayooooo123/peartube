export interface SourceMetadataDisplay {
  hasSource: boolean
  platformKey: string
  platformLabel: string
  creatorLabel: string
  compactLine: string
  detailCounts: string
  publishedText: string | null
  archivedText: string | null
  archiveLine: string
  sourceUrl: string
  sourceDescription: string
}

export function hasSourceMetadata(video?: any): boolean
export function formatSourceCount(value: any, singular: string, plural?: string): string | null
export function formatSourceTimeAgo(timestamp: any, now?: number): string | null
export function getSourceMetadataDisplay(video?: any, options?: { now?: number }): SourceMetadataDisplay
