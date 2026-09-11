import b4a from 'b4a'

const ZERO_PUBLISHER_ID = '0'.repeat(64)
const QUERY_NAMESPACE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const PUBLISHER_ID = /^[0-9a-f]{64}$/

function providerError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'PROVIDER_REQUEST_FAILED',
    message: typeof error?.message === 'string' && error.message ? error.message : 'Provider request failed',
    ...(typeof error?.field === 'string' ? { field: error.field } : {}),
    retryable: error?.retryable === true,
  }
}

function createTitleSelector(title, request) {
  return {
    title,
    kind: request?.kind || 'all',
    ...(request?.year != null ? { year: request.year } : {}),
    ...(request?.season != null ? { season: request.season } : {}),
    ...(request?.episode != null ? { episode: request.episode } : {}),
  }
}

function parseNamespacedSelector(namespace, rest, request) {
  if (!QUERY_NAMESPACE.test(namespace) || !rest) {
    const error = new Error('Provider search selector is invalid')
    error.code = 'PROVIDER_SELECTOR_INVALID'
    throw error
  }
  const parts = rest.split(':')
  if (parts.length === 3 && Number.isSafeInteger(Number(parts[1])) && Number.isSafeInteger(Number(parts[2]))) {
    return {
      namespace,
      identifier: parts[0],
      kind: 'episode',
      season: Number(parts[1]),
      episode: Number(parts[2]),
    }
  }
  return {
    namespace,
    identifier: rest,
    kind: request?.kind || 'movie',
    ...(request?.season != null ? { season: request.season } : {}),
    ...(request?.episode != null ? { episode: request.episode } : {}),
  }
}

function defaultSelectorForQuery(query, request = {}) {
  if (request?.selector && typeof request.selector === 'object') {
    return request.selector
  }
  if (typeof query !== 'string') throw new TypeError('query is required')
  const normalized = query.trim()
  if (!normalized) throw new TypeError('query is required')
  const separator = normalized.indexOf(':')
  if (separator < 1) {
    return createTitleSelector(normalized, request)
  }
  return parseNamespacedSelector(normalized.slice(0, separator), normalized.slice(separator + 1), request)
}

function defaultGrantDecoder(value) {
  try {
    const decoded = JSON.parse(b4a.toString(b4a.from(value || []), 'utf8'))
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error()
    return decoded
  } catch {
    const error = new Error('Source grant is not valid local grant data')
    error.code = 'SOURCE_GRANT_INVALID'
    throw error
  }
}

function hit(value) {
  const media = value.mediaContext || {}
  return {
    schemaVersion: 1,
    resolutionRef: value.ref,
    title: value.title || media.identifier || value.ref,
    mediaKind: media.kind || 'work',
    ...(media.releaseYear ? { subtitle: String(media.releaseYear) } : {}),
    published: value.kind === 'published',
    acquirable: value.kind === 'acquirable',
    ...(media.workEntityId ? { entityId: media.workEntityId } : {}),
    ...(value.publicationId ? { publicationId: value.publicationId } : {}),
    ...(value.expectedBytes != null ? { expectedBytes: value.expectedBytes } : {}),
  }
}

function resolution(value, publisherId) {
  const media = value.mediaContext || {}
  if (!PUBLISHER_ID.test(publisherId || '')) {
    const error = new Error('Provider has no trusted publisher scope')
    error.code = 'PROVIDER_PUBLISHER_SCOPE_UNAVAILABLE'
    throw error
  }
  return {
    schemaVersion: 1,
    resolutionRef: value.resolutionRef,
    publisherId,
    title: value.title || media.identifier || value.resolutionRef,
    mediaKind: media.kind || 'work',
    ...(media.releaseYear ? { subtitle: String(media.releaseYear) } : {}),
    published: value.kind === 'published',
    acquirable: value.kind === 'acquirable' && value.acquisitionAvailable === true,
    ...(media.workEntityId ? { entityId: media.workEntityId } : {}),
    ...(value.publicationId ? { publicationId: value.publicationId } : {}),
    ...(value.expected?.byteLength != null ? { expectedBytes: value.expected.byteLength } : {}),
  }
}

