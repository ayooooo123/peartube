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
    this.publisherPinned = false
    this.ready().catch(() => {})
  }

  async _open () {
    const keyProvider = this.options.keyProvider
    this.base = new Autobase(this.store, this.options.key, {
      valueEncoding: 'binary',
      ackInterval: this.options.ackInterval,
      open: openPublisherCatalogView,
      apply: (nodes, view, host) => applyPublisherCatalogNodes(nodes, view, host, { keyProvider, publisherId: this.options.publisherId, journalLimit: this.options.journalLimit })
    })
    await this.base.ready()
    const descriptorEntry = await this.base.view.get('state/descriptor')
    const journalCountEntry = await this.base.view.get('meta/journal-count')
    let pinError = null
    if (descriptorEntry) {
      const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value, { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY })
      if (!equalBytes(descriptor.publisherId, this.options.publisherId)) pinError = 'persisted descriptor publisherId does not match expected publisherId'
    } else if (journalCountEntry && b4a.toString(journalCountEntry.value) !== '0') {
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
    await this.base.update()
  }

  async waitForWritable (timeout = 20_000) {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 120_000) invalid('writable timeout is out of bounds')
    if (this.writable) return true
    const started = Date.now()
    while (Date.now() - started < timeout) {
      await this.base.update().catch(() => {})
      if (this.writable) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return this.writable
  }

  async append (value) {
    await this.ready()
    if (!this.writable) invalid('local device is not an admitted Autobase writer')
    const frame = isBytes(value) ? value : encodePublisherCatalogFrame(value)
    if (frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('operation frame exceeds its byte limit')
    const decoded = decodePublisherCatalogFrame(frame)
    const canonical = encodePublisherCatalogFrame(decoded)
    if (!b4a.equals(canonical, frame)) invalid('operation frame is noncanonical')
    await this.base.append(frame)
    await this.base.update()
    return decoded.recordId || decoded.transitionId
  }

  async appendAndConfirm (value) {
    const operationId = await this.append(value)
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
    return getPublisherAuthorizationState(this.view)
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
      return { value: frame, from: { key: b4a.from(entry.sourceWriterKey) } }
    })
    await this.openVerifiedPageView()
    const rebuilt = await applyPublisherCatalogNodes(nodes, this.verifiedPageView, {
      key: this.base.key,
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
    return {
      accepted: entries.filter(entry => rebuilt.accepted.some(candidate =>
        b4a.toString(candidate.value.recordId || candidate.value.transitionId, 'hex') === entry.operationId
      )).length,
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
