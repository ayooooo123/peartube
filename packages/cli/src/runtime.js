import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import nodeCrypto from 'node:crypto'
import * as runtimeFs from '#fs'
import { createFileSourceReader, createSourceReader } from '@peartube/backend/assets'
import fetch from '#fetch'

import { createBackendContext } from '@peartube/backend'
import { PROTOCOL_VERSION } from '@peartube/host/contracts'

import { measureVolumeBytes } from './storage-guard.js'

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

function createLocalFileSourceGrantRegistry ({ fs = runtimeFs, now = Date.now } = {}) {
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
        return createFileSourceReader({ fs, path: entry.path, mimeType: entry.mimeType })
      },
      revoke ({ token }) {
        return revokeToken(token)
      }
    }),
    issue ({ acquisitionId, principalId, path, mimeType, expiresAt, dispose = null }) {
      if (typeof path !== 'string' || !path || !Number.isSafeInteger(expiresAt) || expiresAt <= now() ||
          (dispose !== null && typeof dispose !== 'function')) {
        throw new TypeError('local file source grant input is invalid')
      }
      const token = b4a.toString(crypto.randomBytes(32), 'hex')
      grants.set(token, { acquisitionId, principalId, path, mimeType, expiresAt, dispose })
      return Object.freeze({
        token,
        adapterId: 'local-file',
        audience: Object.freeze({ principalId, acquisitionId }),
        expiresAt
      })
    },
    revoke: revokeToken,
    async close () {
      await Promise.all([...grants.keys()].map(revokeToken))
    }
  })
}

