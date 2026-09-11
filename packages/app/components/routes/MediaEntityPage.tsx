import React from 'react'
import { useLocalSearchParams } from 'expo-router'
import { isPublicationSourceSelectable, type PublicationSource } from '../media/SourceSelector'
import { MediaEntityDetailScreen, encodeMediaEntityRouteParam } from '../media/MediaEntityDetailScreen'
import { loadMediaEntity, startMediaPlayback } from './media-entity-loaders.js'
import {
  acquisitionCanPlay,
  acquisitionProgressLabel,
  type Acquisition,
  type ProviderResolution,
  type RetentionClass,
} from '../../lib/provider-consumer-flow'
import { firstRouteParam, useRouteEntityLoader } from './useRouteEntityLoader'
import type {
  PublisherCapabilityAction,
  PublisherDeviceStatusInput,
} from '../publisher/PublisherDeviceStatus'

type MediaEntityInput = {
  entityId?: string | null
  title?: string | null
  sources?: PublicationSource[] | null
  /** Media renditions as the signed manifest declares them, size included. */
  renditions?: Array<{ renditionId?: string, byteLength?: number }> | null
  selectedPublicationId?: string | null
  provenance?: unknown[] | null
  conflicts?: unknown[] | null
  archiveStatus?: { pledgeCount?: number | null } | null
  contributions?: Array<{ role?: string }> | null
  publisherDeviceStatus?: PublisherDeviceStatusInput | null
  [key: string]: unknown
}

export type MediaEntityView = {
  entityId: string
  title: string
  sources: PublicationSource[]
  selectedPublicationId: string | null
  provenance: string[]
  conflicts: Array<{ field: string }>
  archiveStatus: { pledgeCount: number }
  contributions: Array<{ role?: string }>
  publisherDeviceStatus: PublisherDeviceStatusInput | null
}

function findSelectedPublicationId(sources: PublicationSource[], requestedPublicationId: string | null): string | null {
  for (const source of sources) {
    const requested = requestedPublicationId
      ? source?.publicationId === requestedPublicationId
      : source?.selected === true
    if (requested && isPublicationSourceSelectable(source)) {
      return source.publicationId
    }
  }
  return null
}

function parsePledgeCount(rawPledgeCount: unknown): number {
  if (Number.isSafeInteger(rawPledgeCount) && Number(rawPledgeCount) >= 0) {
    return Math.min(Number(rawPledgeCount), 1_000_000)
  }
  return 0
}

function formatProvenanceSummary(provenance: unknown): string[] {
  const count = Array.isArray(provenance) ? Math.min(provenance.length, 64) : 0
  if (count <= 0) return []
  return [`${count} provenance record${count === 1 ? '' : 's'} available.`]
}

function formatConflictSummary(conflicts: unknown): Array<{ field: string }> {
  const count = Array.isArray(conflicts) ? Math.min(conflicts.length, 64) : 0
  if (count <= 0) return []
  return [{ field: `${count} source claim${count === 1 ? '' : 's'}` }]
}

export function normalizeMediaEntityView(entity: MediaEntityInput | null | undefined, fallbackId = ''): MediaEntityView {
  const sources = Array.isArray(entity?.sources) ? entity.sources : []
  const requestedPublicationId = typeof entity?.selectedPublicationId === 'string'
    ? entity.selectedPublicationId
    : null
  const selectedPublicationId = findSelectedPublicationId(sources, requestedPublicationId)
  const pledgeCount = parsePledgeCount(entity?.archiveStatus?.pledgeCount)

  const entityTitle = typeof entity?.title === 'string' && entity.title.trim() ? entity.title : 'Media details'
  const entityId = typeof entity?.entityId === 'string' ? entity.entityId : fallbackId
  const contributions = Array.isArray(entity?.contributions)
    ? entity.contributions
    : [{ role: 'uploader' }, { role: 'performer' }, { role: 'director' }]

  return {
    entityId,
    title: entityTitle,
    sources,
    selectedPublicationId,
    provenance: formatProvenanceSummary(entity?.provenance),
    conflicts: formatConflictSummary(entity?.conflicts),
    archiveStatus: { pledgeCount },
    contributions,
    publisherDeviceStatus: entity?.publisherDeviceStatus || null,
  }
}

function buildRouteSourceEntity(loaded: { item: MediaEntityInput | null; error: unknown }, entityId: string) {
  if (loaded.item) return loaded.item
  if (loaded.error) {
    return {
      entityId,
      title: entityId ? `Media ${entityId}` : 'Media details',
      subtitle: `Media graph request failed: ${loaded.error}`,
      loadError: loaded.error,
      sources: [],
    }
  }
  return null
}

