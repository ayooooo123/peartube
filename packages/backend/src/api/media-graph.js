import { AVAILABILITY_STATES, assessAvailability, requiredRangesForRendition } from '../assets/availability.js'
import { createAssetSession } from '../assets/asset-session.js'
import { artworkEntry, describeMedia } from '../media-graph/described-media.js'
import { selectPlaybackSource, sourceAvailabilityScore } from '../media-graph/source-selector.js'
import { projectSourceSelectionDiagnostics } from '../media-graph/selection-diagnostics.js'
import { preparePlaybackSource } from '../playback/source-preparation.js'
import { isPlaybackErrorCode, playbackErrorMessage, playbackErrorRetry } from '../playback/errors.js'
import { parseBlobRef } from '../blob-utils.js'
import { isArtworkRendition, normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { ASSET_BLOCK_SIZE } from '../assets/static-core.js'
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
// the entry, because there is nowhere else for a consumer to get it. It is
// bounded on the way out by the same normalizer the publisher's own ingest
// used, because a claim signed by somebody else never went through that one.

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

// The verified view hands back resolved metadata and manifests. Normalizing
// here keeps catalog cards and entity details on the same cover and synopsis.
function summaryMediaFields(metadata) {
  const entry = artworkEntry(metadata?.artwork)
  return {
    ...posterResponse({ artwork: entry?.locator || null, artworkMimeType: entry?.mimeType || null }),
    ...describeMedia(metadata),
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
const RENDITION_RETAIN_TIMEOUT_MS = 3_000

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
/**
 * Where a rendition's bytes actually live. The publisher records this once per
 * rendition - 'artwork' for a cover, 'upload' for the video - and it is the only
 * way back to a block span: core.length is blockOffset + blockLength, so neither
 * term survives on its own.
 */
function renditionBlobRef(manifest, rendition) {
  let core
  try {
    core = normalizeAssetCoreRefV2(rendition?.core)
  } catch {
    return null
  }
  const coreKey = core.key
  if (!coreKey) return null
  const entry = (manifest?.body?.provenance || []).find(candidate => (
    candidate.renditionId === rendition.renditionId &&
    candidate.coreKey === coreKey
  ))
  if (entry) {
    const direct = parseBlobRef({ blobsCoreKey: coreKey, blobId: entry.blobId })
    if (direct) return direct
    const start = Number(entry.start)
    const end = Number(entry.end)
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start) {
      const ranged = parseBlobRef({
        blobsCoreKey: coreKey,
        blobId: {
          blockOffset: start,
          blockLength: end - start,
          byteOffset: 0,
          byteLength: schemaUint(core.byteLength),
        },
      })
      if (ranged) return ranged
    }
  }
  if (core.kind === 'static-prologue-v1') {
    return parseBlobRef({
      blobsCoreKey: coreKey,
      blobId: {
        blockOffset: 0,
        blockLength: core.length,
        byteOffset: 0,
        byteLength: core.byteLength,
      },
    })
  }
  return null
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
// are derived from local expiring evidence, never from publisher claims.
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
    sourceFileName: manifest?.body?.sourceFileName || null,
    title: manifest?.body?.title || null,
    // Failover identity. `entityId` anchors the work being played, and the
    // anchors fail closed in `sourceEquivalenceKey`, which is why they are
    // read, not defaulted.
    entityId: entityId || row.body?.subjectRefs?.[0]?.entityId || null,
    editionId: row.body.payload?.editionRef?.entityId || row.body.payload?.editionId || null,
    collectionMemberId: row.body.payload?.memberRef?.entityId || null,
    container: rendition?.format || null,
    codecs: rendition?.codecs || null,
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
  if (!item) return {}
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

// An episode's identity is signed into its external reference as
// `show:<mediaId>:s<season>:e<episode>` (`channel/structured-content.js`), so a
// catalog reader can name the episode without inferring it from a title. A
// reference that does not carry ordinals is a work-level coordinate and says so.
const EPISODE_REFERENCE = /^show:([^:]+):s(\d+):e(\d+)$/i

export function mediaCoordinatesResponse(externalRefs, entityKind, releaseYear) {
  const ref = (externalRefs || []).find(candidate => candidate?.namespace && candidate?.identifier)
  if (!ref) return null
  const episode = EPISODE_REFERENCE.exec(String(ref.identifier))
  if (episode) {
    return {
      contentKind: 'episode',
      mediaProvider: ref.namespace,
      mediaId: episode[1],
      seasonNumber: schemaUint(episode[2]),
      episodeNumber: schemaUint(episode[3]),
    }
  }
  return {
    contentKind: entityKind === 'series' || entityKind === 'show' ? 'series' : 'movie',
    mediaProvider: ref.namespace,
    mediaId: String(ref.identifier),
    ...(releaseYear ? { releaseYear: schemaUint(releaseYear) } : {}),
  }
}

function sourceResponse(source, mediaCoordinates = null) {
  return {
    publicationId: source.publicationId,
    publisherId: source.publisherId,
    manifestId: source.manifestId,
    renditionId: source.renditionId,
    sourceFileName: source.sourceFileName || source.manifest?.body?.sourceFileName || null,
    title: source.title || source.manifest?.body?.title || null,
    score: schemaUint(source.score),
    formatSupport: schemaUint(source.formatSupport),
    moderationPenalty: schemaUint(source.moderationPenalty),
    preferred: source.preferred === true,
    availability: availabilityResponse(source.availability),
    // The work coordinate the publisher signed, carried per source because a
    // reader decides per release which episode or film it is looking at.
    ...(mediaCoordinates ? { mediaCoordinates } : {}),
  }
}

function renditionResponse(rendition) {
  let core
  try {
    core = normalizeAssetCoreRefV2(rendition?.core)
  } catch {
    core = rendition?.core || {}
  }
  return {
    renditionId: rendition.renditionId,
    purpose: rendition.purpose,
    format: rendition.format,
    coreKey: core.key || '',
    coreLength: schemaUint(core.length),
    treeHash: core.treeHash || '',
    byteLength: schemaUint(core.byteLength),
  }
}

export function createMediaGraphApi(options = {}) {
  const verifiedQueryView = options.verifiedQueryView || options.ctx?.verifiedQueryView || null
  const sourcePreferenceStore = normalizePreferenceStore(options.sourcePreferenceStore || options.ctx?.sourcePreferenceStore || options.ctx?.metaSubspaces?.mediaSourcePreferences || options.ctx?.metaDb?.sub?.('media-source-preferences'))
  const trust = options.trust || options.ctx?.mediaGraphTrust || {}
  const availabilityEvidenceStore = options.availabilityEvidenceStore || options.ctx?.availabilityEvidenceStore || null
  // Taking custody of a rendition is how this device becomes a holder of it, so
  // the runtime that owns that is needed across this whole surface, not just in
  // the artwork path that first reached for it.
  const scopedNetwork = options.scopedNetwork || options.ctx?.scopedNetwork || null
  // What this device can actually decode. An absent list leaves that dimension
  // unconstrained rather than silently rejecting every source.
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
      const projected = await verifiedQueryView?.getRendition?.({
        publicationId: source.publicationId,
        renditionId: source.renditionId,
      })
      const manifest = projected?.manifest || null
      const requirement = projected?.requirement || null
      const openCore = options.openCore || options.ctx?.openAssetCore || null
      if (!manifest || !requirement || typeof openCore !== 'function') {
        return { success: false, errorCode: 'NO_COMPATIBLE_SOURCE' }
      }
      const provenance = (manifest.body?.provenance || []).filter(candidate =>
        (candidate?.type === 'upload' || candidate?.type === 'artwork') &&
        candidate.renditionId === source.renditionId &&
        Number.isSafeInteger(candidate.start) &&
        Number.isSafeInteger(candidate.end)
      )
      const range = provenance.length === 1
        ? { start: provenance[0].start, end: provenance[0].end }
        : { start: 0, end: requirement.coreLength }
      if (!await verifiedQueryView.authorizeRendition({
        publicationId: source.publicationId,
        renditionId: source.renditionId,
        ...range,
        operation: 'playback',
      })) return { success: false, errorCode: 'NO_COMPATIBLE_SOURCE' }
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
  /**
   * Take custody of an entity's renditions so the core starts replicating. The
   * catalog names the cores; holding one is all it takes to read and then serve
   * it. Best effort: a title that cannot be retained yet surfaces as a playback
   * error, never as a hang.
   */
  function manifestRequirement(manifest, renditionId = null) {
    const rendition = (manifest?.body?.renditions || []).find(candidate => (
      candidate &&
      candidate.blocked !== true &&
      candidate.superseded !== true &&
      (renditionId == null ? !isArtworkRendition(candidate) : candidate.renditionId === renditionId)
    ))
    if (!rendition) return null
    let core
    try { core = normalizeAssetCoreRefV2(rendition.core) } catch { return null }
    return {
      publicationId: manifest.publicationId,
      renditionId: rendition.renditionId,
      coreKey: core.key,
      coreLength: core.length,
      requiredRanges: requiredRangesForRendition(rendition),
    }
  }

  // Publication-shaped: `getManifest` needs no rendition id, and the rendition
  // projection is only a fallback for views that do not expose it.
  async function residencyManifest(publicationId) {
    const manifest = await verifiedQueryView.getManifest?.({ publicationId })
    if (manifest) return manifest
    const projected = await verifiedQueryView.getRendition?.({ publicationId })
    return projected?.manifest || null
  }

  async function countLocalRanges(core, ranges) {
    let held = 0
    for (const range of ranges) {
      if (await core.has(range.start, range.end) === true) held++
    }
    return held
  }

  async function retainEntitySources(entityId, publicationId = null) {
    if (typeof scopedNetwork?.retainAuthorizedRendition !== 'function') return
    const entity = publicationId ? null : await verifiedQueryView?.getEntity?.({ entityId })
    const publicationIds = publicationId
      ? [publicationId]
      : (entity?.publications || []).map(publication => publication.publicationId)
    for (const candidate of new Set(publicationIds)) {
      const projected = await verifiedQueryView?.getRendition?.({ publicationId: candidate })
      if (!projected) continue
      try {
        await scopedNetwork.retainAuthorizedRendition({
          manifest: projected.manifest,
          renditionId: projected.rendition.renditionId,
          entityRef: entityId,
          publicationId: candidate,
        })
      } catch {
        // Already retained, or not authorized yet; the assessment below decides.
      }
    }
  }

  function createAvailabilityScope() {
    const observedAt = clock()
    const cache = new Map()
    return {
      observedAt,
      assess(publicationId, renditionId = null, requirement = null) {
        const key = `${publicationId}\n${renditionId || ''}`
        const cached = cache.get(key)
        if (cached) return cached
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

  function requireQueryView() {
    if (!verifiedQueryView) return error('MEDIA_GRAPH_NOT_READY', 'Verified media query view is not wired yet')
    return null
  }

  async function isPreferred(entityId, publicationId) {
    const row = await sourcePreferenceStore.get(sourcePreferenceKey(entityId, publicationId))
    return row?.value?.preferred === true || row?.preferred === true
  }

  async function buildSources(entityId, scope, entityView = null) {
    const entity = entityView || await verifiedQueryView.getEntity({ entityId })
    const sources = []
    for (const publication of entity?.publications || []) {
      const manifest = publication.manifest
      const requirement = manifestRequirement(manifest)
      if (!requirement) continue
      const row = {
        claimId: publication.sourceRecordRef,
        issuer: publication.publisherId,
        publisherId: publication.publisherId,
        body: {
          confidence: 0,
          subjectRefs: [{ entityId, entityKind: entity.entityKind }],
          payload: { publicationId: publication.publicationId },
        },
      }
      const source = manifestSource(
        manifest,
        row,
        await isPreferred(entityId, publication.publicationId),
        trust,
        scope.assess(publication.publicationId, requirement.renditionId, requirement),
        entityId,
      )
      source.sourceFileName = publication.sourceFileName || source.sourceFileName || null
      source.manifest = manifest
      sources.push(source)
    }
    const selection = selectPlaybackSource(sources, {
      capabilities: deviceCapabilities,
      now: scope.observedAt,
    })
    return {
      selection,
      sources: selection.candidates.map(candidate => ({ ...candidate.source, score: candidate.score })),
    }
  }

  function decorateSources(built, selection = built.selection) {
    const diagnostics = new Map(
      projectSourceSelectionDiagnostics(built.sources, { selection })
        .filter(item => item && item.publicationId)
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

  /**
   * The media renditions behind an entity's sources, deduplicated and ordered.
   * Artwork seeds with the publication but is not one of the renditions a
   * client chooses between.
   */
  function mediaRenditionDescriptors(built) {
    const renditions = new Map()
    for (const source of built.sources) {
      for (const rendition of source.manifest?.body?.renditions || []) {
        if (isArtworkRendition(rendition)) continue
        if (!rendition.blocked && !rendition.superseded) renditions.set(rendition.renditionId, renditionResponse(rendition))
      }
    }
    return [...renditions.values()].sort((left, right) => left.renditionId.localeCompare(right.renditionId))
  }

  async function entityResult(entityId, request = {}, agent = false) {
    const missingView = requireQueryView()
    if (missingView) return missingView
    const projected = await verifiedQueryView.getEntity({
      entityId,
      ...(agent ? { entityKind: 'agent' } : {}),
    })
    if (!projected) return error('MEDIA_ENTITY_NOT_FOUND', 'Media entity not found')
    const resolved = projected.resolved
    const scope = createAvailabilityScope()
    const built = await buildSources(entityId, scope, projected)
    const entity = {
      entityId,
      entityKind: agent ? 'agent' : projected.entityKind || entityKindFromRow(resolved.claims[0]) || entityKindFromId(entityId),
      localClusterId: resolved.localClusterId,
      title: resolved.metadata.title || resolved.metadata.displayName || null,
      subtitle: resolved.metadata.subtitle || null,
      displayName: resolved.metadata.displayName || resolved.metadata.title || null,
      claimCount: resolved.claims.length,
      conflictCount: resolved.conflicts.length,
      availability: availabilityResponse(entityAvailability(built, scope)),
      sources: decorateSources(built),
      renditions: mediaRenditionDescriptors(built),
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

  /**
   * The loopback URL that serves a rendition's bytes. Retention already joined
   * the publication's asset scope and started the core replicating, so the blob
   * server streams ranges as they land rather than waiting for a whole film.
   */
  async function resolveRenditionUrl(publicationId, renditionId) {
    const blobServer = options.blobServer || options.ctx?.blobServer || null
    if (typeof blobServer?.getLink !== 'function') return null
    const projected = await verifiedQueryView?.getRendition?.({ publicationId, renditionId })
    const manifest = projected?.manifest
    const rendition = projected?.rendition
    if (!manifest || !rendition) return null
    const ref = renditionBlobRef(manifest, rendition)
    if (!ref) return null
    return String(blobServer.getLink(b4a.from(ref.blobsCoreKey, 'hex'), {
      blob: ref.blob,
      type: typeof rendition.format === 'string' ? rendition.format : 'video/mp4',
      host: options.ctx?.blobServerHost || '127.0.0.1',
      port: blobServer.port || options.ctx?.blobServerPort,
    }))
  }

  // Retaining a rendition is what makes this device a holder of it: the same call
  // playback preparation makes (retainEntitySources), so a relay that holds only
  // the manifest starts pulling the bytes because someone asked for them. Bounded
  // and best-effort — the read below blocks on the blocks it needs anyway, so a
  // retain that has not settled must not hold the caller.
  async function retainRenditionForRead(manifest, renditionId, publicationId) {
    if (typeof scopedNetwork?.retainAuthorizedRendition !== 'function') return
    const publication = await verifiedQueryView?.getPublication?.({ publicationId })
    await boundedAttempt(scopedNetwork.retainAuthorizedRendition({
      manifest,
      renditionId,
      entityRef: publication?.workEntityId || null,
      publicationId,
    }), RENDITION_RETAIN_TIMEOUT_MS)
  }

  /**
   * Walk a blob's blocks and yield exactly the requested byte window. `core.get`
   * waits on replication, which is what lets a caller range-request a rendition
   * this device has not finished pulling: the bytes arrive as they land instead
   * of the request failing because they are not local yet.
   */
  async function* readBlobRange(core, blob, start, length) {
    let remaining = length
    let index = blob.blockOffset
    let offset = 0
    if (start > 0) {
      const canonicalStaticBlob = blob.blockOffset === 0 &&
        blob.byteOffset === 0 &&
        blob.blockLength === Math.ceil(blob.byteLength / ASSET_BLOCK_SIZE)
      if (canonicalStaticBlob) {
        index = Math.floor(start / ASSET_BLOCK_SIZE)
        offset = start % ASSET_BLOCK_SIZE
      } else {
        const seek = await core.seek(Number(blob.byteOffset || 0) + start)
        if (!seek) throw new Error('rendition start byte is unavailable')
        index = seek[0]
        offset = seek[1] || 0
      }
    }
    const blockEnd = blob.blockOffset + blob.blockLength
    while (remaining > 0 && index < blockEnd) {
      let block = await core.get(index)
      if (!block || block.byteLength === 0) throw new Error(`rendition block ${index} is unavailable`)
      if (offset > 0) {
        block = block.subarray(offset)
        offset = 0
      }
      if (block.byteLength > remaining) block = block.subarray(0, remaining)
      yield block
      remaining -= block.byteLength
      index++
    }
  }

  return {
    async getMediaCatalog(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return { ...missingView, items: [], nextCursor: null }
      const scope = createAvailabilityScope()
      try {
        const summaries = []
        for (const projected of await verifiedQueryView.listEntities()) {
          const resolved = projected.resolved
          const built = await buildSources(projected.entityId, scope, projected)
          const coordinates = mediaCoordinatesResponse(projected.externalRefs, projected.entityKind, resolved.metadata?.releaseYear)
          summaries.push({
            entityId: projected.entityId,
            entityKind: projected.entityKind,
            localClusterId: resolved.localClusterId,
            title: resolved.metadata.title || resolved.metadata.displayName || null,
            subtitle: resolved.metadata.subtitle || null,
            claimCount: resolved.claims.length,
            conflictCount: resolved.conflicts.length,
            availability: availabilityResponse(entityAvailability(built, scope)),
            sources: built.sources.map(source => sourceResponse(source, coordinates)),
            renditions: mediaRenditionDescriptors(built),
            ...summaryMediaFields(resolved.metadata),
          })
        }
        const result = pageCatalogRows(summaries, request)
        if (result.error) return result.error
        return okPage(result.page, result.nextCursor)
      } catch {
        return error('CONSUMER_CATALOG_UPDATE_FAILED', 'Verified media catalog query failed', { items: [], nextCursor: null })
      }
    },

    async getMediaEntity(request = {}) {
      return entityResult(request.entityId, request)
    },

    async getMediaCollection(request = {}) {
      return entityResult(request.entityId, request)
    },

    async getMediaCollectionItems(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return { ...missingView, items: [], nextCursor: null }
      const rows = (await verifiedQueryView.getClaims())
        .filter(row => (
          row.body.claimType === 'CollectionMembershipClaim' &&
          row.body.payload?.collectionRef?.entityId === request.collectionEntityId
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
      const missingView = requireQueryView()
      if (missingView) return { ...missingView, items: [], nextCursor: null }
      const rows = (await verifiedQueryView.getClaims())
        .filter(row => row.body.claimType === 'ContributionClaim' && row.body.payload?.agentRef?.entityId === request.agentEntityId)
        .sort((a, b) => a.claimId.localeCompare(b.claimId))
      const result = pageRows(rows, request)
      if (result.error) return result.error
      return okPage(result.page.map(contributionSummary), result.nextCursor)
    },

    async getPublicationSources(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return { ...missingView, items: [], nextCursor: null }
      const projected = await verifiedQueryView.getEntity({ entityId: request.entityId })
      if (!projected) {
        return error('MEDIA_ENTITY_NOT_VISIBLE', 'Media entity is not visible under this device policy', { items: [], nextCursor: null })
      }
      const scope = createAvailabilityScope()
      const decorated = decorateSources(await buildSources(request.entityId, scope, projected))
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
      const missingView = requireQueryView()
      if (missingView) return { ...missingView, exists: false }
      const publications = []
      if (requestedPublicationId) {
        const manifest = await verifiedQueryView.getManifest({ publicationId: requestedPublicationId })
        if (!manifest) {
          return error('MEDIA_ENTITY_NOT_VISIBLE', 'Publication is not visible under this device policy', { exists: false })
        }
        publications.push({ publicationId: requestedPublicationId, manifest })
      } else {
        const entity = await verifiedQueryView.getEntity({ entityId })
        if (!entity) {
          return error('MEDIA_ENTITY_NOT_VISIBLE', 'Media entity is not visible under this device policy', { exists: false })
        }
        publications.push(...entity.publications)
      }
      for (const publication of publications) {
        const manifest = publication.manifest
        const rendition = findPosterRendition(manifest)
        if (!rendition) continue
        const ref = renditionBlobRef(manifest, rendition)
        if (!ref) continue
        const url = await resolveArtworkUrl({
          manifest,
          publicationId: publication.publicationId,
          rendition,
          ref,
          entityId,
        })
        if (url) return { success: true, exists: true, url }
      }
      return { success: true, exists: false }
    },

    /**
     * One Play action. The backend selects a source, opens it, and fails over
     * between equivalent sources inside one deadline; the client never picks.
     */
    async prepareMediaPlayback(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return { ...missingView, attempts: [], sources: [] }
      const projected = await verifiedQueryView.getEntity({ entityId: request.entityId })
      if (!projected) {
        return error(
          'MEDIA_ENTITY_NOT_VISIBLE',
          'Media entity is not visible under this device policy',
          { attempts: [], sources: [] },
        )
      }
      // Pressing play is the request to fetch. Taking custody first is what
      // makes this device a holder of the title.
      await retainEntitySources(request.entityId, request.publicationId)
      const scope = createAvailabilityScope()
      const built = await buildSources(request.entityId, scope, projected)
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
        // A core key is not something anyone can play. The blob server in this
        // process serves the rendition's byte ranges over loopback and pulls
        // blocks from the swarm as the player asks for them, so preparation
        // ends where playback can actually begin.
        url: await resolveRenditionUrl(prepared.publicationId, prepared.renditionId),
        attempts: prepared.attempts,
        sources,
      }
    },

    async openMediaRenditionUrl(request = {}) {
      const publicationId = typeof request.publicationId === 'string' ? request.publicationId.trim() : ''
      const renditionId = typeof request.renditionId === 'string' ? request.renditionId.trim() : ''
      if (!publicationId || !renditionId) return error('INVALID_RENDITION_REQUEST', 'publicationId and renditionId are required')
      if (!verifiedQueryView) return error('MEDIA_GRAPH_UNAVAILABLE', 'Media graph is not bound yet')
      const projected = await verifiedQueryView.getRendition({ publicationId, renditionId })
      if (!projected) return error('MEDIA_PUBLICATION_NOT_FOUND', 'Media publication not found')
      const { manifest, rendition } = projected
      const ref = renditionBlobRef(manifest, rendition)
      if (!ref) return error('MEDIA_RENDITION_UNRESOLVED', 'Media rendition has no readable blob reference yet')
      if (!await verifiedQueryView.authorizeRendition({
        publicationId,
        renditionId,
        start: ref.blob.blockOffset,
        end: ref.blob.blockOffset + ref.blob.blockLength,
        operation: 'stream',
      })) return error('MEDIA_RENDITION_NOT_FOUND', 'Media rendition not found')
      await retainRenditionForRead(manifest, renditionId, publicationId)
      const url = await resolveRenditionUrl(publicationId, renditionId)
      if (!url) return error('MEDIA_RENDITION_UNAVAILABLE', 'Media rendition URL is unavailable')
      return {
        success: true,
        publicationId,
        renditionId,
        assetId: rendition.core?.assetId || ref.assetId,
        contentType: typeof rendition.format === 'string' && rendition.format ? rendition.format : 'video/mp4',
        byteLength: ref.blob.byteLength || rendition.core?.byteLength || 0,
        url,
      }
    },
    /**
     * Open one rendition's bytes for a caller that is not this process. A core key
     * is a swarm reference, not something an HTTP player can read, and the loopback
     * blob-server link prepareMediaPlayback hands back is this box's own address —
     * meaningless to another machine. This yields a reader instead, so whoever
     * serves it can answer byte ranges over its own transport.
     *
     * Not RPC-shaped on purpose: `read` is a function, so this is for in-process
     * callers (the relay's HTTP surface) only.
     */

    async openMediaRendition(request = {}) {
      const publicationId = typeof request.publicationId === 'string' ? request.publicationId.trim() : ''
      const renditionId = typeof request.renditionId === 'string' ? request.renditionId.trim() : ''
      if (!publicationId || !renditionId) return error('INVALID_RENDITION_REQUEST', 'publicationId and renditionId are required')
      const corestore = options.store || options.ctx?.store || null
      if (!verifiedQueryView || typeof corestore?.get !== 'function') {
        return error('MEDIA_GRAPH_UNAVAILABLE', 'Media graph is not bound yet')
      }
      const projected = await verifiedQueryView.getRendition({ publicationId, renditionId })
      if (!projected) return error('MEDIA_PUBLICATION_NOT_FOUND', 'Media publication not found')
      const { manifest, rendition } = projected
      const ref = renditionBlobRef(manifest, rendition)
      // A signed rendition whose provenance names no blob span cannot be read at
      // all: that is a publisher that has not finished, not a missing rendition.
      if (!ref) return error('MEDIA_RENDITION_UNRESOLVED', 'Media rendition has no readable blob reference yet')
      if (!await verifiedQueryView.authorizeRendition({
        publicationId,
        renditionId,
        start: ref.blob.blockOffset,
        end: ref.blob.blockOffset + ref.blob.blockLength,
        operation: 'relay-read',
      })) return error('MEDIA_RENDITION_NOT_FOUND', 'Media rendition not found')

      // Asking for the bytes is what fetches them.
      await retainRenditionForRead(manifest, renditionId, publicationId)

      let core = null
      try {
        core = corestore.get({ key: b4a.from(ref.blobsCoreKey, 'hex') })
        await core.ready?.()
      } catch (err) {
        try { await core?.close?.() } catch { /* best effort */ }
        return error('MEDIA_RENDITION_UNAVAILABLE', err?.message || 'Media rendition core could not be opened')
      }

      const byteLength = ref.blob.byteLength || schemaUint(rendition.core?.byteLength) || 0
      return {
        success: true,
        publicationId,
        renditionId,
        assetId: rendition.core?.assetId || ref.assetId,
        contentType: typeof rendition.format === 'string' && rendition.format ? rendition.format : 'video/mp4',
        byteLength,
        read({ start = 0, length = byteLength - start } = {}) {
          return readBlobRange(core, ref.blob, start, length)
        },
        async close() {
          try { await core.close?.() } catch { /* best effort */ }
        },
      }
    },

    /**
     * Does this device hold every block of a publication's rendition, right now?
     *
     * Catalog presence and peer availability answer different questions: a
     * signed manifest says the file exists, and an availability observation says
     * somebody could serve it. Neither says the bytes are on this disk, and an
     * operator surface that says "Local" has to mean it. This reads the local
     * bitfield only - it opens no connection, retains nothing, and pulls no
     * block, so asking never changes the answer.
     */
    async getLocalRangeResidency(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return missingView
      const publicationId = request.publicationId
      if (!publicationId) return error('INVALID_RESIDENCY_REQUEST', 'publicationId is required')
      const requirement = manifestRequirement(
        await residencyManifest(publicationId),
        request.renditionId || null,
      )
      if (!requirement) return error('MEDIA_RENDITION_UNAVAILABLE', 'No unblocked rendition names ranges for this publication')
      const corestore = options.store || options.ctx?.store || null
      if (typeof corestore?.get !== 'function') return error('MEDIA_RENDITION_UNAVAILABLE', 'No local corestore is available')
      let core = null
      try {
        core = corestore.get({ key: b4a.from(requirement.coreKey, 'hex') })
        await core.ready?.()
        const localRangeCount = await countLocalRanges(core, requirement.requiredRanges)
        return {
          success: true,
          publicationId,
          renditionId: requirement.renditionId,
          requiredRangeCount: requirement.requiredRanges.length,
          localRangeCount,
          complete: requirement.requiredRanges.length > 0 && localRangeCount === requirement.requiredRanges.length,
          observedAt: clock(),
        }
      } catch (err) {
        return error('MEDIA_RENDITION_UNAVAILABLE', err?.message || 'Local residency could not be read')
      } finally {
        try { await core?.close?.() } catch { /* best effort */ }
      }
    },

    async getClaimProvenance(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return missingView
      const claim = (await verifiedQueryView.getClaims()).find(candidate => candidate.claimId === request.claimId)
      if (!claim) return error('MEDIA_CLAIM_NOT_FOUND', 'Media claim not found')
      return { success: true, claim: claimSummary(claim) }
    },

    async setSourcePreference(request = {}) {
      const missingView = requireQueryView()
      if (missingView) return missingView
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