function publication(value) {
  const rendition = value.renditions?.[0]
  if (!value.workEntityId || !rendition) {
    const error = new Error('Provider publication has no verified work or rendition')
    error.code = 'PROVIDER_PUBLICATION_INVALID'
    throw error
  }
  return {
    schemaVersion: 1,
    publicationId: value.publicationId,
    entityId: value.workEntityId,
    manifestId: value.manifestId,
    renditionId: rendition.renditionId,
    assetId: rendition.assetId,
    title: value.title || value.publicationId,
  }
}

function principal(principalId, publisherId) {
  return {
    principalId,
    publisherId,
    isLocal: true,
    publisherIds: publisherId === ZERO_PUBLISHER_ID ? [] : [publisherId],
  }
}

async function unavailablePublisherScope() {
  const error = new Error('Provider has no trusted publisher scope')
  error.code = 'PROVIDER_PUBLISHER_SCOPE_UNAVAILABLE'
  throw error
}

export function createProviderApi({
  providerService,
  principalId = 'local-provider',
  selectorForQuery = defaultSelectorForQuery,
  decodeSourceGrant = defaultGrantDecoder,
  resolveTrustedPublisherId = unavailablePublisherScope,
  acquisitionPolicyRevision = null,
} = {}) {
  if (!providerService || typeof providerService !== 'object') throw new TypeError('providerService is required')
  for (const method of [
    'search',
    'resolve',
    'requestAcquisition',
    'attachSourceGrant',
    'getAcquisition',
    'listAcquisitions',
    'cancelAcquisition',
    'retryAcquisition',
    'forgetAcquisition',
    'getPublication',
    'openStream',
    'getStatus',
    'getPolicy',
    'setPolicy',
    'getAcquisitionPolicy',
    'setAcquisitionPolicy',
    'migrateLegacyIngest',
  ]) {
    if (typeof providerService[method] !== 'function') throw new TypeError(`providerService.${method} is required`)
  }
  if (typeof selectorForQuery !== 'function' || typeof decodeSourceGrant !== 'function' ||
      typeof resolveTrustedPublisherId !== 'function') {
    throw new TypeError('provider API adapters must be functions')
  }

  async function wrap(operation, field, fallback = {}) {
    try {
      const value = await operation()
      return { success: true, ...(field ? { [field]: value } : {}), ...fallback }
    } catch (error) {
      return { success: false, ...fallback, error: providerError(error) }
    }
  }

  async function trustedPublisherId(requested = null) {
    const publisherId = await resolveTrustedPublisherId()
    if (!PUBLISHER_ID.test(publisherId || '')) {
      const error = new Error('Provider has no trusted publisher scope')
      error.code = 'PROVIDER_PUBLISHER_SCOPE_UNAVAILABLE'
      throw error
    }
    if (requested !== null && requested !== publisherId) {
      const error = new Error('Acquisition publisher scope does not match this provider session')
      error.code = 'ACQUISITION_FORBIDDEN'
      throw error
    }
    return publisherId
  }

  return Object.freeze({
    provider: providerService,
    providerSearch: request => wrap(async () => {
      const selector = request?.selector
        ? request.selector
        : await selectorForQuery(request?.query, request)
      return providerService.search({
        selector,
        ...(request?.limit == null ? {} : { limit: request.limit }),
        ...(request?.cursor == null ? {} : { cursor: request.cursor }),
      })
    }, 'page').then(response => response.success
      ? {
          success: true,
          hits: (response.page?.candidates || []).map(hit),
          ...(response.page?.nextCursor ? { nextCursor: response.page.nextCursor } : {}),
          ...(response.page?.diagnostics ? { diagnostics: response.page.diagnostics } : {}),
          ...(response.page?.partial ? { partial: true } : {}),
          ...(response.page?.stale ? { stale: true } : {}),
        }
      : { success: false, hits: [], error: response.error }),
    resolveProviderRef: request => wrap(async () => {
      const value = await providerService.resolve({ ref: request?.resolutionRef })
      let publisherScopeId = null
      try { publisherScopeId = await trustedPublisherId() } catch { publisherScopeId = ZERO_PUBLISHER_ID }
      return resolution(value, publisherScopeId)
    }, 'resolution'),
    requestAcquisition: request => wrap(async () => {
      const body = request?.request || {}
      const publisherId = await trustedPublisherId(body.publisherId || null)
      return providerService.requestAcquisition({
        idempotencyKey: request?.idempotencyKey,
        request: {
          schemaVersion: body.schemaVersion,
          resolutionRef: body.resolutionRef,
          publisherId,
          retentionClass: body.retentionClass,
          ...(body.retentionUntilPresent === true ? { retentionUntil: body.retentionUntil } : {}),
          ...(body.sourceFileName != null ? { sourceFileName: body.sourceFileName } : {}),
        },
        principal: principal(principalId, publisherId),
      })
    }, 'acquisition'),
    attachSourceGrant: request => wrap(
      () => providerService.attachSourceGrant({
        acquisitionId: request?.acquisitionId,
        grant: decodeSourceGrant(request?.grant),
        principal: principal(principalId, ZERO_PUBLISHER_ID),
      }),
      'acquisition',
    ),
    getAcquisition: request => wrap(
      () => providerService.getAcquisition({
        acquisitionId: request?.acquisitionId,
        principal: principal(principalId, ZERO_PUBLISHER_ID),
      }),
      'acquisition',
    ),
    listAcquisitions: request => wrap(() => providerService.listAcquisitions({
      ...(request?.cursor == null ? {} : { cursor: request.cursor }),
      ...(request?.limit == null ? {} : { limit: request.limit }),
      ...(request?.states == null ? {} : { states: request.states }),
      principal: principal(principalId, ZERO_PUBLISHER_ID),
    }), 'page').then(response => response.success
      ? {
          success: true,
          acquisitions: response.page.items,
          ...(response.page.cursor ? { nextCursor: response.page.cursor } : {}),
        }
      : { success: false, acquisitions: [], error: response.error }),
    cancelAcquisition: request => wrap(
      () => providerService.cancelAcquisition({
        acquisitionId: request?.acquisitionId,
        principal: principal(principalId, ZERO_PUBLISHER_ID),
      }),
      'acquisition',
    ),
    retryAcquisition: request => wrap(
      () => providerService.retryAcquisition({
        acquisitionId: request?.acquisitionId,
        principal: principal(principalId, ZERO_PUBLISHER_ID),
      }),
      'acquisition',
    ),
    forgetAcquisition: request => wrap(
      () => providerService.forgetAcquisition({
        acquisitionId: request?.acquisitionId,
        principal: principal(principalId, ZERO_PUBLISHER_ID),
      }),
      'acquisition',
    ),
    getProviderPublication: request => wrap(
      async () => publication(await providerService.getPublication({ publicationId: request?.publicationId })),
      'publication',
    ),
    openProviderStream: request => wrap(
      () => providerService.openStream({
        publicationId: request?.publicationId,
        ...(request?.renditionId ? { renditionId: request.renditionId } : {}),
      }),
      'stream',
    ),
    getProviderStatus: () => wrap(async () => {
      const value = await providerService.getStatus()
      return {
        schemaVersion: 1,
        ready: value.ready,
        searchEnabled: value.searchAvailable,
        acquisitionEnabled: value.acquisitionAvailable,
        queuedAcquisitions: value.queuedAcquisitions || 0,
        activeAcquisitions: value.activeAcquisitions || 0,
      }
    }, 'status'),
    getProviderPolicy: () => wrap(() => providerService.getPolicy(), 'policy'),
    setProviderPolicy: request => wrap(() => {
      const { revision: ignored, ...next } = request?.policy || {}
      return providerService.setPolicy({ policy: next, expectedRevision: request?.expectedRevision })
    }, 'policy'),
    getAcquisitionPolicy: () => wrap(async () => ({
      ...(await providerService.getAcquisitionPolicy()),
      revision: acquisitionPolicyRevision ? await acquisitionPolicyRevision.get() : 0,
    }), 'policy'),
    setAcquisitionPolicy: request => wrap(async () => {
      const { revision: ignored, ...next } = request?.policy || {}
      const value = await providerService.setAcquisitionPolicy({
        policy: next,
        consent: request?.consent,
        expectedRevision: request?.expectedRevision,
      })
      return {
        ...value,
        revision: acquisitionPolicyRevision ? await acquisitionPolicyRevision.get() : (request?.expectedRevision || 0) + 1,
      }
    }, 'policy'),
    migrateLegacyIngest: request => providerService.migrateLegacyIngest(request),
  })
}