function buildMediaEntityItemParam(
  sourceEntity: MediaEntityInput | null,
  resolved: MediaEntityView,
  securityStatus: PublisherDeviceStatusInput | null
) {
  if (!sourceEntity) return undefined
  return encodeMediaEntityRouteParam({
    ...sourceEntity,
    id: resolved.entityId,
    entityId: resolved.entityId,
    localEntityId: resolved.entityId,
    entityKind: 'work',
    title: resolved.title,
    sources: resolved.sources,
    provenance: resolved.provenance,
    conflicts: resolved.conflicts,
    archiveStatus: resolved.archiveStatus,
    contributions: resolved.contributions,
    publisherDeviceStatus: securityStatus,
  } as unknown as Parameters<typeof encodeMediaEntityRouteParam>[0])
}

function playbackFailureFromError(error: unknown) {
  const failure = error instanceof Error ? error : null
  const code = failure && 'code' in failure && typeof failure.code === 'string'
    ? failure.code
    : 'PLAYBACK_PREPARATION_FAILED'
  return {
    errorCode: code,
    message: failure?.message || 'Playback could not start',
  }
}

function resolvePrimaryAction({
  providerResolution,
  acquiredEntity,
  acquisition,
  acquisitionError,
  onCancel,
  onRequest,
}: {
  providerResolution: ProviderResolution | null
  acquiredEntity: MediaEntityInput | null
  acquisition: Acquisition | null
  acquisitionError: string | null
  onCancel: () => void
  onRequest: () => void
}) {
  if (!providerResolution || acquiredEntity) return undefined

  const isActive = Boolean(acquisition && ['queued', 'acquiring', 'verifying', 'publishing'].includes(acquisition.state))
  if (isActive) {
    return {
      label: 'Cancel request',
      status: acquisitionProgressLabel(acquisition!),
      onPress: onCancel,
    }
  }

  if (acquisition?.state === 'completed') {
    return {
      label: 'Preparing playback…',
      disabled: true,
      status: acquisitionError,
      onPress: () => {},
    }
  }

  const isRetry = acquisition?.state === 'failed' || acquisition?.state === 'cancelled'
  const progressStatus = acquisition ? acquisitionProgressLabel(acquisition) : null
  return {
    label: isRetry ? 'Request again' : 'Request this title',
    disabled: !providerResolution.acquirable,
    status: acquisitionError || progressStatus,
    onPress: onRequest,
  }
}

type Props = {
  id?: string
  mediaGraph?: {
    getMediaEntity?: (request: Record<string, unknown>) => Promise<any>
    getPublicationSources?: (request: Record<string, unknown>) => Promise<any>
    prepareMediaPlayback?: (request: Record<string, unknown>) => Promise<any>
  } | null
  provider?: {
    requestAcquisition(request: {
      idempotencyKey: string
      request: {
        schemaVersion: 1
        resolutionRef: string
        publisherId: string
        retentionClass: RetentionClass
      }
    }): Promise<unknown>
    getAcquisition(request: { acquisitionId: string }): Promise<unknown>
    cancelAcquisition(request: { acquisitionId: string }): Promise<unknown>
    retryAcquisition?(request: { acquisitionId: string }): Promise<unknown>
    getPublication(request: { publicationId: string }): Promise<unknown>
  } | null
  providerEvents?: {
    onAcquisitionLifecycle?(callback: (event: { acquisitionId?: string }) => void): () => void
  } | null
  entity?: MediaEntityInput | null
  publisherDeviceStatus?: PublisherDeviceStatusInput | null
  publisherActionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
  onSelectSource?: (source: { entityId: string, publicationId: string, renditionId: string }) => void
  /** Receives the source Play actually started, after any backend failover. */
  onPlaybackPrepared?: (playback: {
    entityId: string,
    publicationId: string | null,
    renditionId: string | null,
    // What preparation was for. A caller handed only ids has to go find the
    // bytes itself, which is why Play used to stop here.
    url: string | null,
    title: string,
    // Byte length the signed manifest declares for the rendition that started.
    // Null when this device has not received a manifest that states one.
    byteLength: number | null,
  }) => void
  onPlaybackFailed?: (failure: { entityId: string, errorCode: string, message: string }) => void
}

/**
 * Byte length of the rendition Play actually started, as the signed manifest
 * declares it. A rendition the entity response never named has no size here,
 * which is not zero.
 */
