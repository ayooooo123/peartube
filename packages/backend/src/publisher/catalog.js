import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  prepareSignedEnvelope,
  attachSignedEnvelopeSignature,
  signedRecordSignaturePreimage
} from '../records/index.js'
import { assertBytes, isBytes, equalBytes } from '../records/canonical.js'
import {
  PUBLISHER_LIMITS,
  PUBLISHER_RECORD_TYPES,
  decodePublisherOperationBody,
  encodePublisherOperationBody,
  requiredPublisherCapability
} from './canonical.js'
import {
  PUBLISHER_CATALOG_LEGACY_COMPATIBILITY,
  decodePublisherNamespaceDescriptor
} from './namespace.js'
import { createPublisherKeyProvider } from './key-provider.js'
import {
  applyPublisherCatalogNodes,
  decodePublisherCatalogFrame,
  encodePublisherCatalogFrame,
  getLatestPublisherAnnouncement,
  getPublisherProjection,
  getPublisherOperationReceipt,
  getPublisherAuthorizationState,
  getPublisherRootOperationAuthorization,
  getPublisherRootTransitionAuthorization,
  getPublisherViewHead,
  getPublisherViewSnapshot,
  listPublisherProjections,
  listPublisherRejections,
  listPublisherAcceptedPage,
  openPublisherCatalogView
} from './catalog-view.js'

function invalid (message) {
  throw new Error(`Invalid publisher catalog: ${message}`)
}

function normalizeBootstrapKey (value) {
  if (value === undefined || value === null) return null
  const key = typeof value === 'string' ? b4a.from(value, 'hex') : value
  if (!isBytes(key) || key.byteLength !== 32) invalid('catalog bootstrap key must be exactly 32 bytes')
  if (typeof value === 'string' && (value.length !== 64 || b4a.toString(key, 'hex') !== value.toLowerCase())) invalid('catalog bootstrap key hex is noncanonical')
  return b4a.from(key)
}

function normalizeDeviceSigner (value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object') invalid('deviceSigner must be an object')
  if (!isBytes(value.signerKey) || value.signerKey.byteLength !== 32) invalid('deviceSigner signerKey must be exactly 32 bytes')
  if (typeof value.sign !== 'function') invalid('deviceSigner must expose sign(preimage)')
  const signerKey = b4a.from(value.signerKey)
  const sign = value.sign.bind(value)
  return Object.freeze({
    signerKey,
    async sign (preimage) {
      const signature = await sign(b4a.from(preimage))
      assertBytes(signature, 64, 'device signature')
      return b4a.from(signature)
    }
  })
}

function validateOptions (store, options) {
  if (!store || typeof store !== 'object') invalid('Corestore is required')
  const allowed = ['key', 'publisherId', 'namespace', 'ownsStore', 'keyProvider', 'deviceSigner', 'ackInterval', 'journalLimit']
  for (const field of Object.keys(options)) if (!allowed.includes(field)) invalid(`unknown option ${field}`)
  const key = normalizeBootstrapKey(options.key)
  if (!isBytes(options.publisherId) || options.publisherId.byteLength !== 32) invalid('publisherId must be exactly 32 bytes')
  const publisherId = b4a.from(options.publisherId)
  const deviceSigner = normalizeDeviceSigner(options.deviceSigner)
  const namespace = options.namespace ?? 'peartube-publisher'
  if (typeof namespace !== 'string' || namespace.length === 0 || b4a.byteLength(namespace) > 128) invalid('namespace is out of bounds')
  if (options.ownsStore !== undefined && typeof options.ownsStore !== 'boolean') invalid('ownsStore must be boolean')
  const ackInterval = options.ackInterval ?? 1_000
  if (!Number.isSafeInteger(ackInterval) || ackInterval < 0 || ackInterval > 60_000) invalid('ackInterval is out of bounds')
  const journalLimit = options.journalLimit ?? PUBLISHER_LIMITS.maxJournalOperations
  if (!Number.isSafeInteger(journalLimit) || journalLimit < 1 || journalLimit > PUBLISHER_LIMITS.maxJournalOperations) invalid('journalLimit is out of bounds')
  if (options.keyProvider !== undefined && (!options.keyProvider || typeof options.keyProvider.verifySignature !== 'function' || typeof options.keyProvider.verifySignedEnvelope !== 'function' || typeof options.keyProvider.verifyMultiSignedEnvelope !== 'function')) invalid('keyProvider must expose verifySignature and publisher verification methods')
  return { key, publisherId, namespace, ownsStore: options.ownsStore === true, ackInterval, journalLimit, keyProvider: options.keyProvider || createPublisherKeyProvider(), deviceSigner }
}

