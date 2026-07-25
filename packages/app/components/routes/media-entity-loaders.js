const PAGE_LIMIT = 64
const MAX_PAGES = 16

function requireMethod(rpc, name) {
  const method = rpc?.[name]
  if (typeof method !== 'function') throw new Error(`Media graph RPC does not expose ${name}`)
  return method.bind(rpc)
}

function requireSuccess(response, operation) {
  if (response?.success === true) return response
  const error = new Error(response?.errorMessage || response?.error || `${operation} failed`)
  error.code = response?.errorCode || 'MEDIA_GRAPH_REQUEST_FAILED'
  throw error
}

function nextCursorOf(response) {
  return typeof response?.nextCursor === 'string' && response.nextCursor.length > 0
    ? response.nextCursor
    : null
}

async function loadAllPages(method, request, operation) {
  const items = []
  const seenCursors = new Set()
  let cursor

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = requireSuccess(await method({
      ...request,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    }), operation)
    if (Array.isArray(response.items)) items.push(...response.items)

    const nextCursor = nextCursorOf(response)
    if (!nextCursor) return items
    if (seenCursors.has(nextCursor)) throw new Error(`${operation} repeated pagination cursor`)
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  throw new Error(`${operation} exceeded ${MAX_PAGES} pages`)
}

function entityFrom(response, entityId) {
  const entity = response?.entity
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error(`Media graph returned no entity for ${entityId}`)
  }
  return entity
}

export async function loadMediaEntity({ rpc, entityId }) {
  const getEntity = requireMethod(rpc, 'getMediaEntity')
  const getSources = requireMethod(rpc, 'getPublicationSources')
  const response = requireSuccess(await getEntity({
    entityId,
    includeClaims: true,
    includeConflicts: true,
  }), 'getMediaEntity')
  const entity = entityFrom(response, entityId)
  const sources = await loadAllPages(getSources, { entityId }, 'getPublicationSources')

  return {
    ...entity,
    sources: sources.length > 0 ? sources : (Array.isArray(entity.sources) ? entity.sources : []),
    provenance: Array.isArray(response.claims) ? response.claims : [],
    conflicts: Array.isArray(response.conflicts) ? response.conflicts : [],
  }
}

export async function loadCollectionEntity({ rpc, entityId }) {
  const getCollection = requireMethod(rpc, 'getMediaCollection')
  const getItems = requireMethod(rpc, 'getMediaCollectionItems')
  const response = requireSuccess(await getCollection({
    entityId,
    includeClaims: true,
    includeConflicts: true,
  }), 'getMediaCollection')
  const entity = entityFrom(response, entityId)
  const items = await loadAllPages(getItems, { collectionEntityId: entityId }, 'getMediaCollectionItems')

  return {
    ...entity,
    items,
    provenance: Array.isArray(response.claims) ? response.claims : [],
    conflicts: Array.isArray(response.conflicts) ? response.conflicts : [],
  }
}

export async function loadCreatorEntity({ rpc, entityId }) {
  const getAgent = requireMethod(rpc, 'getMediaAgent')
  const getContributions = requireMethod(rpc, 'getAgentContributions')
  const response = requireSuccess(await getAgent({
    entityId,
    includeClaims: true,
    includeConflicts: true,
  }), 'getMediaAgent')
  const entity = entityFrom(response, entityId)
  const contributions = await loadAllPages(getContributions, { agentEntityId: entityId }, 'getAgentContributions')

  return {
    ...entity,
    contributions,
    provenance: Array.isArray(response.claims) ? response.claims : [],
    conflicts: Array.isArray(response.conflicts) ? response.conflicts : [],
  }
}
