import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import sodium from 'sodium-universal'
import * as runtimeFs from '#fs'
import { createFileSourceReader, createSourceReader } from '@peartube/backend/assets'
import fetch from '#fetch'

import { createBackendContext } from '@peartube/backend'
import { STORAGE_FORMAT_VERSION } from '@peartube/backend/storage'
import { PROTOCOL_MAJOR } from '@peartube/backend/network-version'

import { measureVolumeBytes } from './storage-guard.js'
import { createTorBoxSourceGrants } from './companion/sources/torbox.js'
import { normalizePrivateArtwork, openPrivateArtworkSources } from './artwork-sources.js'

async function closeResources (resources, primaryError = null) {
  const errors = []
  for (const resource of resources) {
    try {
      await resource?.close?.()
    } catch (error) {
      errors.push(error)
    }
  }
  if (primaryError) errors.unshift(primaryError)
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'runtime shutdown failed')
}

const HEX_32 = /^[0-9a-f]{64}$/

function normalizeHexList (values = []) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const normalized = []
  for (const value of values) {
    const hex = String(value || '').trim().toLowerCase()
    if (!HEX_32.test(hex) || seen.has(hex)) continue
    seen.add(hex)
    normalized.push(hex)
  }
  return normalized
}

function trustedSignerBytes (values) {
  return normalizeHexList(values).map((hex) => b4a.from(hex, 'hex'))
}

export function createLocalFileSourceGrantRegistry ({ fs = runtimeFs, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const grants = new Map()
  async function revokeToken(token) {
    const entry = grants.get(token)
    if (!entry) return false
    grants.delete(token)
    await entry.dispose?.()
    return true
  }
  return Object.freeze({
    resolver: Object.freeze({
      resolve ({ token, adapterId, acquisitionId, principalId, expiresAt }) {
        const entry = grants.get(token)
        if (!entry || adapterId !== 'local-file' || entry.acquisitionId !== acquisitionId ||
            entry.principalId !== principalId || entry.expiresAt !== expiresAt || expiresAt <= now()) {
          const error = new Error('Local file source grant is unavailable')
          error.code = 'SOURCE_GRANT_UNAVAILABLE'
          throw error
        }
        return createFileSourceReader({
          fs, path: entry.path, mimeType: entry.mimeType,
          openArtwork: entry.artwork.length > 0
            ? ({ signal }) => openPrivateArtworkSources(entry.artwork, { fs, fetch: fetchImpl, signal })
            : null
        })
      },
      revoke ({ token }) {
        return revokeToken(token)
      }
    }),
    issue ({ acquisitionId, principalId, path, mimeType, artwork = [], expiresAt, dispose = null }) {
      if (typeof path !== 'string' || !path || !Number.isSafeInteger(expiresAt) || expiresAt <= now() ||
          (dispose !== null && typeof dispose !== 'function')) {
        throw new TypeError('local file source grant input is invalid')
      }
      const token = b4a.toString(crypto.randomBytes(32), 'hex')
      grants.set(token, { acquisitionId, principalId, path, mimeType, artwork: normalizePrivateArtwork(artwork), expiresAt, dispose })
      return Object.freeze({
        token,
        adapterId: 'local-file',
        audience: Object.freeze({ principalId, acquisitionId }),
        expiresAt
      })
    },
    revoke: revokeToken,
    async close () {
      const results = await Promise.allSettled([...grants.keys()].map(revokeToken))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'local source grant cleanup failed')
    }
  })
}
function isRetryableRangeStatus (status) {
  return status === 503 || status === 429 || status === 502 || status === 504
}

function createRangeShortError (message, extra = null) {
  const error = new Error(message)
  error.code = 'SOURCE_RANGE_SHORT'
  error.recoverable = true
  if (extra) Object.assign(error, extra)
  return error
}

function delayRangeAttempt (attempt) {
  return new Promise(resolve => setTimeout(resolve, attempt * 500))
}

async function handleRangeStatusError (response, rangeHeader, attempt, rangeAttempts) {
  const retryableStatus = isRetryableRangeStatus(response.status)
  if (retryableStatus && attempt < rangeAttempts) {
    const retryAfter = Number(response.headers?.get?.('retry-after')) || 0
    const delayMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 2000) : attempt * 500
    await new Promise(resolve => setTimeout(resolve, delayMs))
    return
  }
  const error = new Error(`Companion callback GET range ${rangeHeader} failed with HTTP ${response.status}`)
  error.code = response.status === 410 ? 'SOURCE_GRANT_REVOKED' : (retryableStatus ? 'SOURCE_RANGE_SHORT' : 'SOURCE_GRANT_UNAVAILABLE')
  error.recoverable = retryableStatus
  throw error
}

function throwRangeOverrun (rangeHeader) {
  throw createRangeShortError(
    `Companion callback GET range ${rangeHeader} exceeded expected length`,
    { isOverrun: true }
  )
}

function appendBodyChunk (attemptBuffers, attemptBytesRead, value, expectedAttemptBytes, rangeHeader) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (attemptBytesRead + bytes.byteLength > expectedAttemptBytes) {
    throwRangeOverrun(rangeHeader)
  }
  attemptBuffers.push(bytes)
  return attemptBytesRead + bytes.byteLength
}

