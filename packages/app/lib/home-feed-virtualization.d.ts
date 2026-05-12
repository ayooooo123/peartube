import type { VideoData } from '@peartube/core'

export function getHomeFeedVideosForCategory<T extends VideoData>(videos: T[], activeCategory: string): T[]

export function chunkHomeFeedRows<T extends VideoData>(videos: T[], columns: number): T[][]

export function getVirtualizedHomeFeedRows<T extends VideoData>(options: {
  videos: T[]
  activeCategory?: string
  columns?: number
}): T[][]
