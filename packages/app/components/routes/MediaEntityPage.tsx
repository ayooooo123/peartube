import React from 'react'
import { SourceSelector, isPublicationSourceSelectable, type PublicationSource } from '../media/SourceSelector'
import { ProvenancePanel } from '../media/ProvenancePanel'
import { ConflictNotice } from '../media/ConflictNotice'
import { ArchiveStatus } from '../media/ArchiveStatus'
import { ContributionList } from '../media/ContributionList'
import {
  PublisherDeviceStatus,
  type PublisherCapabilityAction,
  type PublisherDeviceStatusInput,
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
    getMediaEntity?: unknown
    getPublicationSources?: unknown
  }
  entity?: MediaEntityInput | null
  publisherDeviceStatus?: PublisherDeviceStatusInput | null
  publisherActionHandlers?: Partial<Record<PublisherCapabilityAction, () => void>>
  onSelectSource?: (source: { entityId: string, publicationId: string, renditionId: string }) => void
}

export default function MediaEntityPage({
  id,
  mediaGraph,
  entity = null,
  publisherDeviceStatus = null,
  publisherActionHandlers,
  onSelectSource,
}: Props) {
  const resolved = normalizeMediaEntityView(entity, id)
  // mediaGraph.getMediaEntity and mediaGraph.getPublicationSources are injected by the runtime loader.
  void mediaGraph?.getMediaEntity
  void mediaGraph?.getPublicationSources
  const securityStatus = publisherDeviceStatus || resolved.publisherDeviceStatus
  return (
    <main>
      <h1>{resolved.title}</h1>
      <SourceSelector
        entityId={resolved.entityId}
        sources={resolved.sources}
        selectedPublicationId={resolved.selectedPublicationId}
        onSelectSource={onSelectSource}
      />
      <ProvenancePanel provenance={resolved.provenance} />
      <ConflictNotice conflicts={resolved.conflicts} />
      <ArchiveStatus status={resolved.archiveStatus} />
      <ContributionList contributions={resolved.contributions} />
      {securityStatus
        ? <PublisherDeviceStatus status={securityStatus} actionHandlers={publisherActionHandlers} />
        : null}
      <p>Publisher channels remain provenance destinations, not creator owners.</p>
    </main>
  )
}