async function readBodyWithReader (reader, expectedAttemptBytes, rangeHeader, signal) {
  const attemptBuffers = []
  let attemptBytesRead = 0
  let reading = true
  try {
    while (reading) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {})
        throw signal.reason || new Error('aborted')
      }
      const { done, value } = await reader.read()
      if (done) {
        reading = false
        break
      }
      if (value && value.byteLength > 0) {
        attemptBytesRead = appendBodyChunk(
          attemptBuffers,
          attemptBytesRead,
          value,
          expectedAttemptBytes,
          rangeHeader
        )
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  return { attemptBuffers, attemptBytesRead }
}

async function readBodyWithArrayBuffer (response, expectedAttemptBytes, rangeHeader) {
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength > expectedAttemptBytes) {
    throwRangeOverrun(rangeHeader)
  }
  return { attemptBuffers: [bytes], attemptBytesRead: bytes.byteLength }
}

async function readResponseBody (response, expectedAttemptBytes, rangeHeader, signal) {
  if (response.body && typeof response.body.getReader === 'function') {
    return readBodyWithReader(response.body.getReader(), expectedAttemptBytes, rangeHeader, signal)
  }
  if (response.arrayBuffer) {
    return readBodyWithArrayBuffer(response, expectedAttemptBytes, rangeHeader)
  }
  return { attemptBuffers: [], attemptBytesRead: 0 }
}

async function fetchRangeResponse ({ origin, path, rangeHeader, authHeaders, fetchFn, signal }) {
  const headers = {
    ...authHeaders('GET'),
    range: rangeHeader
  }
  return fetchFn(`${origin}${path}`, { method: 'GET', headers, signal })
}

async function fetchRangeOrRetry ({ origin, path, rangeHeader, authHeaders, fetchFn, signal, attempt, rangeAttempts }) {
  try {
    return await fetchRangeResponse({ origin, path, rangeHeader, authHeaders, fetchFn, signal })
  } catch (err) {
    if (signal?.aborted || attempt === rangeAttempts) {
      throw createRangeShortError(
        `Companion callback GET range ${rangeHeader} network failed: ${err?.message || err}`
      )
    }
    await delayRangeAttempt(attempt)
    return null
  }
}

async function readRangeBodyOrRetry ({ response, expectedAttemptBytes, rangeHeader, signal, attempt, rangeAttempts }) {
  try {
    return await readResponseBody(response, expectedAttemptBytes, rangeHeader, signal)
  } catch (streamErr) {
    if (signal?.aborted || streamErr?.isOverrun || attempt === rangeAttempts) {
      if (streamErr?.isOverrun) throw streamErr
      throw createRangeShortError(
        `Companion callback GET range ${rangeHeader} stream failed: ${streamErr?.message || streamErr}`
      )
    }
    await delayRangeAttempt(attempt)
    return null
  }
}

function finishShortChunk ({ rangeHeader, chunkBytesRead, expectedChunkBytes, attempt, rangeAttempts }) {
  if (attempt === rangeAttempts) {
    throw createRangeShortError(
      `Companion callback GET range ${rangeHeader} returned short body: ${chunkBytesRead}/${expectedChunkBytes}`
    )
  }
  return delayRangeAttempt(attempt)
}

async function readChunkBuffers ({ origin, path, current, chunkEnd, expectedChunkBytes, authHeaders, fetchFn, signal }) {
  const RANGE_ATTEMPTS = 4
  const chunkBuffers = []
  let chunkBytesRead = 0

  for (let attempt = 1; attempt <= RANGE_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error('source read aborted')
    const rangeStart = current + chunkBytesRead
    if (rangeStart > chunkEnd) break
    const expectedAttemptBytes = chunkEnd - rangeStart + 1
    const rangeHeader = `bytes=${rangeStart}-${chunkEnd}`

    const response = await fetchRangeOrRetry({
      origin,
      path,
      rangeHeader,
      authHeaders,
      fetchFn,
      signal,
      attempt,
      rangeAttempts: RANGE_ATTEMPTS
    })
    if (!response) continue

    if (response.status !== 206) {
      await handleRangeStatusError(response, rangeHeader, attempt, RANGE_ATTEMPTS)
      continue
    }

    const body = await readRangeBodyOrRetry({
      response,
      expectedAttemptBytes,
      rangeHeader,
      signal,
      attempt,
      rangeAttempts: RANGE_ATTEMPTS
    })
    if (!body) continue

    for (const buf of body.attemptBuffers) {
      chunkBuffers.push(buf)
    }
    chunkBytesRead += body.attemptBytesRead
    if (chunkBytesRead === expectedChunkBytes) {
      return chunkBuffers
    }
    await finishShortChunk({
      rangeHeader,
      chunkBytesRead,
      expectedChunkBytes,
      attempt,
      rangeAttempts: RANGE_ATTEMPTS
    })
  }

  throw createRangeShortError(
    `Companion callback GET range bytes=${current}-${chunkEnd} failed after ${RANGE_ATTEMPTS} attempts`
  )
}

