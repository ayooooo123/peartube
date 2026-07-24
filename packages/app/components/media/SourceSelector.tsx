import React from 'react'

type Source = {
  publicationId: string
  renditionId: string
  sourceProvider?: string | null
  publisherId?: string | null
}

type Props = {
  entityId: string
  sources?: Source[]
  selectedPublicationId?: string | null
  onSelectSource?: (source: { entityId: string, publicationId: string, renditionId: string }) => void
}

export function SourceSelector({ entityId, sources = [], selectedPublicationId = null, onSelectSource = () => {} }: Props) {
  return (
    <div data-entity-id={entityId}>
      {sources.map((source) => (
        <button
          key={`${source.publicationId}:${source.renditionId}`}
          data-publication-id={source.publicationId}
          data-rendition-id={source.renditionId}
          aria-pressed={source.publicationId === selectedPublicationId}
          onClick={() => onSelectSource({ entityId, publicationId: source.publicationId, renditionId: source.renditionId })}
        >
          {source.sourceProvider || source.publisherId || source.publicationId}
        </button>
      ))}
    </div>
  )
}
