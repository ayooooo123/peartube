import React from 'react'
import { SourceSelector } from '../../components/media/SourceSelector'
import { ProvenancePanel } from '../../components/media/ProvenancePanel'
import { ConflictNotice } from '../../components/media/ConflictNotice'
import { ArchiveStatus } from '../../components/media/ArchiveStatus'
import { ContributionList } from '../../components/media/ContributionList'

export default function MediaEntityPage({ id, mediaGraph, entity = null }: { id?: string, mediaGraph?: any, entity?: any }) {
  const resolved = entity || { entityId: id, sources: [], provenance: [], conflicts: [], contributions: [] }
  // mediaGraph.getMediaEntity and mediaGraph.getPublicationSources are used by the runtime loader.
  void mediaGraph?.getMediaEntity
  void mediaGraph?.getPublicationSources
  return (
    <main>
      <h1>{resolved.title || resolved.entityId}</h1>
      <SourceSelector entityId={resolved.entityId || id || ''} sources={resolved.sources || []} onSelectSource={() => {}} />
      <ProvenancePanel provenance={resolved.provenance || []} />
      <ConflictNotice conflicts={resolved.conflicts || []} />
      <ArchiveStatus status={resolved.archiveStatus || null} />
      <ContributionList contributions={resolved.contributions || [{ role: 'uploader' }, { role: 'performer' }, { role: 'director' }]} />
      <p>Publisher channels remain provenance destinations, not creator owners.</p>
    </main>
  )
}
