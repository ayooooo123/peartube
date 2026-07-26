import { resolveMediaEntity } from '../media-graph/resolver.js'
import { selectPublicationSources } from '../media-graph/source-selector.js'
import { projectSourceSelectionDiagnostics } from '../media-graph/selection-diagnostics.js'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const DEFAULT_CATALOG_PAGE_LIMIT = 20
const MAX_CATALOG_PAGE_LIMIT = 50

function okPage(items, nextCursor = null) {
  return { success: true, items, nextCursor }
}

function error(code, message, extra = {}) {
  return { success: false, errorCode: code, error: message, ...extra }
}

function entityKindFromRow(row) {
  return row?.body?.subjectRefs?.[0]?.entityKind || 'unknown'
}

function entityKindFromId(entityId = '') {
  const match = /^peartube:media-entity:v1:([^:]+):/.exec(String(entityId))
  return match?.[1] || 'unknown'
}

function normalizeLimit(request = {}) {
  if (!request.limitProvided && request.limit === undefined) return DEFAULT_PAGE_LIMIT
  const limit = Number(request.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error('limit must be between 1 and 100')
  }
  return limit
}

function pageRows(rows, request = {}, keyOf = row => row.claimId) {
  const limit = normalizeLimit(request)
  let offset = 0
  if (request.cursor) {
    const index = rows.findIndex(row => keyOf(row) === request.cursor)
    if (index < 0) return { error: error('INVALID_CURSOR', 'Invalid media graph cursor', { items: [], nextCursor: null }) }
    offset = index + 1
  }
  const page = rows.slice(offset, offset + limit)
  const nextCursor = offset + limit < rows.length ? keyOf(page.at(-1)) : null
  return { page, nextCursor }
}

function pageCatalogRows(rows, request = {}, keyOf = row => row.entityId) {
  const limit = (!request.limitProvided && request.limit === undefined)
    ? DEFAULT_CATALOG_PAGE_LIMIT
    : Number(request.limit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_LIMIT) {
    return { error: error('INVALID_LIMIT', 'Media catalog limit must be between 1 and 50', { items: [], nextCursor: null }) }
  }
  let offset = 0
  if (request.cursor) {
    const index = rows.findIndex(row => keyOf(row) === request.cursor)
    if (index < 0) return { error: error('INVALID_CURSOR', 'Invalid media catalog cursor', { items: [], nextCursor: null }) }
    offset = index + 1
  }
  const page = rows.slice(offset, offset + limit)
  const nextCursor = offset + limit < rows.length ? keyOf(page.at(-1)) : null
  return { page, nextCursor }
}

function claimSummary(row) {
  if (!row) return null
  return {
    claimId: row.claimId,
    claimType: row.body.claimType,
    issuerId: row.issuer,
    subjectEntityId: row.subjects?.[0] || null,
    confidence: row.body.confidence,
    sourceRank: row.body.payload?.sourceRank,
    revoked: row.revoked === true,
    issuedAt: row.envelope?.issuedAt || null,
  }
}

function conflictSummary(row) {
  return {
    conflictId: row.claimId,
    claimId: row.claimId,
    claimType: row.body.claimType,
    subjectEntityId: row.subjects?.[0] || null,
    claimIds: [row.claimId],
    preferredClaimId: null,
  }
}

function contributionSummary(row) {
  const payload = row.body.payload || {}
  return {
    agentEntityId: payload.agentRef?.entityId || null,
    role: payload.role || 'unknown',
    workEntityId: payload.subjectRef?.entityId || row.subjects?.[0] || null,
    publicationId: payload.publicationId || null,
    claimId: row.claimId,
  }
}

function sourcePreferenceKey(entityId, publicationId) {
  return `${entityId}\n${publicationId}`
}

function createMemoryPreferenceStore() {
  const values = new Map()
  return {
    async get(key) {
      if (!values.has(key)) return null
      return { value: values.get(key) }
    },
    async put(key, value) {
      values.set(key, value)
    },
    async del(key) {
      values.delete(key)
    },
  }
}

function normalizePreferenceStore(store) {
  if (!store) return createMemoryPreferenceStore()
  if (store instanceof Map) {
    return {
      async get(key) {
        if (!store.has(key)) return null
        return { value: store.get(key) }
      },
      async put(key, value) {
        store.set(key, value)
      },
      async del(key) {
        store.delete(key)
      },
    }
  }
  return store
}

