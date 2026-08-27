export type ProviderHit = {
  resolutionRef: string
  title: string
  subtitle?: string | null
  mediaKind?: string | null
  published: boolean
  acquirable: boolean
  entityId?: string | null
  publicationId?: string | null
}

export type ProviderResolution = ProviderHit & {
  schemaVersion: 1
  publisherId: string
}

export type AcquisitionState =
  | 'queued'
  | 'acquiring'
  | 'verifying'
  | 'publishing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type Acquisition = {
  acquisitionId: string
  state: AcquisitionState
  retentionClass: RetentionClass
  bytesAcquired: number
  expectedBytes?: number | null
  publicationId?: string | null
  errorCode?: string | null
  recoverable: boolean
}

export type RetentionClass = 'contribution-cache' | 'archive-pin'

export const RETENTION_CHOICES: ReadonlyArray<{
  value: RetentionClass
  label: string
  detail: string
}> = [
  {
    value: 'contribution-cache',
    label: 'Stream once',
    detail: 'Use playback cache; evicted as space is needed.',
  },
  {
    value: 'archive-pin',
    label: 'Keep after watching',
    detail: 'Keep available on this device within its archive budget.',
  },
]

const ACQUISITION_COPY: Record<Exclude<AcquisitionState, 'acquiring'>, string> = {
  queued: 'Finding a peer…',
  verifying: 'Checking every block…',
  publishing: 'Making it playable…',
  completed: 'Watch now',
  failed: 'Request failed',
  cancelled: 'Request cancelled',
}

export function providerHitAction(hit: ProviderHit): 'play' | 'resolve' | 'unavailable' {
  if (hit.published && hit.entityId && hit.publicationId) return 'play'
  return hit.acquirable ? 'resolve' : 'unavailable'
}

export function acquisitionProgressLabel(acquisition: Acquisition): string {
  if (acquisition.state !== 'acquiring') return ACQUISITION_COPY[acquisition.state]
  const expected = Number(acquisition.expectedBytes || 0)
  if (!Number.isSafeInteger(expected) || expected <= 0) return 'Acquiring…'
  const acquired = Math.max(0, Math.min(expected, Number(acquisition.bytesAcquired) || 0))
  return `Acquiring… ${Math.floor((acquired / expected) * 100)}%`
}

export function acquisitionCanPlay(acquisition: Acquisition | null | undefined): boolean {
  return acquisition?.state === 'completed' && Boolean(acquisition.publicationId)
}

type ProviderResult<T> = {
  success: boolean
  error?: { code?: string; message?: string } | null
} & Partial<T>

type ProviderFacade = {
  resolveProviderRef(request: { resolutionRef: string }): Promise<ProviderResult<{ resolution: ProviderResolution }>>
  getPublication(request: { publicationId: string }): Promise<ProviderResult<{ publication: { publicationId: string; entityId: string } }>>
}

function successfulValue<T>(response: ProviderResult<T>, key: keyof T, operation: string): T[keyof T] {
  const value = response[key]
  if (response.success === true && value !== undefined && value !== null) return value
  const error = new Error(response.error?.message || `${operation} failed`)
  error.name = response.error?.code || 'PROVIDER_REQUEST_FAILED'
  throw error
}

export async function resolveProviderHit(provider: ProviderFacade, hit: ProviderHit) {
  if (providerHitAction(hit) === 'play') {
    return {
      kind: 'published' as const,
      entityId: hit.entityId as string,
      publicationId: hit.publicationId as string,
    }
  }
  if (providerHitAction(hit) === 'unavailable') return { kind: 'unavailable' as const }
  const response = await provider.resolveProviderRef({ resolutionRef: hit.resolutionRef })
  const resolution = successfulValue(response, 'resolution', 'Provider resolution') as ProviderResolution
  if (providerHitAction(resolution) === 'play') {
    return {
      kind: 'published' as const,
      entityId: resolution.entityId as string,
      publicationId: resolution.publicationId as string,
    }
  }
  return resolution.acquirable
    ? { kind: 'request' as const, resolution }
    : { kind: 'unavailable' as const }
}

export async function reloadCompletedAcquisition<T>({
  provider,
  acquisition,
  loadEntity,
}: {
  provider: ProviderFacade
  acquisition: Acquisition
  loadEntity(entityId: string): Promise<T>
}): Promise<{ publication: { publicationId: string; entityId: string }; entity: T }> {
  if (!acquisitionCanPlay(acquisition)) {
    throw new Error('Acquisition is not completed')
  }
  const response = await provider.getPublication({ publicationId: acquisition.publicationId as string })
  const publication = successfulValue(response, 'publication', 'Publication reload') as {
    publicationId: string
    entityId: string
  }
  const entity = await loadEntity(publication.entityId)
  return { publication, entity }
}
