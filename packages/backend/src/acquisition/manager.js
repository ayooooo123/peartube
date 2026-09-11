import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import AbortController from 'abort-controller'
import {
  MAX_ACQUISITION_BYTES,
  TERMINAL_ACQUISITION_STATES,
  acquisitionError,
  assertNoPrivateSourceMaterial,
  acquisitionIdForRequest,
  fingerprintAcquisitionRequest,
  idempotencyDigestFor,
  normalizeAcquisitionRequest,
  normalizePrincipalId,
  normalizePublicationMetadata,
  PUBLICATION_METADATA_FIELDS,
  projectAcquisitionJob
} from './contract.js'
import { createAcquisitionAdmissionLedger } from './accounting.js'
import { migrateLegacyIngest as migrateLegacy } from './store.js'

const TERMINAL = new Set(TERMINAL_ACQUISITION_STATES)
const RESET_PREFIX_ERRORS = new Set(['SOURCE_IDENTITY_CHANGED', 'ASSET_SOURCE_IDENTITY_CHANGED', 'ASSET_SOURCE_CHANGED', 'SOURCE_LENGTH_MISMATCH', 'HASH_MISMATCH', 'VERIFICATION_FAILED'])
const PERMANENT_ERRORS = new Set(['PUBLISHER_AUTHORITY_LOST', 'ASSET_INVALID'])
const IDENTITY_KINDS = new Set(['sha256', 'etag'])
const DAY_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function fail (code, message, statusCode = 409) { throw acquisitionError(code, message, statusCode) }
function at (now) { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('now must return a non-negative safe integer'); return value }
function publicJob (job) { return job ? projectAcquisitionJob(job) : null }
function errorCode (error, state) {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return error.code
  if (state === 'acquiring') return 'ACQUISITION_FAILED'
  if (state === 'verifying') return 'VERIFICATION_FAILED'
  if (state === 'publishing') return 'PUBLICATION_FAILED'
  return 'ACQUISITION_FAILED'
}
function durableSourceIdentity (identity) {
  if (!identity || !IDENTITY_KINDS.has(identity.kind) || typeof identity.value !== 'string' || !identity.value) {
    fail('ACQUISITION_RESOLUTION_INVALID', 'source identity is invalid', 502)
  }
  if (identity.kind === 'sha256') return { kind: 'sha256', value: identity.value }
  const digest = crypto.hash(b4a.from(`peartube.acquisition.source-identity.v1\u0000${identity.kind}\u0000${identity.value}`))
  return { kind: 'etag', value: `etag-${b4a.toString(digest, 'hex')}` }
}


function publicationMetadata(value, request = null) {
  const output = { title: null, sourceFileName: request?.sourceFileName ?? null, mediaContext: null }
  for (const field of PUBLICATION_METADATA_FIELDS) {
    if (value?.[field] != null) output[field] = value[field]
  }
  return normalizePublicationMetadata(output, 'ACQUISITION_SECRET_REJECTED')
}
function expectedFacts (value) {
  const expected = value?.expected ?? value ?? {}
  const byteLength = expected.byteLength
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_ACQUISITION_BYTES) {
    fail('ACQUISITION_RESOLUTION_INVALID', 'resolution has invalid byte length', 502)
  }
  let identity = expected.identity ?? null
  if (identity == null && expected.sha256) identity = { kind: 'sha256', value: expected.sha256 }
  if (identity == null && expected.etag) identity = { kind: 'etag', value: expected.etag }
  if (identity !== null && (!IDENTITY_KINDS.has(identity.kind) || typeof identity.value !== 'string' || !identity.value ||
      identity.value.length > 512 || (identity.kind === 'sha256' && !/^[0-9a-f]{64}$/.test(identity.value)))) {
    fail('ACQUISITION_RESOLUTION_INVALID', 'resolution has invalid source identity', 502)
  }
  return {
    byteLength,
    identity: identity === null ? null : durableSourceIdentity(identity)
  }
}
function sameIdentity (left, right) { return left?.kind === right?.kind && left?.value === right?.value }
function replayFingerprintMatches (existing, request) {
  const fingerprint = fingerprintAcquisitionRequest(request)
  if (existing?.requestFingerprint === fingerprint) return true
  if (existing?.deferredInput !== true || !existing.request) return false
  const prior = { ...existing.request }
  const next = { ...request }
  delete prior.sourceFileName
  delete next.sourceFileName
  return fingerprintAcquisitionRequest(prior) === fingerprintAcquisitionRequest(next)
}
function assetDescriptor (value, expectedBytes) {
  const source = value?.descriptor ?? value?.asset ?? value
  const fields = ['assetId', 'key', 'treeHash']
  if (!source || fields.some(field => typeof source[field] !== 'string' || !ID.test(source[field])) ||
      !Number.isSafeInteger(source.length) || source.length < 1 || source.byteLength !== expectedBytes ||
      !Number.isSafeInteger(source.blockSize) || source.blockSize < 1) fail('ASSET_INVALID', 'acquisition adapter returned an invalid static asset', 502)
  return { assetId: source.assetId, key: source.key, treeHash: source.treeHash, length: source.length, byteLength: source.byteLength, blockSize: source.blockSize }
}
function resolveTransferHook (provider) {
  if (typeof provider.importAsset === 'function') return provider.importAsset
  if (typeof provider.fetchAsset === 'function') return provider.fetchAsset
  return null
}
function transferResultByteCount (result) {
  const bytes = Number(result?.byteLength ?? result?.transferredBytes ?? result?.bytesReceived ?? result?.core?.byteLength)
  if (!Number.isSafeInteger(bytes) || bytes < 1) fail('TRANSFERRED_BYTES_INVALID', 'transferred asset byte count is invalid', 502)
  return bytes
}
function publicationResult (value, assetId) {
  const fields = ['publicationId', 'manifestId', 'renditionId', 'assetId']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) ||
      fields.some(field => typeof value[field] !== 'string' || !ID.test(value[field])) || value.assetId !== assetId) {
    fail('PUBLICATION_INVALID', 'publisher returned invalid immutable identifiers', 502)
  }
  return { publicationId: value.publicationId, manifestId: value.manifestId, renditionId: value.renditionId, assetId: value.assetId }
}
function publisherIdsForPrincipal (principal) {
  const raw = principal?.publisherIds ?? principal?.allowedPublisherIds
  const values = Array.isArray(raw) ? raw : (typeof principal?.publisherId === 'string' && principal.publisherId ? [principal.publisherId] : [])
  if (!Array.isArray(values) || values.length > 64) fail('ACQUISITION_PRINCIPAL_INVALID', 'principal publisher scope is invalid', 403)
  const normalized = values.map(value => {
    if (typeof value !== 'string' || !ID.test(value)) fail('ACQUISITION_PRINCIPAL_INVALID', 'principal publisher scope is invalid', 403)
    return value
  })
  return [...new Set(normalized)].sort()
}
function principalForJob (job) { return { principalId: job.principalId, isLocal: job.isRemote !== true, publisherIds: job.requesterPublisherIds } }
function requireMethods (value, methods, message) {
  if (!value || !methods.every(method => typeof value[method] === 'function')) throw new TypeError(message)
}
function validateManagerDependencies ({ store, policy, provider, sourceGrants, publisher, freeDiskBytes, now }) {
  requireMethods(store, ['get', 'createOrReplay', 'transition', 'updateProgress', 'complete', 'exhaust', 'list', 'listActive'], 'acquisition manager requires an acquisition store')
  requireMethods(policy, ['getPolicy', 'admit'], 'acquisition manager requires a policy runtime')
  requireMethods(provider, ['resolve', 'open', 'acquire', 'verify'], 'acquisition provider must implement resolve, open, acquire, and verify')
  requireMethods(sourceGrants, ['attach', 'has', 'inspect', 'resolve', 'revoke'], 'acquisition manager requires a SourceGrantVault')
  requireMethods(publisher, ['hasAuthority', 'publish'], 'acquisition publisher must implement hasAuthority and publish')
  if (typeof freeDiskBytes !== 'function' || typeof now !== 'function') throw new TypeError('manager clock and disk probe must be functions')
}