function renditionByteLength(entity: MediaEntityInput | null, renditionId: string | null): number | null {
  const renditions = Array.isArray(entity?.renditions) ? entity.renditions : []
  const match = renditions.find(rendition => rendition?.renditionId === renditionId)
  const byteLength = Number(match?.byteLength)
  return Number.isSafeInteger(byteLength) && byteLength > 0 ? byteLength : null
}
function providerResolutionFrom(entity: MediaEntityInput | null): ProviderResolution | null {
  const value = entity?.providerResolution
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (
    !('schemaVersion' in value) || value.schemaVersion !== 1 ||
    !('resolutionRef' in value) || typeof value.resolutionRef !== 'string' ||
    !('publisherId' in value) || typeof value.publisherId !== 'string' ||
    !('title' in value) || typeof value.title !== 'string' ||
    !('published' in value) || typeof value.published !== 'boolean' ||
    !('acquirable' in value) || typeof value.acquirable !== 'boolean'
  ) return null
  return value as ProviderResolution
}

function acquisitionFromResponse(response: unknown): Acquisition | null {
  if (!response || typeof response !== 'object') return null
  const value = 'acquisition' in response ? response.acquisition : response
  if (
    !value || typeof value !== 'object' ||
    !('acquisitionId' in value) || typeof value.acquisitionId !== 'string' ||
    !('state' in value) || typeof value.state !== 'string'
  ) return null
  return value as Acquisition
}