// Replay order for a rebuilt catalog. The producer appended its namespace, then
// its writer admissions, then data, and its journal positions follow that order.
// comparePublisherOperationEntries cannot be reused here: it exists to resolve
// conflicts and does not treat the namespace as a root record, so it replays an
// admission ahead of the namespace and lands both at swapped journal positions,
// which is enough to make the rebuilt head digest disagree with the advertised
// one even though every operation was accepted.
const REPLAY_ROOT_TYPES = new Set([
  PUBLISHER_RECORD_TYPES.NAMESPACE,
  PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
  PUBLISHER_RECORD_TYPES.WRITER_REVOCATION,
  PUBLISHER_RECORD_TYPES.ROOT_TRANSITION
])

function compareReplayOrder (left, right) {
  const leftRoot = REPLAY_ROOT_TYPES.has(left.operation.recordType)
  const rightRoot = REPLAY_ROOT_TYPES.has(right.operation.recordType)
  if (leftRoot !== rightRoot) return leftRoot ? -1 : 1
  if (left.operation.policyEpoch !== right.operation.policyEpoch) {
    return left.operation.policyEpoch - right.operation.policyEpoch
  }
  if (left.operation.issuerSequence !== right.operation.issuerSequence) {
    return left.operation.issuerSequence - right.operation.issuerSequence
  }
  return b4a.compare(left.operationId, right.operationId)
}

// A follower's catalog is rebuilt from verified accepted pages, so it must not
// be held hostage by an Autobase that can only open once a peer replicates.
const REMOTE_CATALOG_OPEN_TIMEOUT_MS = 5000
const PUBLISHER_ID_USER_DATA_KEY = 'peartube/publisher-id'

