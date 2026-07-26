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
  onPlaybackPrepared?: (playback: { entityId: string, publicationId: string | null, renditionId: string | null }) => void
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
    if (!mediaGraph?.prepareMediaPlayback || !entityId) return
    try {
      const prepared = await startMediaPlayback({ rpc: mediaGraph, entityId, publicationId })
      onPlaybackPrepared?.({
        entityId,
        publicationId: prepared.publicationId,
        renditionId: prepared.renditionId,
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
  }, [mediaGraph, entityId, onPlaybackPrepared, onPlaybackFailed])

  return (
    <MediaEntityDetailScreen
      type="media"
      routeId={entityId}
      itemParam={itemParam}
      publisherDeviceStatus={securityStatus}
      publisherActionHandlers={publisherActionHandlers}
      onSelectSource={(source) => {
        onSelectSource?.(source)
        void play(source.publicationId || null)
      }}
    />
  )
}