function manifestSource(manifest, row, preferred, trust = {}) {
  const publisherId = manifest?.body?.publisherId || row.issuer
  const rendition = manifest?.body?.renditions?.find(candidate => (
    candidate && candidate.blocked !== true && candidate.superseded !== true &&
    typeof candidate.renditionId === 'string' && candidate.renditionId.length > 0
  )) || null
  const publicationId = manifest?.publicationId || row.body.payload?.publicationId
  return {
    publicationId,
    publisherId,
    manifestId: manifest?.body?.manifestId || null,
    renditionId: rendition?.renditionId || null,
    publicationAuthorized: Boolean(
      manifest &&
      rendition &&
      manifest.publicationId === publicationId &&
      manifest.body?.publisherId === publisherId
    ),
    metadataConfidence: row.body.confidence || 0,
    publisherTrust: trust[publisherId] || 0,
    availabilityScore: row.body.payload?.availabilityStatus === 'available' ? 100 : 0,
    formatSupport: 100,
    moderationPenalty: row.body.payload?.moderationPenalty || 0,
    availabilityState: row.body.payload?.availabilityStatus || 'unknown',
    archiveState: row.body.payload?.archiveState,
    cacheState: row.body.payload?.cacheState,
    introductionPublisherIds: row.body.payload?.introductionPublisherIds || [row.issuer],
    introductionIndexIds: row.body.payload?.introductionIndexIds || [],
    moderationFeedIds: row.body.payload?.moderationFeedIds || [],
    claimConflictIds: row.body.payload?.claimConflictIds || [],
    provenanceClaimIds: row.body.payload?.provenanceClaimIds || [row.claimId],
    stale: row.body.payload?.stale === true,
    incomplete: row.body.payload?.incomplete === true,
    preferred,
  }
}

function schemaUint(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(number))
}

function sourceDiagnosticsResponse(item) {
  return {
    ...item,
    scoreMetadataConfidence: schemaUint(item.scoreMetadataConfidence),
    scorePublisherTrust: schemaUint(item.scorePublisherTrust),
    scoreAvailability: schemaUint(item.scoreAvailability),
    scoreFormatSupport: schemaUint(item.scoreFormatSupport),
    scoreModerationPenalty: schemaUint(-Number(item.scoreModerationPenalty || 0))
  }
}

function sourceResponse(source) {
  return {
    publicationId: source.publicationId,
    publisherId: source.publisherId,
    manifestId: source.manifestId,
    renditionId: source.renditionId,
    score: schemaUint(source.score),
    availabilityScore: schemaUint(source.availabilityScore),
    formatSupport: schemaUint(source.formatSupport),
    moderationPenalty: schemaUint(source.moderationPenalty),
    preferred: source.preferred === true,
  }
}

function renditionResponse(rendition) {
  return {
    renditionId: rendition.renditionId,
    purpose: rendition.purpose,
    format: rendition.format,
    coreKey: rendition.core.key,
    coreLength: schemaUint(rendition.core.length),
    treeHash: rendition.core.treeHash,
    byteLength: schemaUint(rendition.core.byteLength),
  }
}

