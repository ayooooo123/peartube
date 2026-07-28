import { AVAILABILITY_STATES, assessAvailability, isPlayableAvailability } from '../assets/availability.js'
import { createAssetSession } from '../assets/asset-session.js'
import { resolveMediaEntity } from '../media-graph/resolver.js'
import { artworkEntry } from '../media-graph/catalog-projection.js'
import { selectPlaybackSource, sourceAvailabilityScore } from '../media-graph/source-selector.js'
import { projectSourceSelectionDiagnostics } from '../media-graph/selection-diagnostics.js'
import { preparePlaybackSource } from '../playback/source-preparation.js'
import { isPlaybackErrorCode, playbackErrorMessage, playbackErrorRetry } from '../playback/errors.js'
import { parseBlobRef } from '../blob-utils.js'
import { isArtworkRendition } from '../assets/rendition.js'
import b4a from 'b4a'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const DEFAULT_CATALOG_PAGE_LIMIT = 20
const MAX_CATALOG_PAGE_LIMIT = 50

// The catalog carries one artwork locator. A swarm blob ref is handed to the
// consumer as the blob it is, so the consumer replicates the bytes from the
// publisher instead of fetching an origin; anything else is passed through as a
// URL for claims that predate swarm-native covers.
// Descriptive metadata reaches the consumer the same way the cover does: with
// the entry, because there is nowhere else for a consumer to get it.
function describedMediaResponse(item) {
  const out = {}
  if (Number.isSafeInteger(item?.releaseYear) && item.releaseYear > 0) out.releaseYear = item.releaseYear
  if (Number.isSafeInteger(item?.runtimeMinutes) && item.runtimeMinutes > 0) out.runtimeMinutes = item.runtimeMinutes
  if (typeof item?.overview === 'string' && item.overview) out.overview = item.overview
  const genres = Array.isArray(item?.genres) ? item.genres.filter(genre => typeof genre === 'string' && genre) : []
  if (genres.length > 0) out.genres = genres
  return out
}

function posterResponse(item) {
  const locator = typeof item?.artwork === 'string' ? item.artwork.trim() : ''
  if (!locator) return {}
  const blob = parseBlobRef({ blobRef: locator })
  if (blob?.blobsCoreKey && blob?.blobId) {
    const mimeType = typeof item.artworkMimeType === 'string' && item.artworkMimeType ? item.artworkMimeType : null
    return {
      posterBlobId: blob.blobId,
      posterBlobsCoreKey: blob.blobsCoreKey,
      ...(mimeType ? { posterMimeType: mimeType } : {}),
    }
  }
  return { posterUrl: locator }
}

// The consumer projection hands its items one resolved display locator; the graph
// resolver hands back the publisher's raw metadata claim. Normalizing here is
// what keeps every media-entity-summary path carrying the same cover and the same
// synopsis, so a title cannot show art on a shelf and none on its own page.
function summaryMediaFields(metadata) {
  const entry = artworkEntry(metadata?.artwork)
  return {
    ...posterResponse({ artwork: entry?.locator || null, artworkMimeType: entry?.mimeType || null }),
    ...describedMediaResponse({
      releaseYear: Number(metadata?.releaseYear),
      runtimeMinutes: Number(metadata?.runtimeMinutes),
      overview: metadata?.overview,
      genres: metadata?.genres,
    }),
  }
}

// Cover art is an asset OF the publication, not a side channel: the publisher
// signs it into the manifest as a `poster` rendition, so it seeds, authorizes,
// and transfers over the same asset protocol as the video. `body.artwork` is not
// reachable that way, so only a signed rendition can ever yield bytes.
const POSTER_RENDITION_PURPOSE = 'poster'
const DEFAULT_ARTWORK_TRANSFER_TIMEOUT_MS = 3_000
const ARTWORK_RETAIN_TIMEOUT_MS = 3_000
const ARTWORK_POLL_INTERVAL_MS = 100
const ARTWORK_MISS = Symbol('artwork-miss')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// A cold cover must never hold an RPC open, and a retain that rejects is the
// same answer as one that has not finished: come back later.
function boundedAttempt(promise, timeoutMs) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).then(value => value, () => ARTWORK_MISS),
    new Promise(resolve => { timer = setTimeout(() => resolve(ARTWORK_MISS), timeoutMs) }),
  ]).then(value => {
    clearTimeout(timer)
    return value
  })
}

