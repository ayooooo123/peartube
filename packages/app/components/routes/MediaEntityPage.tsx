import React from 'react'
import { useLocalSearchParams } from 'expo-router'
import { isPublicationSourceSelectable, type PublicationSource } from '../media/SourceSelector'
import { MediaEntityDetailScreen, encodeMediaEntityRouteParam } from '../media/MediaEntityDetailScreen'
import { loadMediaEntity, startMediaPlayback } from './media-entity-loaders.js'
import { firstRouteParam, useRouteEntityLoader } from './useRouteEntityLoader'
import type {
  PublisherCapabilityAction,
  PublisherDeviceStatusInput,
} from '../publisher/PublisherDeviceStatus'

type MediaEntityInput = {
  entityId?: string | null
  title?: string | null
  sources?: PublicationSource[] | null
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

export function normalizeMediaEntityView(entity: MediaEntityInput | null | undefined, fallbackId = ''): MediaEntityView {
  const provenanceCount = Array.isArray(entity?.provenance) ? Math.min(entity.provenance.length, 64) : 0
  const conflictCount = Array.isArray(entity?.conflicts) ? Math.min(entity.conflicts.length, 64) : 0
  const rawPledgeCount = entity?.archiveStatus?.pledgeCount
  const pledgeCount = Number.isSafeInteger(rawPledgeCount) && Number(rawPledgeCount) >= 0
    ? Math.min(Number(rawPledgeCount), 1_000_000)
    : 0
  const sources = Array.isArray(entity?.sources) ? entity.sources : []
  const requestedPublicationId = typeof entity?.selectedPublicationId === 'string'
    ? entity.selectedPublicationId
    : null
  let selectedPublicationId: string | null = null
  for (const source of sources) {
    const requested = requestedPublicationId
      ? source?.publicationId === requestedPublicationId
      : source?.selected === true
    if (requested && isPublicationSourceSelectable(source)) {
      selectedPublicationId = source.publicationId
      break
    }
  }

  return {
    entityId: typeof entity?.entityId === 'string' ? entity.entityId : fallbackId,
    title: typeof entity?.title === 'string' && entity.title.trim() ? entity.title : 'Media details',
    sources,
    selectedPublicationId,
    provenance: provenanceCount > 0 ? [`${provenanceCount} provenance record${provenanceCount === 1 ? '' : 's'} available.`] : [],
    conflicts: conflictCount > 0 ? [{ field: `${conflictCount} source claim${conflictCount === 1 ? '' : 's'}` }] : [],
    archiveStatus: { pledgeCount },
    contributions: Array.isArray(entity?.contributions)
      ? entity.contributions
      : [{ role: 'uploader' }, { role: 'performer' }, { role: 'director' }],
    publisherDeviceStatus: entity?.publisherDeviceStatus || null,
  }
}

type Props = {
  id?: string
  mediaGraph?: {
    getMediaEntity?: (request: Record<string, unknown>) => Promise<any>
    getPublicationSources?: (request: Record<string, unknown>) => Promise<any>
    prepareMediaPlayback?: (request: Record<string, unknown>) => Promise<any>
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
  }) => void
  onPlaybackFailed?: (failure: { entityId: string, errorCode: string, message: string }) => void
}

export default function MediaEntityPage({
  id,
  mediaGraph,
  entity = null,
  publisherDeviceStatus = null,
  publisherActionHandlers,
  onSelectSource,
  onPlaybackPrepared,
  onPlaybackFailed,
}: Props) {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const entityId = id || firstRouteParam(params.id)
  const loaded = useRouteEntityLoader({
    entityId,
    explicitItem: entity,
    rpc: mediaGraph,
    loader: loadMediaEntity,
  })
  const sourceEntity = loaded.item || (loaded.error
    ? {
        entityId,
        title: entityId ? `Media ${entityId}` : 'Media details',
        subtitle: `Media graph request failed: ${loaded.error}`,
        loadError: loaded.error,
        sources: [],
      }
    : null)
  const resolved = normalizeMediaEntityView(sourceEntity, entityId)
  const securityStatus = publisherDeviceStatus || resolved.publisherDeviceStatus
  const itemParam = sourceEntity
    ? encodeMediaEntityRouteParam({
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
      } as any)
    : undefined
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
      })
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : null
      const code = failure && 'code' in failure && typeof failure.code === 'string'
        ? failure.code
        : 'PLAYBACK_PREPARATION_FAILED'
      onPlaybackFailed?.({
        entityId,
        errorCode: code,
        message: failure?.message || 'Playback could not start',
      })
    }
  }, [mediaGraph, entityId, resolved.title, onPlaybackPrepared, onPlaybackFailed])

  return (
    <MediaEntityDetailScreen
      type="media"
      routeId={entityId}
      itemParam={itemParam}
      publisherDeviceStatus={securityStatus}
      publisherActionHandlers={publisherActionHandlers}
      onPlay={() => { void play(null) }}
      onSelectSource={(source) => {
        onSelectSource?.(source)
        void play(source.publicationId || null)
      }}
    />
  )
}