export default function MediaEntityPage({
  id,
  mediaGraph,
  entity = null,
  publisherDeviceStatus = null,
  provider = null,
  providerEvents = null,
  publisherActionHandlers,
  onSelectSource,
  onPlaybackPrepared,
  onPlaybackFailed,
}: Props) {
  const params = useLocalSearchParams<{ id?: string | string[]; autoplay?: string; publicationId?: string }>()
  const entityId = id || firstRouteParam(params.id)
  const [retentionClass, setRetentionClass] = React.useState<RetentionClass>('contribution-cache')
  const [acquisition, setAcquisition] = React.useState<Acquisition | null>(null)
  const [acquiredEntity, setAcquiredEntity] = React.useState<MediaEntityInput | null>(null)
  const [acquisitionError, setAcquisitionError] = React.useState<string | null>(null)
  const idempotencyKey = React.useRef(`app-${Date.now()}`)
  const autoPlayed = React.useRef(false)
  const loaded = useRouteEntityLoader({
    entityId,
    explicitItem: entity,
    rpc: mediaGraph,
    loader: loadMediaEntity,
  })
  const routeSourceEntity = buildRouteSourceEntity(loaded, entityId ?? '')
  const sourceEntity = acquiredEntity || routeSourceEntity
  const providerResolution = providerResolutionFrom(sourceEntity)
  const resolved = normalizeMediaEntityView(sourceEntity, entityId)
  const securityStatus = publisherDeviceStatus || resolved.publisherDeviceStatus
  const itemParam = buildMediaEntityItemParam(sourceEntity, resolved, securityStatus)
  // Choosing a source in Other Sources is a Play with an explicit override, not
  // a local re-rank: it goes back through the backend selector, which still
  // refuses the choice if it fails a hard gate and still fails over between
  // equivalent sources.
  const play = React.useCallback(async (publicationId: string | null) => {
    // Every one of these used to be the same silent return, which is
    // indistinguishable from a dead button to anyone holding the device.
    if (!entityId) {
      onPlaybackFailed?.({ entityId: '', errorCode: 'ENTITY_ID_MISSING', message: 'This screen has no entity to play' })
      return
    }
    if (!mediaGraph) {
      onPlaybackFailed?.({ entityId, errorCode: 'RPC_NOT_READY', message: 'The backend connection is not ready yet' })
      return
    }
    if (!mediaGraph.prepareMediaPlayback) {
      onPlaybackFailed?.({ entityId, errorCode: 'PREPARE_METHOD_MISSING', message: 'This build cannot ask the backend to prepare playback' })
      return
    }
    try {
      const prepared = await startMediaPlayback({ rpc: mediaGraph, entityId, publicationId })
      // A source chosen but not servable is a failure with a name, not a Play
      // button that quietly does nothing.
      if (!prepared.url) {
        onPlaybackFailed?.({
          entityId,
          errorCode: 'PLAYBACK_URL_UNAVAILABLE',
          message: 'This source was selected but is not servable yet',
        })
        return
      }
      onPlaybackPrepared?.({
        entityId,
        publicationId: prepared.publicationId,
        renditionId: prepared.renditionId,
        url: prepared.url,
        title: resolved.title,
        byteLength: renditionByteLength(sourceEntity, prepared.renditionId),
      })
    } catch (error: unknown) {
      const failure = playbackFailureFromError(error)
      onPlaybackFailed?.({
        entityId,
        errorCode: failure.errorCode,
        message: failure.message,
      })
    }
  }, [mediaGraph, entityId, resolved.title, sourceEntity, onPlaybackPrepared, onPlaybackFailed])
  const requestAcquisition = React.useCallback(async () => {
    if (!provider || !providerResolution?.acquirable) return
    if (acquisition?.state === 'cancelled' || (acquisition?.state === 'failed' && acquisition.recoverable !== true)) {
      idempotencyKey.current = `app-${Date.now()}-${acquisition.acquisitionId}`
    }
    setAcquisitionError(null)
    try {
      const response = await provider.requestAcquisition({
        idempotencyKey: idempotencyKey.current,
        request: {
          schemaVersion: 1,
          resolutionRef: providerResolution.resolutionRef,
          publisherId: providerResolution.publisherId,
          retentionClass,
        },
      })
      const next = acquisitionFromResponse(response)
      if (!next) throw new Error('Acquisition request returned no status')
      setAcquisition(next)
    } catch {
      setAcquisitionError('This title could not be requested.')
    }
  }, [acquisition, provider, providerResolution, retentionClass])

  const cancelAcquisition = React.useCallback(async () => {
    if (!provider || !acquisition) return
    try {
      const response = await provider.cancelAcquisition({ acquisitionId: acquisition.acquisitionId })
      const next = acquisitionFromResponse(response)
      if (next) setAcquisition(next)
    } catch {
      setAcquisitionError('The request could not be cancelled.')
    }
  }, [acquisition, provider])

  React.useEffect(() => {
    if (!providerEvents?.onAcquisitionLifecycle || !provider || !acquisition) return
    return providerEvents.onAcquisitionLifecycle((event) => {
      if (event.acquisitionId !== acquisition.acquisitionId) return
      void provider.getAcquisition({ acquisitionId: acquisition.acquisitionId }).then((response) => {
        const next = acquisitionFromResponse(response)
        if (next) setAcquisition(next)
      }).catch(() => {})
    })
  }, [acquisition?.acquisitionId, provider, providerEvents])

  React.useEffect(() => {
    const publicationId = acquisitionCanPlay(acquisition) ? acquisition?.publicationId : null
    if (!provider || !mediaGraph || !publicationId || acquiredEntity) return
    let active = true
    void provider.getPublication({ publicationId }).then(async (response) => {
      if (!response || typeof response !== 'object' || !('publication' in response)) {
        throw new Error('Publication reload failed')
      }
      const publication = response.publication
      if (!publication || typeof publication !== 'object' || !('entityId' in publication) || typeof publication.entityId !== 'string') {
        throw new Error('Publication has no media entity')
      }
      const reloaded = await loadMediaEntity({ rpc: mediaGraph, entityId: publication.entityId })
      if (active) setAcquiredEntity(reloaded)
    }).catch(() => {
      if (active) setAcquisitionError('The completed publication could not be loaded.')
    })
    return () => { active = false }
  }, [acquiredEntity, acquisition, mediaGraph, provider])

  React.useEffect(() => {
    if (
      autoPlayed.current ||
      params.autoplay !== 'true' ||
      !sourceEntity ||
      providerResolution
    ) return
    autoPlayed.current = true
    void play(params.publicationId || null)
  }, [params.autoplay, params.publicationId, play, providerResolution, sourceEntity])

  const primaryAction = resolvePrimaryAction({
    providerResolution,
    acquiredEntity,
    acquisition,
    acquisitionError,
    onCancel: () => { void cancelAcquisition() },
    onRequest: () => { void requestAcquisition() },
  })


  return (
    <MediaEntityDetailScreen
      type="media"
      routeId={entityId}
      itemParam={itemParam}
      publisherDeviceStatus={securityStatus}
      publisherActionHandlers={publisherActionHandlers}
      onPlay={() => { void play(null) }}
      primaryAction={primaryAction}
      retentionChoice={providerResolution && !acquisition ? {
        value: retentionClass,
        onChange: setRetentionClass,
      } : undefined}
      availabilityOverride={providerResolution && !acquiredEntity ? {
        label: 'Available by request',
        detail: 'Request this title to verify and publish it locally before playback.',
        playable: false,
      } : undefined}
      onSelectSource={(source) => {
        onSelectSource?.(source)
        void play(source.publicationId || null)
      }}
    />
  )
}