export function createCompanionCallbackSourceReader ({ origin, client, secret, token, jobId = '', etag = null, length = null, sha256 = null, contentType = 'application/octet-stream', logger = null, fetch: fetchFn = fetch }) {
  const EMPTY_BODY_HASH = b4a.toString(crypto.hash(b4a.alloc(0)), 'hex')
  const path = `/internal/peartube/v2/sources/${encodeURIComponent(token)}`
  let currentEtag = etag

  function authHeaders (method, query = '') {
    const timestamp = String(Date.now())
    const nonce = b4a.toString(crypto.randomBytes(16), 'hex')
    const target = query ? `${path}?${query}` : path
    const canonical = b4a.from(`${method}\n${target}\n${timestamp}\n${nonce}\n${EMPTY_BODY_HASH}`)
    const keyBytes = typeof secret === 'string' ? b4a.from(secret, 'hex') : secret
    const mac = b4a.alloc(sodium.crypto_auth_BYTES)
    sodium.crypto_auth(mac, canonical, keyBytes)
    const headers = {
      'x-peartube-client': client,
      'x-peartube-timestamp': timestamp,
      'x-peartube-nonce': nonce,
      'x-peartube-mac': b4a.toString(mac, 'hex'),
      'x-peartube-job-id': jobId,
      accept: '*/*'
    }
    headers['if-match'] = currentEtag || '*'
    return headers
  }

  let descriptionCache = length !== null && length > 0
    ? {
        identity: sha256 ? { kind: 'sha256', value: sha256 } : { kind: 'etag', value: currentEtag || `grant:${token}` },
        byteLength: length,
        mimeType: contentType || 'application/octet-stream'
      }
    : null

  return createSourceReader({
    resumable: true,
    maxReadBytes: 16 * 1024 * 1024,
    async describe ({ signal } = {}) {
      if (descriptionCache) return descriptionCache
      const url = `${origin}${path}`
      const headers = authHeaders('HEAD')
      const response = await fetchFn(url, { method: 'HEAD', headers, signal })
      if (!response.ok) {
        const error = new Error(`Companion callback HEAD failed with HTTP ${response.status}`)
        error.code = response.status === 410 ? 'SOURCE_GRANT_REVOKED' : 'SOURCE_GRANT_UNAVAILABLE'
        throw error
      }
      const lengthHeader = response.headers.get('content-length')
      const byteLength = lengthHeader ? parseInt(lengthHeader, 10) : 0
      const headerEtag = response.headers.get('etag') || `grant:${token}`
      currentEtag = headerEtag
      const headerSha256 = response.headers.get('x-source-sha256') || null
      const headerContentType = response.headers.get('content-type') || contentType
      descriptionCache = {
        identity: headerSha256 ? { kind: 'sha256', value: headerSha256 } : { kind: 'etag', value: headerEtag },
        byteLength,
        mimeType: headerContentType
      }
      return descriptionCache
    },
    open ({ offset, length: readLength, signal } = {}) {
      return (async function * () {
        if (!readLength || readLength <= 0) return
        const CHUNK_SIZE = 4 * 1024 * 1024
        let current = offset
        const end = offset + readLength
        while (current < end) {
          if (signal?.aborted) throw new Error('source read aborted')
          const chunkEnd = Math.min(current + CHUNK_SIZE - 1, end - 1)
          const expectedChunkBytes = chunkEnd - current + 1
          const chunkBuffers = await readChunkBuffers({
            origin,
            path,
            current,
            chunkEnd,
            expectedChunkBytes,
            authHeaders,
            fetchFn,
            signal
          })
          for (const buf of chunkBuffers) {
            yield buf
          }
          current += expectedChunkBytes
        }
      })()
    },
    async close () {}
  })
}

// Scope diagnostics carry `purpose`, never `role`. Reading `role` made every
// topic count silently zero, so a relay with live publisher and asset scopes
// reported none and looked idle in exactly the diagnostics AGENTS.md says to
// trust when a catalog turns up empty.
function purposeCount (values, purpose) {
  if (!Array.isArray(values)) return 0
  return values.reduce((count, value) => count + (value?.purpose === purpose ? 1 : 0), 0)
}

