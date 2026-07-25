import React from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MediaEntityDetailScreen, encodeMediaEntityRouteParam } from '../media/MediaEntityDetailScreen'
import { loadCreatorEntity } from './media-entity-loaders.js'
import { firstRouteParam, useRouteEntityLoader } from './useRouteEntityLoader'

type CreatorMediaGraph = {
  getMediaAgent?: (request: Record<string, unknown>) => Promise<any>
  getAgentContributions?: (request: Record<string, unknown>) => Promise<any>
}

type CreatorAgent = {
  entityId?: string
  name?: string
  title?: string
  contributions?: Contribution[]
  [key: string]: unknown
}

type Contribution = {
  agentId?: string
  name?: string
  role?: string
  publisherId?: string
}

export type CreatorPageProps = {
  id?: string
  mediaGraph?: CreatorMediaGraph | null
  agent?: CreatorAgent | null
  contributions?: Contribution[]
}

export default function CreatorPage({ id, mediaGraph, agent = null, contributions = [] }: CreatorPageProps) {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const entityId = id || firstRouteParam(params.id)
  const explicitAgent = agent
    ? {
        ...agent,
        contributions: contributions.length > 0 ? contributions : agent.contributions,
      }
    : contributions.length > 0
      ? { entityId, title: entityId, contributions }
      : null
  const loaded = useRouteEntityLoader({
    entityId,
    explicitItem: explicitAgent,
    rpc: mediaGraph,
    loader: loadCreatorEntity,
  })
  const resolved = loaded.item || (loaded.error
    ? {
        entityId,
        title: entityId ? `Creator ${entityId}` : 'Creator',
        subtitle: `Creator graph request failed: ${loaded.error}`,
        loadError: loaded.error,
        contributions: [],
        sources: [],
      }
    : null)
  const itemParam = resolved
    ? encodeMediaEntityRouteParam({
        ...resolved,
        id: entityId,
        entityId,
        localEntityId: entityId,
        entityKind: 'agent',
        contentKind: 'creator',
        title: resolved.title || resolved.name || entityId,
        contributions: Array.isArray(resolved.contributions) ? resolved.contributions : [],
        sources: Array.isArray(resolved.sources) ? resolved.sources : [],
      } as any)
    : undefined
  return <MediaEntityDetailScreen type="creator" routeId={entityId} itemParam={itemParam} />
}
