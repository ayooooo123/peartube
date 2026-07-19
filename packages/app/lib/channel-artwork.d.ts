export const CHANNEL_ARTWORK_RESOLUTION_MS: number

export type BlobArtworkCandidate = {
  kind: 'blob'
  role: string
  blobId: string
  blobsCoreKey: string
  mimeType: string | null
}

export type RemoteArtworkCandidate = {
  kind: 'remote'
  role: string
  url: string
}

export type ArtworkCandidate = BlobArtworkCandidate | RemoteArtworkCandidate

export type ArtworkResolution = {
  url: string | null
  nextIndex: number
  provisional: boolean
  failedUrls: string[]
}

export type ArtworkResolutionOptions = {
  deadline?: number
  signal?: AbortSignal
  isStale?: () => boolean
  startIndex?: number
  blobResolverAvailable?: boolean
  initialProvisional?: boolean
  failedUrls?: readonly string[]
}

export function resolveArtworkCandidates(
  candidates: readonly ArtworkCandidate[] | null | undefined,
  resolveBlob: ((
    candidate: BlobArtworkCandidate,
    options: Pick<ArtworkResolutionOptions, 'deadline' | 'signal'>,
  ) => string | null | Promise<string | null>) | null | undefined,
  options?: ArtworkResolutionOptions,
): Promise<ArtworkResolution | null>
