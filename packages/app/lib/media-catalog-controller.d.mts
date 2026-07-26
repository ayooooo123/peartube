import type { MediaCatalogResult, MediaCatalogState, MediaEntitySummary, MediaGraphUpdate } from '@peartube/core'

export interface MediaCatalogDiagnostic {
  kind: 'empty' | 'error'
  title: string
  detail: string
  errorCode?: string
  actionLabel: string
}

export interface MediaCatalogController {
  getState(): MediaCatalogState
  subscribe(listener: (state: MediaCatalogState) => void): () => void
  load(): Promise<MediaCatalogState>
  refresh(): Promise<MediaCatalogState>
  loadNext(): Promise<MediaCatalogState>
  handleGraphUpdate(update: MediaGraphUpdate): Promise<MediaCatalogState>
  handleForeground(): Promise<MediaCatalogState>
  destroy(): void
}

export function createMediaCatalogController(options: {
  getMediaCatalog(request: { cursor?: string; limit?: number }): Promise<MediaCatalogResult>
  pageSize?: number
}): MediaCatalogController

export function searchMediaCatalog(options: {
  getMediaCatalog(request: { cursor?: string; limit: number }): Promise<MediaCatalogResult>
  query: string
  cursor?: string
  limit?: number
}): Promise<MediaCatalogResult>

export function describeMediaCatalogState(
  state: MediaCatalogState,
  diagnostics?: { backendError?: string | null; startupStatus?: string | null; networkReason?: string | null },
): MediaCatalogDiagnostic | null

export type { MediaCatalogState, MediaEntitySummary }