export function createAcquisitionManager ({ store, policy, provider, sourceGrants, publisher, network = null, accounting = null, freeDiskBytes = () => Number.MAX_SAFE_INTEGER, now = () => Date.now() } = {}) {
  validateManagerDependencies({ store, policy, provider, sourceGrants, publisher, freeDiskBytes, now })
  const ledger = accounting || createAcquisitionAdmissionLedger({ now })
  const active = new Map()
  const listeners = new Set()
  let started = false
  let closing = false
  let closed = false
  let unsubscribePolicy = null
  let mutations = Promise.resolve()
  let dispatches = Promise.resolve()
  function serialized (operation) { const result = mutations.then(operation, operation); mutations = result.catch(() => {}); return result }
  function assertOpen () { if (closed || closing) fail('ACQUISITION_MANAGER_CLOSED', 'acquisition manager is closed', 503) }
  async function notify (event) {
    if (!event) return
    for (const listener of listeners) {
      try { listener(event) } catch { /* lifecycle observers cannot break acquisition */ }
    }
    if (!network) return
    try {
      if (event.type === 'acquisition.verified' || event.type === 'acquisition.completed') await network.result?.(event)
      else if (event.type === 'acquisition.cancelled') await network.cancel?.(event)
      else await network.progress?.(event)
    } catch {
      // Wire progress is best-effort telemetry. Rate limits, transient transport
      // faults, and missing assignment scopes must not abort the single runJob.
      if (event.type === 'acquisition.verified' || event.type === 'acquisition.completed' || event.type === 'acquisition.cancelled') {
        // Terminal coordination still needs a durable retry path via reconcile;
        // swallow here so local verification/publication is not rolled back by wire.
      }
    }
  }
  async function change (id, input) { const outcome = await store.transition(id, input); await notify(outcome.event); return outcome.job }
  async function progress (job, patch) { const outcome = await store.updateProgress(job.acquisitionId, { expectedVersion: job.version, state: job.state, patch }); await notify(outcome.event); return outcome.job }
  async function currentPolicy () { return policy.getPolicy() }
  async function assertAuthority (job) {
    const authorized = await publisher.hasAuthority({ publisherId: job.publisherId, principalId: job.principalId, acquisitionId: job.acquisitionId })
    if (authorized !== true && authorized?.authorized !== true) fail('PUBLISHER_AUTHORITY_LOST', 'publisher authority is not current', 403)
  }
  async function discard (job, reason) { await provider.discard?.({ acquisitionId: job.acquisitionId, verifiedPrefix: job.verifiedPrefix, verifiedAsset: job.verifiedAsset, reason }).catch?.(() => {}) }
  async function terminal (job, state, code, recoverable) {
    const latest = await store.get(job.acquisitionId)
    if (!latest || TERMINAL.has(latest.state)) return latest
    return change(job.acquisitionId, { expectedVersion: latest.version, from: latest.state, to: state, patch: { errorCode: code, recoverable, finishedAt: at(now) } })
  }
  async function resolveReader (job, signal, policyValue) {
    if (sourceGrants.has({ acquisitionId: job.acquisitionId, principal: job.principalId })) return sourceGrants.resolve({ acquisitionId: job.acquisitionId, principal: job.principalId, signal, budget: policyValue })
    return provider.open({ ref: job.request.resolutionRef, request: job.request, principalId: job.principalId, signal, budget: policyValue })
  }
  async function finalizeAcquisitionOnly({ job, id, bytes, asset, policyValue }) {
    job = await progress(await store.get(id), {
      verifiedBytes: bytes,
      verifiedAsset: asset,
      sourceBytesRead: bytes,
      sourceBytesAccepted: bytes,
      bytesAcquired: bytes,
      stagingBytes: 0
    })
    if (policyValue) {
      ledger.record(id, { committedBytes: bytes, retainedBytes: bytes, stagingBytes: 0 }, { policy: policyValue })
      ledger.commit(id)
    }
    const verifiedOutcome = await store.completeVerified(id, { expectedVersion: job.version, asset })
    await notify(verifiedOutcome.event)
    if (policyValue) ledger.release(id)
    await sourceGrants.revoke({ acquisitionId: id, principal: job.principalId, reason: acquisitionError('SOURCE_GRANT_CONSUMED', 'source grant consumed') }).catch(() => {})
    return verifiedOutcome.job
  }

  async function publishFinalizedAcquisition({ job, id, bytes, asset, sourceDescription, signal, policyValue }) {
    await assertAuthority(job)

    job = await change(id, {
      expectedVersion: job.version,
      from: 'verifying',
      to: 'publishing',
      patch: { verifiedBytes: bytes, verifiedAsset: asset }
    })
    await assertAuthority(job)

    let publication
    let artworkReader = null
    let createArtworkSources = null
    try {
      if (job.publicationMetadata?.artworkRoles?.length > 0) {
        artworkReader = await resolveReader(job, signal, policyValue || await currentPolicy())
        if (typeof artworkReader?.openArtwork !== 'function') {
          fail('SOURCE_GRANT_UNAVAILABLE', 'publication artwork requires a source grant', 409)
        }
        createArtworkSources = () => artworkReader.openArtwork({ signal })
      }
      publication = publicationResult(await publisher.publish({
        acquisitionId: id,
        request: job.request,
        asset,
        source: sourceDescription,
        resolution: job.publicationMetadata,
        createArtworkSources,
        principalId: job.principalId,
        signal
      }), asset.assetId)
    } finally {
      await artworkReader?.close?.().catch(() => {})
    }

    if (policyValue) {
      ledger.record(id, { committedBytes: bytes, retainedBytes: bytes, stagingBytes: 0 }, { policy: policyValue })
      ledger.commit(id)
    }

    const completed = await store.complete(id, { expectedVersion: job.version, publication })
    await notify(completed.event)
    if (policyValue) ledger.release(id)
    await sourceGrants.revoke({ acquisitionId: id, principal: job.principalId, reason: acquisitionError('SOURCE_GRANT_CONSUMED', 'source grant consumed') }).catch(() => {})
    return completed.job
  }

  async function finalizeAcquisition({ job: initialJob, asset, sourceDescription, sourceIdentity, signal = null, policyValue = null, publish = true }) {
    let job = initialJob
    const bytes = job.expectedBytes
    const id = job.acquisitionId
    const acquisitionOnly = job.isRemote === true || publish === false

    if (job.state === 'queued') {
      job = await change(id, { expectedVersion: job.version, from: 'queued', to: 'acquiring', patch: { attempts: job.attempts + 1, startedAt: job.startedAt ?? at(now) } })
    }
    if (job.state === 'acquiring') {
      job = await change(id, { expectedVersion: job.version, from: 'acquiring', to: 'verifying' })
    }

    const verification = await provider.verify({
      acquisitionId: id,
      request: job.request,
      asset,
      expected: { byteLength: job.expectedBytes, identity: sourceIdentity || job.expectedIdentity },
      signal
    })
    const verified = verification === true || (verification?.verified === true && verification.byteLength === job.expectedBytes)
    if (!verified) fail('VERIFICATION_FAILED', 'static asset failed exact verification', 502)

    if (policyValue) ledger.record(id, { verifiedBytes: bytes }, { policy: policyValue })

    if (acquisitionOnly) {
      return finalizeAcquisitionOnly({ job, id, bytes, asset, policyValue })
    }

    return publishFinalizedAcquisition({ job, id, bytes, asset, sourceDescription, signal, policyValue })
  }
  async function finalizePublication(input) {
    return finalizeAcquisition({ ...input, publish: true })
  }

  async function admitJob(job, isStagedComplete, grant) {
    let resolution = grant || (job.request?.resolutionRef ? await provider.resolve({ ref: job.request.resolutionRef, request: job.request, principalId: job.principalId }).catch(() => null) : null)
    let adapterId = null
    if (!isStagedComplete) {
      adapterId = resolution?.adapterId ?? null
      if (adapterId === null) fail('ACQUISITION_ADAPTER_DENIED', 'the resolved source names no adapter, so no allowlist can admit it', 403)
    }
    await policy.admit({
      request: job.request,
      principal: principalForJob(job),
      adapterId,
      freeDiskBytes: freeDiskBytes(),
      isRemote: job.isRemote === true
    })
  }

  function resolveStagedIdentity(job, grant, isStagedComplete) {
    if (!grant && isStagedComplete && (job.verifiedPrefix?.identity || job.expectedIdentity)) {
      return job.verifiedPrefix?.identity || job.expectedIdentity
    }
    return null
  }

  function resolveResumeState(reader, job, describedIdentity, isStagedComplete) {
    if (reader.resumable && (!job.verifiedPrefix || sameIdentity(job.verifiedPrefix.identity, describedIdentity) || isStagedComplete)) {
      return { ...(job.verifiedPrefix || {}), identity: describedIdentity }
    }
    return null
  }

  async function prepareJobReader(job, grant, isStagedComplete, stagedIdentity, entry, policyValue) {
    const reader = (!grant && isStagedComplete && stagedIdentity)
      ? {
          resumable: true,
          maxReadBytes: 16 * 1024 * 1024,
          async describe () { return { byteLength: job.expectedBytes, identity: stagedIdentity, mimeType: 'video/mp4' } },
          async * open () {},
          async close () {}
        }
      : await resolveReader(job, entry.controller.signal, policyValue)
    try {
      const description = await reader.describe({ signal: entry.controller.signal })
      if (description.byteLength !== job.expectedBytes) fail('SOURCE_LENGTH_MISMATCH', 'source length changed')
      const describedIdentity = stagedIdentity
        ? stagedIdentity
        : durableSourceIdentity(description.identity)
      if (job.expectedIdentity !== null && !stagedIdentity && !sameIdentity(describedIdentity, job.expectedIdentity)) {
        fail('SOURCE_IDENTITY_CHANGED', 'source identity changed')
      }
      return { reader, description, describedIdentity }
    } catch (error) {
      // Ownership transfers to runJob's finally only on success. Close the exact
      // reader acquired here on every post-acquisition failure, discarding a
      // noisy close so the original durable error survives.
      try { await reader.close?.() } catch { /* the original error is the contract */ }
      throw error
    }
  }

  async function recoverPublishingJob(latest, id) {
    if (latest?.state === 'publishing' && latest.verifiedAsset && typeof publisher.getPublication === 'function') {
      try {
        const existing = await publisher.getPublication({
          acquisitionId: latest.acquisitionId,
          publisherId: latest.publisherId,
          asset: latest.verifiedAsset,
          resolution: latest.publicationMetadata
        })
        if (existing) {
          const publication = publicationResult(existing, latest.verifiedAsset.assetId)
          const completed = await store.complete(latest.acquisitionId, {
            expectedVersion: latest.version,
            publication
          })
          await notify(completed.event)
          ledger.release(id)
          await sourceGrants.revoke({
            acquisitionId: id,
            principal: latest.principalId,
            reason: acquisitionError('SOURCE_GRANT_CONSUMED', 'source grant consumed')
          }).catch(() => {})
          return completed.job
        }
      } catch {
        // Preserve the original publication failure below.
      }
    }
    return null
  }

  async function handleJobError(error, latest, id, entry) {
    if (entry.cancelled) {
      const cancelled = await terminal(latest, 'cancelled', 'CANCELLED', false)
      await discard(cancelled, error)
      ledger.release(id)
      await sourceGrants.revoke({ acquisitionId: id, principal: latest.principalId, reason: error }).catch(() => {})
      return cancelled
    }
    const code = errorCode(error, latest?.state)
    const recoverable = error?.recoverable !== false && !PERMANENT_ERRORS.has(code)
    const failed = await terminal(latest, 'failed', code, recoverable)
    if (!recoverable || RESET_PREFIX_ERRORS.has(code)) {
      await discard(failed, error)
      await sourceGrants.revoke({ acquisitionId: id, principal: latest.principalId, reason: error }).catch(() => {})
    }
    ledger.release(id)
    return failed
  }

  async function runJob (id, entry) {
    let job = await store.get(id)
    let reader = null
    try {
      if (!job || job.state !== 'queued') return job
      const policyValue = await currentPolicy()
      const isStagedComplete = job.bytesAcquired >= job.expectedBytes && job.expectedBytes > 0
      const grant = sourceGrants.inspect({ acquisitionId: job.acquisitionId, principal: job.principalId })
      await admitJob(job, isStagedComplete, grant)
      ledger.start({ acquisitionId: id, policy: policyValue, counters: job })
      if (job.isRemote !== true) await assertAuthority(job)
      job = await change(id, { expectedVersion: job.version, from: 'queued', to: 'acquiring', patch: { attempts: job.attempts + 1, startedAt: job.startedAt ?? at(now) } })
      const sourceExpensive = sourceGrants.has({ acquisitionId: job.acquisitionId, principal: job.principalId })
      const stagedIdentity = resolveStagedIdentity(job, grant, isStagedComplete)
      const prepared = await prepareJobReader(job, grant, isStagedComplete, stagedIdentity, entry, policyValue)
      reader = prepared.reader
      const description = prepared.description
      const describedIdentity = prepared.describedIdentity
      if (job.expectedIdentity === null) job = await progress(job, { expectedIdentity: describedIdentity })
      const resume = resolveResumeState(reader, job, describedIdentity, isStagedComplete)
      const acquired = await provider.acquire({ acquisitionId: id, request: job.request, reader, resume, budget: policyValue, sourceExpensive, priorBytes: Math.max(job.sourceBytesRead, job.sourceBytesAccepted, job.bytesAcquired, job.stagingBytes), signal: entry.controller.signal, onProgress: async counters => {
        const latest = await store.get(id); if (!latest || latest.state !== 'acquiring') return
        const patch = { sourceBytesRead: counters.sourceBytesRead ?? counters.bytesAcquired, sourceBytesAccepted: counters.sourceBytesAccepted ?? counters.bytesAcquired, bytesAcquired: counters.bytesAcquired, stagingBytes: counters.stagingBytes ?? latest.stagingBytes }
        ledger.record(id, { sourceBytesRead: patch.sourceBytesRead, sourceBytesAccepted: patch.sourceBytesAccepted, stagingBytes: patch.stagingBytes }, { policy: policyValue }); job = await progress(latest, patch)
      } })
      const asset = assetDescriptor(acquired, job.expectedBytes)
      const bytes = job.expectedBytes
      const acquisitionPatch = { sourceBytesRead: bytes, sourceBytesAccepted: bytes, bytesAcquired: bytes, stagingBytes: acquired?.stagingBytes ?? job.stagingBytes, verifiedPrefix: { byteLength: bytes, identity: describedIdentity } }
      ledger.record(id, { sourceBytesRead: bytes, sourceBytesAccepted: bytes, stagingBytes: acquisitionPatch.stagingBytes }, { policy: policyValue })
      job = await progress(await store.get(id), acquisitionPatch)
      return await finalizeAcquisition({ job, asset, sourceDescription: description, sourceIdentity: describedIdentity, signal: entry.controller.signal, policyValue, publish: job.isRemote !== true })
    } catch (error) {
      if (closing || entry.closing) return store.get(id)
      const latest = await store.get(id) || job
      const recovered = await recoverPublishingJob(latest, id)
      if (recovered) return recovered
      return handleJobError(error, latest, id, entry)
    } finally {
      await reader?.close?.().catch(() => {})
      if (active.get(id) === entry) active.delete(id)
      if (!closing && !closed) dispatchQueued().catch(() => {})
    }
  }
  function canSchedule (job) {
    if (job.bytesAcquired >= job.expectedBytes && job.expectedBytes > 0) return true
    const hasGrant = sourceGrants.has({ acquisitionId: job.acquisitionId, principal: job.principalId })
    if (job.deferredInput === true) return hasGrant
    if (hasGrant) return true
    return provider.canOpen?.({ ref: job.request.resolutionRef, principalId: job.principalId }) === true
  }
  function schedule (job) {
    if (!started || closing || active.has(job.acquisitionId) || !canSchedule(job)) return false
    const entry = { controller: new AbortController(), cancelled: false, closing: false, principalId: job.principalId, promise: null }
    entry.promise = runJob(job.acquisitionId, entry)
    active.set(job.acquisitionId, entry)
    return true
  }
  function dispatchQueued () {
    const operation = dispatches.then(async () => {
      if (!started || closing || closed) return
      const policyValue = await currentPolicy()
      let slots = Math.max(0, policyValue.maxConcurrentJobs - active.size)
      if (slots === 0) return
      const activeByPrincipal = new Map()
      for (const entry of active.values()) {
        activeByPrincipal.set(entry.principalId, (activeByPrincipal.get(entry.principalId) || 0) + 1)
      }
      for (const job of await store.listActive()) {
        if (slots === 0) break
        if (job.state !== 'queued' || !canSchedule(job)) continue
        const principalActive = activeByPrincipal.get(job.principalId) || 0
        if (principalActive >= policyValue.maxConcurrentPerRequester) continue
        if (!schedule(job)) continue
        activeByPrincipal.set(job.principalId, principalActive + 1)
        slots--
      }
    })
    dispatches = operation.catch(() => {})
    return operation
  }
  async function owned (acquisitionId, principal) {
    const job = await store.get(acquisitionId); if (!job) return null
    if (job.principalId !== normalizePrincipalId(principal)) fail('ACQUISITION_NOT_FOUND', 'acquisition not found', 404)
    return job
  }
  async function retireDeferredReplayGrant (job) {
    if (job.deferredInput !== true) return
    await sourceGrants.revoke({
      acquisitionId: job.acquisitionId,
      principal: job.principalId,
      reason: acquisitionError('SOURCE_GRANT_REPLACED', 'source grant replaced for acquisition replay', 409)
    }).catch(() => {})
  }
  async function enforcePolicy () {
    for (const job of await store.listActive()) {
      try {
        const grant = sourceGrants.inspect({ acquisitionId: job.acquisitionId, principal: job.principalId })
        const resolution = grant || await provider.resolve({ ref: job.request.resolutionRef, principalId: job.principalId })
        await policy.admit({ request: job.request, principal: principalForJob(job), adapterId: resolution.adapterId, freeDiskBytes: freeDiskBytes(), isRemote: job.isRemote === true })
      } catch {
        await manager.cancel({ acquisitionId: job.acquisitionId, principal: job.principalId })
      }
    }
  }
  function validateTransferredIdentity(sourceIdentity, expectedIdentity) {
    if (!sourceIdentity || !IDENTITY_KINDS.has(sourceIdentity.kind) ||
        typeof sourceIdentity.value !== 'string' || !/^[0-9a-f]{64}$/.test(sourceIdentity.value)) {
      fail('ACQUISITION_RESULT_INVALID', 'transferred source identity is invalid', 502)
    }
    const normalized = {
      kind: sourceIdentity.kind,
      value: sourceIdentity.kind === 'etag' ? `etag-${sourceIdentity.value}` : sourceIdentity.value
    }
    if (expectedIdentity !== null && !sameIdentity(normalized, expectedIdentity)) {
      fail('SOURCE_IDENTITY_CHANGED', 'transferred source identity changed', 502)
    }
    return normalized
  }

  async function executeAssetTransfer(acquisitionId, asset, peerId, signal, sourceIdentity, expectedBytes) {
    const transferHook = resolveTransferHook(provider)
    if (!transferHook) fail('TRANSFER_HOOK_REQUIRED', 'provider lacks required byte-transfer hook', 501)

    // .call keeps the provider as receiver without allocating a bound function.
    const transferResult = await transferHook.call(provider, { acquisitionId, asset, peerId, signal, sourceIdentity })
    const transferredBytes = transferResultByteCount(transferResult)
    if (transferredBytes !== expectedBytes) {
      fail('TRANSFERRED_BYTES_MISMATCH', 'transferred asset byte length does not match expected bytes', 502)
    }
    const importedAsset = assetDescriptor(transferResult?.descriptor ?? transferResult?.asset ?? transferResult?.core ?? asset, expectedBytes)
    return { transferredBytes, importedAsset }
  }

  function transferredAbortError () {
    return acquisitionError('ACQUISITION_CANCELLED', 'transferred import was aborted', 499)
  }
  function assertTransferredAlive (entry) {
    if (entry.controller.signal.aborted) throw transferredAbortError()
  }

  async function handleTransferredImportFailure (error, admitted, entry, job) {
    const acquisitionId = job.acquisitionId
    if (closing || entry.closing) return store.get(acquisitionId)
    const latest = await store.get(acquisitionId) || job
    if (!admitted && !entry.cancelled) throw error
    const recovered = await recoverPublishingJob(latest, acquisitionId)
    if (recovered) return recovered
    if (entry.controller.signal.aborted && !entry.cancelled) {
      // Only manager.cancel marks a user cancellation, and only shutdown marks
      // closing. An abort left over here is the caller/coordinator transport
      // lifetime ending: reject this operation, never terminalize the durable
      // job, so a later acceptTransferredResult can resume the nonterminal state.
      throw error
    }
    return handleJobError(error, latest, acquisitionId, entry)
  }

  async function runTransferredImport ({ entry, job, validatedIdentity, asset, peerId, signal }) {
    const acquisitionId = job.acquisitionId
    const forwardCallerAbort = () => entry.controller.abort()
    if (signal && !signal.aborted && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', forwardCallerAbort, { once: true })
    }
    let admitted = false
    try {
      if (signal?.aborted) entry.controller.abort()
      assertTransferredAlive(entry)
      if (job.state === 'publishing') {
        const recovered = await recoverPublishingJob(job, acquisitionId)
        if (recovered) return recovered
        const unrecovered = await terminal(job, 'failed', 'PUBLICATION_RECOVERY_REQUIRED', true)
        ledger.release(acquisitionId)
        return unrecovered
      }
      const { transferredBytes, importedAsset } = await executeAssetTransfer(
        acquisitionId, asset, peerId, entry.controller.signal, validatedIdentity, job.expectedBytes
      )
      const policyValue = await currentPolicy()
      assertTransferredAlive(entry)
      admitted = true
      if (job.state === 'queued') {
        job = await change(acquisitionId, {
          expectedVersion: job.version,
          from: 'queued',
          to: 'acquiring',
          patch: { attempts: job.attempts + 1, startedAt: job.startedAt ?? at(now) }
        })
      }
      ledger.start({ acquisitionId, policy: policyValue, counters: job })
      const transferPatch = {
        sourceBytesRead: transferredBytes,
        sourceBytesAccepted: transferredBytes,
        bytesAcquired: transferredBytes,
        stagingBytes: 0,
        verifiedPrefix: { byteLength: transferredBytes, identity: validatedIdentity }
      }
      ledger.record(acquisitionId, {
        sourceBytesRead: transferredBytes,
        sourceBytesAccepted: transferredBytes,
        stagingBytes: 0
      }, { policy: policyValue })
      job = await progress(await store.get(acquisitionId), transferPatch)
      assertTransferredAlive(entry)
      return await finalizePublication({
        job,
        asset: importedAsset,
        sourceDescription: { identity: validatedIdentity, byteLength: transferredBytes },
        sourceIdentity: validatedIdentity,
        signal: entry.controller.signal,
        policyValue
      })
    } catch (error) {
      return await handleTransferredImportFailure(error, admitted, entry, job)
    } finally {
      signal?.removeEventListener?.('abort', forwardCallerAbort)
      if (active.get(acquisitionId) === entry) active.delete(acquisitionId)
      if (!closing && !closed) dispatchQueued().catch(() => {})
    }
  }

  async function restoreLedgerUsage(current) {
    if (typeof store.listAccountingSince === 'function' && typeof ledger.restoreUsage === 'function') {
      for (const usage of await store.listAccountingSince(Math.max(0, current - DAY_MS))) {
        ledger.restoreUsage({
          at: Math.min(usage.updatedAt, current),
          bytes: usage.sourceBytesRead,
          publicRequestAt: usage.isRemote ? Math.min(usage.createdAt, current) : null,
        })
      }
    }
  }

  async function reconcileActiveJob(job, current) {
    if (job.state === 'acquiring' || job.state === 'verifying') {
      if (canSchedule(job)) {
        const outcome = await store.recover(job.acquisitionId, { expectedVersion: job.version })
        await notify(outcome.event)
        job = outcome.job
      } else {
        const outcome = await store.transition(job.acquisitionId, {
          expectedVersion: job.version,
          from: job.state,
          to: 'failed',
          patch: { errorCode: 'RESTART_INTERRUPTED', recoverable: true, finishedAt: current }
        })
        await notify(outcome.event)
        ledger.release(job.acquisitionId)
        return
      }
    } else if (job.state === 'queued' && job.deferredInput === true && !canSchedule(job)) {
      const hadStarted = (job.attempts || 0) > 0 || (job.bytesAcquired || 0) > 0 || (job.sourceBytesRead || 0) > 0 || (job.stagingBytes || 0) > 0
      if (hadStarted) {
        const outcome = await store.transition(job.acquisitionId, {
          expectedVersion: job.version,
          from: 'queued',
          to: 'failed',
          patch: { errorCode: 'SOURCE_GRANT_REQUIRED', recoverable: true, finishedAt: current }
        })
        await notify(outcome.event)
        ledger.release(job.acquisitionId)
        return
      }
    }
    ledger.restore({ acquisitionId: job.acquisitionId, principalId: job.principalId, expectedBytes: job.expectedBytes, counters: job, phase: job.state === 'publishing' ? 'active' : 'queued' })
    if (job.state === 'publishing') {
      const existing = await publisher.getPublication?.({ acquisitionId: job.acquisitionId, publisherId: job.publisherId, asset: job.verifiedAsset, resolution: job.publicationMetadata })
      if (existing) {
        const completed = await store.complete(job.acquisitionId, { expectedVersion: job.version, publication: publicationResult(existing, job.verifiedAsset.assetId) })
        await notify(completed.event)
        ledger.release(job.acquisitionId)
      } else {
        await terminal(job, 'failed', 'PUBLICATION_RECOVERY_REQUIRED', true)
        ledger.release(job.acquisitionId)
      }
    }
  }

  async function repairExhaustedJobs() {
    if (typeof store.list !== 'function' || typeof store.repairExhausted !== 'function') return
    const toRepair = []
    let cursor = null
    do {
      const failedPage = await store.list({ states: ['failed'], limit: 64, cursor })
      for (const failedJob of failedPage.items) {
        const isRateBug = failedJob.errorCode === 'ACQUISITION_RATE_BUDGET_EXCEEDED'
        const isPrefixMismatch = RESET_PREFIX_ERRORS.has(failedJob.errorCode)
        const isStagedComplete = failedJob.bytesAcquired >= failedJob.expectedBytes && failedJob.expectedBytes > 0 && !PERMANENT_ERRORS.has(failedJob.errorCode)
        if ((isRateBug || isPrefixMismatch || isStagedComplete) && !failedJob.recoverable) {
          toRepair.push({ id: failedJob.acquisitionId, version: failedJob.version })
        }
      }
      cursor = failedPage.cursor
    } while (cursor !== null)
    for (const target of toRepair) {
      const outcome = await store.repairExhausted(target.id, {
        expectedVersion: target.version
      })
      if (outcome.event) await notify(outcome.event)
    }
  }
  const manager = {
    async findRequest ({ idempotencyKey, request: input, principal } = {}) {
      assertOpen()
      const request = normalizeAcquisitionRequest(input)
      const principalId = normalizePrincipalId(principal)
      const digest = idempotencyDigestFor({ principal: principalId, publisherId: request.publisherId, idempotencyKey })
      const existing = await store.findByIdempotency(digest)
      if (!existing) return null
      if (!replayFingerprintMatches(existing, request)) {
        fail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another request')
      }
      return publicJob(existing)
    },
    async prepareRequest ({ idempotencyKey, request: input, principal, isRemote = false } = {}) {
      assertOpen(); const request = normalizeAcquisitionRequest(input); const principalId = normalizePrincipalId(principal)
      const digest = idempotencyDigestFor({ principal: principalId, publisherId: request.publisherId, idempotencyKey }); const fingerprint = fingerprintAcquisitionRequest(request)
      let existing = await store.findByIdempotency(digest)
      if (existing && !replayFingerprintMatches(existing, request)) {
        fail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another request')
      }
      if ((existing?.state === 'failed' || existing?.state === 'cancelled') && existing.deferredInput !== true) {
        const refreshed = await provider.resolve({ ref: request.resolutionRef, request, principalId })
        if (refreshed.deferredInput === true) {
          await store.forget(existing.acquisitionId)
          existing = null
        }
      }
      if (existing) {
        return { created: false, job: publicJob(existing), event: null, request }
      }
      const resolution = await provider.resolve({ ref: request.resolutionRef, request, principalId })
      const expected = expectedFacts(resolution); const admission = await policy.admit({ request, principal, adapterId: resolution.adapterId, freeDiskBytes: freeDiskBytes(), isRemote })
      const acquisitionId = acquisitionIdForRequest({ principal: principalId, idempotencyKey, request }); const createdAt = at(now)
      const job = { schemaVersion: 1, acquisitionId, state: 'queued', version: 0, principalId, publisherId: request.publisherId, requesterPublisherIds: publisherIdsForPrincipal(principal), isRemote: isRemote === true, deferredInput: resolution.deferredInput === true, idempotencyDigest: digest, requestFingerprint: fingerprint, request, retentionClass: request.retentionClass, publicationMetadata: publicationMetadata(resolution, request), expectedBytes: expected.byteLength, expectedIdentity: expected.identity, sourceBytesRead: 0, sourceBytesAccepted: 0, bytesAcquired: 0, verifiedBytes: 0, committedBytes: 0, retainedBytes: 0, stagingBytes: 0, stagingPeakBytes: 0, attempts: 0, startedAt: null, finishedAt: null, verifiedPrefix: null, verifiedAsset: null, publication: null, errorCode: null, recoverable: false, createdAt, updatedAt: createdAt }
      ledger.reserve({ acquisitionId, principalId, expectedBytes: expected.byteLength, policy: admission.policy, isRemote })
      // Persist only — no notify and no schedule until the caller binds coordination.
      const outcome = await store.createOrReplay({ idempotencyDigest: digest, requestFingerprint: fingerprint, job })
      if (!outcome.created) ledger.release(acquisitionId)
      return { created: outcome.created === true, job: publicJob(outcome.job), event: outcome.event || null, request, internalJob: outcome.job }
    },
    async commitPreparedRequest ({ prepared, isRemote = false, publishNetwork = true } = {}) {
      assertOpen()
      if (!prepared?.job?.acquisitionId) fail('ACQUISITION_REQUEST_INVALID', 'prepared request is required')
      if (prepared.created && prepared.event) await notify(prepared.event)
      if (prepared.created && publishNetwork && isRemote !== true) {
        await network?.publishRequest?.({
          acquisitionId: prepared.job.acquisitionId,
          request: {
            ...prepared.request,
            expectedBytes: prepared.job.expectedBytes,
            output: prepared.job.publicationMetadata?.mediaContext?.format
              ? { purpose: 'original', formats: [prepared.job.publicationMetadata.mediaContext.format] }
              : { purpose: 'original', formats: ['application/octet-stream'] }
          }
        })
      }
      if (prepared.created) await dispatchQueued()
      return prepared.job
    },
    async request ({ idempotencyKey, request: input, principal, isRemote = false } = {}) {
      assertOpen()
      const prepared = await manager.prepareRequest({ idempotencyKey, request: input, principal, isRemote })
      if (!prepared.created) {
        const policyValue = await currentPolicy()
        let existing = await store.get(prepared.job.acquisitionId)
        if (existing?.state === 'failed' && existing.recoverable && existing.attempts < policyValue.maxAttempts) {
          await retireDeferredReplayGrant(existing)
          const outcome = await store.retry(existing.acquisitionId, { expectedVersion: existing.version, resetVerifiedPrefix: RESET_PREFIX_ERRORS.has(existing.errorCode) }); await notify(outcome.event); existing = outcome.job
          ledger.reserve({ acquisitionId: existing.acquisitionId, principalId: existing.principalId, expectedBytes: existing.expectedBytes, policy: policyValue, isRemote, counters: RESET_PREFIX_ERRORS.has(existing.errorCode) ? {} : outcome.job })
          await dispatchQueued()
          return publicJob(existing)
        } else if (existing?.state === 'failed' && existing.recoverable) {
          const outcome = await store.exhaust(existing.acquisitionId, { expectedVersion: existing.version }); await notify(outcome.event)
          return publicJob(outcome.job)
        }
        return prepared.job
      }
      return manager.commitPreparedRequest({ prepared, isRemote, publishNetwork: true })
    },
    async dispatchQueuedJobs () {
      assertOpen()
      await dispatchQueued()
    },
    async attachGrant ({ acquisitionId, grant, principal } = {}) {
      assertOpen()
      const job = await owned(acquisitionId, principal)
      if (!job) return null
      if (job.state !== 'queued') fail('ACQUISITION_NOT_QUEUED', 'source grants can only attach to queued acquisitions')
      const policyValue = await currentPolicy()
      await policy.admit({ request: job.request, principal, adapterId: grant?.adapterId, freeDiskBytes: freeDiskBytes(), isRemote: job.isRemote === true })
      await sourceGrants.attach({ acquisitionId, grant, principal, maxTtlMs: policyValue.sourceGrantTtlMs })
      await dispatchQueued(); return publicJob(job)
    },
    async get ({ acquisitionId, principal } = {}) { return publicJob(await owned(acquisitionId, principal)) },
    async getPublicProjection ({ acquisitionId } = {}) {
      if (!acquisitionId) return null
      const job = await store.get(acquisitionId)
      if (!job) return null
      return Object.freeze({
        acquisitionId: job.acquisitionId,
        state: job.state,
        publisherId: job.publisherId ?? null,
        publicationId: job.publication?.publicationId ?? null,
        renditionId: job.publication?.renditionId ?? null,
        expectedBytes: job.expectedBytes ?? 0
      })
    },

    async acceptTransferredResult({ acquisitionId, asset, sourceIdentity, peerId = null, signal = null } = {}) {
      assertOpen()
      const job = await store.get(acquisitionId)
      if (closing || closed) fail('ACQUISITION_MANAGER_CLOSED', 'acquisition manager is closed', 503)
      if (!job) fail('ACQUISITION_NOT_FOUND', 'acquisition not found', 404)
      if (TERMINAL.has(job.state)) return publicJob(job)
      if (job.isRemote === true) fail('ACQUISITION_ROLE_INVALID', 'worker jobs cannot import transferred results', 409)
      const validatedIdentity = validateTransferredIdentity(sourceIdentity, job.expectedIdentity)
      const inFlight = active.get(acquisitionId)
      if (inFlight) {
        // Serialize a duplicate on the owner's raw durable-job promise, the same
        // contract schedule() keeps: no second import, ledger charge, CAS race,
        // swallowed rejection, or store read after the owner drained and closed.
        return inFlight.promise.then(finalized => publicJob(finalized))
      }
      const entry = { controller: new AbortController(), cancelled: false, closing: false, principalId: job.principalId, promise: null }
      active.set(acquisitionId, entry)
      entry.promise = Promise.resolve().then(() => runTransferredImport({ entry, job, validatedIdentity, asset, peerId, signal }))
      return entry.promise.then(finalized => publicJob(finalized))
    },
    async list ({ cursor = null, limit = 64, states = null, principal } = {}) { const page = await store.list({ cursor, limit, states, principalId: normalizePrincipalId(principal) }); return { items: page.items.map(publicJob), cursor: page.cursor } },
    async listActive () { return (await store.listActive()).map(publicJob) },
    async cancel ({ acquisitionId, principal } = {}) {
      assertOpen(); const job = await owned(acquisitionId, principal); if (!job || TERMINAL.has(job.state)) return publicJob(job)
      const running = active.get(acquisitionId)
      if (running) { running.cancelled = true; running.controller.abort(); await running.promise.catch(() => {}) } else { await terminal(job, 'cancelled', 'CANCELLED', false); await discard(job, acquisitionError('CANCELLED')); ledger.release(acquisitionId); await sourceGrants.revoke({ acquisitionId, principal, reason: acquisitionError('CANCELLED') }).catch(() => {}) }
      return publicJob(await store.get(acquisitionId))
    },
    async retry ({ acquisitionId, principal } = {}) {
      assertOpen()
      let job = await owned(acquisitionId, principal)
      if (!job) fail('ACQUISITION_NOT_FOUND', 'acquisition not found', 404)
      if (job.state !== 'failed') fail('ACQUISITION_NOT_FAILED', 'only failed acquisitions can be retried', 409)
      const isRateBug = job.errorCode === 'ACQUISITION_RATE_BUDGET_EXCEEDED'
      const isPrefixMismatch = RESET_PREFIX_ERRORS.has(job.errorCode)
      const isStagedComplete = job.bytesAcquired >= job.expectedBytes && job.expectedBytes > 0 && !PERMANENT_ERRORS.has(job.errorCode)
      if (!job.recoverable && (isRateBug || isPrefixMismatch || isStagedComplete) && typeof store.repairExhausted === 'function') {
        const repaired = await store.repairExhausted(job.acquisitionId, { expectedVersion: job.version })
        job = repaired.job
      }
      if (!job.recoverable) fail('ACQUISITION_NOT_RECOVERABLE', 'acquisition failure is not recoverable', 409)
      const policyValue = await currentPolicy()
      if (job.attempts >= policyValue.maxAttempts) {
        const outcome = await store.exhaust(job.acquisitionId, { expectedVersion: job.version })
        await notify(outcome.event)
        fail('ACQUISITION_RETRY_LIMIT_EXCEEDED', 'acquisition retry limit reached', 409)
      }
      const outcome = await store.retry(job.acquisitionId, {
        expectedVersion: job.version,
        resetVerifiedPrefix: RESET_PREFIX_ERRORS.has(job.errorCode)
      })
      await notify(outcome.event)
      ledger.reserve({
        acquisitionId: job.acquisitionId,
        principalId: job.principalId,
        expectedBytes: job.expectedBytes,
        policy: policyValue,
        isRemote: job.isRemote === true,
        counters: RESET_PREFIX_ERRORS.has(job.errorCode) ? {} : outcome.job
      })
      await dispatchQueued()
      return publicJob(outcome.job)
    },
    // Clearing a finished attempt is the operator's call, so it is owner-checked
    // like every other mutation and refuses anything still running.
    async forget ({ acquisitionId, principal } = {}) {
      assertOpen(); const job = await owned(acquisitionId, principal)
      if (!job) return { forgotten: false, acquisitionId, state: null }
      const result = await store.forget(acquisitionId)
      return { forgotten: result.forgotten === true, acquisitionId, state: result.state }
    },
    acceptRemoteRequest (input = {}) { return this.prepareRequest({ ...input, isRemote: true }) },
    async acceptOffer ({ acquisitionId, offer, principal } = {}) { const job = await owned(acquisitionId, principal); if (!job || TERMINAL.has(job.state)) return publicJob(job); await network?.assign?.({ acquisitionId, offer }); await dispatchQueued(); return publicJob(job) },
    async migrateLegacyIngest ({ legacyStore, legacyPrincipalId = 'local', legacyPublisherId = 'local', now: migrationNow = now } = {}) { return migrateLegacy({ legacyStore, acquisitionStore: store, legacyPrincipalId, legacyPublisherId, now: migrationNow }) },
    subscribe (listener) {
      if (typeof listener !== 'function') throw new TypeError('acquisition listener must be a function')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async start () {
      assertOpen()
      if (started) return this
      await store.ready?.()
      const current = at(now)
      await restoreLedgerUsage(current)
      started = true
      for (const job of await store.listActive()) {
        await reconcileActiveJob(job, current)
      }
      await repairExhaustedJobs()
      await dispatchQueued()
      unsubscribePolicy = policy.subscribe?.(() => { enforcePolicy().catch(() => {}) }) || null
      return this
    },
    async close () {
      if (closed) return; closing = true; unsubscribePolicy?.(); unsubscribePolicy = null; listeners.clear()
      for (const entry of active.values()) { entry.closing = true; entry.controller.abort() }
      await Promise.all([...active.values()].map(entry => entry.promise.catch(() => {}))); await dispatches; await mutations; await sourceGrants.close?.(); await store.close?.(); started = false; closed = true
    }
  }
  return Object.freeze(manager)
}