function counter (counters, ...names) {
  for (const name of names) {
    const value = Number(counters?.[name])
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  return 0
}

function archiveOperatorMode (relayMode) {
  return relayMode === 'public' ? 'community' : 'local-first'
}

function buildSourceAdapters ({ config, dependencies, localFileSourceGrants, torBoxSourceGrants, logger }) {
  const sourceAdapters = new Map()
  sourceAdapters.set('local-file', {
    adapterId: 'local-file',
    enabled: true,
    async resolve ({ token, adapterId, acquisitionId, principalId, expiresAt }) {
      return localFileSourceGrants.resolver.resolve({ token, adapterId, acquisitionId, principalId, expiresAt })
    },
    async revoke ({ token }) {
      return localFileSourceGrants.revoke(token)
    },
    async close () {
      return localFileSourceGrants.close?.()
    }
  })

  const torBoxApiKey = config.archive?.torbox?.apiKey
  sourceAdapters.set('torbox', {
    adapterId: 'torbox',
    enabled: Boolean(torBoxApiKey && String(torBoxApiKey).trim() !== ''),
    async resolve ({ token, etag, length, sha256, contentType, signal }) {
      return torBoxSourceGrants.resolve({ token, etag, length, sha256, contentType, signal })
    },
    async revoke ({ token, reason }) {
      return torBoxSourceGrants.revoke?.({ token, reason })
    },
    async close () {
      return torBoxSourceGrants.close?.()
    }
  })

  const companionOrigin = config.companion?.sourceOrigin
  const companionSecret = config.companion?.sourceSharedSecret || config.companion?.sharedSecret
  sourceAdapters.set('companion-callback', {
    adapterId: 'companion-callback',
    enabled: Boolean(companionOrigin && companionSecret),
    async resolve ({ token, acquisitionId, etag, length, sha256, contentType, signal }) {
      if (!companionOrigin || !companionSecret) {
        const error = new Error('Companion callback source origin/secret is not configured')
        error.code = 'SOURCE_GRANT_UNAVAILABLE'
        throw error
      }
      const client = config.companion?.sourceClient || 'peartube-companion'
      return createCompanionCallbackSourceReader({ origin: companionOrigin, client, secret: companionSecret, token, jobId: acquisitionId, etag, length, sha256, contentType, logger })
    },
    async revoke () {
      return false
    },
    async close () {}
  })

  if (dependencies?.sourceAdapters) {
    const injected = dependencies.sourceAdapters instanceof Map
      ? dependencies.sourceAdapters.entries()
      : Object.entries(dependencies.sourceAdapters)
    for (const [id, adapter] of injected) {
      if (!adapter) continue
      sourceAdapters.set(id, {
        adapterId: id,
        enabled: adapter.enabled !== false,
        async resolve (params) {
          return adapter.resolve ? adapter.resolve(params) : adapter(params)
        },
        async revoke (params) {
          return adapter.revoke ? adapter.revoke(params) : false
        },
        async close () {
          return adapter.close?.()
        }
      })
    }
  }

  return sourceAdapters
}

function buildNetworkPolicy ({ config, reseedEnabled, maxBytes }) {
  if (!reseedEnabled) {
    return {
      uploadPermission: 'enabled',
      uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
      ...(config.networkPolicy || {})
    }
  }
  return {
    uploadPermission: 'enabled',
    uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
    retentionMode: 'archive-pledges',
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: true,
    ...(maxBytes > 0
      ? {
          diskCeilingBytes: maxBytes,
          diskCeilingExplicit: true,
          contributionBudgetBytes: maxBytes,
          archiveBudgetBytes: maxBytes
        }
      : {}),
    ...(config.networkPolicy || {})
  }
}

function buildArchiveOptions ({ config, reseedEnabled }) {
  return {
    enabled: reseedEnabled ? true : config.archive?.enabled !== false,
    ...(config.archive?.challengeIntervalMs === undefined
      ? {}
      : { challengeIntervalMs: config.archive.challengeIntervalMs }),
    ...(config.archive?.challengeTimeoutMs === undefined
      ? {}
      : { challengeTimeoutMs: config.archive.challengeTimeoutMs }),
  }
}

function createSourceGrantResolver (sourceAdapters) {
  return Object.freeze({
    async resolve ({ token, adapterId, acquisitionId, principalId, expiresAt, etag, length, sha256, contentType, signal }) {
      const adapter = sourceAdapters.get(adapterId)
      if (!adapter || adapter.enabled !== true) {
        const error = new Error(`Unsupported source grant adapter: ${adapterId}`)
        error.code = 'SOURCE_GRANT_UNAVAILABLE'
        throw error
      }
      return adapter.resolve({ token, adapterId, acquisitionId, principalId, expiresAt, etag, length, sha256, contentType, signal })
    },
    async revoke ({ token, adapterId, acquisitionId, principalId, reason }) {
      if (adapterId && sourceAdapters.has(adapterId)) {
        const adapter = sourceAdapters.get(adapterId)
        if (typeof adapter.revoke === 'function') {
          return adapter.revoke({ token, adapterId, acquisitionId, principalId, reason })
        }
      }
      return false
    }
  })
}

function buildBackendOptions ({
  config,
  networkConfig,
  trustedBootstrapSigners,
  trustedBootstrapRootIds,
  bootstrapEnabled,
  reseedEnabled,
  maxBytes,
  maxConcurrent,
  blockOffload,
  sourceAdapters,
  dependencies,
  logger
}) {
  return {
    storagePath: config.storage.path,
    blockOffload,
    platform: 'relay',
    role: 'relay',
    expectedStorageFormatVersion: STORAGE_FORMAT_VERSION,
    network: {
      networkId: networkConfig.networkId || 'peartube-main',
      trustedBootstrapSigners,
      trustedBootstrapRootIds,
      bootstrapEnabled
    },
    networkPolicy: buildNetworkPolicy({ config, reseedEnabled, maxBytes }),
    resources: {
      profile: { maxBytesPerDay: maxBytes },
      maxConcurrentSync: maxConcurrent,
      maxConcurrentProofs: maxConcurrent,
      maxConcurrentFetches: maxConcurrent
    },
    seedPin: config.seedPin || {},
    archive: buildArchiveOptions({ config, reseedEnabled }),
    operability: {
      operatorMode: config.archiveOperatorMode || archiveOperatorMode(config.mode)
    },
    provider: {
      ...(config.provider || {}),
      sourceGrantResolver: createSourceGrantResolver(sourceAdapters),
      principalId: config.companion?.client || 'local-provider',
      freeDiskBytes: () => measureVolumeBytes({
        storagePath: config.storage.path,
        statfsSync: (dependencies?.fs || runtimeFs).statfsSync,
        log: message => logger?.runtime?.warn?.(message)
      })?.freeBytes || 0,
    },
    ipcLog: (message) => logger?.runtime?.debug?.(message)
  }
}

function mirrorEvidence (network, record) {
  if (typeof network?.getOffloadEvidence !== 'function') return []
  try {
    const evidence = network.getOffloadEvidence(record.publicationId, record.locators)
    return Array.isArray(evidence) ? evidence : []
  } catch {
    return []
  }
}

async function measureAndReportHostDisk ({ backend, dependencies, config, logger }) {
  if (typeof backend.api.setDeviceConditions !== 'function') {
    return { measured: false, reason: 'device-conditions-unavailable', freeBytes: null, totalBytes: null }
  }
  const fs = dependencies?.fs || await import('#fs').catch(() => null)
  const volume = measureVolumeBytes({
    storagePath: config.storage.path,
    statfsSync: fs?.statfsSync || null,
    log: (message) => logger?.runtime?.debug?.(message)
  })
  if (!volume || !Number.isFinite(volume.freeBytes) || !Number.isFinite(volume.totalBytes)) {
    logger?.runtime?.warn?.('Host disk is unmeasurable; this relay will not take archive pledges', {
      storagePath: config.storage.path,
      reason: 'statfs-unavailable'
    })
    return { measured: false, reason: 'statfs-unavailable', freeBytes: null, totalBytes: null }
  }
  await backend.api.setDeviceConditions({
    freeDiskBytes: volume.freeBytes,
    freeDiskBytesProvided: true,
    totalDiskBytes: volume.totalBytes,
    totalDiskBytesProvided: true
  })
  return { measured: true, reason: null, freeBytes: volume.freeBytes, totalBytes: volume.totalBytes }
}

async function executeArchiveMirrorRequest (backend, logger, publicationId, renditionId) {
  try {
    return await backend.api.requestArchivePublication({ publicationId, renditionId })
  } catch (error) {
    logger?.runtime?.warn?.('Archive mirror request failed', {
      publicationId,
      renditionId,
      error: error?.message || String(error)
    })
    return { success: false, status: 'failed', requestId: '', errorCode: 'ARCHIVE_REQUEST_FAILED' }
  }
}

function normalizeArchiveMirrorResult (result) {
  return {
    requested: result?.success === true,
    status: String(result?.status || 'failed'),
    requestId: String(result?.requestId || ''),
    errorCode: result?.errorCode || null
  }
}

function formatPolicyDiagnostics (scoped, policyResult) {
  const policy = policyResult?.policy || {}
  return {
    policyVersion: Number(policy.policyVersion) || 0,
    consentVersion: Number(policy.consentVersion) || 0,
    migrationRequired: policy.migrationRequired !== false,
    effectiveRole: policy.effectiveRole || 'watch-only',
    permissions: {
      contribute: policy.permissions?.contribute === true,
      archive: policy.permissions?.archive === true
    },
    contributionBudgetBytes: Number(policy.contributionBudgetBytes) || 0,
    archiveBudgetBytes: Number(policy.archiveBudgetBytes) || 0,
    selectedIndexerCount: Number(scoped?.selectedIndexerCount) || 0,
    selectedIndexers: Array.isArray(scoped?.selectedIndexers)
      ? scoped.selectedIndexers.slice(0, 8).map((indexer, index) => ({
          id: String(indexer?.id || `selected-${index + 1}`).slice(0, 32),
          status: String(indexer?.status || 'unknown').slice(0, 32)
        }))
      : []
  }
}

function formatDhtDiagnostics (swarm) {
  return {
    bootstrapped: swarm?.dht?.bootstrapped ?? null,
    firewalled: swarm?.dht?.firewalled ?? null,
    online: swarm?.dht?.online ?? null
  }
}

function formatScopedRecentErrors (scoped) {
  if (!Array.isArray(scoped?.recentErrors)) return []
  return scoped.recentErrors.slice(-8).map(error => String(error?.code || 'SCOPED_NETWORK_ERROR').slice(0, 64))
}

function formatNetworkDiagnostics (scoped, swarm, networkConfig) {
  return {
    status: scoped?.status || 'unknown',
    protocolMajor: scoped?.protocolMajor ?? PROTOCOL_MAJOR,
    networkId: scoped?.networkId || networkConfig.networkId || 'peartube-main',
    peers: swarm?.peers?.size || 0,
    connections: swarm?.connections?.size || 0,
    dht: formatDhtDiagnostics(swarm),
    offline: Boolean(swarm?._peartubeOffline),
    offlineReason: swarm?._peartubeOfflineReason || null,
    listenResolved: Boolean(swarm?._peartubeListenResolved),
    lastErrors: formatScopedRecentErrors(scoped)
  }
}

function formatPublisherDiagnostics (scoped, counters, publisherTopics) {
  return {
    catalogs: counter(counters, 'publisherCatalogs', 'catalogs') || publisherTopics,
    followed: counter(counters, 'publishersFollowed', 'followedPublishers'),
    lastErrorCode: scoped?.lastErrorCode || null
  }
}

function formatBootstrapDiagnostics (scoped, counters, bootstrapEnabled, locators) {
  const active = scoped && scoped.status === 'active'
  return {
    joined: Boolean(bootstrapEnabled && active),
    locators: Array.isArray(locators) ? locators.length : 0,
    rejected: counter(counters, 'locatorsRejected', 'bootstrapRejected'),
    maxLocators: counter(counters, 'maxLocators', 'bootstrapLimit')
  }
}

function publicWorkNumber (scoped, key) {
  const publicWork = scoped && scoped.publicWork
  return Number(publicWork && publicWork[key]) || 0
}

function formatPublicWorkDiagnostics (scoped) {
  return {
    activeAnnouncements: publicWorkNumber(scoped, 'activeAnnouncements'),
    activeServes: publicWorkNumber(scoped, 'activeServes'),
    servedBytes: publicWorkNumber(scoped, 'servedBytes')
  }
}

function formatAssetDiagnostics (scoped, counters, assetTopics) {
  return {
    retainedRenditions: counter(counters, 'retainedRenditions'),
    activeSessions: purposeCount(scoped && scoped.sessions, 'asset'),
    topics: assetTopics,
    activeServes: publicWorkNumber(scoped, 'activeServes'),
    servedBytes: publicWorkNumber(scoped, 'servedBytes'),
    maxSessions: counter(counters, 'maxAssetSessions', 'assetSessionLimit')
  }
}

function positiveSafeInteger (value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function resolveRelayRuntimeConfig (config) {
  const networkConfig = config.network || {}
  const maxBytes = positiveSafeInteger(config.storage.maxBytes) || 0
  const maxConcurrent = positiveSafeInteger(config.seedPin && config.seedPin.maxConcurrent) || 1
  const bootstrapEnabled = networkConfig.bootstrapEnabled !== false &&
    (config.discovery ? config.discovery.enabled !== false : true)
  const reseedEnabled = !config.reseed || config.reseed.enabled !== false
  return {
    networkConfig,
    trustedBootstrapSigners: trustedSignerBytes(networkConfig.trustedBootstrapSigners),
    trustedBootstrapRootIds: normalizeHexList(networkConfig.trustedBootstrapRootIds),
    bootstrapEnabled,
    maxBytes,
    maxConcurrent,
    reseedEnabled
  }
}

function resolveBackendBindings (backend) {
  return {
    provider: backend.provider || backend.ctx?.providerService || null,
    acquisitionManager: backend.acquisitionManager || backend.ctx?.acquisitionManager || null,
    issueLocalProviderResolution: backend.issueLocalProviderResolution || backend.ctx?.issueLocalProviderResolution || null,
    retractPublication: backend.retractPublication || backend.uploadManager?.retractAcquiredPublication || null,
    verifiedQueryView: backend.verifiedQueryView || backend.ctx?.verifiedQueryView || null,
    uploadManager: backend.uploadManager || backend.ctx?.uploadManager || null
  }
}

function isCompleteBackend (backend) {
  return Boolean(backend && backend.ctx && backend.api && typeof backend.destroy === 'function')
}

async function destroyIncompleteBackend (backend) {
  if (!backend || typeof backend.destroy !== 'function') return
  try {
    await backend.destroy()
  } catch {
    /* incomplete backend teardown is best effort */
  }
}

async function openRelayBackend (backendFactory, backendOptions) {
  const backend = await backendFactory(backendOptions)
  if (isCompleteBackend(backend)) return backend
  await destroyIncompleteBackend(backend)
  throw new Error('universal backend returned an incomplete relay context')
}

function countFreshArchivists (evidence) {
  let count = 0
  for (const entry of evidence) {
    if (entry && entry.passed === true && entry.recent === true) count += 1
  }
  return count
}

function listArchiveMirrorRequests (archiveRequests, backend) {
  const network = backend.ctx && backend.ctx.permissionlessArchiveNetwork
  return Array.from(archiveRequests.values(), (record) => {
    const evidence = mirrorEvidence(network, record)
    return {
      publicationId: record.publicationId,
      renditionId: record.renditionId,
      status: record.status,
      requestId: record.requestId,
      errorCode: record.errorCode,
      requestedAt: record.requestedAt,
      archivists: evidence.length,
      freshArchivists: countFreshArchivists(evidence)
    }
  })
}

async function requestArchiveMirrorAction (state, { publicationId, renditionId, locators = [] } = {}) {
  const { reseedEnabled, backend, logger, archiveRequests } = state
  if (!reseedEnabled) return { requested: false, reason: 'reseed-disabled' }
  if (!HEX_32.test(publicationId || '') || !HEX_32.test(renditionId || '')) {
    return { requested: false, reason: 'invalid-rendition', errorCode: 'ARCHIVE_REQUEST_INVALID' }
  }
  if (typeof backend.api.requestArchivePublication !== 'function') {
    return { requested: false, reason: 'unavailable', errorCode: 'ARCHIVE_NETWORK_UNAVAILABLE' }
  }
  const result = await executeArchiveMirrorRequest(backend, logger, publicationId, renditionId)
  const normalized = normalizeArchiveMirrorResult(result)
  archiveRequests.set(`${publicationId}:${renditionId}`, {
    publicationId,
    renditionId,
    locators: Array.isArray(locators) ? locators : [],
    ...normalized,
    requestedAt: Date.now()
  })
  return normalized
}

function resolveArchiveRoom (headroomBytes, maxBytes, reservedBytes) {
  const measured = positiveSafeInteger(headroomBytes)
  if (measured != null) return measured
  if (headroomBytes == null) return Math.max(0, maxBytes - reservedBytes)
  return 0
}

async function applyArchiveCapacityAction (state, { headroomBytes = null } = {}) {
  const { reseedEnabled, backend, maxBytes } = state
  if (!reseedEnabled) return { applied: false, reason: 'reseed-disabled' }
  if (typeof backend.api.getArchiveParticipation !== 'function' ||
      typeof backend.api.setArchiveParticipation !== 'function') {
    return { applied: false, reason: 'archive-participation-unavailable' }
  }
  const status = await backend.api.getArchiveParticipation({})
  if (status && status.success === false) {
    return { applied: false, reason: status.errorCode || 'archive-participation-unavailable' }
  }
  const reservedBytes = positiveSafeInteger(status && status.reservedBytes) || 0
  const room = resolveArchiveRoom(headroomBytes, maxBytes, reservedBytes)
  const capacityBytes = reservedBytes + room
  const applied = await backend.api.setArchiveParticipation({
    enabled: true,
    capacityBytes,
    maxRequestBytes: room,
    acceptancePermille: 1000
  })
  if (applied && applied.success === false) {
    return { applied: false, reason: applied.errorCode || 'archive-participation-unavailable' }
  }
  return { applied: true, capacityBytes, maxRequestBytes: room, reservedBytes }
}

function invokeOptional (fn, thisArg, args = []) {
  if (typeof fn !== 'function') return {}
  return fn.apply(thisArg, args) || {}
}

async function collectDiagnosticsSnapshots (backend) {
  const seedingManager = backend.seedingManager
  return Promise.all([
    backend.api.getScopedNetworkDiagnostics(),
    backend.api.listBootstrapLocators(),
    invokeOptional(seedingManager && seedingManager.getStatus, seedingManager),
    invokeOptional(backend.api.getArchiveOperatorStatus, backend.api, [{}]),
    invokeOptional(backend.api.getStorageStats, backend.api),
    invokeOptional(backend.api.getArchiveParticipation, backend.api, [{}]),
    invokeOptional(backend.api.getNetworkPolicy, backend.api)
  ])
}

function assembleDiagnosticsReport ({
  scoped,
  locators,
  seedRetention,
  archive,
  storage,
  archiveParticipation,
  policyResult,
  backend,
  networkConfig,
  bootstrapEnabled,
  hostDisk,
  archiveRequests
}) {
  const counters = (scoped && scoped.counters) || {}
  const swarm = backend.ctx && backend.ctx.swarm
  const publisherTopics = purposeCount(scoped && scoped.topics, 'publisher')
  const assetTopics = purposeCount(scoped && scoped.topics, 'asset')
  return {
    policy: formatPolicyDiagnostics(scoped, policyResult),
    network: formatNetworkDiagnostics(scoped, swarm, networkConfig),
    publicWork: formatPublicWorkDiagnostics(scoped),
    publisher: formatPublisherDiagnostics(scoped, counters, publisherTopics),
    bootstrap: formatBootstrapDiagnostics(scoped, counters, bootstrapEnabled, locators),
    assets: formatAssetDiagnostics(scoped, counters, assetTopics),
    seedRetention: seedRetention || {},
    archive: archive || {},
    storage: storage || {},
    archiveRequests: listArchiveMirrorRequests(archiveRequests, backend),
    archiveParticipation: archiveParticipation || {},
    archiveHostDisk: { ...hostDisk }
  }
}

async function getRelayDiagnostics (state) {
  const [
    scoped,
    locators,
    seedRetention,
    archive,
    storage,
    archiveParticipation,
    policyResult
  ] = await collectDiagnosticsSnapshots(state.backend)
  return assembleDiagnosticsReport({
    scoped,
    locators,
    seedRetention,
    archive,
    storage,
    archiveParticipation,
    policyResult,
    backend: state.backend,
    networkConfig: state.networkConfig,
    bootstrapEnabled: state.bootstrapEnabled,
    hostDisk: state.hostDisk,
    archiveRequests: state.archiveRequests
  })
}

async function awaitOptionalCall (result) {
  if (result == null) return
  if (typeof result.catch === 'function') {
    await result.catch(() => {})
    return
  }
  await result
}

async function startRelayRuntime (state) {
  if (state.closed) throw new Error('relay runtime is closed')
  if (state.started) return
  state.started = true
  state.hostDisk = await measureAndReportHostDisk({
    backend: state.backend,
    dependencies: state.dependencies,
    config: state.config,
    logger: state.logger
  })
  await awaitOptionalCall(state.backend.api.getParticipationStatus?.())
  const networkId = state.networkConfig.networkId || 'peartube-main'
  const readyInfo = {
    platform: 'relay',
    networkId,
    hostDiskMeasured: state.hostDisk.measured
  }
  if (!state.hostDisk.measured) readyInfo.hostDiskReason = state.hostDisk.reason
  state.logger?.runtime?.info?.('Relay universal backend ready', readyInfo)
}

async function refreshRelayAuthorization (backend, trustedClients) {
  if (typeof backend.api.refreshScopedAuthorization !== 'function') return false
  const result = await backend.api.refreshScopedAuthorization({
    trustedClients: normalizeHexList(trustedClients)
  })
  return result && result.status === 'updated'
}

async function requestRelayCatalogSync (backend) {
  if (typeof backend.api.reannounceArchiveRequests === 'function') {
    await backend.api.reannounceArchiveRequests().catch(() => {})
  }
  const locators = await backend.api.listBootstrapLocators()
  return Array.isArray(locators) ? locators.length : 0
}

async function resolveRelayCandidate (backend, candidate = {}) {
  const publisherId = candidate.publisherId || null
  if (!publisherId) return { ...candidate }
  const catalog = await backend.api.resolveLocalPublisherCatalog({ publisherId })
  return { ...candidate, publisherId, catalog }
}

async function closeRelayRuntime (state) {
  if (state.closed) return
  state.closed = true
  let backendError = null
  try {
    await state.backend.destroy()
  } catch (error) {
    backendError = error
  }
  await closeResources(
    [...state.sourceAdapters.values(), state.localFileSourceGrants],
    backendError
  )
}

function createRelayRuntimeSurface (state) {
  const { backend } = state
  const bindings = resolveBackendBindings(backend)
  return {
    backend,
    ctx: backend.ctx,
    api: backend.api,
    provider: bindings.provider,
    acquisitionManager: bindings.acquisitionManager,
    issueLocalProviderResolution: bindings.issueLocalProviderResolution,
    retractPublication: bindings.retractPublication,
    localFileSourceGrants: state.localFileSourceGrants,
    sourceAdapters: state.sourceAdapters,
    configuredSourceAdapterIds: state.configuredSourceAdapterIds,
    scopedNetwork: backend.scopedNetwork,
    seedingManager: backend.seedingManager,
    verifiedQueryView: bindings.verifiedQueryView,
    identityManager: backend.identityManager,
    uploadManager: bindings.uploadManager,
    seedPin: backend.seedPin,
    seedPinClients: backend.seedPinClients,

    async start () {
      return startRelayRuntime(state)
    },

    async followPublisher (request) {
      return backend.api.followPublisher(request)
    },

    async unfollowPublisher (request) {
      return backend.api.unfollowPublisher(request)
    },

    async publishPublisherCatalog (request) {
      return backend.api.publishLocalPublisherCatalog(request)
    },

    async resolvePublisherCatalog (request) {
      return backend.api.resolveLocalPublisherCatalog(request)
    },

    async publishBootstrapLocator (request) {
      return backend.api.publishBootstrapLocator(request)
    },

    async listBootstrapLocators () {
      return backend.api.listBootstrapLocators()
    },

    async retainRendition (request) {
      return backend.api.retainAuthorizedRendition(request)
    },

    async releaseRendition (request) {
      return backend.api.releaseAuthorizedRendition(request)
    },

    async retainArchive (request) {
      return backend.api.retainAuthorizedArchive(request)
    },

    async releaseArchive (request) {
      return backend.api.releaseAuthorizedArchive(request)
    },

    async requestArchiveMirror (args) {
      return requestArchiveMirrorAction(state, args)
    },

    async applyArchiveCapacity (args) {
      return applyArchiveCapacityAction(state, args)
    },

    async getArchiveParticipation () {
      if (typeof backend.api.getArchiveParticipation !== 'function') return {}
      return backend.api.getArchiveParticipation({}) || {}
    },

    getArchiveMirrorRequests () {
      return listArchiveMirrorRequests(state.archiveRequests, backend)
    },

    async refreshAuthorization (trustedClients) {
      return refreshRelayAuthorization(backend, trustedClients)
    },

    async requestCatalogSync () {
      return requestRelayCatalogSync(backend)
    },

    async resolveCandidate (candidate) {
      return resolveRelayCandidate(backend, candidate)
    },

    setCandidateHandler () {
      /* candidate delivery belongs to the backend scoped publisher manager */
    },

    async getDiagnostics () {
      return getRelayDiagnostics(state)
    },

    async getNetworkStats () {
      return getRelayDiagnostics(state)
    },

    async close () {
      return closeRelayRuntime(state)
    }
  }
}

export async function createRelayRuntime ({ config, logger, dependencies = null, blockOffload = null } = {}) {
  if (!config || !config.storage || !config.storage.path) {
    throw new Error('relay runtime requires config.storage.path')
  }
  const backendFactory = (dependencies && dependencies.createBackendContext) || createBackendContext
  const runtimeConfig = resolveRelayRuntimeConfig(config)
  const archiveRequests = new Map()
  const localFileSourceGrants = createLocalFileSourceGrantRegistry({
    fs: (dependencies && dependencies.fs) || runtimeFs
  })
  const torbox = config.archive && config.archive.torbox
  const torBoxSourceGrants = createTorBoxSourceGrants({
    apiKey: (torbox && torbox.apiKey) || '',
    chunkBytes: torbox && torbox.chunkBytes,
    fetchImpl: fetch
  })

  const sourceAdapters = buildSourceAdapters({
    config,
    dependencies,
    localFileSourceGrants,
    torBoxSourceGrants,
    logger
  })
  const configuredSourceAdapterIds = Object.freeze(
    [...sourceAdapters.values()].filter((adapter) => adapter.enabled).map((adapter) => adapter.adapterId).sort()
  )

  let backend
  try {
    backend = await openRelayBackend(
      backendFactory,
      buildBackendOptions({
        config,
        networkConfig: runtimeConfig.networkConfig,
        trustedBootstrapSigners: runtimeConfig.trustedBootstrapSigners,
        trustedBootstrapRootIds: runtimeConfig.trustedBootstrapRootIds,
        bootstrapEnabled: runtimeConfig.bootstrapEnabled,
        reseedEnabled: runtimeConfig.reseedEnabled,
        maxBytes: runtimeConfig.maxBytes,
        maxConcurrent: runtimeConfig.maxConcurrent,
        blockOffload,
        sourceAdapters,
        dependencies,
        logger
      })
    )
  } catch (backendError) {
    // Adapters and the local-file grant registry are owned once built, so a
    // failed open must tear them down through the same closeResources policy
    // closeRelayRuntime uses, keeping the backend error primary.
    await closeResources([...sourceAdapters.values(), localFileSourceGrants], backendError)
  }

  const state = {
    config,
    logger,
    dependencies,
    backend,
    networkConfig: runtimeConfig.networkConfig,
    bootstrapEnabled: runtimeConfig.bootstrapEnabled,
    reseedEnabled: runtimeConfig.reseedEnabled,
    maxBytes: runtimeConfig.maxBytes,
    archiveRequests,
    localFileSourceGrants,
    sourceAdapters,
    configuredSourceAdapterIds,
    closed: false,
    started: false,
    hostDisk: { measured: false, reason: 'not-measured', freeBytes: null, totalBytes: null }
  }

  return createRelayRuntimeSurface(state)
}
