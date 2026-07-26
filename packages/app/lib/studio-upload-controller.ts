import type { UploadVideoEpisodeMetadata } from '@peartube/core'

const SERIES_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const TMDB_ID = /^[1-9][0-9]{0,19}$/
const POSITIVE_INTEGER = /^[1-9][0-9]{0,5}$/
const MAX_EPISODE_NUMBER = 100000

export type StudioEpisodeMediaInput = {
  enabled: boolean
  seriesId?: string
  seriesTitle?: string
  tmdbId?: string
  seasonNumber?: string
  episodeNumber?: string
  expectedEpisodeCount?: string
}

export type StudioUploadOptions = {
  filePath: string
  title: string
  mimeType: string
  category: string
  onProgress?: (progress: number, speed?: number, eta?: number, isTranscoding?: boolean) => void
  skipThumbnailGeneration?: boolean
  media?: StudioEpisodeMediaInput
}

type UploadVideo = (
  filePath: string,
  title: string,
  description: string,
  mimeType: string,
  category: string,
  onProgress?: StudioUploadOptions['onProgress'],
  skipThumbnailGeneration?: boolean,
  mediaMetadata?: UploadVideoEpisodeMetadata,
) => Promise<any>

function requiredBoundedString(
  value: string | undefined,
  label: string,
  maximumBytes: number,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 ||
      new TextEncoder().encode(value).byteLength > maximumBytes ||
      value.includes('\0') || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function positiveInteger(value: string | undefined, label: string): number {
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) {
    throw new Error(`${label} must be a positive number`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > MAX_EPISODE_NUMBER) {
    throw new Error(`${label} must be at most ${MAX_EPISODE_NUMBER}`)
  }
  return number
}

export function normalizeStudioEpisodeMetadata(
  input: StudioEpisodeMediaInput | undefined,
): UploadVideoEpisodeMetadata | undefined {
  if (!input?.enabled) return undefined
  return {
    contentKind: 'episode',
    seriesId: requiredBoundedString(input.seriesId, 'Series ID', 128, SERIES_ID),
    seriesTitle: requiredBoundedString(input.seriesTitle, 'Series title', 512),
    mediaProvider: 'tmdb',
    mediaId: requiredBoundedString(input.tmdbId, 'TMDB series ID', 20, TMDB_ID),
    seasonNumber: positiveInteger(input.seasonNumber, 'Season number'),
    episodeNumber: positiveInteger(input.episodeNumber, 'Episode number'),
    expectedEpisodeCount: positiveInteger(input.expectedEpisodeCount, 'Expected episode count'),
  }
}

export async function uploadStudioVideo(
  uploadVideo: UploadVideo,
  options: StudioUploadOptions,
): Promise<any> {
  const mediaMetadata = normalizeStudioEpisodeMetadata(options.media)
  return uploadVideo(
    options.filePath,
    options.title,
    '',
    options.mimeType,
    options.category,
    options.onProgress,
    options.skipThumbnailGeneration,
    mediaMetadata,
  )
}