async function raceOpenBudget (promise, timeoutMs) {
  let timer = null
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class PublisherCatalog extends ReadyResource {
  constructor (store, options = {}) {
    const normalized = validateOptions(store, options)
    super()
    this.options = normalized
    this.rootStore = store
    this.ownsStore = normalized.ownsStore
    this.store = typeof store.namespace === 'function' ? store.namespace(normalized.namespace) : store
    this.ownsScopedStore = this.store !== store
    this.base = null
    this.verifiedPageView = null
    this.baseUpdating = null
    this.baseReady = false
    this.publisherPinned = false
    this.ready().catch(() => {})
  }

  async _open () {
    const keyProvider = this.options.keyProvider
    this.base = new Autobase(this.store, this.options.key, {
      valueEncoding: 'binary',
      ackInterval: this.options.ackInterval,
      optimistic: true,
      open: openPublisherCatalogView,
      apply: (nodes, view, host) => applyPublisherCatalogNodes(nodes, view, host, { keyProvider, publisherId: this.options.publisherId, journalLimit: this.options.journalLimit })
    })


    const pinnedPublisherId = await this.base.getUserData(PUBLISHER_ID_USER_DATA_KEY).catch(() => null)
    if (pinnedPublisherId && !equalBytes(pinnedPublisherId, this.options.publisherId)) {
      const base = this.base
      this.base = null
      try {
        await base.close()
      } finally {
        invalid('persisted publisherId does not match expected publisherId')
      }
    }
    // A follower opens this from a publisher's bootstrap key with no local
    // history, so the Autobase cannot become ready until that core's first
    // block replicates - and the scope that would replicate it is only joined
    // after this call returns. Awaiting unconditionally deadlocks the first
    // follow of every publisher, which is the whole of discovery.
    //
    // A follower does not need the base: its catalog is rebuilt locally from
    // verified accepted pages. So bound the wait, and when it lapses continue
    // with the page path while the base catches up on its own.
    const readyWithinBudget = this.options.key
      ? await raceOpenBudget(this.base.ready(), REMOTE_CATALOG_OPEN_TIMEOUT_MS)
      : (await this.base.ready(), true)
    this.baseReady = readyWithinBudget

    if (readyWithinBudget && this.base?.view) {
      await raceOpenBudget(this.base.update(), 1_000).catch(() => {})
      await raceOpenBudget(this.base.view.ready?.() || Promise.resolve(), 1000).catch(() => {})
      const descriptorEntry = await raceOpenBudget(this.base.view.get('state/descriptor'), 1000).catch(() => null)
      const journalCountEntry = await raceOpenBudget(this.base.view.get('meta/journal-count'), 1000).catch(() => null)
      let pinError = null
      if (descriptorEntry?.value) {
        const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value, { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY })
        if (!equalBytes(descriptor.publisherId, this.options.publisherId)) pinError = 'persisted descriptor publisherId does not match expected publisherId'
      } else if (journalCountEntry?.value && b4a.toString(journalCountEntry.value) !== '0') {
        pinError = 'persisted catalog history has no descriptor matching expected publisherId'
      }
      if (pinError) {
        const base = this.base
        this.base = null
        try {
          await base.close()
        } finally {
          invalid(pinError)
        }
      }
    }
    // Pin writable local catalogs outside the derived view. A wrong expected
    // publisher can otherwise rebuild that view first and erase the descriptor
    // needed to detect the mismatch.
    if (!pinnedPublisherId) {
      await this.base.setUserData(PUBLISHER_ID_USER_DATA_KEY, this.options.publisherId).catch(() => {})
    }
    // Nothing is pinned against yet when a remote base never opened: there is
    // no persisted history to contradict the expected publisher, and every
    // accepted page ingested later is verified against it.
    this.publisherPinned = true
  }

  get key () {
    return this.base?.key || null
  }

  get keyHex () {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey () {
    return this.base?.discoveryKey || null
  }

  get localWriterKey () {
    return this.base?.local?.key || null
  }

  get localSignerKey () {
    return this.options.deviceSigner ? b4a.from(this.options.deviceSigner.signerKey) : null
  }

  get writable () {
    return Boolean(this.base?.writable)
  }

  get view () {
    return this.publisherPinned ? this.verifiedPageView || this.base?.view || null : null
  }

  async update () {
    await this.ready()
    if (!this.base) return
    // A follower reads through the view it rebuilt from verified accepted
    // pages. Its Autobase is opened from the publisher's bootstrap key and may
    // never become ready, so `base.update()` can block indefinitely. Awaiting it
    // here made every local read - including the head check that completes a
    // sync, and every projection scan afterwards - wait on a remote core that
    // owes this catalog nothing. Advance the base in the background instead and
    // answer from the view that is already local and already verified.
    if (this.verifiedPageView || !this.baseReady) {
      if (!this.baseUpdating) {
        this.baseUpdating = Promise.resolve()
          .then(() => this.base?.update())
          .catch(() => {})
          .finally(() => { this.baseUpdating = null })
      }
      return
    }
    await raceOpenBudget(this.base.update(), 1000).catch(() => {})
  }

  async waitForWritable (timeout = 20_000) {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 120_000) invalid('writable timeout is out of bounds')
    if (this.writable) return true
    const started = Date.now()
    while (Date.now() - started < timeout) {
      await this.update().catch(() => {})
      if (this.writable) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return this.writable
  }

  async append (value, { allowAuthorityBootstrap = false } = {}) {
    await this.ready()
    const frame = isBytes(value) ? value : encodePublisherCatalogFrame(value)
    if (frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('operation frame exceeds its byte limit')
    const decoded = decodePublisherCatalogFrame(frame)
    const canonical = encodePublisherCatalogFrame(decoded)
    if (!b4a.equals(canonical, frame)) invalid('operation frame is noncanonical')
    const recordType = decoded.recordType || decoded.operation?.recordType
    const isRootRecord = REPLAY_ROOT_TYPES.has(recordType)
    if (!this.writable && (!allowAuthorityBootstrap || !isRootRecord)) {
      invalid('local device is not an admitted Autobase writer')
    }
    const optimistic = allowAuthorityBootstrap && isRootRecord && !this.writable
    await this.base.append(frame, optimistic ? { optimistic: true } : undefined)
    await this.base.update()
    return decoded.recordId || decoded.transitionId
  }

  async appendAndConfirm (value, options = {}) {
    const operationId = await this.append(value, options)
    const receipt = await getPublisherOperationReceipt(this.view, operationId)
    return { operationId: b4a.from(operationId), ...receipt }
  }

  async appendBatchAndConfirm (values) {
    await this.ready()
    if (!this.writable) invalid('local device is not an admitted Autobase writer')
    if (!Array.isArray(values) || values.length < 1 || values.length > PUBLISHER_LIMITS.maxApplyBatch) {
      invalid('operation batch is out of bounds')
    }
    const frames = []
    const operationIds = []
    for (const value of values) {
      const frame = isBytes(value) ? b4a.from(value) : encodePublisherCatalogFrame(value)
      if (frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('operation frame exceeds its byte limit')
      const decoded = decodePublisherCatalogFrame(frame)
      const canonical = encodePublisherCatalogFrame(decoded)
      if (!b4a.equals(canonical, frame)) invalid('operation frame is noncanonical')
      frames.push(frame)
      operationIds.push(decoded.recordId || decoded.transitionId)
    }
    await this.base.append(frames)
    await this.base.update()
    return await Promise.all(operationIds.map(async operationId => ({
      operationId: b4a.from(operationId),
      ...await getPublisherOperationReceipt(this.view, operationId),
    })))
  }

  async createLocalOperation ({ recordType, policyEpoch, sequence, signedAt, expiresAt, body } = {}) {
    await this.ready()
    const canonicalBody = encodePublisherOperationBody(recordType, body)
    const decodedBody = decodePublisherOperationBody(recordType, canonicalBody)
    if (!requiredPublisherCapability(recordType, decodedBody)) invalid('local device signing is limited to ordinary typed writer operations')
    if (!this.options.deviceSigner) invalid('local device signing requires an injected deviceSigner')
    const descriptorEntry = await this.view.get('state/descriptor')
    if (!descriptorEntry) invalid('publisher namespace genesis is not initialized')
    const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value, { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY })
    assertBytes(this.localWriterKey, 32, 'local writer key')
    assertBytes(this.localSignerKey, 32, 'local signer key')
    const prepared = prepareSignedEnvelope({
      recordType,
      schemaMajor: 1,
      schemaMinor: 0,
      issuerIdentityKey: descriptor.publisherId,
      signerKey: this.localSignerKey,
      policyEpoch,
      issuerSequence: sequence,
      signedAt,
      expiresAt,
      canonicalBody
    }, { hash: this.options.keyProvider.hash || crypto.hash })
    const signature = await this.options.deviceSigner.sign(signedRecordSignaturePreimage(prepared))
    return attachSignedEnvelopeSignature(prepared, signature)
  }

  async getProjection (kind, identifier) {
    await this.update()
    return getPublisherProjection(this.view, kind, identifier)
  }

  async getAuthorizationState () {
    await this.update()
    if (!this.view) return null
    return getPublisherAuthorizationState(this.view)
  }
  async getNamespaceDescriptor () {
    await this.ready()
    // A followed catalog may have no live Autobase peer after restart, while
    // its verified page view is already local and complete. Use the base when
    // it opened from local history; otherwise open the persisted page view so
    // descriptor reads never wait on a remote core.
    if (!this.baseReady && !this.verifiedPageView) await this.openVerifiedPageView()
    await this.update()
    const descriptor = await this.view?.get('state/descriptor')
    return descriptor
      ? decodePublisherNamespaceDescriptor(descriptor.value, { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY })
      : null
  }


  async listProjections (kind, options) {
    await this.update()
    return listPublisherProjections(this.view, kind, options)
  }

  async listAcceptedPage (options) {
    await this.update()
    return listPublisherAcceptedPage(this.view, options)
  }

  async openVerifiedPageView () {
    await this.ready()
    if (!this.verifiedPageView) {
      const publisherHex = b4a.toString(this.options.publisherId, 'hex')
      this.verifiedPageView = openPublisherCatalogView({
        get: () => this.store.get({ name: `verified-page-view-${publisherHex}` })
      })
      await this.verifiedPageView.ready()
    }
    return this.verifiedPageView
  }

  async ingestAcceptedPage (entries) {
    await this.ready()
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128) {
      invalid('accepted page batch is out of bounds')
    }
    let prior = null
    const nodes = entries.map(entry => {
      if (!entry || typeof entry.operationId !== 'string' || !/^[0-9a-f]{64}$/.test(entry.operationId)) {
        invalid('accepted page operationId is invalid')
      }
      assertBytes(entry.sourceWriterKey, 32, 'accepted page sourceWriterKey')
      if (!isBytes(entry.frame)) invalid('accepted page frame must be bytes')
      const frame = b4a.from(entry.frame)
      if (frame.byteLength < 1 || frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('accepted page frame is out of bounds')
      const operation = decodePublisherCatalogFrame(frame)
      if (!b4a.equals(encodePublisherCatalogFrame(operation), frame)) invalid('accepted page frame is noncanonical')
      const operationId = b4a.toString(operation.recordId || operation.transitionId, 'hex')
      if (operationId !== entry.operationId || (prior !== null && operationId <= prior)) {
        invalid('accepted page operation ordering or identity is invalid')
      }
      prior = operationId
      return {
        node: { value: frame, from: { key: b4a.from(entry.sourceWriterKey) } },
        operation,
        operationId: b4a.from(operationId, 'hex')
      }
    })
    await this.openVerifiedPageView()
    // The wire order is operation-id ascending, which is a hash order and says
    // nothing about causality. applyPublisherCatalogNodes replays nodes exactly
    // as given, so a claim whose id sorts below the writer-admission that
    // authorizes it gets reduced first and rejected WRITER_NOT_ADMITTED, which
    // then voids the entire page. Replay in the same causal order the producer
    // reduced them in: root records first, then by policy epoch and issuer
    // sequence. The transmitted order is untouched, so page verification and
    // deduplication are unaffected.
    const ordered = [...nodes].sort(compareReplayOrder).map(entry => entry.node)
    const rebuilt = await applyPublisherCatalogNodes(ordered, this.verifiedPageView, {
      key: this.base?.key || this.options.key,
      async addWriter () {},
      removeable () { return false },
      async removeWriter () {},
    }, {
      keyProvider: this.options.keyProvider,
      publisherId: this.options.publisherId,
      journalLimit: this.options.journalLimit,
    })
    if (rebuilt.rejected.length > 0) {
      // The consumer aborts the whole page on any rejection, so without the
      // per-operation code an empty catalog is indistinguishable from a
      // transport failure.
      console.log('[PublisherCatalog] accepted page rejected', rebuilt.rejected.length, 'of', entries.length,
        rebuilt.rejected.slice(0, 4).map(candidate => `${candidate?.code || 'UNKNOWN'}:${candidate?.reason || candidate?.value?.recordType || ''}`).join(' | '))
    }
    const acceptedCount = entries.filter(entry => rebuilt.accepted.some(candidate =>
      b4a.toString(candidate.value.recordId || candidate.value.transitionId, 'hex') === entry.operationId
    )).length
    if (acceptedCount !== entries.length && rebuilt.rejected.length === 0) {
      // Operations can also be dropped without being rejected: a page whose
      // namespace genesis or writer admission sits in a different page applies
      // nothing at all. Without this the consumer reports the page inadmissible
      // with no per-operation code and an empty catalog looks like a transport
      // fault rather than a causally incomplete page.
      console.log('[PublisherCatalog] accepted page applied nothing', acceptedCount, 'of', entries.length,
        'types:', entries.map(entry => decodePublisherCatalogFrame(entry.frame).recordType).join(','))
    }
    return {
      accepted: acceptedCount,
      rejected: entries.filter(entry => rebuilt.rejected.some(candidate =>
        b4a.toString(candidate.value.recordId || candidate.value.transitionId, 'hex') === entry.operationId
      )).length,
    }
  }

  async getOperationReceipt (operationId) {
    await this.update()
    return getPublisherOperationReceipt(this.view, operationId)
  }

  async getRootOperationAuthorization (options) {
    await this.update()
    return getPublisherRootOperationAuthorization(this.view, options)
  }

  async getRootTransitionAuthorization (options) {
    await this.update()
    return getPublisherRootTransitionAuthorization(this.view, options)
  }

  async listRejected () {
    await this.update()
    return listPublisherRejections(this.view)
  }

  async getViewSnapshot () {
    await this.update()
    return getPublisherViewSnapshot(this.view)
  }

  async getViewHead () {
    await this.update()
    return getPublisherViewHead(this.view, { hash: this.options.keyProvider.hash || crypto.hash })
  }

  async getLatestAnnouncement () {
    await this.update()
    return getLatestPublisherAnnouncement(this.view)
  }

  replicate (initiatorOrStream, options) {
    if (!this.publisherPinned || !this.base) invalid('catalog is not open')
    return this.base.replicate(initiatorOrStream, options)
  }

  async _close () {
    this.baseReady = false
    const close = async resource => {
      try { await resource?.close?.() } catch { /* close every owned layer */ }
    }
    const base = this.base
    const verifiedPageView = this.verifiedPageView
    this.publisherPinned = false
    this.base = null
    this.verifiedPageView = null
    await close(verifiedPageView)
    await close(base)
    if (this.ownsScopedStore) await close(this.store)
    if (this.ownsStore) await close(this.rootStore)
  }
}
