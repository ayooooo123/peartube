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
    sources,
    provenance: Array.isArray(response.claims) ? response.claims : [],
    conflicts: Array.isArray(response.conflicts) ? response.conflicts : [],
  }
}

/**
 * One Play action.
 *
 * The backend selects the source, opens it, and fails over between equivalent
 * sources inside one deadline. The app hands over an entity id and renders the
 * outcome; it never ranks sources and never opens a picker to start playback.
 * `publicationId` is only ever the viewer's explicit choice from Other Sources,
 * and the backend still refuses it if it fails a hard gate.
 */
/**
 * @param {{ rpc: any, entityId: string, publicationId?: string | null }} request
 */
export async function startMediaPlayback({ rpc, entityId, publicationId = null }) {
  const prepare = requireMethod(rpc, 'prepareMediaPlayback')
  const response = await prepare(publicationId ? { entityId, publicationId } : { entityId })
  if (response?.success === true) {
    return {
      publicationId: response.publicationId || null,
      renditionId: response.renditionId || null,
      coreKey: response.coreKey || null,
      // The only field a player can act on: without it Play resolved a source
      // and then had nowhere to send anyone.
      url: response.url || null,
      attempts: Array.isArray(response.attempts) ? response.attempts : [],
      sources: Array.isArray(response.sources) ? response.sources : [],
    }
  }
  // Preparation already exhausted every equivalent source it was allowed to
  // try, so this is a final answer for now, not a prompt to pick manually.
  const error = new Error(response?.error || 'Playback could not start')
  error.code = response?.errorCode || 'PLAYBACK_PREPARATION_FAILED'
  error.attempts = Array.isArray(response?.attempts) ? response.attempts : []
  error.sources = Array.isArray(response?.sources) ? response.sources : []
  throw error
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
