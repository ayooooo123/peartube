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
  normalizePublicMediaContext,
  normalizePublicTitle,
  PUBLICATION_MEDIA_FIELDS,
  projectAcquisitionJob
} from './contract.js'
import { createAcquisitionAdmissionLedger } from './accounting.js'
import { migrateLegacyIngest as migrateLegacy } from './store.js'

const TERMINAL = new Set(TERMINAL_ACQUISITION_STATES)
const RESET_PREFIX_ERRORS = new Set(['SOURCE_IDENTITY_CHANGED', 'SOURCE_LENGTH_MISMATCH', 'HASH_MISMATCH', 'VERIFICATION_FAILED'])
const PERMANENT_ERRORS = new Set([...RESET_PREFIX_ERRORS, 'PUBLISHER_AUTHORITY_LOST', 'ASSET_INVALID'])
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
  const output = { title: null, sourceFileName: null, mediaContext: null }
  if (typeof value?.title === 'string' && value.title && b4a.byteLength(value.title) <= 512) {
    output.title = normalizePublicTitle(value.title, 'ACQUISITION_SECRET_REJECTED')
  }
  // The name the source gave the file. Two versions of one work are told apart
  // by this and by their byte length, so it is kept verbatim rather than
  // regenerated from a title.
  const rawFileName = value?.sourceFileName || request?.sourceFileName || null
  if (typeof rawFileName === 'string' && /^[^/\\]{1,255}$/.test(rawFileName)) {
    output.sourceFileName = rawFileName
  }
  if (value?.mediaContext && typeof value.mediaContext === 'object' && !Array.isArray(value.mediaContext)) {
    const context = {}
    for (const [key, entry] of Object.entries(value.mediaContext)) {
      if (!PUBLICATION_MEDIA_FIELDS.has(key)) continue
      if (typeof entry === 'string' && entry && b4a.byteLength(entry) <= 512) context[key] = entry
      else if (Number.isSafeInteger(entry) && entry >= 0) context[key] = entry
    }
    if (Object.keys(context).length > 0) {
      output.mediaContext = normalizePublicMediaContext(context, 'ACQUISITION_SECRET_REJECTED')
    }
  }
  return output
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
    if (event.type === 'acquisition.completed') await network.result?.(event)
    else if (event.type === 'acquisition.cancelled') await network.cancel?.(event)
    else await network.progress?.(event)
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
  async function runJob (id, entry) {
    let job = await store.get(id)
    let reader = null
    try {
      if (!job || job.state !== 'queued') return job
      const policyValue = await currentPolicy()
      const isStagedComplete = job.bytesAcquired >= job.expectedBytes && job.expectedBytes > 0
      const grant = sourceGrants.inspect({ acquisitionId: job.acquisitionId, principal: job.principalId })
      let resolution = grant || (job.request?.resolutionRef ? await provider.resolve({ ref: job.request.resolutionRef, request: job.request, principalId: job.principalId }).catch(() => null) : null)
      if (!resolution && isStagedComplete) {
        resolution = { adapterId: job.deferredInput ? 'companion-callback' : 'local-file' }
      }
      const adapterId = resolution?.adapterId ?? null
      if (adapterId === null) fail('ACQUISITION_ADAPTER_DENIED', 'the resolved source names no adapter, so no allowlist can admit it', 403)
      await policy.admit({
        request: job.request,
        principal: principalForJob(job),
        adapterId,
        freeDiskBytes: freeDiskBytes(),
        isRemote: job.isRemote === true
      })
      ledger.start({ acquisitionId: id, policy: policyValue })
      await assertAuthority(job)
      job = await change(id, { expectedVersion: job.version, from: 'queued', to: 'acquiring', patch: { attempts: job.attempts + 1, startedAt: job.startedAt ?? at(now) } })
      const sourceExpensive = sourceGrants.has({ acquisitionId: job.acquisitionId, principal: job.principalId })
      if (!grant && isStagedComplete) {
        reader = {
          resumable: true,
          async describe () { return { byteLength: job.expectedBytes, identity: job.expectedIdentity || { kind: 'etag', value: 'staged-complete' } } },
          async * open () {},
          async close () {}
        }
      } else {
        reader = await resolveReader(job, entry.controller.signal, policyValue)
      }
      const description = await reader.describe({ signal: entry.controller.signal })
      if (description.byteLength !== job.expectedBytes) fail('SOURCE_LENGTH_MISMATCH', 'source length changed')
      const describedIdentity = (!grant && isStagedComplete && job.expectedIdentity)
        ? job.expectedIdentity
        : durableSourceIdentity(description.identity)
      if (job.expectedIdentity !== null && !sameIdentity(describedIdentity, job.expectedIdentity)) fail('SOURCE_IDENTITY_CHANGED', 'source identity changed')
      if (job.expectedIdentity === null) job = await progress(job, { expectedIdentity: describedIdentity })
      const resume = job.verifiedPrefix && reader.resumable && (sameIdentity(job.verifiedPrefix.identity, describedIdentity) || isStagedComplete)
        ? { ...job.verifiedPrefix, identity: describedIdentity }
        : null
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
      job = await change(id, { expectedVersion: job.version, from: 'acquiring', to: 'verifying' })
      const verification = await provider.verify({ acquisitionId: id, request: job.request, asset, expected: { byteLength: job.expectedBytes, identity: job.expectedIdentity }, signal: entry.controller.signal })
      const verified = verification === true || (verification?.verified === true && verification.byteLength === job.expectedBytes)
      if (!verified) fail('VERIFICATION_FAILED', 'static asset failed exact verification', 502)
      ledger.record(id, { verifiedBytes: bytes }, { policy: policyValue })
      await assertAuthority(job)
      job = await change(id, { expectedVersion: job.version, from: 'verifying', to: 'publishing', patch: { verifiedBytes: bytes, verifiedAsset: asset } })
      await assertAuthority(job)
      const publication = publicationResult(await publisher.publish({ acquisitionId: id, request: job.request, asset, source: description, resolution: job.publicationMetadata, principalId: job.principalId, signal: entry.controller.signal }), asset.assetId)
      ledger.record(id, { committedBytes: bytes, retainedBytes: bytes, stagingBytes: 0 }, { policy: policyValue }); ledger.commit(id)
      const completed = await store.complete(id, { expectedVersion: job.version, publication }); await notify(completed.event); ledger.release(id)
      await sourceGrants.revoke({ acquisitionId: id, principal: job.principalId, reason: acquisitionError('SOURCE_GRANT_CONSUMED', 'source grant consumed') }).catch(() => {})
      return completed.job
    } catch (error) {
      if (closing || entry.closing) return store.get(id)
      const latest = await store.get(id) || job
      if (entry.cancelled) {
        const cancelled = await terminal(latest, 'cancelled', 'CANCELLED', false); await discard(cancelled, error); ledger.release(id); await sourceGrants.revoke({ acquisitionId: id, principal: latest.principalId, reason: error }).catch(() => {}); return cancelled
      }
      const code = errorCode(error, latest?.state)
      const recoverable = error?.recoverable !== false && !PERMANENT_ERRORS.has(code)
      const failed = await terminal(latest, 'failed', code, recoverable)
      if (!recoverable || RESET_PREFIX_ERRORS.has(code)) { await discard(failed, error); await sourceGrants.revoke({ acquisitionId: id, principal: latest.principalId, reason: error }).catch(() => {}) }
      ledger.release(id)
      return failed
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
    async request ({ idempotencyKey, request: input, principal, isRemote = false } = {}) {
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
        const policyValue = await currentPolicy()
        if (existing.state === 'failed' && existing.recoverable && existing.attempts < policyValue.maxAttempts) {
          const outcome = await store.retry(existing.acquisitionId, { expectedVersion: existing.version, resetVerifiedPrefix: RESET_PREFIX_ERRORS.has(existing.errorCode) }); await notify(outcome.event); existing = outcome.job
          ledger.reserve({ acquisitionId: existing.acquisitionId, principalId, expectedBytes: existing.expectedBytes, policy: policyValue, isRemote }); await dispatchQueued()
        } else if (existing.state === 'failed' && existing.recoverable) {
          const outcome = await store.exhaust(existing.acquisitionId, { expectedVersion: existing.version }); await notify(outcome.event); existing = outcome.job
        }
        return publicJob(existing)
      }
      const resolution = await provider.resolve({ ref: request.resolutionRef, request, principalId })
      const expected = expectedFacts(resolution); const admission = await policy.admit({ request, principal, adapterId: resolution.adapterId, freeDiskBytes: freeDiskBytes(), isRemote })
      const acquisitionId = acquisitionIdForRequest({ principal: principalId, idempotencyKey, request }); const createdAt = at(now)
      const job = { schemaVersion: 1, acquisitionId, state: 'queued', version: 0, principalId, publisherId: request.publisherId, requesterPublisherIds: publisherIdsForPrincipal(principal), isRemote: isRemote === true, deferredInput: resolution.deferredInput === true, idempotencyDigest: digest, requestFingerprint: fingerprint, request, retentionClass: request.retentionClass, publicationMetadata: publicationMetadata(resolution, request), expectedBytes: expected.byteLength, expectedIdentity: expected.identity, sourceBytesRead: 0, sourceBytesAccepted: 0, bytesAcquired: 0, verifiedBytes: 0, committedBytes: 0, retainedBytes: 0, stagingBytes: 0, stagingPeakBytes: 0, attempts: 0, startedAt: null, finishedAt: null, verifiedPrefix: null, verifiedAsset: null, publication: null, errorCode: null, recoverable: false, createdAt, updatedAt: createdAt }
      ledger.reserve({ acquisitionId, principalId, expectedBytes: expected.byteLength, policy: admission.policy, isRemote })
      const outcome = await store.createOrReplay({ idempotencyDigest: digest, requestFingerprint: fingerprint, job }); await notify(outcome.event)
      if (outcome.created) { await network?.publishRequest?.({ acquisitionId, request }); await dispatchQueued() }
      else ledger.release(acquisitionId)
      return publicJob(outcome.job)
    },
    async attachGrant ({ acquisitionId, grant, principal } = {}) {
      assertOpen()
      const job = await owned(acquisitionId, principal)
      if (!job) return null
      if (job.state !== 'queued') fail('ACQUISITION_NOT_QUEUED', 'source grants can only attach to queued acquisitions')
      const policyValue = await currentPolicy(); const attached = await sourceGrants.attach({ acquisitionId, grant, principal, maxTtlMs: policyValue.sourceGrantTtlMs })
      await policy.admit({ request: job.request, principal, adapterId: attached.adapterId, freeDiskBytes: freeDiskBytes(), isRemote: job.isRemote === true })
      await dispatchQueued(); return publicJob(job)
    },
    async get ({ acquisitionId, principal } = {}) { return publicJob(await owned(acquisitionId, principal)) },
    async list ({ cursor = null, limit = 64, states = null, principal } = {}) { const page = await store.list({ cursor, limit, states, principalId: normalizePrincipalId(principal) }); return { items: page.items.map(publicJob), cursor: page.cursor } },
    async listActive () { return (await store.listActive()).map(publicJob) },
    async cancel ({ acquisitionId, principal } = {}) {
      assertOpen(); const job = await owned(acquisitionId, principal); if (!job || TERMINAL.has(job.state)) return publicJob(job)
      const running = active.get(acquisitionId)
      if (running) { running.cancelled = true; running.controller.abort(); await running.promise.catch(() => {}) } else { await terminal(job, 'cancelled', 'CANCELLED', false); await discard(job, acquisitionError('CANCELLED')); ledger.release(acquisitionId); await sourceGrants.revoke({ acquisitionId, principal, reason: acquisitionError('CANCELLED') }).catch(() => {}) }
      return publicJob(await store.get(acquisitionId))
    },
    // Clearing a finished attempt is the operator's call, so it is owner-checked
    // like every other mutation and refuses anything still running.
    async forget ({ acquisitionId, principal } = {}) {
      assertOpen(); const job = await owned(acquisitionId, principal)
      if (!job) return { forgotten: false, acquisitionId, state: null }
      const result = await store.forget(acquisitionId)
      return { forgotten: result.forgotten === true, acquisitionId, state: result.state }
    },
    acceptRemoteRequest (input = {}) { return this.request({ ...input, isRemote: true }) },
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
      if (typeof store.listAccountingSince === 'function' && typeof ledger.restoreUsage === 'function') {
        for (const usage of await store.listAccountingSince(Math.max(0, current - DAY_MS))) {
          ledger.restoreUsage({
            at: Math.min(usage.updatedAt, current),
            bytes: usage.sourceBytesRead,
            publicRequestAt: usage.isRemote ? Math.min(usage.createdAt, current) : null,
          })
        }
      }
      started = true
      for (let job of await store.listActive()) {
        if (job.state === 'acquiring' || job.state === 'verifying') { const outcome = await store.recover(job.acquisitionId, { expectedVersion: job.version }); await notify(outcome.event); job = outcome.job }
        ledger.restore({ acquisitionId: job.acquisitionId, principalId: job.principalId, expectedBytes: job.expectedBytes, counters: job, phase: job.state === 'publishing' ? 'active' : 'queued' })
        if (job.state === 'publishing') {
          const existing = await publisher.getPublication?.({ acquisitionId: job.acquisitionId, publisherId: job.publisherId, asset: job.verifiedAsset, resolution: job.publicationMetadata })
          if (existing) {
            const completed = await store.complete(job.acquisitionId, { expectedVersion: job.version, publication: publicationResult(existing, job.verifiedAsset.assetId) }); await notify(completed.event); ledger.release(job.acquisitionId)
          } else {
            await terminal(job, 'failed', 'PUBLICATION_RECOVERY_REQUIRED', true)
            ledger.release(job.acquisitionId)
          }
        }
      }
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
