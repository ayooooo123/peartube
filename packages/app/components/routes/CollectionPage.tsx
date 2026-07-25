import React from 'react'
import { CollectionCompleteness } from '../media/CollectionCompleteness'

type CollectionMediaGraph = {
  getMediaCollection?: unknown
  getMediaCollectionItems?: unknown
}

type CollectionItem = {
  entityId: string
  title?: string
  available?: boolean
}

type MediaCollection = {
  title?: string
  items?: CollectionItem[]
}

type CollectionPageProps = {
  id?: string
  mediaGraph?: CollectionMediaGraph
  collection?: MediaCollection | null
}

export default function CollectionPage({ id, mediaGraph, collection = null }: CollectionPageProps) {
  // mediaGraph.getMediaCollection and mediaGraph.getMediaCollectionItems fetch paginated collection data.
  void mediaGraph?.getMediaCollection
  void mediaGraph?.getMediaCollectionItems
  const items = collection?.items || []
  const missingCount = items.filter(item => item.available === false).length
  return (
    <main>
      <h1>{collection?.title || id}</h1>
      <CollectionCompleteness completeness={missingCount > 0 ? 'partial' : 'complete'} missingCount={missingCount} />
      {items.map(item => <div key={item.entityId}>{item.available === false ? 'missing placeholder' : item.title}</div>)}
    </main>
  )
}
