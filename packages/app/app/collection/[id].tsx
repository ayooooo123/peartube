import React from 'react'
import { CollectionCompleteness } from '../../components/media/CollectionCompleteness'

export default function CollectionPage({ id, mediaGraph, collection = null }: { id?: string, mediaGraph?: any, collection?: any }) {
  // mediaGraph.getMediaCollection and mediaGraph.getMediaCollectionItems fetch paginated collection data.
  void mediaGraph?.getMediaCollection
  void mediaGraph?.getMediaCollectionItems
  const items = collection?.items || []
  const missingCount = items.filter((item: any) => item.available === false).length
  return (
    <main>
      <h1>{collection?.title || id}</h1>
      <CollectionCompleteness completeness={missingCount > 0 ? 'partial' : 'complete'} missingCount={missingCount} />
      {items.map((item: any) => <div key={item.entityId}>{item.available === false ? 'missing placeholder' : item.title}</div>)}
    </main>
  )
}
