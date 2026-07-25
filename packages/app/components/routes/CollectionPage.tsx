import React from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MediaEntityDetailScreen, encodeMediaEntityRouteParam } from '../media/MediaEntityDetailScreen'
import { loadCollectionEntity } from './media-entity-loaders.js'
import { firstRouteParam, useRouteEntityLoader } from './useRouteEntityLoader'

type CollectionMediaGraph = {
  getMediaCollection?: (request: Record<string, unknown>) => Promise<any>
  getMediaCollectionItems?: (request: Record<string, unknown>) => Promise<any>
}

type CollectionItem = {
  entityId: string
  title?: string
  available?: boolean
}

type MediaCollection = {
  entityId?: string
  title?: string
  items?: CollectionItem[]
  [key: string]: unknown
}

export type CollectionPageProps = {
  id?: string
  mediaGraph?: CollectionMediaGraph | null
  collection?: MediaCollection | null
}

export default function CollectionPage({ id, mediaGraph, collection = null }: CollectionPageProps) {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const entityId = id || firstRouteParam(params.id)
  const loaded = useRouteEntityLoader({
    entityId,
    explicitItem: collection,
    rpc: mediaGraph,
    loader: loadCollectionEntity,
  })
  const resolved = loaded.item || (loaded.error
    ? {
        entityId,
        title: entityId ? `Collection ${entityId}` : 'Collection',
        subtitle: `Collection graph request failed: ${loaded.error}`,
        loadError: loaded.error,
        items: [],
        sources: [],
      }
    : null)
  const itemParam = resolved
    ? encodeMediaEntityRouteParam({
        ...resolved,
        id: entityId,
        entityId,
        localEntityId: entityId,
        entityKind: 'collection',
        contentKind: 'collection',
        sources: Array.isArray(resolved.sources) ? resolved.sources : [],
      } as any)
    : undefined
  return <MediaEntityDetailScreen type="collection" routeId={entityId} itemParam={itemParam} />
}
