import ReadyResource from 'ready-resource'
import HyperDB from 'hyperdb'
import Hyperblobs from 'hyperblobs'
import BlindPairing from 'blind-pairing'
import Protomux from 'protomux'
import z32 from 'z32'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { fromHex } from './util.js'
import { CommentsChannel } from './comments-channel.js'
import { ReactionsManager } from './reactions.js'
import { PublicChannelBee } from './public-channel-bee.js'
import { normalizeBlobRefInput } from '../blob-ref.js'
import { compareSignedChannelRootDescriptors } from '../channel-descriptor.js'
import channelDbDefinition from './channel-hyperdb-spec/hyperdb/index.js'
import {
  normalizeArtworkRole,
  normalizeChannelArtwork,
  normalizeChannelProfile,
  normalizeChannelSource,
  normalizeContentDetails,
  normalizeImportClaim,
  resolveClaimWinner
} from './structured-content.js'

const CURRENT_SCHEMA_VERSION = 1
const VALID_WRITER_ROLES = new Set(['device', 'moderator', 'owner'])
const MAX_SAFE_RANGE = Number.MAX_SAFE_INTEGER
const DEFAULT_IMPORT_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const IMPORT_CLAIM_STATE_RANK = Object.freeze({
  reserved: 0,
  published: 1,
  released: 2
})
const LEGACY_VIDEO_FIELDS = [
  'title',
  'description',
  'path',
  'duration',
  'thumbnail',
  'thumbnailBlobId',
  'thumbnailBlobsCoreKey',
  'thumbnailMimeType',
  'blobId',
  'blobsCoreKey',
  'blobDriveKey',
  'mimeType',
  'size',
  'category',
  'views',
  'uploadedAt',
  'uploadedBy',
  'updatedAt',
  'updatedBy',
  'schemaVersion',
  'logicalClock'
]
const CHANNEL_PROFILE_FIELDS = [
  'id',
  'profileKind',
  'mediaProvider',
  'mediaId',
  'originalLanguage',
  'releaseDate',
  'releaseYear'
]
const CHANNEL_PROFILE_STORAGE_DEFAULTS = {
  releaseDate: MAX_SAFE_RANGE,
  releaseYear: MAX_SAFE_RANGE
}
const CHANNEL_SOURCE_FIELDS = [
  'provider',
  'identityKey',
  'sourceId',
  'identityUrl',
  'handle',
  'displayName',
  'createdAt',
  'updatedAt'
]
const CHANNEL_SOURCE_STORAGE_DEFAULTS = {
  createdAt: MAX_SAFE_RANGE,
  updatedAt: MAX_SAFE_RANGE
}
const CHANNEL_ARTWORK_FIELDS = [
  'role',
  'blobId',
  'blobsCoreKey',
  'mimeType',
  'remoteUrl',
  'updatedAt'
]
const CHANNEL_ARTWORK_STORAGE_DEFAULTS = {
  updatedAt: MAX_SAFE_RANGE
}
const CONTENT_DETAIL_FIELDS = [
  'contentKind',
  'sourceProvider',
  'sourceVideoId',
  'identityUrl',
  'sourceCreatorId',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'originalAirDate',
  'thumbnailUrl',
  'artwork',
  'provenanceVersion',
  'publicationState',
  'contentFingerprint',
  'importIdentityKey',
  'importClaimantId'
]
const CONTENT_STORAGE_DEFAULTS = {
  contentKind: '',
  sourceProvider: '',
  sourceVideoId: '',
  sourcePublishedAt: MAX_SAFE_RANGE,
  seasonNumber: MAX_SAFE_RANGE,
  episodeNumber: MAX_SAFE_RANGE,
  originalAirDate: MAX_SAFE_RANGE
}

function toBuffer(value) {
  if (!value) return null
  if (b4a.isBuffer(value)) return value
  if (typeof value === 'string') return b4a.from(value, 'hex')
  return value
}

function cloneWithoutInternalVideoFields(value) {
  if (!value || typeof value !== 'object') return {}
  const { type, ...rest } = value
  return rest
}

function stripUndefined(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function pickDefinedFields(value, fields) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const field of fields) {
    if (value[field] !== undefined) out[field] = value[field]
  }
  return out
}

function encodeStoredRecord(record, defaults) {
  return { ...defaults, ...record }
}

function decodeStoredRecord(record, fields, defaults) {
  if (!record) return null
  const decoded = { ...record }
  for (const field of fields) {
    if (decoded[field] === null) delete decoded[field]
  }
  for (const [field, sentinel] of Object.entries(defaults)) {
    if (decoded[field] === sentinel) delete decoded[field]
  }
  return decoded
}

function encodeContentDetails(details) {
  return encodeStoredRecord(details, CONTENT_STORAGE_DEFAULTS)
}

function decodeContentDetails(details) {
  return decodeStoredRecord(details, CONTENT_DETAIL_FIELDS, CONTENT_STORAGE_DEFAULTS)
}

function assertFiniteNonnegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`)
  }
}


function mergeEqualRevisionRecords(left, right) {
  const current = stripUndefined(left)
  const candidate = stripUndefined(right)
  const merged = {}
  for (const field of new Set([...Object.keys(current), ...Object.keys(candidate)])) {
    const currentValue = current[field]
    const candidateValue = candidate[field]
    if (currentValue === undefined) {
      merged[field] = candidateValue
    } else if (candidateValue === undefined) {
      merged[field] = currentValue
    } else {
      merged[field] = JSON.stringify(candidateValue) > JSON.stringify(currentValue)
        ? candidateValue
        : currentValue
    }
  }
  return merged
}

function mergeStagedRecords(existing, incoming, keyOf) {
  const records = new Map()
  for (const record of existing || []) records.set(keyOf(record), { ...record })
  for (const candidate of incoming || []) {
    const key = keyOf(candidate)
    const current = records.get(key)
    if (!current) {
      records.set(key, { ...candidate })
      continue
    }
    const currentUpdatedAt = Number.isFinite(current.updatedAt) ? current.updatedAt : -1
    const candidateUpdatedAt = Number.isFinite(candidate?.updatedAt) ? candidate.updatedAt : -1
    let merged
    if (candidateUpdatedAt > currentUpdatedAt) {
      merged = { ...current, ...stripUndefined(candidate) }
    } else if (currentUpdatedAt > candidateUpdatedAt) {
      merged = { ...stripUndefined(candidate), ...current }
    } else {
      merged = mergeEqualRevisionRecords(current, candidate)
    }
    records.set(key, merged)
  }
  return [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record)
}

function channelSourceStageKey(source) {
  return `${source?.provider || ''}\u0000${source?.identityKey || ''}`
}

function channelArtworkStageKey(artwork) {
  return artwork?.role || ''
}

function makeCoreName(keyHex) {
  return `peartube-channel-hyperdb-${keyHex || 'default'}`
}

export class MultiWriterChannel extends ReadyResource {
  constructor(store, opts = {}) {
    super()
    this.store = store
    this.opts = opts
    this.swarm = opts.swarm || null


    this.blobs = null
    this._blobsCore = null
    this._channelDiscovery = null
    this.pairing = null
    this.pairingMember = null
    this.publicBee = null
    this._publicDiscovery = null
    const deferredProjection = opts.deferPublicProjection === true
    this._publicProjectionActive =
      !deferredProjection || opts.publicProjectionState === 'active'
    this._publicProjectionCommitState = this._publicProjectionActive ? 'active' : 'pending'
    this._stagedPublicProjection = {}
    this._inFlightPublicProjection = null
    this._publicActivation = null
    this._publicProjectionClosing = false
    this.comments = null
    this.reactions = null
    this.wakeupSession = null

    this._localWriterKey = null
    this._localWriterKeyHex = null
    this._lastVideoLogicalClock = 0
    this._localRateLimits = new Map()
    this._pairingSetupDone = false
    this._replicatedConnections = new WeakSet()
    this._replicateConnection = null
    this._claimWriteTail = Promise.resolve()

    this.ready().catch(() => {})
  }

  get key() {
    return this.core?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey() {
    return this.core?.discoveryKey || null
  }

  get encryptionKey() {
    return this.core?.encryptionKey || this.opts.encryptionKey || null
  }

  get writable() {
    return Boolean(this.core?.writable && this.db?.writable)
  }

  get localWriterKey() {
    return this._localWriterKey || this.key
  }

  get localWriterKeyHex() {
    return this._localWriterKeyHex || this.keyHex
  }

  get blobsKey() {
    return this._blobsCore?.key || null
  }

  get blobsKeyHex() {
    return this.blobsKey ? b4a.toString(this.blobsKey, 'hex') : null
  }

  get publicBeeKey() {
    return this.publicBee?.keyHex || null
  }

  get publicProjectionActive() {
    return this._publicProjectionActive
  }

  async _open() {
    const bootstrapKey = toBuffer(this.opts.key)
    const keyPair = this.opts.keyPair || null
    const coreOpts = bootstrapKey
      ? { key: bootstrapKey, encryptionKey: toBuffer(this.opts.encryptionKey) }
      : keyPair
        ? { keyPair, encryptionKey: toBuffer(this.opts.encryptionKey) }
        : { name: makeCoreName(this.opts.name || 'default'), encryptionKey: toBuffer(this.opts.encryptionKey) }

    this.core = this.store.get(coreOpts)
    await this.core.ready()

    this.db = HyperDB.bee(this.core, channelDbDefinition, {
      autoUpdate: true,
      writable: this.core.writable !== false,
      extension: false
    })
    await this.db.ready()

    const writerKeyPair = keyPair || (typeof this.store.createKeyPair === 'function'
      ? await this.store.createKeyPair(`peartube-channel-writer-${this.keyHex}`)
      : null)
    this._localWriterKey = writerKeyPair?.publicKey || this.core.key
    this._localWriterKeyHex = this._localWriterKey ? b4a.toString(this._localWriterKey, 'hex') : this.keyHex

    await this._ensureBootstrapRecords()
    await this._openBlobs()
    await this._openPublicDb()

    this.comments = new CommentsChannel(this)
    this.reactions = new ReactionsManager(this)
  }

  async _ensureBootstrapRecords() {
    const now = Date.now()
    const meta = await this.getMetadata().catch(() => null)
    if (!this.writable) return
    if (!meta) {
      await this.db.insert('@peartubeChannel/metadata', {
        key: 'meta',
        name: '',
        description: '',
        createdAt: now,
        createdBy: this.localWriterKeyHex,
        updatedAt: now,
        updatedBy: this.localWriterKeyHex,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        logicalClock: 0
      })
    }

    if (this.localWriterKeyHex) {
      // A writable channel core has exactly one physical owner device. Two code
      // paths historically derived that device's *writer-table key* from
      // different names — the identity-scoped `peartube-channel-writer:<id>`
      // (whose public key equals the channel key) on load, vs. the internal
      // fallback `peartube-channel-writer-<channelKey>` when the channel was
      // created/opened without a writer key. Opening the same owned channel via
      // each path inserted a *second* "owner" record, surfacing in the UI as a
      // phantom "synced device" that was never paired.
      //
      // Reconcile to a single owner: prefer the record this device actually
      // claimed (it has a device name or a blob drive), adopt that identity so
      // blob drives and authorship stay consistent across every open path, and
      // prune leftover un-claimed owner records.
      const owners = (await this.db.find('@peartubeChannel/writers', {}).toArray())
        .filter((w) => w?.role === 'owner')
      const claimed = owners.find((w) => w.keyHex && (w.deviceName || w.blobDriveKey))
      const ownerKeyHex = claimed?.keyHex || this.localWriterKeyHex

      if (ownerKeyHex !== this.localWriterKeyHex) {
        this._localWriterKeyHex = ownerKeyHex
        this._localWriterKey = b4a.from(ownerKeyHex, 'hex')
      }

      // Only ever delete un-claimed owner records (no device name, no blob
      // drive) so this can never drop a device that holds uploaded content.
      for (const w of owners) {
        if (w.keyHex && w.keyHex !== ownerKeyHex && !w.deviceName && !w.blobDriveKey) {
          await this.db.delete('@peartubeChannel/writers', { keyHex: w.keyHex })
        }
      }

      if (!owners.some((w) => w.keyHex === ownerKeyHex)) {
        await this.db.insert('@peartubeChannel/writers', {
          keyHex: ownerKeyHex,
          role: 'owner',
          deviceName: '',
          addedAt: now,
          blobDriveKey: ''
        })
      }
    }

    await this.db.flush()
  }

  async _openBlobs() {
    const localWriterKey = this.localWriterKeyHex || 'default'
    const blobsCoreName = `peartube-blobs-${this.keyHex?.slice(0, 16)}-${localWriterKey.slice(0, 16)}`
    this._blobsCore = this.store.get({ name: blobsCoreName })
    await this._blobsCore.ready()
    this.blobs = new Hyperblobs(this._blobsCore)
  }

  async _openPublicDb() {
    if (!this.writable) return
    const existingMeta = await this.getMetadata().catch(() => null)
    const existingPublicBeeKey = existingMeta?.publicBeeKey || null
    const isValidPublicBeeKey = (key) =>
      typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)

    this.publicBee = isValidPublicBeeKey(existingPublicBeeKey)
      ? new PublicChannelBee(this.store, { key: existingPublicBeeKey })
      : new PublicChannelBee(this.store, { name: `peartube-public-${this.keyHex}` })

    await this.publicBee.ready()
    if (!this._publicProjectionActive) return

    await this._joinPublicDiscovery()
    if (this.publicBee.keyHex && existingMeta?.publicBeeKey !== this.publicBee.keyHex) {
      await this.updateMetadata({ publicBeeKey: this.publicBee.keyHex })
    }
    await this._syncPublicBeeFromFeedChannel()
  }

  async _syncPublicBeeFromFeedChannel() {
    if (!this._publicProjectionActive || !this.publicBee?.writable) return
    await this.publicBee.syncFromChannel(this)
  }
 
  async _flushPublicDiscovery(discovery) {
    const flushed = discovery?.flushed?.()
    if (!flushed || typeof flushed.then !== 'function') return
    const configured = Number(this.opts.publicDiscoveryFlushTimeoutMs)
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 5000
    let timer = null
    try {
      await Promise.race([
        flushed,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Public discovery flush timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async _joinPublicDiscovery({ strict = false } = {}) {
    if (this._publicProjectionClosing || this.closing) {
      if (strict) throw new Error('Channel is closing')
      return this._publicDiscovery
    }
    if (this._publicDiscovery) {
      if (strict) await this._flushPublicDiscovery(this._publicDiscovery)
      return this._publicDiscovery
    }
    if (!this.swarm || !this.publicBee?.discoveryKey) {
      if (strict) throw new Error('Public discovery is unavailable')
      return null
    }

    let discovery = null
    try {
      discovery = this.swarm.join(this.publicBee.discoveryKey)
      if (strict) {
        await this._flushPublicDiscovery(discovery)
        if (this._publicProjectionClosing || this.closing) {
          throw new Error('Channel is closing')
        }
      } else {
        discovery?.flushed?.().catch(() => {})
      }
      this._publicDiscovery = discovery
      return discovery
    } catch (err) {
      try { await discovery?.destroy?.() } catch { /* best effort */ }
      try { await discovery?.close?.() } catch { /* best effort */ }
      if (this._publicDiscovery === discovery) this._publicDiscovery = null
      if (strict) throw err
      return null
    }
  }

  stagePublicProjection({
    stagedDescriptor,
    stagedProfile,
    stagedSources,
    stagedArtwork
  } = {}) {
    if (stagedDescriptor !== undefined) {
      const currentDescriptor = this.getStagedPublicProjection().stagedDescriptor
      if (
        currentDescriptor === undefined ||
        compareSignedChannelRootDescriptors(stagedDescriptor, currentDescriptor) > 0
      ) {
        this._stagedPublicProjection.stagedDescriptor = stagedDescriptor
      }
    }
    if (stagedProfile !== undefined) {
      this._stagedPublicProjection.stagedProfile = {
        ...(this._stagedPublicProjection.stagedProfile || {}),
        ...stagedProfile
      }
    }
    if (stagedSources !== undefined) {
      this._stagedPublicProjection.stagedSources = mergeStagedRecords(
        this._stagedPublicProjection.stagedSources,
        stagedSources,
        channelSourceStageKey
      )
    }
    if (stagedArtwork !== undefined) {
      this._stagedPublicProjection.stagedArtwork = mergeStagedRecords(
        this._stagedPublicProjection.stagedArtwork,
        stagedArtwork,
        channelArtworkStageKey
      )
    }
    return this.getStagedPublicProjection()
  }

  getStagedPublicProjection() {
    const inFlight = this._inFlightPublicProjection || {}
    const queued = this._stagedPublicProjection
    const stagedProfile = inFlight.stagedProfile || queued.stagedProfile
      ? {
          ...(inFlight.stagedProfile || {}),
          ...(queued.stagedProfile || {})
        }
      : undefined
    const stagedSources = inFlight.stagedSources || queued.stagedSources
      ? mergeStagedRecords(
          inFlight.stagedSources,
          queued.stagedSources,
          channelSourceStageKey
        )
      : undefined
    const stagedArtwork = inFlight.stagedArtwork || queued.stagedArtwork
      ? mergeStagedRecords(
          inFlight.stagedArtwork,
          queued.stagedArtwork,
          channelArtworkStageKey
        )
      : undefined
    return {
      ...inFlight,
      ...queued,
      stagedProfile,
      stagedSources: stagedSources ? [...stagedSources] : undefined,
      stagedArtwork: stagedArtwork ? [...stagedArtwork] : undefined
    }
  }

  async activatePublicProjection(staged = {}) {
    if (this._publicProjectionClosing || this.closing || this.closed) {
      throw new Error('Channel is closing')
    }
    if (this._publicActivation) {
      try {
        await this._publicActivation
      } catch {
        // The queued call below retries a failed partial projection.
      }
      return this.activatePublicProjection(staged)
    }

    this.stagePublicProjection(staged)
    const projection = this.getStagedPublicProjection()
    // Stages added while this snapshot is in flight belong to the next replay.
    this._inFlightPublicProjection = projection
    this._stagedPublicProjection = {}
    const activation = (async () => {
      if (!this.publicBee?.writable) throw new Error('Public projection is not writable')
      if (
        !this._publicProjectionActive &&
        typeof this.opts.setPublicProjectionState === 'function'
      ) {
        // The durable pending marker must precede any private key exposure.
        this._publicProjectionCommitState = 'pending'
        await this.opts.setPublicProjectionState('pending')
      }
      await this.publicBee.activatePublicProjection({
        channel: this,
        ...projection
      })
      if (!this._publicProjectionActive) {
        // Commit point: every fallible durable/private write completes before
        // discovery is allowed to expose the public core.
        this._publicProjectionCommitState = 'committing'
        try {
          await this.updateMetadata({ publicBeeKey: this.publicBee.keyHex })
        } catch (err) {
          this._publicProjectionCommitState = 'committed'
          throw err
        }
        this._publicProjectionCommitState = 'committed'
      }
      await this._joinPublicDiscovery({ strict: true })
      // Discovery is now exposed. Runtime activation cannot fail from here;
      // a failed durable marker write leaves reload fail-closed and replayable.
      this._publicProjectionActive = true
      this._publicProjectionCommitState = 'active'
      if (typeof this.opts.setPublicProjectionState === 'function') {
        try {
          await this.opts.setPublicProjectionState('active')
        } catch (err) {
          console.warn(
            '[Channel] Public projection active marker repair deferred:',
            err?.message || err
          )
        }
      }
      return this.publicBee.keyHex
    })()
    this._publicActivation = activation
    try {
      return await activation
    } catch (err) {
      const queued = this._stagedPublicProjection
      this._stagedPublicProjection = {}
      this._inFlightPublicProjection = null
      this.stagePublicProjection(projection)
      this.stagePublicProjection(queued)
      throw err
    } finally {
      if (this._inFlightPublicProjection === projection) {
        this._inFlightPublicProjection = null
      }
      if (this._publicActivation === activation) this._publicActivation = null
    }
  }

  async _suppressPublicVideo(id) {
    if (!this.publicBee?.writable) return
    await this.publicBee.applyVideoChanges([{ type: 'del', id }])
  }

  async _close() {
    this._publicProjectionClosing = true
    const closeResource = async (resource) => {
      if (!resource || typeof resource.close !== 'function') return
      try {
        await resource.close()
      } catch {
        // best effort
      }
    }
    const destroyResource = async (resource) => {
      if (!resource || typeof resource.destroy !== 'function') return
      try {
        await resource.destroy()
      } catch {
        // best effort
      }
    }

    if (this.wakeupSession) {
      await destroyResource(this.wakeupSession)
      await closeResource(this.wakeupSession)
      this.wakeupSession = null
    }
    if (this._publicActivation) {
      try {
        await this._publicActivation
      } catch {
        // Activation failures do not prevent resource cleanup.
      }
    }
    if (this._replicateConnection && this.swarm) {
      this.swarm.off?.('connection', this._replicateConnection)
      this.swarm.removeListener?.('connection', this._replicateConnection)
      this._replicateConnection = null
    }
    if (this._channelDiscovery) {
      await destroyResource(this._channelDiscovery)
      await closeResource(this._channelDiscovery)
      this._channelDiscovery = null
    }
    if (this._publicDiscovery) {
      await destroyResource(this._publicDiscovery)
      await closeResource(this._publicDiscovery)
      this._publicDiscovery = null
    }
    if (this.publicBee) {
      await closeResource(this.publicBee)
      this.publicBee = null
    }
    if (this.pairingMember) {
      await closeResource(this.pairingMember)
      this.pairingMember = null
    }
    if (this.pairing) {
      await closeResource(this.pairing)
      this.pairing = null
    }
    if (this.blobs) this.blobs = null
    if (this._blobsCore) {
      await closeResource(this._blobsCore)
      this._blobsCore = null
    }
    if (this.db) {
      await closeResource(this.db)
      this.db = null
    }
    this.core = null
  }

  async _flush() {
    await this.db.flush()
  }

  async _update() {
    this.db?.update?.()
  }

  _checkLocalRateLimit(writerKeyHex) {
    const now = Date.now()
    const windowMs = 60 * 1000
    const maxOpsPerWindow = 100
    const prev = this._localRateLimits.get(writerKeyHex)
    if (!prev || now - prev.windowStartMs >= windowMs) {
      this._localRateLimits.set(writerKeyHex, { count: 1, windowStartMs: now })
      return
    }
    if (prev.count >= maxOpsPerWindow) throw new Error('Rate limit exceeded (local)')
    prev.count++
  }

  async appendOp(op) {
    if (!op?.type) return null
    switch (op.type) {
      case 'update-channel': return this.updateMetadata(op)
      case 'add-video': return this.addVideo(op)
      case 'update-video': return this.updateVideo(op.id, op)
      case 'delete-video': return this.deleteVideo(op.id)
      case 'add-writer': return this.addWriter(op)
      case 'upsert-writer': return this.ensureLocalBlobDrive({ deviceName: op.deviceName || '' })
      case 'remove-writer': return this.removeWriter(op)
      case 'add-comment': return this.comments.addComment(op.videoId, op.text, op.parentId, op)
      case 'hide-comment': return this.comments.hideComment(op.videoId, op.commentId, op)
      case 'remove-comment': return this.comments.removeComment(op.videoId, op.commentId, op)
      case 'add-reaction': return this.reactions.addReaction(op.videoId, op.reactionType, op)
      case 'remove-reaction': return this.reactions.removeReaction(op.videoId, op)
      // Legacy, read-only: nothing produces 'log-watch-event' any more — viewer
      // ranking is device-local. The case stays so channel logs written before
      // the watch-telemetry removal keep replaying to the same derived state.
      case 'log-watch-event': return this.addWatchEvent(op)
      case 'add-vector-index': return this.addVectorIndex(op)
      default: return null
    }
  }

  async getMetadata() {
    await this._update()
    const [meta, profile] = await Promise.all([
      this.db.get('@peartubeChannel/metadata', { key: 'meta' }),
      this.db.get('@peartubeChannel/channelProfiles', { id: 'profile' })
    ])
    const logicalProfile = decodeStoredRecord(
      profile,
      CHANNEL_PROFILE_FIELDS,
      CHANNEL_PROFILE_STORAGE_DEFAULTS
    )
    if (meta && !meta.schemaVersion) meta.schemaVersion = CURRENT_SCHEMA_VERSION
    const logical = !meta
      ? logicalProfile
      : logicalProfile
        ? { ...meta, ...logicalProfile }
        : meta
    if (logical?.publicBeeKey && this._publicProjectionCommitState !== 'active') {
      return { ...logical, publicBeeKey: null }
    }
    return logical
  }

  async updateMetadata(updates = {}) {
    if (!this.writable) throw new Error('Channel is not writable')
    const patch = updates && typeof updates === 'object' ? updates : {}
    const currentMeta = await this.getMetadata().catch(() => null)
    const nextClock = Math.max((currentMeta?.logicalClock || 0) + 1, patch.logicalClock || 0)
    const now = Date.now()
    const meta = stripUndefined({
      ...(currentMeta || {}),
      key: 'meta',
      name: 'name' in patch ? patch.name : currentMeta?.name || '',
      description: 'description' in patch ? patch.description : currentMeta?.description || '',
      avatar: 'avatar' in patch ? patch.avatar : currentMeta?.avatar || null,
      publicBeeKey: patch.publicBeeKey || currentMeta?.publicBeeKey ||
        (this._publicProjectionActive ? this.publicBee?.keyHex : null),
      commentsDbKey: patch.commentsDbKey || currentMeta?.commentsDbKey || this.keyHex || null,
      commentsAdminKey: patch.commentsAdminKey || currentMeta?.commentsAdminKey || null,
      createdAt: 'createdAt' in patch ? patch.createdAt : (currentMeta?.createdAt || now),
      createdBy: 'createdBy' in patch ? patch.createdBy : (currentMeta?.createdBy || this.localWriterKeyHex),
      updatedAt: patch.updatedAt || now,
      updatedBy: patch.updatedBy || this.localWriterKeyHex,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock
    })
    await this.db.insert('@peartubeChannel/metadata', meta)
    await this._flush()
    await this._syncPublicBeeFromFeedChannel()
  }

  async putChannelProfile(profile) {
    const normalized = normalizeChannelProfile({ ...(profile || {}), id: 'profile' })
    await this.db.insert('@peartubeChannel/channelProfiles',
      encodeStoredRecord(normalized, CHANNEL_PROFILE_STORAGE_DEFAULTS))
    await this._flush()
  }

  async getChannelProfile() {
    await this._update()
    const profile = await this.db.get('@peartubeChannel/channelProfiles', { id: 'profile' })
    return decodeStoredRecord(profile, CHANNEL_PROFILE_FIELDS, CHANNEL_PROFILE_STORAGE_DEFAULTS)
  }

  async putChannelSource(source) {
    const normalized = normalizeChannelSource(source)
    await this.db.insert('@peartubeChannel/channelSources',
      encodeStoredRecord(normalized, CHANNEL_SOURCE_STORAGE_DEFAULTS))
    await this._flush()
  }

  async listChannelSources() {
    await this._update()
    const sources = await this.db.find('@peartubeChannel/channelSources', {}).toArray()
    return sources.map((source) =>
      decodeStoredRecord(source, CHANNEL_SOURCE_FIELDS, CHANNEL_SOURCE_STORAGE_DEFAULTS))
  }

  async putChannelArtwork(artwork) {
    const normalized = normalizeChannelArtwork(artwork)
    await this.db.insert('@peartubeChannel/channelArtwork',
      encodeStoredRecord(normalized, CHANNEL_ARTWORK_STORAGE_DEFAULTS))
    await this._flush()
  }

  async getChannelArtwork(role) {
    await this._update()
    const artwork = await this.db.get('@peartubeChannel/channelArtwork', { role: normalizeArtworkRole(role) })
    return decodeStoredRecord(artwork, CHANNEL_ARTWORK_FIELDS, CHANNEL_ARTWORK_STORAGE_DEFAULTS)
  }

  async listChannelArtwork() {
    await this._update()
    const artwork = await this.db.find('@peartubeChannel/channelArtwork', {}).toArray()
    return artwork.map((record) =>
      decodeStoredRecord(record, CHANNEL_ARTWORK_FIELDS, CHANNEL_ARTWORK_STORAGE_DEFAULTS))
  }

  async _withClaimWriteLock(operation) {
    const previous = this._claimWriteTail
    let unlock
    this._claimWriteTail = new Promise((resolve) => { unlock = resolve })
    await previous
    try {
      return await operation()
    } finally {
      unlock()
    }
  }

  async putImportClaim(claim) {
    return this._withClaimWriteLock(() => this._putImportClaim(claim))
  }

  async _putImportClaim(claim) {
    const normalized = normalizeImportClaim(claim)
    if (normalized.writerKey !== this.localWriterKeyHex) {
      throw new Error('Import claim writerKey must match the authenticated writer')
    }
    await this._update()
    const existing = await this.db.get('@peartubeChannel/importClaims', {
      identityKey: normalized.identityKey,
      claimantId: normalized.claimantId
    })
    const writerClaims = await this.db.find('@peartubeChannel/claims-by-writer', {
      identityKey: normalized.identityKey,
      writerKey: normalized.writerKey
    }).toArray()
    if (writerClaims.some((candidate) =>
      candidate.identityKey === normalized.identityKey &&
      candidate.writerKey === normalized.writerKey &&
      candidate.claimantId !== normalized.claimantId &&
      candidate.state !== 'released')) {
      throw new Error('Active import claim already exists for the same writer and identity')
    }

    const now = Date.now()
    const incomingUpdatedAt = normalized.updatedAt ?? now
    if (!existing) {
      if (normalized.state === 'released' && normalized.releasedAt < incomingUpdatedAt) {
        throw new Error('releasedAt cannot precede the claim update time')
      }
      const next = normalizeImportClaim({
        ...normalized,
        state: normalized.state ?? 'reserved',
        createdAt: normalized.createdAt ?? now,
        updatedAt: incomingUpdatedAt
      })
      await this.db.insert('@peartubeChannel/importClaims', next)
      await this._flush()
      return next
    }

    for (const field of ['identityKey', 'claimantId', 'jobId', 'writerKey']) {
      if (normalized[field] !== existing[field]) {
        throw new Error(`Import claim ${field} cannot change`)
      }
    }
    if (normalized.createdAt !== undefined && normalized.createdAt !== existing.createdAt) {
      throw new Error('Import claim createdAt cannot change')
    }
    const existingVideoId = existing.videoId || undefined
    if (existingVideoId !== undefined &&
        normalized.videoId !== undefined &&
        normalized.videoId !== existingVideoId) {
      throw new Error('Import claim videoId cannot change once assigned')
    }
    if (existing.state !== 'released' &&
        normalized.state === 'released' &&
        normalized.releasedAt < Math.max(existing.updatedAt ?? 0, incomingUpdatedAt)) {
      throw new Error('releasedAt cannot precede the claim update time')
    }
    if (existing.state === 'released' || incomingUpdatedAt < (existing.updatedAt ?? 0)) {
      return existing
    }
    if (incomingUpdatedAt === (existing.updatedAt ?? 0)) {
      const conflicts = (
        (normalized.videoId !== undefined && normalized.videoId !== existingVideoId) ||
        (normalized.state !== undefined && normalized.state !== existing.state) ||
        (normalized.releasedAt !== undefined && normalized.releasedAt !== existing.releasedAt)
      )
      if (conflicts) throw new Error('Import claim equal timestamp payload conflict')
      return existing
    }

    const nextState = normalized.state ?? existing.state
    if (IMPORT_CLAIM_STATE_RANK[nextState] < IMPORT_CLAIM_STATE_RANK[existing.state]) {
      throw new Error(`Invalid import claim state transition from ${existing.state} to ${nextState}`)
    }
    const next = normalizeImportClaim({
      ...existing,
      state: nextState,
      videoId: existingVideoId ?? normalized.videoId,
      updatedAt: incomingUpdatedAt,
      releasedAt: nextState === 'released' ? normalized.releasedAt : existing.releasedAt
    })
    await this.db.insert('@peartubeChannel/importClaims', next)
    await this._flush()
    return next
  }

  async listImportClaims(identityKey) {
    if (typeof identityKey !== 'string' || identityKey.length === 0) {
      throw new Error('Import identity key required')
    }
    await this._update()
    const claims = await this.db.find('@peartubeChannel/claims-by-identity', { identityKey }).toArray()
    return claims.filter((claim) => claim.identityKey === identityKey)
  }

  async listAllImportClaims() {
    await this._update()
    return this.db.find('@peartubeChannel/importClaims', {}).toArray()
  }

  async resolveImportClaim(identityKey) {
    return resolveClaimWinner(await this.listImportClaims(identityKey))
  }

  async releaseImportClaim(identityKey, claimantId, releasedAt = Date.now()) {
    return this._withClaimWriteLock(() => this._releaseImportClaim(identityKey, claimantId, releasedAt))
  }

  async _releaseImportClaim(identityKey, claimantId, releasedAt) {
    const claims = await this.listImportClaims(identityKey)
    const existing = claims.find((claim) => claim.claimantId === claimantId)
    if (!existing) throw new Error('Import claim not found')
    if (existing.writerKey !== this.localWriterKeyHex) {
      throw new Error('Import claim writerKey must match the authenticated writer')
    }
    if (existing.state !== 'released' && releasedAt < (existing.updatedAt ?? 0)) {
      throw new Error('releasedAt cannot precede the claim update time')
    }
    const effectiveReleasedAt = existing.state === 'released'
      ? existing.releasedAt
      : releasedAt
    const released = normalizeImportClaim({
      ...existing,
      state: 'released',
      updatedAt: Math.max(existing.updatedAt ?? 0, effectiveReleasedAt),
      releasedAt: effectiveReleasedAt
    })
    await this.db.insert('@peartubeChannel/importClaims', released)
    await this._flush()
    return released
  }

  async compactReleasedImportClaims(options = {}) {
    return this._withClaimWriteLock(() => this._compactReleasedImportClaims(options))
  }

  async _compactReleasedImportClaims({
    now,
    retentionMs = DEFAULT_IMPORT_CLAIM_RETENTION_MS,
    isJobActive
  } = {}) {
    assertFiniteNonnegative(now, 'now')
    assertFiniteNonnegative(retentionMs, 'retentionMs')
    if (typeof isJobActive !== 'function') throw new Error('isJobActive must be a function')

    await this._update()
    const claims = await this.db.find('@peartubeChannel/importClaims', {}).toArray()
    const byIdentity = new Map()
    for (const claim of claims) {
      const group = byIdentity.get(claim.identityKey)
      if (group) group.push(claim)
      else byIdentity.set(claim.identityKey, [claim])
    }

    let deleted = 0
    for (const claim of claims) {
      if (claim.state !== 'released' || claim.releasedAt === undefined) continue
      if (now - claim.releasedAt < retentionMs) continue
      if (await isJobActive(claim.jobId, claim)) continue

      const identityClaims = byIdentity.get(claim.identityKey)
      const contenders = identityClaims.filter((candidate) => candidate.state !== 'released')
      const winner = resolveClaimWinner(identityClaims)
      if (contenders.length > 0 && winner?.state !== 'published') continue

      await this.db.delete('@peartubeChannel/importClaims', {
        identityKey: claim.identityKey,
        claimantId: claim.claimantId
      })
      deleted++
    }
    if (deleted > 0) await this._flush()
    return { deleted }
  }

  async listWriters() {
    await this._update()
    return this.db.find('@peartubeChannel/writers', {}).toArray()
  }

  async _getWriter(keyHex) {
    if (!keyHex) return null
    await this._update()
    return this.db.get('@peartubeChannel/writers', { keyHex })
  }

  async _isLocalPrivileged() {
    const writer = await this._getWriter(this.localWriterKeyHex)
    return !writer || writer.role === 'owner' || writer.role === 'moderator'
  }

  // Hex of the Hyperswarm/Noise public key this device replicates under. Other
  // devices read it from the writer record to recognise this device as a
  // connected replication peer (durable own-device offload anchor).
  _localSwarmKeyHex() {
    try {
      const pk = this.swarm?.keyPair?.publicKey
      if (!pk) return ''
      const hex = b4a.toString(pk, 'hex')
      return /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : ''
    } catch {
      return ''
    }
  }

  async ensureLocalBlobDrive({ deviceName = '' } = {}) {
    if (!this.localWriterKeyHex) throw new Error('Channel not ready')
    if (!this.blobs) throw new Error('Blobs not initialized')
    const existing = await this._getWriter(this.localWriterKeyHex)
    await this.db.insert('@peartubeChannel/writers', {
      ...(existing || {}),
      keyHex: this.localWriterKeyHex,
      role: existing?.role || 'owner',
      deviceName: deviceName || existing?.deviceName || '',
      addedAt: existing?.addedAt || Date.now(),
      updatedAt: Date.now(),
      blobDriveKey: this.blobsKeyHex || existing?.blobDriveKey || '',
      swarmKeyHex: this._localSwarmKeyHex() || existing?.swarmKeyHex || ''
    })
    await this._flush()
    return this.blobsKeyHex
  }

  async addWriter({ keyHex, role = 'device', deviceName = '' }) {
    if (!keyHex) throw new Error('Writer key required')
    if (!VALID_WRITER_ROLES.has(role)) throw new Error(`Invalid role: ${role}. Must be one of: ${[...VALID_WRITER_ROLES].join(', ')}`)
    const localWriter = await this._getWriter(this.localWriterKeyHex)
    if (localWriter && localWriter.role !== 'owner') throw new Error('Only owners can add writers')
    await this.db.insert('@peartubeChannel/writers', {
      keyHex,
      role,
      deviceName,
      addedAt: Date.now(),
      blobDriveKey: ''
    })
    await this._flush()
  }

  async removeWriter({ keyHex, ban = false }) {
    const localWriter = await this._getWriter(this.localWriterKeyHex)
    if (localWriter && localWriter.role !== 'owner') throw new Error('Only owners can remove writers')
    if (keyHex === this.localWriterKeyHex) throw new Error('Cannot remove yourself')
    if (ban) {
      const existing = await this._getWriter(keyHex)
      await this.db.insert('@peartubeChannel/writers', {
        ...(existing || { keyHex }),
        removedAt: Date.now(),
        banned: true
      })
    } else {
      await this.db.delete('@peartubeChannel/writers', { keyHex })
    }
    await this._flush()
  }

  _toPublicVideoMeta(value) {
    const { schemaVersion, logicalClock, ...rest } = cloneWithoutInternalVideoFields(value)
    return rest
  }

  _nextVideoLogicalClock() {
    const now = Date.now()
    const next = Math.max(this._lastVideoLogicalClock + 1, now)
    this._lastVideoLogicalClock = next
    return next
  }

  async listVideos() {
    await this._update()
    const [videos, details] = await Promise.all([
      this.db.find('@peartubeChannel/videos-by-uploaded-at', {}, { reverse: true }).toArray(),
      this.db.find('@peartubeChannel/contentDetails', {}).toArray()
    ])
    if (details.length === 0) return videos
    const detailsById = new Map(details.map((record) => [record.id, decodeContentDetails(record)]))
    return videos.map((video) => {
      const sidecar = detailsById.get(video.id)
      return sidecar ? { ...video, ...sidecar } : video
    })
  }

  async getVideo(id) {
    if (!id) return null
    await this._update()
    const [video, details] = await Promise.all([
      this.db.get('@peartubeChannel/videos', { id }),
      this.db.get('@peartubeChannel/contentDetails', { id })
    ])
    if (!video) return null
    return details ? { ...video, ...decodeContentDetails(details) } : video
  }

  async addVideo(meta, { syncPublic = meta?.publicationState !== 'replicationPending' } = {}) {
    const id = meta?.id
    if (!id) throw new Error('Video id required')
    const nextClock = this._nextVideoLogicalClock()
    const videoMeta = stripUndefined({
      ...pickDefinedFields(meta, LEGACY_VIDEO_FIELDS),
      id,
      title: typeof meta.title === 'string' ? meta.title : String(meta.title ?? ''),
      description: typeof meta.description === 'string' ? meta.description : '',
      uploadedAt: meta.uploadedAt || Date.now(),
      uploadedBy: meta.uploadedBy || this.localWriterKeyHex,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock
    })
    const detailsInput = pickDefinedFields(meta, CONTENT_DETAIL_FIELDS)
    let details = null
    if (Object.keys(detailsInput).length > 0) {
      await this._update()
      const existingDetails = await this.db.get('@peartubeChannel/contentDetails', { id })
      details = normalizeContentDetails({
        ...(decodeContentDetails(existingDetails) || {}),
        ...detailsInput,
        id
      })
    }

    await this.db.insert('@peartubeChannel/videos', videoMeta)
    if (details) await this.db.insert('@peartubeChannel/contentDetails', encodeContentDetails(details))
    await this._flush()
    if (details?.publicationState === 'replicationPending') {
      await this._suppressPublicVideo(id)
    } else if (syncPublic) {
      await this._syncPublicBeeFromFeedChannel()
    }
  }

  async updateVideo(id, updates, { syncPublic = updates?.publicationState !== 'replicationPending' } = {}) {
    if (!id) throw new Error('Video id required')
    await this._update()
    const [existing, existingDetails] = await Promise.all([
      this.db.get('@peartubeChannel/videos', { id }),
      this.db.get('@peartubeChannel/contentDetails', { id })
    ])
    if (!existing) throw new Error('Video not found: ' + id)
    const nextClock = this._nextVideoLogicalClock()
    const videoMeta = stripUndefined({
      ...existing,
      ...pickDefinedFields(updates, LEGACY_VIDEO_FIELDS),
      id,
      updatedAt: updates?.updatedAt || Date.now(),
      updatedBy: updates?.updatedBy || this.localWriterKeyHex,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      logicalClock: nextClock
    })
    const detailsPatch = pickDefinedFields(updates, CONTENT_DETAIL_FIELDS)
    const details = Object.keys(detailsPatch).length > 0
      ? normalizeContentDetails({ ...(decodeContentDetails(existingDetails) || {}), ...detailsPatch, id })
      : null

    await this.db.insert('@peartubeChannel/videos', videoMeta)
    if (details) await this.db.insert('@peartubeChannel/contentDetails', encodeContentDetails(details))
    await this._flush()
    if (details?.publicationState === 'replicationPending') {
      await this._suppressPublicVideo(id)
    } else if (syncPublic) {
      await this._syncPublicBeeFromFeedChannel()
    }
  }

  async deleteVideo(id) {
    if (!this.writable) throw new Error('Channel is not writable')
    await this.db.delete('@peartubeChannel/videos', { id })
    await this.db.delete('@peartubeChannel/contentDetails', { id })
    await this._flush()
    await this._suppressPublicVideo(id)
  }

  async putBlob(data) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = await this.blobs.put(data)
    return { id: `${id.blockOffset}:${id.blockLength}:${id.byteOffset}:${id.byteLength}`, ...id }
  }

  async getBlob(blobId) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = normalizeBlobRefInput(blobId)
    if (!id) throw new Error('Invalid blob ID format')
    try { return await this.blobs.get(id) } catch { return null }
  }

  createBlobReadStream(blobId, opts = {}) {
    if (!this.blobs) throw new Error('Blobs not initialized')
    const id = normalizeBlobRefInput(blobId)
    if (!id) throw new Error('Invalid blob ID format')
    return this.blobs.createReadStream(id, opts)
  }

  async getBlobEntry(video) {
    if (!video?.blobId) return null
    const id = normalizeBlobRefInput(video.blobId)
    if (!id) return null
    let blobsKey = this._blobsCore?.key
    if (video.blobsCoreKey && video.blobsCoreKey !== this.blobsKeyHex) {
      if (typeof video.blobsCoreKey !== 'string' || !/^[0-9a-f]{64}$/i.test(video.blobsCoreKey)) return null
      blobsKey = b4a.from(video.blobsCoreKey, 'hex')
    }
    if (!blobsKey) return null
    return { blobId: id, blobsKey, byteLength: id.byteLength }
  }

  async createInvite({ expires = 0 } = {}) {
    if (this.swarm) this.setupPairing(this.swarm).catch(() => {})
    await this._update()
    const current = await this.db.findOne('@peartubeChannel/invites', { gte: { idHex: '' } })
    if (current?.current && current?.inviteZ32) return current.inviteZ32
    const inv = BlindPairing.createInvite(this.key, { expires })
    const invite = {
      idHex: b4a.toString(inv.id, 'hex'),
      inviteZ32: z32.encode(inv.invite),
      publicKeyHex: b4a.toString(inv.publicKey, 'hex'),
      expires,
      createdAt: Date.now(),
      current: true
    }
    await this.db.insert('@peartubeChannel/invites', invite)
    await this._flush()
    return invite.inviteZ32
  }

  async clearInvite() {
    const invites = await this.db.find('@peartubeChannel/invites', {}).toArray()
    for (const inv of invites) await this.db.delete('@peartubeChannel/invites', { idHex: inv.idHex })
    await this._flush()
  }

  async setupPairing(swarm) {
    if (!swarm || this._pairingSetupDone) return
    this._pairingSetupDone = true
    this.swarm = swarm
    if (this.discoveryKey) {
      try {
        this._channelDiscovery = swarm.join(this.discoveryKey)
        this._channelDiscovery?.flushed?.().catch(() => {})
      } catch {
        // best effort
      }
    }
    this._replicateConnection = (connection) => {
      if (!connection || this._replicatedConnections.has(connection) || !this.core) return
      this._replicatedConnections.add(connection)
      this.core.replicate(Protomux.from(connection), { live: true })
    }
    swarm.on('connection', this._replicateConnection)
    for (const connection of swarm.connections || []) this._replicateConnection(connection)
    if (!this.writable) return
    this.pairing = new BlindPairing(swarm)
    this.pairingMember = this.pairing.addMember({
      discoveryKey: this.discoveryKey,
      onadd: async (req) => {
        try {
          const invites = await this.db.find('@peartubeChannel/invites', {}).toArray()
          const inv = invites.find((candidate) => candidate.current)
          if (!inv) return
          if (inv.expires > 0 && Date.now() > inv.expires) {
            await this.db.delete('@peartubeChannel/invites', { idHex: inv.idHex })
            await this._flush()
            return
          }
          const candidateIdHex = b4a.toString(req.inviteId, 'hex')
          if (candidateIdHex !== inv.idHex) return
          const userData = req.open(fromHex(inv.publicKeyHex))
          const newWriterKeyHex = b4a.toString(userData, 'hex')
          await this.addWriter({ keyHex: newWriterKeyHex, role: 'device', deviceName: '' })
          req.confirm({ key: this.key, encryptionKey: this.encryptionKey })
          await this.db.delete('@peartubeChannel/invites', { idHex: inv.idHex })
          await this._flush()
        } catch (err) {
          console.error('[Channel] Pairing error:', err)
        }
      }
    })
  }

  async waitForPeerConnection(timeoutMs = 30000) {
    if (!this.swarm) return false
    if (this.discoveryKey) {
      try {
        if (!this._channelDiscovery) {
          this._channelDiscovery = this.swarm.join(this.discoveryKey)
        }
        await this._channelDiscovery?.flushed?.()
      } catch {
        // best effort
      }
    }
    if (this.swarm?.connections?.size > 0) return true
    return new Promise((resolve) => {
      const start = Date.now()
      const checkInterval = setInterval(() => {
        const connCount = this.swarm?.connections?.size || 0
        if (connCount > 0) {
          clearInterval(checkInterval)
          resolve(true)
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(checkInterval)
          resolve(false)
        }
      }, 500)
    })
  }

  async waitForInitialSync(opts = {}) {
    const { peerTimeout = 30000, dataTimeout = 20000, onProgress = () => {} } = opts
    onProgress('connecting', { message: 'Looking for peers...' })
    const peerConnected = await this.waitForPeerConnection(peerTimeout)
    if (!peerConnected) {
      onProgress('offline', { message: 'No peers found. Original device may be offline.' })
      return { success: false, videoCount: 0, state: 'offline' }
    }
    onProgress('syncing', { message: 'Connected! Syncing data...', peerCount: this.swarm?.connections?.size || 0 })
    const start = Date.now()
    while (Date.now() - start < dataTimeout) {
      await this.core.update({ wait: true, timeout: 2000 }).catch(() => {})
      this.db.update?.()
      const videos = await this.listVideos()
      if (videos.length > 0) {
        onProgress('synced', { videoCount: videos.length })
        return { success: true, videoCount: videos.length, state: 'synced' }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const videos = await this.listVideos()
    if (videos.length > 0) return { success: true, videoCount: videos.length, state: 'synced' }
    onProgress('failed', { message: 'Sync timeout - no videos received yet' })
    return { success: false, videoCount: 0, state: 'failed' }
  }

  // Applies a legacy 'log-watch-event' op during replay. No producer calls this
  // any more and no API reads the collection back; it exists only so a channel
  // log written before the watch-telemetry removal derives the same state.
  async addWatchEvent(event) {
    const eventId = event.eventId || b4a.toString(crypto.randomBytes(16), 'hex')
    await this.db.insert('@peartubeChannel/watchEvents', stripUndefined({
      ...event,
      eventId,
      videoId: event.videoId,
      channelKey: event.channelKey || this.keyHex,
      timestamp: event.timestamp || Date.now()
    }))
    await this._flush()
    return { success: true, eventId }
  }

  async addVectorIndex(record) {
    if (!record?.videoId) throw new Error('videoId required')
    await this.db.insert('@peartubeChannel/vectorIndexes', {
      videoId: record.videoId,
      vector: record.vector || '',
      text: record.text || '',
      metadata: record.metadata || '',
      indexedAt: record.indexedAt || Date.now()
    })
    await this._flush()
    return { success: true }
  }
}