function createCompanionCallbackSourceReader ({ origin, client, secret, token, jobId = '', etag = null, length = null, sha256 = null, contentType = 'application/octet-stream', logger = null }) {
  const EMPTY_BODY_HASH = b4a.toString(crypto.hash(b4a.alloc(0)), 'hex')
  const path = `/internal/peartube/v2/sources/${encodeURIComponent(token)}`
  let currentEtag = etag

  function authHeaders (method, query = '') {
    const timestamp = String(Date.now())
    const nonce = b4a.toString(crypto.randomBytes(16), 'hex')
    const target = query ? `${path}?${query}` : path
    const canonical = `${method}\n${target}\n${timestamp}\n${nonce}\n${EMPTY_BODY_HASH}`
    const keyBytes = typeof secret === 'string' ? Buffer.from(secret, 'hex') : secret
    const hmac = nodeCrypto.createHmac('sha512', keyBytes).update(canonical).digest()
    const mac = hmac.subarray(0, 32).toString('hex')
    const headers = {
      'x-peartube-client': client,
      'x-peartube-timestamp': timestamp,
      'x-peartube-nonce': nonce,
      'x-peartube-mac': mac,
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
      const response = await fetch(url, { method: 'HEAD', headers, signal })
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
        const CHUNK_SIZE = 4 * 1024 * 1024
        let current = offset
        const end = offset + readLength
        while (current < end) {
          if (signal?.aborted) throw new Error('source read aborted')
          const chunkEnd = Math.min(current + CHUNK_SIZE - 1, end - 1)
          const expectedChunkBytes = chunkEnd - current + 1
          const rangeHeader = `bytes=${current}-${chunkEnd}`
          const headers = {
            ...authHeaders('GET'),
            range: rangeHeader
          }
          const response = await fetch(`${origin}${path}`, { method: 'GET', headers, signal })
          if (response.status !== 206) {
            const error = new Error(`Companion callback GET range ${rangeHeader} failed with HTTP ${response.status}`)
            error.code = response.status === 410 ? 'SOURCE_GRANT_REVOKED' : 'SOURCE_GRANT_UNAVAILABLE'
            throw error
          }
          let chunkBytesRead = 0
          if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value && value.byteLength > 0) {
                  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
                  if (chunkBytesRead + bytes.byteLength > expectedChunkBytes) {
                    throw new Error(`Companion callback GET range ${rangeHeader} exceeded expected length of ${expectedChunkBytes} bytes`)
                  }
                  chunkBytesRead += bytes.byteLength
                  yield bytes
                }
              }
            } finally {
              reader.releaseLock?.()
            }
          } else if (response.arrayBuffer) {
            const buffer = await response.arrayBuffer()
            const bytes = new Uint8Array(buffer)
            if (bytes.byteLength !== expectedChunkBytes) {
              throw new Error(`Companion callback GET range ${rangeHeader} returned ${bytes.byteLength} bytes, expected ${expectedChunkBytes}`)
            }
            yield bytes
            chunkBytesRead = bytes.byteLength
          } else {
            throw new Error('Unsupported response body stream')
          }
          if (chunkBytesRead !== expectedChunkBytes) {
            throw new Error(`Companion callback GET range ${rangeHeader} returned ${chunkBytesRead} bytes, expected ${expectedChunkBytes}`)
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

export async function createRelayRuntime ({ config, logger, dependencies = null, blockOffload = null } = {}) {
  if (!config?.storage?.path) throw new Error('relay runtime requires config.storage.path')
  const backendFactory = dependencies?.createBackendContext || createBackendContext
  const networkConfig = config.network || {}
  const trustedBootstrapSigners = trustedSignerBytes(networkConfig.trustedBootstrapSigners)
  const trustedBootstrapRootIds = normalizeHexList(networkConfig.trustedBootstrapRootIds)
  const bootstrapEnabled = networkConfig.bootstrapEnabled !== false && config.discovery?.enabled !== false
  const maxBytes = Number.isSafeInteger(config.storage.maxBytes) && config.storage.maxBytes > 0
    ? config.storage.maxBytes
    : 0
  const maxConcurrent = Number.isSafeInteger(config.seedPin?.maxConcurrent) && config.seedPin.maxConcurrent > 0
    ? config.seedPin.maxConcurrent
    : 1
  // Re-seeding: this relay mirrors what peer relays publish, and asks them to
  // mirror what it publishes. Off only when the operator passed --no-reseed.
  const reseedEnabled = config.reseed?.enabled !== false
  // Every rendition this relay has asked the network to mirror, keyed by
  // publication+rendition. Status reads the archivists' own possession
  // evidence back through these locators; a request with no evidence is
  // reported as a request with no evidence, never as a durable copy.
  const archiveRequests = new Map()
  const localFileSourceGrants = createLocalFileSourceGrantRegistry({
    fs: dependencies?.fs || runtimeFs
  })
  const backend = await backendFactory({
    storagePath: config.storage.path,
    // Optional. When the operator enabled block offload the backend opens its
    // Corestore over the wrapped storage, so a block whose data now lives in
    // the object store is restored and served exactly as a local one, and the
    // asset write path gets the hook that puts it there.
    blockOffload,
    platform: 'relay',
    role: 'relay',
    expectedProtocolVersion: PROTOCOL_VERSION,
    network: {
      networkId: networkConfig.networkId || 'peartube-main',
      trustedBootstrapSigners,
      trustedBootstrapRootIds,
      bootstrapEnabled
    },
    // A relay exists to make data available. The shared default upload
    // permission is 'manual', which is right for a phone on a metered link and
    // exactly wrong here: uploadAllowed requires 'enabled', so a relay left on
    // the default answers every block request with "unavailable". It announces
    // a catalog it will never serve, and every peer reads the whole library as
    // awaiting replication. An operator can still narrow this at runtime.
    networkPolicy: {
      uploadPermission: 'enabled',
      uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
      // The shared default retentionMode is 'none', which leaves
      // desiredArchiveParticipationEnabled false (orchestrator.js) and the
      // archive network idle. A relay that publishes and never mirrors makes
      // every title depend on the one machine that published it. The archive
      // ceiling is the storage ceiling the operator already configured, not a
      // second number: the policy runtime hands diskCeilingBytes straight to
      // the archive network (api/policy.js applyNow), floored at whatever is
      // already pledged.
      ...(reseedEnabled
        ? {
            retentionMode: 'archive-pledges',
            // Consent is a device-owner question on a phone; on a relay the
            // operator already answered it by configuring re-seeding. Without
            // these the consent gate leaves permissions.archive false and the
            // archive network stays idle no matter what the operator asked for.
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
              : {})
          }
        : {}),
      ...(config.networkPolicy || {}),
    },
    resources: {
      profile: { maxBytesPerDay: maxBytes },
      maxConcurrentSync: maxConcurrent,
      maxConcurrentProofs: maxConcurrent,
      maxConcurrentFetches: maxConcurrent
    },
    // Capacity is deliberately not configured here. Passing archive.capacityBytes
    // makes the reservation ledger authoritative at boot, and a ceiling lowered
    // under the bytes already pledged fails the whole startup
    // (archive/policy.js decodeState). The live number comes from the storage
    // guard through applyArchiveCapacity instead, which floors at the pledges.
    // The cadence is the operator's, when they set one: the backend already
    // accepts both knobs and only ever saw its own defaults, so custody could
    // not be confirmed sooner than every five minutes - or verified at all
    // inside a test - without reaching into the runtime by hand.
    seedPin: config.seedPin || {},
    // One archive option, not two: a second `archive` key in this literal
    // silently overwrote the re-seeding block, so a relay asked to re-seed
    // still handed the backend `enabled: false`.
    archive: {
      enabled: reseedEnabled ? true : config.archive?.enabled !== false,
      ...(config.archive?.challengeIntervalMs === undefined
        ? {}
        : { challengeIntervalMs: config.archive.challengeIntervalMs }),
      ...(config.archive?.challengeTimeoutMs === undefined
        ? {}
        : { challengeTimeoutMs: config.archive.challengeTimeoutMs }),
    },
    operability: {
      // Relay mode (public/private) and archive operator mode
      // (local-first/altruistic/friend-family/community/...) are different
      // vocabularies. Passing the relay mode straight through made every
      // public relay fail startup with "invalid archive operator mode", so the
      // operator intent is configured on its own or derived from the relay mode.
      operatorMode: config.archiveOperatorMode || archiveOperatorMode(config.mode)
    },
    provider: {
      ...(config.provider || {}),
      sourceGrantResolver: Object.freeze({
        async resolve ({ token, adapterId, acquisitionId, principalId, expiresAt, etag, length, sha256, contentType }) {
          if (adapterId === 'local-file') {
            return localFileSourceGrants.resolver.resolve({ token, adapterId, acquisitionId, principalId, expiresAt })
          }
          if (adapterId === 'companion-callback') {
            const origin = config.companion?.sourceOrigin
            const client = config.companion?.sourceClient || 'peartube-companion'
            const secret = config.companion?.sourceSharedSecret || config.companion?.sharedSecret
            if (!origin || !secret) {
              const error = new Error('Companion callback source origin/secret is not configured')
              error.code = 'SOURCE_GRANT_UNAVAILABLE'
              throw error
            }
            return createCompanionCallbackSourceReader({ origin, client, secret, token, jobId: acquisitionId, etag, length, sha256, contentType, logger })
          }
          const error = new Error(`Unsupported source grant adapter: ${adapterId}`)
          error.code = 'SOURCE_GRANT_UNAVAILABLE'
          throw error
        },
        async revoke ({ token }) {
          return localFileSourceGrants.revoke(token)
        }
      }),
      principalId: config.companion?.client || 'local-provider',
      freeDiskBytes: () => measureVolumeBytes({
        storagePath: config.storage.path,
        statfsSync: (dependencies?.fs || runtimeFs).statfsSync,
        log: message => logger?.runtime?.warn?.(message)
      })?.freeBytes || 0,
    },
    ipcLog: (message) => logger?.runtime?.debug?.(message)
  })

  if (!backend?.ctx || !backend?.api || typeof backend.destroy !== 'function') {
    await backend?.destroy?.().catch(() => {})
    throw new Error('universal backend returned an incomplete relay context')
  }

  let closed = false
  let started = false
  // The archivists' own possession evidence for one requested mirror: peers
  // whose challenge for these exact ranges passed. Never a peer count — a peer
  // that can stream the bytes has promised nothing about keeping them.
  function mirrorEvidence (record) {
    const network = backend.ctx?.permissionlessArchiveNetwork
    if (typeof network?.getOffloadEvidence !== 'function') return []
    try {
      const evidence = network.getOffloadEvidence(record.publicationId, record.locators)
      return Array.isArray(evidence) ? evidence : []
    } catch {
      return []
    }
  }

  // The host volume, measured once at start and reported to the participation
  // decision. archiveEligible requires a real free-disk reading
  // (playback/resource-policy.js: allSignalsKnown -> diskKnown), and until one
  // exists the archive ledger refuses every pledge with
  // 'archiving-not-permitted'.
  //
  // Exactly two fields go out. On a server host the battery, thermal and
  // metered signals are not-applicable rather than unread, so they need nothing
  // from here, and inventing values for them would be a lie told to open a
  // gate. These two are a real statfs on the storage volume — the host's own
  // numbers, never the operator's byte budget, which answers a different
  // question and is enforced separately by applyArchiveCapacity.
  let hostDisk = { measured: false, reason: 'not-measured', freeBytes: null, totalBytes: null }

  async function reportHostDisk () {
    if (typeof backend.api.setDeviceConditions !== 'function') {
      hostDisk = { measured: false, reason: 'device-conditions-unavailable', freeBytes: null, totalBytes: null }
      return hostDisk
    }
    const fs = dependencies?.fs || await import('#fs').catch(() => null)
    const volume = measureVolumeBytes({
      storagePath: config.storage.path,
      statfsSync: fs?.statfsSync || null,
      log: (message) => logger?.runtime?.debug?.(message)
    })
    // Both numbers or neither: the decision measures its floor as a fraction of
    // the volume, so a free reading without a total cannot be judged and must
    // stay unknown rather than be judged against a guess.
    if (!volume || !Number.isFinite(volume.freeBytes) || !Number.isFinite(volume.totalBytes)) {
      hostDisk = { measured: false, reason: 'statfs-unavailable', freeBytes: null, totalBytes: null }
      // A host that cannot read its own disk must not promise anyone durable
      // storage, so custody stays shut — but an operator whose relay is not
      // pledging deserves the reason rather than an absence of logs. Bare's
      // `#fs` exports no statfsSync, so this is the normal state there.
      logger?.runtime?.warn?.('Host disk is unmeasurable; this relay will not take archive pledges', {
        storagePath: config.storage.path,
        reason: 'statfs-unavailable'
      })
      return hostDisk
    }
    await backend.api.setDeviceConditions({
      freeDiskBytes: volume.freeBytes,
      freeDiskBytesProvided: true,
      totalDiskBytes: volume.totalBytes,
      totalDiskBytesProvided: true
    })
    hostDisk = { measured: true, reason: null, freeBytes: volume.freeBytes, totalBytes: volume.totalBytes }
    return hostDisk
  }

  const runtime = {
    backend,
    ctx: backend.ctx,
    api: backend.api,
    provider: backend.provider || backend.ctx?.providerService || null,
    acquisitionManager: backend.acquisitionManager || backend.ctx?.acquisitionManager || null,
    issueLocalProviderResolution: backend.issueLocalProviderResolution || backend.ctx?.issueLocalProviderResolution || null,
    retractPublication: backend.retractPublication || backend.uploadManager?.retractAcquiredPublication || null,
    localFileSourceGrants,
    scopedNetwork: backend.scopedNetwork,
    seedingManager: backend.seedingManager,
    verifiedQueryView: backend.verifiedQueryView || backend.ctx?.verifiedQueryView || null,
    identityManager: backend.identityManager,
    uploadManager: backend.uploadManager || backend.ctx?.uploadManager || null,
    seedPin: backend.seedPin,
    seedPinClients: backend.seedPinClients,

    async start () {
      if (closed) throw new Error('relay runtime is closed')
      if (started) return
      started = true
      await reportHostDisk()
      // The server-host decision is published from the backend's own startup as
      // fire-and-forget, so without this barrier start() can return while
      // ctx.participationDecision is still null and the first inbound archive
      // request is refused 'archiving-not-permitted' for no reason an operator
      // could see. Evaluating once here makes start() returning mean custody
      // has an answer, whatever that answer is.
      await backend.api.getParticipationStatus?.().catch?.(() => {})
      logger?.runtime?.info?.('Relay universal backend ready', {
        platform: 'relay',
        networkId: networkConfig.networkId || 'peartube-main',
        hostDiskMeasured: hostDisk.measured,
        ...(hostDisk.measured ? {} : { hostDiskReason: hostDisk.reason })
      })
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

    // Ask the network to mirror a rendition this relay already holds. The
    // archive network resolves the byte ranges from the signed manifest itself;
    // the locators are kept here only so status can read the archivists'
    // possession evidence back for this exact rendition.
    async requestArchiveMirror ({ publicationId, renditionId, locators = [] } = {}) {
      if (!reseedEnabled) return { requested: false, reason: 'reseed-disabled' }
      if (!HEX_32.test(publicationId || '') || !HEX_32.test(renditionId || '')) {
        return { requested: false, reason: 'invalid-rendition', errorCode: 'ARCHIVE_REQUEST_INVALID' }
      }
      if (typeof backend.api.requestArchivePublication !== 'function') {
        return { requested: false, reason: 'unavailable', errorCode: 'ARCHIVE_NETWORK_UNAVAILABLE' }
      }
      let result = null
      try {
        result = await backend.api.requestArchivePublication({ publicationId, renditionId })
      } catch (error) {
        result = { success: false, status: 'failed', requestId: '', errorCode: 'ARCHIVE_REQUEST_FAILED' }
        logger?.runtime?.warn?.('Archive mirror request failed', {
          publicationId,
          renditionId,
          error: error?.message || String(error)
        })
      }
      archiveRequests.set(`${publicationId}:${renditionId}`, {
        publicationId,
        renditionId,
        locators: Array.isArray(locators) ? locators : [],
        status: String(result?.status || 'failed'),
        requestId: String(result?.requestId || ''),
        errorCode: result?.errorCode || null,
        requestedAt: Date.now()
      })
      return {
        requested: result?.success === true,
        status: String(result?.status || 'failed'),
        requestId: String(result?.requestId || ''),
        errorCode: result?.errorCode || null
      }
    },

    // One ceiling governs both the local store and the pledges this relay takes
    // on for other relays. `headroomBytes` is the storage guard's live number:
    // null when neither the byte budget nor the free-disk floor is measurable.
    async applyArchiveCapacity ({ headroomBytes = null } = {}) {
      if (!reseedEnabled) return { applied: false, reason: 'reseed-disabled' }
      if (typeof backend.api.getArchiveParticipation !== 'function' ||
          typeof backend.api.setArchiveParticipation !== 'function') {
        return { applied: false, reason: 'archive-participation-unavailable' }
      }
      const status = await backend.api.getArchiveParticipation({})
      if (status?.success === false) {
        return { applied: false, reason: status.errorCode || 'archive-participation-unavailable' }
      }
      const reservedBytes = Number.isSafeInteger(status?.reservedBytes) && status.reservedBytes > 0
        ? status.reservedBytes
        : 0
      // A measured headroom already has the pledged bytes on disk subtracted
      // from it. When neither storage signal is measurable the configured
      // ceiling is all there is, and what is already pledged comes off it.
      const measured = Number.isSafeInteger(headroomBytes) && headroomBytes > 0 ? headroomBytes : null
      const room = measured ?? (headroomBytes == null ? Math.max(0, maxBytes - reservedBytes) : 0)
      // Floored at the bytes already pledged. setParticipation releases EVERY
      // local pledge when the new capacity falls under what is reserved
      // (archive/permissionless-network.js), so a full disk must never be handed
      // down as an instruction to abandon custody. A relay at its ceiling
      // reports capacity == reserved, which the ingest path reads as no room for
      // anything new while every existing pledge stays exactly where it is.
      const capacityBytes = reservedBytes + room
      const applied = await backend.api.setArchiveParticipation({
        enabled: true,
        capacityBytes,
        maxRequestBytes: room,
        // A dedicated relay is a public archivist, not a consumer device hiding
        // in a crowd: it accepts every request it has room for. The
        // probabilistic decline exists so a phone cannot be mapped by what it
        // agrees to keep, which is not a relay's problem.
        acceptancePermille: 1000
      })
      if (applied?.success === false) {
        return { applied: false, reason: applied.errorCode || 'archive-participation-unavailable' }
      }
      return { applied: true, capacityBytes, maxRequestBytes: room, reservedBytes }
    },

    async getArchiveParticipation () {
      if (typeof backend.api.getArchiveParticipation !== 'function') return {}
      return backend.api.getArchiveParticipation({}) || {}
    },

    // What this relay has asked the network to mirror, each with the archivist
    // evidence backing it at this moment.
    getArchiveMirrorRequests () {
      return Array.from(archiveRequests.values(), (record) => {
        const evidence = mirrorEvidence(record)
        return {
          publicationId: record.publicationId,
          renditionId: record.renditionId,
          status: record.status,
          requestId: record.requestId,
          errorCode: record.errorCode,
          requestedAt: record.requestedAt,
          archivists: evidence.length,
          freshArchivists: evidence.reduce(
            (count, entry) => count + (entry?.passed === true && entry?.recent === true ? 1 : 0),
            0
          )
        }
      })
    },

    async refreshAuthorization (trustedClients) {
      if (typeof backend.api.refreshScopedAuthorization !== 'function') return false
      const result = await backend.api.refreshScopedAuthorization({
        trustedClients: normalizeHexList(trustedClients)
      })
      return result?.status === 'updated'
    },

    async requestCatalogSync () {
      if (typeof backend.api.reannounceArchiveRequests === 'function') {
        await backend.api.reannounceArchiveRequests().catch(() => {})
      }
      const locators = await backend.api.listBootstrapLocators()
      return Array.isArray(locators) ? locators.length : 0
    },

    async resolveCandidate (candidate = {}) {
      const publisherId = candidate.publisherId || null
      if (!publisherId) return { ...candidate }
      const catalog = await backend.api.resolveLocalPublisherCatalog({ publisherId })
      return { ...candidate, publisherId, catalog }
    },

    setCandidateHandler () {
      // Candidate delivery belongs to the backend's scoped publisher manager.
      // Callers explicitly follow authenticated publishers through followPublisher.
    },

    async getDiagnostics () {
      const [scoped, locators, seedRetention, archive, storage, archiveParticipation, policyResult] = await Promise.all([
        backend.api.getScopedNetworkDiagnostics(),
        backend.api.listBootstrapLocators(),
        backend.seedingManager?.getStatus?.() || {},
        backend.api.getArchiveOperatorStatus?.({}) || {},
        backend.api.getStorageStats?.() || {},
        backend.api.getArchiveParticipation?.({}) || {},
        backend.api.getNetworkPolicy?.() || {}
      ])
      const counters = scoped?.counters || {}
      const swarm = backend.ctx?.swarm
      const publisherTopics = purposeCount(scoped?.topics, 'publisher')
      const assetTopics = purposeCount(scoped?.topics, 'asset')
      const policy = policyResult?.policy || {}
      return {
        policy: {
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
        },
        network: {
          status: scoped?.status || 'unknown',
          protocolMajor: scoped?.protocolMajor ?? PROTOCOL_VERSION,
          networkId: scoped?.networkId || networkConfig.networkId || 'peartube-main',
          peers: swarm?.peers?.size || 0,
          connections: swarm?.connections?.size || 0,
          dht: {
            bootstrapped: swarm?.dht?.bootstrapped ?? null,
            firewalled: swarm?.dht?.firewalled ?? null,
            online: swarm?.dht?.online ?? null
          },
          offline: Boolean(swarm?._peartubeOffline),
          offlineReason: swarm?._peartubeOfflineReason || null,
          listenResolved: Boolean(swarm?._peartubeListenResolved),
          lastErrors: Array.isArray(scoped?.recentErrors)
            ? scoped.recentErrors.slice(-8).map(error => String(error?.code || 'SCOPED_NETWORK_ERROR').slice(0, 64))
            : []
        },
        publicWork: {
          activeAnnouncements: Number(scoped?.publicWork?.activeAnnouncements) || 0,
          activeServes: Number(scoped?.publicWork?.activeServes) || 0,
          servedBytes: Number(scoped?.publicWork?.servedBytes) || 0
        },
        publisher: {
          catalogs: counter(counters, 'publisherCatalogs', 'catalogs') || publisherTopics,
          followed: counter(counters, 'publishersFollowed', 'followedPublishers'),
          lastErrorCode: scoped?.lastErrorCode || null
        },
        bootstrap: {
          // The scoped runtime reports 'active' once it is running; it never
          // reports 'ready', so comparing against that pinned joined to false
          // even while the bootstrap scope was live.
          joined: bootstrapEnabled && scoped?.status === 'active',
          locators: Array.isArray(locators) ? locators.length : 0,
          rejected: counter(counters, 'locatorsRejected', 'bootstrapRejected'),
          maxLocators: counter(counters, 'maxLocators', 'bootstrapLimit')
        },
        assets: {
          retainedRenditions: counter(counters, 'retainedRenditions'),
          activeSessions: purposeCount(scoped?.sessions, 'asset'),
          topics: assetTopics,
          activeServes: Number(scoped?.publicWork?.activeServes) || 0,
          servedBytes: Number(scoped?.publicWork?.servedBytes) || 0,
          maxSessions: counter(counters, 'maxAssetSessions', 'assetSessionLimit')
        },
        seedRetention: seedRetention || {},
        archive: archive || {},
        storage: storage || {},
        // Both directions of re-seeding: what this relay asked the network to
        // mirror, and what it is mirroring for other relays.
        archiveRequests: this.getArchiveMirrorRequests(),
        archiveParticipation: archiveParticipation || {},
        // Why custody is open or shut: without a real free-disk reading the
        // participation decision refuses every pledge, and an operator should
        // be able to see that rather than infer it.
        archiveHostDisk: { ...hostDisk }
      }
    },

    async getNetworkStats () {
      return this.getDiagnostics()
    },

    async close () {
      if (closed) return
      closed = true
      await backend.destroy()
      await localFileSourceGrants.close()
    }
  }

  return runtime
}
