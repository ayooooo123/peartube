import React from 'react'
import {
  SourceExplanation,
  normalizeSourceExplanation,
  type PublicationSource,
} from './SourceExplanation'
import { isMediaSourcePlayable } from '../../lib/media-source-selection.js'

export { normalizeSourceExplanation }
export type { PublicationSource }

type Props = {
  entityId: string
  sources?: PublicationSource[]
  selectedPublicationId?: string | null
  onSelectSource?: (source: { entityId: string, publicationId: string, renditionId: string }) => void
}


export function isPublicationSourceSelectable(source: PublicationSource | null | undefined): boolean {
  return isMediaSourcePlayable(source || {})
}

export function SourceSelector({
  entityId,
  sources = [],
  selectedPublicationId = null,
  onSelectSource,
}: Props) {
  const hasSelectedSource = sources.some(source => (
    source.publicationId === selectedPublicationId && isPublicationSourceSelectable(source)
  ))
  return (
    <section aria-label="Playback sources">
      {sources.length === 0
        ? <p>No publication sources are known for this media entity.</p>
        : !hasSelectedSource
          ? <p>No trusted playable source is currently available. Rejected sources remain visible with local reasons.</p>
          : null}
      {sources.map((source, index) => {
        const selectable = isPublicationSourceSelectable(source)
        const selected = selectable && source.publicationId === selectedPublicationId
        const explanation = normalizeSourceExplanation(source, index, selected)
        return (
          <div key={`${source.publicationId}:${source.renditionId}`}>
            <SourceExplanation explanation={explanation} />
            <button
              type="button"
              aria-label={`${selected ? 'Selected' : selectable ? 'Use' : 'Unavailable'} source ${index + 1}`}
              aria-pressed={selected}
              disabled={!onSelectSource || selected || !selectable}
              onClick={onSelectSource && selectable
                ? () => onSelectSource({
                    entityId,
                    publicationId: source.publicationId,
                    renditionId: source.renditionId,
                  })
                : undefined}
            >
              {selected ? 'Currently selected' : selectable ? 'Use this source' : 'Source unavailable'}
            </button>
          </div>
        )
      })}
    </section>
  )
}