export function createMediaGraphApi(options = {}) {
  const mediaGraphStore = options.mediaGraphStore || options.ctx?.mediaGraphStore || null
  const assetManifestStore = options.assetManifestStore || options.ctx?.assetManifestStore || null
  const sourcePreferenceStore = normalizePreferenceStore(options.sourcePreferenceStore || options.ctx?.sourcePreferenceStore || options.ctx?.metaSubspaces?.mediaSourcePreferences || options.ctx?.metaDb?.sub?.('media-source-preferences'))
  const trust = options.trust || options.ctx?.mediaGraphTrust || {}
  const consumerCatalogProjection = options.consumerCatalogProjection || options.ctx?.consumerCatalogProjection || null

  function requireGraphStore() {
    if (!mediaGraphStore) return error('MEDIA_GRAPH_NOT_READY', 'Media graph projection storage is not wired yet')
    return null
  }

  async function isPreferred(entityId, publicationId) {
    const row = await sourcePreferenceStore.get(sourcePreferenceKey(entityId, publicationId))
    return row?.value?.preferred === true || row?.preferred === true
  }

  async function buildSources(entityId) {
    const rows = mediaGraphStore.getClaimsBySubject(entityId)
      .filter(row => !row.revoked && row.body.claimType === 'AvailabilityObservation' && row.body.payload?.publicationId)
    const sources = []
    for (const row of rows) {
      const publicationId = row.body.payload.publicationId
      const manifest = assetManifestStore?.getManifest?.(publicationId) || null
      sources.push(manifestSource(manifest, row, await isPreferred(entityId, publicationId), trust))
    }
    return selectPublicationSources(sources).sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
      if (b.score !== a.score) return b.score - a.score
      return String(a.publicationId).localeCompare(String(b.publicationId))
    })
  }

  function decorateSources(sources) {
    const diagnostics = new Map(projectSourceSelectionDiagnostics(sources, {
      selectedPublicationId: sources[0]?.publicationId,
      requireAuthorization: true,
      now: options.now?.() ?? Date.now(),
    }).map(item => [item.publicationId, sourceDiagnosticsResponse(item)]))
    return sources.map(source => ({
      ...sourceResponse(source),
      ...(diagnostics.get(source.publicationId) || {}),
    }))
  }

  function resolveOrMissing(entityId) {
    const claims = mediaGraphStore.getClaimsBySubject(entityId)
    if (claims.length === 0) return null
    return resolveMediaEntity(mediaGraphStore, entityId, { trust })
  }

  async function entityResult(entityId, request = {}, agent = false) {
    const missingStore = requireGraphStore()
    if (missingStore) return missingStore
    const resolved = resolveOrMissing(entityId)
    if (!resolved) return error('MEDIA_ENTITY_NOT_FOUND', 'Media entity not found')
    const sources = await buildSources(entityId)
    const entity = {
      entityId,
      entityKind: agent ? 'agent' : entityKindFromRow(resolved.claims[0]) || entityKindFromId(entityId),
      localClusterId: resolved.localClusterId,
      title: resolved.metadata.title || resolved.metadata.displayName || null,
      subtitle: resolved.metadata.subtitle || null,
      displayName: resolved.metadata.displayName || resolved.metadata.title || null,
      claimCount: resolved.claims.length,
      conflictCount: resolved.conflicts.length,
      sources: decorateSources(sources),
      renditions: [],
    }
    return {
      success: true,
      entity,
      claims: request.includeClaims ? resolved.claims.map(claimSummary) : [],
      conflicts: request.includeConflicts ? resolved.conflicts.map(conflictSummary) : [],
    }
  }

  return {
    async getMediaCatalog(request = {}) {
      if (consumerCatalogProjection) {
        try {
          await options.ctx?.mediaCatalogProjection?.update?.()
          await consumerCatalogProjection.update?.()
          const page = consumerCatalogProjection.getCatalog(request)
          if (!page?.success) return page
          return {
            success: true,
            items: page.items.map(item => ({
              entityId: item.entityRef,
              entityKind: item.entityKind || 'unknown',
              title: item.title || null,
              subtitle: item.creator || null,
              claimCount: item.publications?.length || 0,
              conflictCount: 0,
              sources: (item.publications || []).map(publication => ({ publicationId: publication.publicationId, publisherId: publication.publisherId })),
              renditions: [],
            })),
            nextCursor: page.nextCursor,
          }
        } catch {
          return error('CONSUMER_CATALOG_UPDATE_FAILED', 'Consumer catalog projection update failed', { items: [], nextCursor: null })
        }
      }
      const missingStore = requireGraphStore()
      if (missingStore) return { ...missingStore, items: [], nextCursor: null }
      try {
        await options.ctx?.mediaCatalogProjection?.update?.()
      } catch {
        return error('MEDIA_GRAPH_UPDATE_FAILED', 'Media graph projection update failed', { items: [], nextCursor: null })
      }
      const entityIds = new Set()
      for (const claim of mediaGraphStore.getClaims()) {
        if (claim.revoked) continue
        for (const subject of claim.subjects || []) entityIds.add(subject)
      }
      const summaries = []
      for (const entityId of [...entityIds].sort()) {
        const resolved = resolveOrMissing(entityId)
        if (!resolved) continue
        const sources = await buildSources(entityId)
        const renditions = new Map()
        for (const source of sources) {
          const manifest = assetManifestStore?.getManifest?.(source.publicationId)
          for (const rendition of manifest?.body?.renditions || []) {
            if (!rendition.blocked && !rendition.superseded) renditions.set(rendition.renditionId, renditionResponse(rendition))
          }
        }
        summaries.push({
          entityId,
          entityKind: entityKindFromRow(resolved.claims[0]) || entityKindFromId(entityId),
          localClusterId: resolved.localClusterId,
          title: resolved.metadata.title || resolved.metadata.displayName || null,
          subtitle: resolved.metadata.subtitle || null,
          claimCount: resolved.claims.length,
          conflictCount: resolved.conflicts.length,
          sources: sources.map(sourceResponse),
          renditions: [...renditions.values()].sort((left, right) => left.renditionId.localeCompare(right.renditionId)),
        })
      }
      const result = pageCatalogRows(summaries, request)
      if (result.error) return result.error
      return okPage(result.page, result.nextCursor)
    },

    async getMediaEntity(request = {}) {
      return entityResult(request.entityId, request)
    },

    async getMediaCollection(request = {}) {
      return entityResult(request.entityId, request)
    },

    async getMediaCollectionItems(request = {}) {
      const missingStore = requireGraphStore()
      if (missingStore) return { ...missingStore, items: [], nextCursor: null }
      const rows = mediaGraphStore.getClaimsByCollection(request.collectionEntityId)
        .filter(row => !row.revoked && row.body.claimType === 'CollectionMembershipClaim')
        .sort((a, b) => {
          const ap = a.body.payload?.position?.episode || a.body.payload?.position?.index || 0
          const bp = b.body.payload?.position?.episode || b.body.payload?.position?.index || 0
          if (ap !== bp) return ap - bp
          return a.claimId.localeCompare(b.claimId)
        })
      const result = pageRows(rows, request)
      if (result.error) return result.error
      return okPage(result.page.map(row => ({
        entityId: row.body.payload?.memberRef?.entityId,
        entityKind: row.body.payload?.memberRef?.entityKind || entityKindFromId(row.body.payload?.memberRef?.entityId),
        claimCount: 1,
        conflictCount: 0,
        sources: [],
        renditions: [],
      })), result.nextCursor)
    },

    async getMediaAgent(request = {}) {
      return entityResult(request.entityId, request, true)
    },

    async getAgentContributions(request = {}) {
      const missingStore = requireGraphStore()
      if (missingStore) return { ...missingStore, items: [], nextCursor: null }
      const rows = mediaGraphStore.getClaims()
        .filter(row => !row.revoked && row.body.claimType === 'ContributionClaim' && row.body.payload?.agentRef?.entityId === request.agentEntityId)
        .sort((a, b) => a.claimId.localeCompare(b.claimId))
      const result = pageRows(rows, request)
      if (result.error) return result.error
      return okPage(result.page.map(contributionSummary), result.nextCursor)
    },

    async getPublicationSources(request = {}) {
      const missingStore = requireGraphStore()
      if (missingStore) return { ...missingStore, items: [], nextCursor: null }
      const sources = await buildSources(request.entityId)
      const decorated = decorateSources(sources)
      const result = pageRows(decorated, request, source => source.publicationId)
      if (result.error) return result.error
      return okPage(result.page, result.nextCursor)
    },

    async getClaimProvenance(request = {}) {
      const missingStore = requireGraphStore()
      if (missingStore) return missingStore
      const claim = mediaGraphStore.getClaim(request.claimId)
      if (!claim) return error('MEDIA_CLAIM_NOT_FOUND', 'Media claim not found')
      return { success: true, claim: claimSummary(claim) }
    },

    async setSourcePreference(request = {}) {
      const missingStore = requireGraphStore()
      if (missingStore) return missingStore
      if (!request.entityId || !request.publicationId) return error('INVALID_SOURCE_PREFERENCE', 'entityId and publicationId are required')
      const key = sourcePreferenceKey(request.entityId, request.publicationId)
      if (request.preferred) {
        await sourcePreferenceStore.put(key, { entityId: request.entityId, publicationId: request.publicationId, preferred: true })
      } else if (typeof sourcePreferenceStore.del === 'function') {
        await sourcePreferenceStore.del(key)
      } else {
        await sourcePreferenceStore.put(key, { entityId: request.entityId, publicationId: request.publicationId, preferred: false })
      }
      return { success: true }
    },
  }
}