function findPosterRendition(manifest) {
  return (manifest?.body?.renditions || []).find(rendition => (
    rendition?.purpose === POSTER_RENDITION_PURPOSE &&
    rendition.blocked !== true &&
    rendition.superseded !== true &&
    typeof rendition.renditionId === 'string' && rendition.renditionId.length > 0
  )) || null
}

// The publisher records the poster's hyperblobs id verbatim in provenance. Its
// byte offset inside the block region is not derivable from the block span, so
// rebuilding the id would read the wrong bytes; the span is only a fallback for
// a manifest that recorded no id.
function posterBlobRef(manifest, rendition) {
  const coreKey = rendition?.core?.key
  if (!coreKey) return null
  const entry = (manifest?.body?.provenance || []).find(candidate => (
    candidate?.type === 'artwork' &&
    candidate.renditionId === rendition.renditionId &&
    candidate.coreKey === coreKey
  ))
  if (!entry) return null
  const direct = parseBlobRef({ blobsCoreKey: coreKey, blobId: entry.blobId })
  if (direct) return direct
  const start = Number(entry.start)
  const end = Number(entry.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null
  return parseBlobRef({
    blobsCoreKey: coreKey,
    blobId: {
      blockOffset: start,
      blockLength: end - start,
      byteOffset: 0,
      byteLength: schemaUint(rendition.core?.byteLength),
    },
  })
}

// The same loopback path getVideoThumbnail uses: `pt_thumbnail=1` makes the blob
// server answer from a buffer with a fixed Content-Length instead of a streaming
// pipe that waits on replication, which is the only shape native image loaders
// accept.
function artworkBlobUrl(blobServer, ref, mimeType, host, port) {
  const baseUrl = String(blobServer.getLink(b4a.from(ref.blobsCoreKey, 'hex'), {
    blob: ref.blob,
    type: mimeType,
    host,
    port,
  }))
  const [origin, query = ''] = baseUrl.split('?')
  const pathUrl = `${origin.replace(/\/$/, '')}/__peartube_thumbnail__.jpg${query ? `?${query}` : ''}`
  return `${pathUrl}${pathUrl.includes('?') ? '&' : '?'}pt_thumbnail=1`
}

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

// `availabilityState`/`stale` remain the selection-diagnostics vocabulary and
// are derived from the assessment, never from the publisher's claimed status.
// Task 4 collapses that legacy gate onto the four-state contract directly.
const LEGACY_AVAILABILITY_STATE = Object.freeze({
  [AVAILABILITY_STATES.healthy]: 'available',
  [AVAILABILITY_STATES.limited]: 'available',
  [AVAILABILITY_STATES.unavailable]: 'unavailable',
  [AVAILABILITY_STATES.awaitingReplication]: 'unknown',
})

function manifestSource(manifest, row, preferred, trust = {}, availability = null, entityId = null) {
  const publisherId = manifest?.body?.publisherId || row.issuer
  // Cover art now rides the manifest as a rendition so it seeds with the
  // publication. It is not something to play: without this filter a source
  // resolves to the poster and a viewer presses Play on a JPEG.
  const rendition = manifest?.body?.renditions?.find(candidate => (
    candidate && candidate.blocked !== true && candidate.superseded !== true &&
    !isArtworkRendition(candidate) &&
    typeof candidate.renditionId === 'string' && candidate.renditionId.length > 0
  )) || null
  const publicationId = manifest?.publicationId || row.body.payload?.publicationId
  return {
    publicationId,
    publisherId,
    manifestId: manifest?.body?.manifestId || null,
    renditionId: rendition?.renditionId || null,
    // Failover identity. `entityId` anchors the work being played, the edition
    // and collection position distinguish cuts and episodes, and `protected`
    // separates DRM titles from public lookalikes. Missing anchors fail closed
    // in `sourceEquivalenceKey`, which is why they are read, not defaulted.
    entityId: entityId || row.body?.subjectRefs?.[0]?.entityId || null,
    editionId: row.body.payload?.editionRef?.entityId || row.body.payload?.editionId || null,
    collectionMemberId: row.body.payload?.memberRef?.entityId || null,
    protected: rendition?.encryption != null,
    container: rendition?.format || null,
    codecs: rendition?.codecs || null,
    drmSystem: rendition?.encryption?.drmSystem || null,
    manifestStale: manifest?.body?.superseded === true,
    // Measured against a contributing peer, never claimed by the publisher.
    expectedStartupLatencyMs: availability?.measuredLatencyMs || 0,
    publicationAuthorized: Boolean(
      manifest &&
      rendition &&
      manifest.publicationId === publicationId &&
      manifest.body?.publisherId === publisherId
    ),
    metadataConfidence: row.body.confidence || 0,
    publisherTrust: trust[publisherId] || 0,
    availabilityScore: sourceAvailabilityScore({ availability }),
    formatSupport: 100,
    moderationPenalty: row.body.payload?.moderationPenalty || 0,
    availability,
    availabilityState: LEGACY_AVAILABILITY_STATE[availability?.state] || 'unknown',
    availabilityExpiresAt: availability?.expiresAt ?? 0,
    archiveState: row.body.payload?.archiveState,
    cacheState: row.body.payload?.cacheState,
    introductionPublisherIds: row.body.payload?.introductionPublisherIds || [row.issuer],
    introductionIndexIds: row.body.payload?.introductionIndexIds || [],
    moderationFeedIds: row.body.payload?.moderationFeedIds || [],
    claimConflictIds: row.body.payload?.claimConflictIds || [],
    provenanceClaimIds: row.body.payload?.provenanceClaimIds || [row.claimId],
    stale: availability?.state === AVAILABILITY_STATES.unavailable &&
      (availability?.reasonCodes || []).includes('EVIDENCE_EXPIRED'),
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
    scoreLocalCompleteness: schemaUint(item.scoreLocalCompleteness),
    scoreStartupReachability: schemaUint(item.scoreStartupReachability),
    scorePeerEvidence: schemaUint(item.scorePeerEvidence),
    scoreFormatSupport: schemaUint(item.scoreFormatSupport),
    // Latency is a penalty in the score and a magnitude on the wire.
    scoreStartupLatency: schemaUint(-Number(item.scoreStartupLatency || 0)),
    scoreUserOverride: schemaUint(item.scoreUserOverride),
  }
}

function availabilityResponse(availability) {
  if (!availability) return null
  return {
    state: availability.state,
    renditionId: availability.renditionId || null,
    observedAt: schemaUint(availability.observedAt),
    expiresAt: schemaUint(availability.expiresAt),
    requiredRangeCount: schemaUint(availability.requiredRangeCount),
    reachableRangeCount: schemaUint(availability.reachableRangeCount),
    independentPeerCount: schemaUint(availability.independentPeerCount),
    completePeerCount: schemaUint(availability.completePeerCount),
    measuredLatencyMs: schemaUint(availability.measuredLatencyMs),
    offlinePlayable: availability.offlinePlayable === true,
    archivePledged: availability.archivePledged === true,
    reasonCodes: availability.reasonCodes || [],
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
    availability: availabilityResponse(source.availability),
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
  const availabilityEvidenceStore = options.availabilityEvidenceStore || options.ctx?.availabilityEvidenceStore || null
  // What this device can actually decrypt and decode. An absent list leaves
  // that dimension unconstrained rather than silently rejecting every source.
  const deviceCapabilities = options.capabilities || options.ctx?.deviceCapabilities || {}
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()

  /**
   * Open one authorized scoped asset session for a selected source. It proves
   * the rendition core the manifest signed is the core we are about to read;
   * a mismatch is a per-source failure, so preparation may try the next
   * equivalent source instead of failing the whole Play action.
   */
  const openPlaybackSession = typeof options.openPlaybackSession === 'function'
    ? options.openPlaybackSession
    : async ({ source }) => {
      const manifest = assetManifestStore?.getManifest?.(source.publicationId) || null
      const openCore = options.openCore || options.ctx?.openAssetCore || null
      if (!manifest || typeof openCore !== 'function') {
        return { success: false, errorCode: 'NO_COMPATIBLE_SOURCE' }
      }
      const requirement = assetManifestStore?.getRenditionRequirement?.(source.publicationId, source.renditionId)
      const session = createAssetSession({ manifest, openCore })
      let authorized = false
      try {
        authorized = await session.authorizeCore({
          renditionId: source.renditionId,
          coreKey: requirement?.coreKey,
        })
      } catch (thrown) {
        session.close()
        // A scoped session reports its own bounded code (SESSION_LIMIT, and
        // later DRM codes). Only an unrecognised failure degrades to a peer
        // timeout, so a real reason is never flattened into the wrong policy.
        const errorCode = isPlaybackErrorCode(thrown?.errorCode) ? thrown.errorCode : 'PEER_TIMEOUT'
        return { success: false, errorCode }
      }
      if (!authorized) {
        session.close()
        return { success: false, errorCode: 'RANGE_MISMATCH' }
      }
      return {
        success: true,
        coreKey: requirement?.coreKey || null,
        close: () => session.close(),
      }
    }

  /**
   * One assessment per rendition per operation. Cards, entity details, Other
   * Sources, and playback preparation must quote the same instance and the same
   * `observedAt`, so a viewer never sees two different availability answers for
   * one title in one response.
   *
   * Reading is passive: it consumes evidence the asset layer already collected
   * under its own lazy budget and never opens an asset swarm to render a page.
   */
  function createAvailabilityScope() {
    const observedAt = clock()
    const cache = new Map()
    return {
      observedAt,
      assess(publicationId, renditionId = null) {
        const key = `${publicationId}\n${renditionId || ''}`
        const cached = cache.get(key)
        if (cached) return cached
        const requirement = assetManifestStore?.getRenditionRequirement?.(publicationId, renditionId) || null
        const evidence = availabilityEvidenceStore?.getCachedEvidence?.(
          publicationId,
          requirement?.renditionId || renditionId || null,
        ) || {}
        const assessment = assessAvailability({
          ...evidence,
          publicationId,
          renditionId: requirement?.renditionId || renditionId || null,
          requiredRanges: requirement?.requiredRanges || [],
        }, { now: observedAt })
        cache.set(key, assessment)
        return assessment
      },
    }
  }

  function requireGraphStore() {
    if (!mediaGraphStore) return error('MEDIA_GRAPH_NOT_READY', 'Media graph projection storage is not wired yet')
    return null
  }

  async function isPreferred(entityId, publicationId) {
    const row = await sourcePreferenceStore.get(sourcePreferenceKey(entityId, publicationId))
    return row?.value?.preferred === true || row?.preferred === true
  }

  async function buildSources(entityId, scope) {
    const rows = mediaGraphStore.getClaimsBySubject(entityId)
      .filter(row => !row.revoked && row.body.claimType === 'AvailabilityObservation' && row.body.payload?.publicationId)
    const sources = []
    for (const row of rows) {
      const publicationId = row.body.payload.publicationId
      if (
        typeof consumerCatalogProjection?.isPublicationVisible === 'function' &&
        consumerCatalogProjection.isPublicationVisible(publicationId) !== true
      ) {
        continue
      }
      const manifest = assetManifestStore?.getManifest?.(publicationId) || null
      sources.push(manifestSource(
        manifest,
        row,
        await isPreferred(entityId, publicationId),
        trust,
        scope.assess(publicationId),
        entityId,
      ))
    }
    // One decision, one order: the selector ranks what can actually play and
    // pushes everything it rejected to the tail. Nothing downstream re-ranks.
    const selection = selectPlaybackSource(sources, {
      capabilities: deviceCapabilities,
      now: scope.observedAt,
    })
    return {
      selection,
      sources: selection.candidates.map(candidate => ({ ...candidate.source, score: candidate.score })),
    }
  }

  function isPublicationVisible(publicationId) {
    if (typeof consumerCatalogProjection?.isPublicationVisible !== 'function') return true
    return consumerCatalogProjection.isPublicationVisible(publicationId) === true
  }

  function isEntityVisible(entityId) {
    if (typeof consumerCatalogProjection?.isVisible !== 'function') return true
    return consumerCatalogProjection.isVisible(entityId) === true
  }

  function hasVisibleLinkedPublication(entityId) {
    const publications = mediaGraphStore.getClaimsBySubject(entityId)
      .filter(row => (
        !row.revoked &&
        row.body.claimType === 'AvailabilityObservation' &&
        row.body.payload?.publicationId
      ))
      .map(row => row.body.payload.publicationId)
    return publications.length === 0 || publications.some(isPublicationVisible)
  }

  function isConsumerClaimVisible(row) {
    if (!consumerCatalogProjection) return true
    if (
      typeof consumerCatalogProjection.isClaimVisible === 'function' &&
      consumerCatalogProjection.isClaimVisible(row.claimId) !== true
    ) return false
    const publicationId = row.body?.payload?.publicationId
    if (publicationId && !isPublicationVisible(publicationId)) return false
    if (row.body?.claimType === 'CollectionMembershipClaim') {
      const memberId = row.body.payload?.memberRef?.entityId
      return Boolean(memberId && isEntityVisible(memberId) && hasVisibleLinkedPublication(memberId))
    }
    const workSubjects = (row.body?.subjectRefs || []).filter(ref => ref.entityKind === 'work')
    if (workSubjects.length > 0 && !workSubjects.some(ref => (
      isEntityVisible(ref.entityId) && hasVisibleLinkedPublication(ref.entityId)
    ))) return false
    return true
  }

  function consumerStoreView() {
    return {
      getClaims() {
        return mediaGraphStore.getClaims().filter(isConsumerClaimVisible)
      },
      getClaimsBySubject(entityId) {
        return mediaGraphStore.getClaimsBySubject(entityId).filter(isConsumerClaimVisible)
      },
    }
  }

  function decorateSources(built, selection = built.selection) {
    const diagnostics = new Map(
      projectSourceSelectionDiagnostics(built.sources, { selection })
        .map(item => [item.publicationId, sourceDiagnosticsResponse(item)])
    )
    return built.sources.map(source => ({
      ...sourceResponse(source),
      ...(diagnostics.get(source.publicationId) || {}),
    }))
  }

  /**
   * What Play would report right now: the availability of the source the
   * selector chose, or a metadata-only assessment when nothing can play.
   */
  function entityAvailability(built, scope) {
    return built.selection.selected?.availability ||
      built.sources[0]?.availability ||
      scope.assess('', null)
  }

  function resolveOrMissing(entityId, consumerVisible = false) {
    const store = consumerVisible && consumerCatalogProjection ? consumerStoreView() : mediaGraphStore
    const claims = store.getClaimsBySubject(entityId)
    if (claims.length === 0) return null
    return resolveMediaEntity(store, entityId, { trust })
  }

  async function entityResult(entityId, request = {}, agent = false) {
    const missingStore = requireGraphStore()
    if (missingStore) return missingStore
    if (!agent && consumerCatalogProjection) {
      await options.ctx?.mediaCatalogProjection?.update?.()
      await consumerCatalogProjection.update?.()
      if (!consumerCatalogProjection.isVisible?.(entityId)) {
        return error('MEDIA_ENTITY_NOT_VISIBLE', 'Media entity is not visible under this device policy')
      }
    }
    const resolved = resolveOrMissing(entityId, !agent)
    if (!resolved) return error('MEDIA_ENTITY_NOT_FOUND', 'Media entity not found')
    const scope = createAvailabilityScope()
    const built = await buildSources(entityId, scope)
    const entity = {
      entityId,
      entityKind: agent ? 'agent' : entityKindFromRow(resolved.claims[0]) || entityKindFromId(entityId),
      localClusterId: resolved.localClusterId,
      title: resolved.metadata.title || resolved.metadata.displayName || null,
      subtitle: resolved.metadata.subtitle || null,
      displayName: resolved.metadata.displayName || resolved.metadata.title || null,
      claimCount: resolved.claims.length,
      conflictCount: resolved.conflicts.length,
      availability: availabilityResponse(entityAvailability(built, scope)),
      sources: decorateSources(built),
      renditions: [],
      ...summaryMediaFields(resolved.metadata),
    }
    return {
      success: true,
      entity,
      claims: request.includeClaims ? resolved.claims.map(claimSummary) : [],
      conflicts: request.includeConflicts ? resolved.conflicts.map(conflictSummary) : [],
    }
  }

  // How long one artwork resolution may spend waiting for the retained transfer
  // before it answers "not yet". A retryable miss beats a hung RPC.
  const artworkTransferTimeoutMs = Number.isSafeInteger(options.artworkTransferTimeoutMs) && options.artworkTransferTimeoutMs >= 0
    ? options.artworkTransferTimeoutMs
    : DEFAULT_ARTWORK_TRANSFER_TIMEOUT_MS

  /**
   * A read-only session on the local corestore, used only to observe whether the
   * poster's blocks have arrived. Retaining the rendition is what pulls them, so
   * this never becomes a second, unauthorized replication path.
   */
  async function openArtworkProbe(ref) {
    const store = options.store || options.ctx?.store || null
    if (typeof store?.get !== 'function') return null
    const start = ref.blob.blockOffset
    const end = start + ref.blob.blockLength
    let core = null
    try {
      core = store.get({ key: b4a.from(ref.blobsCoreKey, 'hex') })
      await core.ready?.()
    } catch {
      try { await core?.close?.() } catch { /* best effort */ }
      return null
    }
    return {
      async local() {
        try { return await core.has(start, end) === true } catch { return false }
      },
      async close() {
        try { await core.close?.() } catch { /* best effort */ }
      },
    }
  }

  // Polling counts attempts rather than reading a clock: the injected clock is
  // frozen in tests, and a deadline compared against it would never expire.
  async function waitForArtworkBytes(probe) {
    const attempts = Math.max(1, Math.ceil(artworkTransferTimeoutMs / ARTWORK_POLL_INTERVAL_MS))
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await probe.local()) return true
      if (attempt + 1 < attempts) await sleep(ARTWORK_POLL_INTERVAL_MS)
    }
    return false
  }

  /**
   * Make the poster's bytes local over the authorized asset path, then hand back
   * the loopback URL that serves them. Null means "no bytes yet" — never an
   * error, because a consumer that just discovered a title has not replicated
   * its cover yet either.
   */
  async function resolveArtworkUrl({ manifest, publicationId, rendition, ref, entityId }) {
    const blobServer = options.blobServer || options.ctx?.blobServer || null
    if (typeof blobServer?.getLink !== 'function') return null
    const probe = await openArtworkProbe(ref)
    if (!probe) return null
    try {
      if (!await probe.local()) {
        const scopedNetwork = options.scopedNetwork || options.ctx?.scopedNetwork || null
        if (typeof scopedNetwork?.retainAuthorizedRendition !== 'function') return null
        // Retention IS the transfer: it joins the publication's asset scope and
        // downloads exactly the poster's block span under the manifest the
        // publisher signed. No raw core is opened for replication here.
        const retained = await boundedAttempt(scopedNetwork.retainAuthorizedRendition({
          manifest,
          renditionId: rendition.renditionId,
          start: ref.blob.blockOffset,
          end: ref.blob.blockOffset + ref.blob.blockLength,
          entityRef: entityId || null,
          publicationId,
        }), ARTWORK_RETAIN_TIMEOUT_MS)
        if (retained === ARTWORK_MISS) return null
        if (!await waitForArtworkBytes(probe)) return null
      }
      // The publisher declares the poster's encoding as the rendition format;
      // mislabelled bytes are what native decoders refuse outright.
      const mimeType = typeof rendition.format === 'string' && rendition.format.startsWith('image/')
        ? rendition.format
        : 'image/jpeg'
      return artworkBlobUrl(
        blobServer,
        ref,
        mimeType,
        options.ctx?.blobServerHost || '127.0.0.1',
        blobServer.port || options.ctx?.blobServerPort,
      )
    } finally {
      await probe.close()
    }
  }

  return {
    async getMediaCatalog(request = {}) {
      const scope = createAvailabilityScope()
      if (consumerCatalogProjection) {
        try {
          await options.ctx?.mediaCatalogProjection?.update?.()
          await consumerCatalogProjection.update?.()
          const page = consumerCatalogProjection.getCatalog(request)
          if (!page?.success) return page
          return {
            success: true,
            items: page.items.map(item => {
              const sources = (item.publications || []).map(publication => ({
                publicationId: publication.publicationId,
                publisherId: publication.publisherId,
                availability: scope.assess(publication.publicationId),
              }))
              return {
                entityId: item.entityRef,
                entityKind: item.entityKind || 'unknown',
                title: item.title || null,
                subtitle: item.creator || null,
                claimCount: item.publications?.length || 0,
                conflictCount: 0,
                availability: availabilityResponse(
                  sources.find(source => isPlayableAvailability(source.availability))?.availability ||
                  sources[0]?.availability ||
                  scope.assess('', null)
                ),
                sources: sources.map(source => ({
                  publicationId: source.publicationId,
                  publisherId: source.publisherId,
                  availability: availabilityResponse(source.availability),
                })),
                renditions: [],
                // Cover art is published on the metadata claim; passing it on
                // is what stops a fully synced catalog rendering blank.
                ...posterResponse(item),
                ...describedMediaResponse(item),
              }
            }),
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
        const built = await buildSources(entityId, scope)
        const renditions = new Map()
        for (const source of built.sources) {
          const manifest = assetManifestStore?.getManifest?.(source.publicationId)
          for (const rendition of manifest?.body?.renditions || []) {
            // Artwork seeds with the publication but is not one of the media
            // renditions a client chooses between.
            if (isArtworkRendition(rendition)) continue
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
          availability: availabilityResponse(entityAvailability(built, scope)),
          sources: built.sources.map(sourceResponse),
          renditions: [...renditions.values()].sort((left, right) => left.renditionId.localeCompare(right.renditionId)),
          ...summaryMediaFields(resolved.metadata),
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
      if (consumerCatalogProjection) {
        await options.ctx?.mediaCatalogProjection?.update?.()
        await consumerCatalogProjection.update?.()
        if (!isEntityVisible(request.collectionEntityId)) {
          return error(
            'MEDIA_ENTITY_NOT_VISIBLE',
            'Media collection is not visible under this device policy',
            { items: [], nextCursor: null },
          )
        }
      }
      const rows = mediaGraphStore.getClaimsByCollection(request.collectionEntityId)
        .filter(row => (
          !row.revoked &&
          row.body.claimType === 'CollectionMembershipClaim' &&
          isConsumerClaimVisible(row)
        ))
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
      if (consumerCatalogProjection) {
        await options.ctx?.mediaCatalogProjection?.update?.()
        await consumerCatalogProjection.update?.()
        if (!consumerCatalogProjection.isVisible?.(request.entityId)) {
          return error(
            'MEDIA_ENTITY_NOT_VISIBLE',
            'Media entity is not visible under this device policy',
            { items: [], nextCursor: null },
          )
        }
      }
      const scope = createAvailabilityScope()
      const decorated = decorateSources(await buildSources(request.entityId, scope))
      const result = pageRows(decorated, request, source => source.publicationId)
      if (result.error) return result.error
      return okPage(result.page, result.nextCursor)
    },

    /**
     * Cover art for one entity, as bytes this device already holds.
     *
     * The poster is an asset OF the publication: the publisher signs it into the
     * manifest as a `poster` rendition, so retaining that rendition moves it over
     * the same authorized asset protocol as the video. Nothing here reaches an
     * origin, opens a raw blob core, or consults a separate artwork feed — a
     * device that can play a title can also see its cover.
     *
     * `exists: false` with no errorCode means the bytes have not arrived yet.
     * That is retryable, not a failure.
     */
    async getEntityArtwork(request = {}) {
      const entityId = typeof request.entityId === 'string' ? request.entityId.trim() : ''
      const requestedPublicationId = typeof request.publicationId === 'string' ? request.publicationId.trim() : ''
      if (!entityId && !requestedPublicationId) {
        return error('INVALID_ARTWORK_REQUEST', 'entityId or publicationId is required', { exists: false })
      }

      let publicationIds = []
      if (requestedPublicationId) {
        if (!isPublicationVisible(requestedPublicationId)) {
          return error('MEDIA_ENTITY_NOT_VISIBLE', 'Publication is not visible under this device policy', { exists: false })
        }
        publicationIds = [requestedPublicationId]
      } else {
        const missingStore = requireGraphStore()
        if (missingStore) return { ...missingStore, exists: false }
        if (consumerCatalogProjection) {
          // A stale projection still resolves covers this device already holds,
          // so a refresh failure must not blank the artwork.
          try {
            await options.ctx?.mediaCatalogProjection?.update?.()
            await consumerCatalogProjection.update?.()
          } catch { /* best effort */ }
          if (!isEntityVisible(entityId)) {
            return error('MEDIA_ENTITY_NOT_VISIBLE', 'Media entity is not visible under this device policy', { exists: false })
          }
        }
        publicationIds = mediaGraphStore.getClaimsBySubject(entityId)
          .filter(row => (
            !row.revoked &&
            row.body.claimType === 'AvailabilityObservation' &&
            row.body.payload?.publicationId
          ))
          .map(row => row.body.payload.publicationId)
          .filter(isPublicationVisible)
      }

      for (const publicationId of new Set(publicationIds)) {
        const manifest = assetManifestStore?.getManifest?.(publicationId) || null
        const rendition = findPosterRendition(manifest)
        if (!rendition) continue
        const ref = posterBlobRef(manifest, rendition)
        if (!ref) continue
        const url = await resolveArtworkUrl({ manifest, publicationId, rendition, ref, entityId })
        if (url) return { success: true, exists: true, url }
      }
      return { success: true, exists: false }
    },

    /**
     * One Play action. The backend selects a source, opens it, and fails over
     * between equivalent sources inside one deadline; the client never picks.
     */
    async prepareMediaPlayback(request = {}) {
      const missingStore = requireGraphStore()
      if (missingStore) return { ...missingStore, attempts: [], sources: [] }
      if (consumerCatalogProjection) {
        await options.ctx?.mediaCatalogProjection?.update?.()
        await consumerCatalogProjection.update?.()
        if (!consumerCatalogProjection.isVisible?.(request.entityId)) {
          return error(
            'MEDIA_ENTITY_NOT_VISIBLE',
            'Media entity is not visible under this device policy',
            { attempts: [], sources: [] },
          )
        }
      }
      const scope = createAvailabilityScope()
      const built = await buildSources(request.entityId, scope)
      const prepared = await preparePlaybackSource({
        sources: built.sources,
        capabilities: deviceCapabilities,
        selectedPublicationId: request.publicationId,
        openSession: openPlaybackSession,
        deadlineMs: options.preparationDeadlineMs,
        maxAttempts: options.preparationMaxAttempts,
        // Availability stays pinned to `scope.observedAt` for consistency, but
        // the preparation deadline must advance with real time or every retry
        // would silently get the full budget again.
        now: clock,
      })
      // Other Sources must agree with what Play actually did. Re-select around
      // the source that started, and fold each attempt's failure into the
      // candidate it belongs to so an abandoned winner explains itself.
      const attemptFailures = new Map(
        prepared.attempts.filter(attempt => attempt.errorCode).map(attempt => [attempt.publicationId, attempt.errorCode])
      )
      const outcome = prepared.success
        ? selectPlaybackSource(built.sources, {
          capabilities: deviceCapabilities,
          selectedPublicationId: prepared.publicationId,
          now: scope.observedAt,
        })
        : { candidates: prepared.candidates.map(candidate => ({ ...candidate, selected: false, selectionReasonCodes: [] })) }
      const sources = decorateSources(built, {
        candidates: outcome.candidates.map(candidate => {
          const failure = attemptFailures.get(candidate.publicationId)
          if (!failure || candidate.selected) return candidate
          return {
            ...candidate,
            rejectionReasonCodes: [...new Set([failure, ...candidate.rejectionReasonCodes])],
          }
        }),
      })
      if (!prepared.success) {
        return {
          success: false,
          errorCode: prepared.errorCode,
          error: playbackErrorMessage(prepared.errorCode),
          retry: playbackErrorRetry(prepared.errorCode),
          attempts: prepared.attempts,
          sources,
        }
      }
      return {
        success: true,
        publicationId: prepared.publicationId,
        renditionId: prepared.renditionId,
        coreKey: prepared.session.coreKey || null,
        attempts: prepared.attempts,
        sources,
      }
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
